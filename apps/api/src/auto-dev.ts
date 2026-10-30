import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { Orchestrator, opencodeFetch } from "@devteam/agents";
import { syncProjectRepo } from "./repo-sync.js";
import {
  EVENT_TYPES,
  PHASE_LABELS,
  type TurnSummary,
  type WorkflowPhase,
} from "@devteam/contracts";
import {
  getDb,
  insertMessage,
  agentRuns,
  approvals,
  artifacts,
  loadRoomBundle,
  messages,
  projects,
  rooms,
  taskDependencies,
  tasks,
  workspaces,
  type ProjectRow,
  type TaskRow,
} from "@devteam/db";
import {
  canTransitionPhase,
  gateRequirementsForTransition,
  inferTaskRoleKey,
  nextPhase,
  uuidv7,
} from "@devteam/domain";
import {
  commitAndMergeWorkspace,
  createWorkspace,
  ensureProjectRepo,
  runTaskWork,
  validateRepoPath,
} from "@devteam/workspace";
import {
  guardStaleQueues,
  projectEmitter,
  roomQueue,
  runtime,
  workQueue,
} from "./orchestration.js";
import { previewLocalUrlForProject, previewUrlForProject, startPreview } from "./preview.js";

const schedulerLocks = new Map<string, number>();
/** Projects with a task in the middle of workspace allocation. */
const startingProjects = new Map<string, number>();
const pausedProjects = new Set<string>();
/** Why the scheduler last paused a project. User-initiated pauses have no entry. */
const autoPauseReasons = new Map<string, string>();
const AUTO_PAUSE_LABELS: Record<string, string> = {
  pending_decisions: "还有待决策项",
  artifact_decision: "产物需要确认",
  artifact_batch_accepted: "产物已接受，准备继续",
  decision: "产生了新的产品决策",
  approval: "产生了新的审批项",
  task_merged: "任务刚合并",
  task_failed: "任务失败",
};
/** Locks carry timestamps so a wedged promise cannot own a project forever. */
const phaseNudgeLocks = new Map<string, number>();
const lastPhaseNudge = new Map<string, number>();
const lastGateNotice = new Map<string, number>();
const lastTriageNudge = new Map<string, number>();
/** Projects currently repairing orphaned `proposed` tasks. */
const proposalRepairLocks = new Map<string, number>();
const triageLocks = new Map<string, number>();
const lastOpsHeartbeat = new Map<string, number>();
const lastNotice = new Map<string, number>();
const internalMergeLocks = new Map<string, number>();

/**
 * Claim a per-project lock. Returns a token, or null while a fresh lock is
 * held. A lock older than `ttlMs` is considered wedged and can be reclaimed,
 * so a promise that never settles cannot freeze a project forever.
 */
function claimLock(
  locks: Map<string, number>,
  projectId: string,
  ttlMs: number,
): number | null {
  const heldSince = locks.get(projectId);
  if (heldSince !== undefined && Date.now() - heldSince < ttlMs) return null;
  const token = Date.now();
  locks.set(projectId, token);
  return token;
}

function releaseLock(
  locks: Map<string, number>,
  projectId: string,
  token?: number,
): void {
  // Only the owner may release; a reclaimed stale lock has a new token.
  if (token === undefined || locks.get(projectId) === token) locks.delete(projectId);
}

/** Post an operational notice at most once per cooldown window. */
async function noticeOnce(
  project: ProjectRow,
  roomId: string,
  key: string,
  cooldownMs: number,
  content: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const cacheKey = `${project.id}:${key}`;
  const last = lastNotice.get(cacheKey) ?? 0;
  if (Date.now() - last < cooldownMs) return;
  lastNotice.set(cacheKey, Date.now());
  const messageId = uuidv7();
  await insertMessage({
    id: messageId,
    tenantId: project.tenantId,
    projectId: project.id,
    roomId,
    senderType: "system",
    senderName: "系统",
    type: "system_event",
    content,
    metadata: { ...metadata, kind: key },
  });
  await projectEmitter(project.tenantId, project.id)(EVENT_TYPES.messageCreated, {
    messageId,
    roomId,
    senderType: "system",
    senderName: "系统",
    type: "system_event",
  });
}

/**
 * If the process survived but a work run vanished (rejected promise, killed
 * worker, dropped queue entry), an `in_progress` task has no worker and is
 * invisible to the scheduler, which only picks `ready`. Requeue those rows so
 * the project cannot idle behind a ghost task. Startup recovery handles the
 * restart case; this handles the running-process case.
 */
async function recoverProjectOrphanedTasks(
  project: ProjectRow,
  roomId: string,
): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ task: tasks, workspaceId: workspaces.id })
    .from(tasks)
    .innerJoin(workspaces, eq(workspaces.taskId, tasks.id))
    .where(and(eq(tasks.projectId, project.id), eq(tasks.status, "in_progress")));
  let recovered = 0;
  for (const row of rows) {
    if (workQueue.isRunning(row.workspaceId)) continue;
    const attempts = Number(row.task.evidence?.["orphanRecoveries"] ?? 0) + 1;
    // Retry a vanished worker, but do not loop forever on a task that keeps
    // killing its run. After three ghost runs, park it for Lead triage.
    const giveUp = attempts >= 3;
    const [updated] = await db
      .update(tasks)
      .set({
        status: giveUp ? "blocked" : "ready",
        blockedReason: giveUp
          ? "任务连续 3 次执行进程消失，已挂起等待返工/取消。"
          : null,
        evidence: {
          ...row.task.evidence,
          orphanRecoveries: attempts,
          recoveredFromInProgressAt: new Date().toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(and(eq(tasks.id, row.task.id), eq(tasks.status, "in_progress")))
      .returning();
    if (!updated) continue;
    recovered += 1;
    await projectEmitter(project.tenantId, project.id)(EVENT_TYPES.taskChanged, {
      taskId: row.task.id,
      action: giveUp ? "blocked" : "recovered",
      status: giveUp ? "blocked" : "ready",
      reason: "orphaned_in_progress",
      attempts,
    }).catch(() => undefined);
  }
  if (recovered) {
    await noticeOnce(
      project,
      roomId,
      "orphaned_in_progress",
      10 * 60_000,
      `发现 ${recovered} 个 in_progress 任务没有执行进程，已重新排队（连续 3 次会转为 blocked 等待分诊）。`,
      { recovered },
    ).catch(() => undefined);
  }
  return recovered;
}

/**
 * Artifacts are internal review material. Leftover `in_review` rows would make
 * `hasPendingDecisions` true forever with no reviewer to clear them.
 */
async function acceptLegacyInReviewArtifacts(projectId: string): Promise<void> {
  await getDb()
    .update(artifacts)
    .set({ status: "accepted", updatedAt: new Date() })
    .where(and(eq(artifacts.projectId, projectId), eq(artifacts.status, "in_review")));
}

export async function hasPendingDecisions(projectId: string): Promise<boolean> {
  const db = getDb();
  const [pendingApprovals, pendingArtifacts] = await Promise.all([
    db
      .select({ id: approvals.id })
      .from(approvals)
      .where(and(eq(approvals.projectId, projectId), eq(approvals.status, "pending")))
      .limit(1),
    db
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(and(eq(artifacts.projectId, projectId), eq(artifacts.status, "in_review")))
      .limit(1),
  ]);
  // Engineering decisions are auto-accepted. Product decisions are recorded
  // in the decision inbox but must not freeze coding: the team continues with
  // a conservative default and the client can accept or override later. Only
  // explicit approvals and artifacts awaiting review are hard blockers.
  return pendingApprovals.length > 0 || pendingArtifacts.length > 0;
}

/**
 * A task without a usable `roleKey` can never reach assignee confirmation, so
 * it stays `proposed` forever and keeps `tasks_closed` false. Repair the owner
 * (deterministically) and immediately run the normal internal confirmation, so
 * an orphaned proposal becomes ready or needs_replan instead of deadlocking the
 * scheduler. This is routing, not approval: the assigned role still decides.
 */
async function repairOrphanProposedTasks(
  project: ProjectRow,
  room: { id: string },
  proposed: TaskRow[],
): Promise<void> {
  if (!proposed.length) return;
  const repairToken = claimLock(proposalRepairLocks, project.id, 15 * 60_000);
  if (!repairToken) return;
  try {
    const bundle = await loadRoomBundle(project.id, room.id, 0);
    if (!bundle) return;
    const enabledRoles = bundle.roles.filter((role) => role.enabled).map((role) => role.key);
    if (!enabledRoles.length) return;

    const db = getDb();
    const taskIds: string[] = [];
    for (const task of proposed) {
      const current = task.roleKey;
      if (current && enabledRoles.includes(current)) {
        taskIds.push(task.id);
        continue;
      }
      const roleKey = inferTaskRoleKey({
        mode: task.mode,
        title: task.title,
        description: task.description,
        availableRoles: enabledRoles,
      });
      await db
        .update(tasks)
        .set({
          roleKey,
          evidence: {
            ...task.evidence,
            assignment: {
              ...(task.evidence?.["assignment"] as Record<string, unknown> | undefined),
              autoRoleAssigned: {
                roleKey,
                at: new Date().toISOString(),
                reason: current ? `角色 ${current} 不可用` : "任务没有承接角色",
              },
            },
          },
          updatedAt: new Date(),
        })
        .where(and(eq(tasks.id, task.id), eq(tasks.status, "proposed")));
      taskIds.push(task.id);
    }
    if (!taskIds.length) return;

    const orchestrator = new Orchestrator({
      runtime,
      emit: projectEmitter(project.tenantId, project.id),
    });
    await orchestrator.reviewTaskAssignments(bundle, taskIds, `scheduler-${uuidv7()}`);
  } catch (error) {
    console.error(
      "[auto-dev] orphan proposal repair failed",
      error instanceof Error ? error.message : error,
    );
  } finally {
    releaseLock(proposalRepairLocks, project.id, repairToken);
  }
}

/**
 * When the queue has no ready work but failed/blocked tasks remain, hand the
 * Lead one internal turn to triage: cancel, split, reopen or create rework.
 * This is deliberately not a client question; engineering triage is internal.
 */
async function nudgeStuckTasks(projectId: string, stuck: TaskRow[]): Promise<void> {
  const last = lastTriageNudge.get(projectId) ?? 0;
  // An unrunnable ready task parks the whole phase. Five minutes is enough to
  // avoid flooding the room while still surfacing the deadlock quickly.
  if (Date.now() - last < 5 * 60_000) return;
  const triageToken = claimLock(triageLocks, projectId, 20 * 60_000);
  if (!triageToken) return;
  try {
    const db = getDb();
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project || project.status === "archived") return;
    const [room] = await db.select().from(rooms).where(eq(rooms.projectId, projectId)).limit(1);
    if (!room || roomQueue.isRunning(room.id)) return;
    const workspaceRows = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.projectId, projectId));
    if (workspaceRows.some((workspace) => workQueue.isRunning(workspace.id))) return;
    const bundle = await loadRoomBundle(project.id, room.id, 0);
    // A disabled `lead` must not turn the triage turn into a no-op.
    const triageRole = bundle
      ? resolveEnabledOwner(bundle.roles, "lead", project.phase as WorkflowPhase)
      : "lead";
    const triageName =
      bundle?.roles.find((role) => role.key === triageRole)?.displayName ?? triageRole;

    lastTriageNudge.set(projectId, Date.now());
    const lines = stuck.slice(0, 8).map((task) => {
      const phaseBlocked = task.status === "ready" && task.mode !== "workbench";
      const reason = phaseBlocked
        ? `当前阶段 ${project.phase} 只自动执行 workbench；这条 code 任务需要退回 coding 或取消`
        : task.status === "ready"
          ? "依赖未满足，调度器无法启动；请拆单、取消依赖或调整顺序"
          : (task.blockedReason ?? "无原因");
      return `- [${task.status}] ${task.title}：${reason.slice(0, 220)}`;
    });
    const content = [
      "编码队列当前没有 ready 任务，但有任务卡住：",
      ...lines,
      "",
      `请 ${triageName} 在团队内部处理：取消、返工、拆分或新建任务；工程事项不要问甲方。`,
      "处理完用 update_task/create_task 落状态，自动开发会继续。",
    ].join("\n");
    const messageId = uuidv7();
    await insertMessage({
      id: messageId,
      tenantId: project.tenantId,
      projectId: project.id,
      roomId: room.id,
      senderType: "system",
      senderName: "系统",
      type: "system_event",
      content,
      metadata: { kind: "task_triage", stuck: stuck.map((task) => task.id) },
    });
    const emit = projectEmitter(project.tenantId, project.id);
    await emit(EVENT_TYPES.messageCreated, {
      messageId,
      roomId: room.id,
      senderType: "system",
      senderName: "系统",
      type: "system_event",
    });
    const orchestrator = new Orchestrator({
      runtime,
      emit,
      maxRounds: 1,
      maxSpeakersPerRound: 1,
      maxMessagesPerTurn: 3,
    });
    await new Promise<void>((resolve) => {
      roomQueue.enqueue(room.id, async (signal) => {
        try {
          await orchestrator.run({
            projectId: project.id,
            roomId: room.id,
            userMessageId: messageId,
            content,
            mentions: [triageRole],
            participantKeys: [triageRole],
            userName: "系统",
            triggerLabel: "系统（任务分诊）",
            readOnly: false,
            phaseOnly: false,
            userId: project.tenantId,
            signal,
          });
        } finally {
          resolve();
        }
      });
    });
  } catch (error) {
    console.error("[auto-dev] task triage failed", error);
  } finally {
    releaseLock(triageLocks, projectId, triageToken);
  }
}

/**
 * When a gate becomes satisfied, give the Lead one narrow turn to decide
 * internally whether to advance/loop the phase. The turn may only emit
 * request_phase; it cannot create tasks, artifacts, approvals or change task
 * state. Client confirmation is not part of engineering phase transitions.
 */
/** Which role owns the evidence that is still missing from a phase gate. */
function gateOwnerRole(unmetKeys: string[], phase: WorkflowPhase): string {
  const owners: Record<string, string> = {
    prd_accepted: "pm",
    acceptance_criteria: "pm",
    security_requirements: "security",
    design_accepted: "architect",
    plan_accepted: "architect",
    has_tasks: "architect",
    security_design: "security",
    tasks_closed: "lead",
    sca: "security",
    sast: "security",
    code_audit: "security",
    test_report: "qa",
    spec_review: "qa",
    security_test: "security",
    release_security: "security",
  };
  const phaseOwner: Record<WorkflowPhase, string> = {
    requirements: "pm",
    design: "architect",
    coding: "lead",
    testing: "qa",
    deployment: "devops",
    operations: "devops",
  };
  for (const key of unmetKeys) {
    const owner = owners[key];
    if (owner) return owner;
  }
  return phaseOwner[phase] ?? "lead";
}

function resolveEnabledOwner(
  roles: Array<{ key: string; enabled: boolean }>,
  preferred: string,
  phase: WorkflowPhase,
): string {
  const enabled = roles.filter((role) => role.enabled).map((role) => role.key);
  if (enabled.includes(preferred)) return preferred;
  const phaseOwner = gateOwnerRole([], phase);
  if (enabled.includes(phaseOwner)) return phaseOwner;
  if (enabled.includes("lead")) return "lead";
  return enabled[0] ?? "lead";
}

export async function nudgePhaseProposal(projectId: string, trigger = "gate_satisfied"): Promise<void> {
  const phaseToken = claimLock(phaseNudgeLocks, projectId, 25 * 60_000);
  if (!phaseToken) return;
  try {
    const db = getDb();
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project || project.status === "archived") return;
    const from = project.phase as WorkflowPhase;
    const next = nextPhase(from);
    // Cooldown is per phase, not per project: after a transition the next
    // phase must be evaluated immediately instead of waiting out the previous
    // phase's ten-minute window.
    const phaseKey = `${projectId}:${from}`;
    const last = lastPhaseNudge.get(phaseKey) ?? 0;
    // If the Lead declines, do not re-ask on every scheduler tick.
    if (Date.now() - last < 10 * 60_000) return;
    if (!next || !canTransitionPhase(from, next)) return;
    // Legacy in_review artifacts are internal material; clear them before the
    // pending-decision check so they cannot block the gate forever.
    await acceptLegacyInReviewArtifacts(projectId);
    if (await hasPendingDecisions(projectId)) return;
    // Ready work is the scheduler's job; a simultaneous gate turn would race
    // it and add noise. Only nudge when the queue is genuinely empty.
    const [readyWork] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), eq(tasks.status, "ready")))
      .limit(1);
    if (readyWork) return;

    const [room] = await db.select().from(rooms).where(eq(rooms.projectId, projectId)).limit(1);
    if (!room || roomQueue.isRunning(room.id)) return;
    const workspaceRows = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.projectId, projectId));
    if (workspaceRows.some((workspace) => workQueue.isRunning(workspace.id))) return;

    const bundle = await loadRoomBundle(project.id, room.id, 0);
    if (!bundle) return;
    if (!bundle.roles.some((role) => role.enabled)) {
      await noticeOnce(
        project,
        room.id,
        "no_enabled_roles",
        30 * 60_000,
        "所有角色都被禁用，自动开发无法推进；请至少启用一个角色。",
        {},
      ).catch(() => undefined);
      return;
    }
    const requirements = gateRequirementsForTransition(from, next, {
      artifacts: bundle.artifacts.map((a) => ({ kind: a.kind, status: a.status, title: a.title })),
      tasks: bundle.tasks.map((t) => ({ status: t.status, id: t.id, evidence: t.evidence })),
      approvals: bundle.approvals.map((a) => ({ targetType: a.targetType, status: a.status })),
    });
    if (!requirements.every((r) => r.met)) {
      // Idle is not an error: the scheduler has no ready work because a gate is
      // waiting for evidence (for example Security's SCA/SAST reports). Say so
      // explicitly instead of looking like the conversation silently stopped.
      const lastNotice = lastGateNotice.get(phaseKey) ?? 0;
      if (Date.now() - lastNotice >= 10 * 60_000) {
        lastGateNotice.set(phaseKey, Date.now());
        const unmet = requirements.filter((r) => !r.met);
        const preferred = gateOwnerRole(unmet.map((r) => r.key), from);
        const owner = resolveEnabledOwner(bundle.roles, preferred, from);
        const ownerName = bundle.roles.find((role) => role.key === owner)?.displayName ?? owner;
        const messageId = uuidv7();
        const content = [
          `自动开发当前没有可执行任务；${PHASE_LABELS[from]}门禁尚未满足。`,
          `还差：${unmet.map((r) => r.label).join("、")}。`,
          `这个小回合交给 ${ownerName}：请补齐缺失证据，或用 create_task 创建缺失的 workbench 任务（先检查现有任务，避免重复）。`,
          "工程事项不要问甲方；补齐后 Lead 会自动发起阶段推进。",
        ].join("\n");
        await insertMessage({
          id: messageId,
          tenantId: project.tenantId,
          projectId: project.id,
          roomId: room.id,
          senderType: "system",
          senderName: "系统",
          type: "system_event",
          content,
          metadata: { kind: "gate_waiting", phase: from, unmet: unmet.map((r) => r.key), trigger, owner },
        });
        const emit = projectEmitter(project.tenantId, project.id);
        await emit(EVENT_TYPES.messageCreated, {
          messageId,
          roomId: room.id,
          senderType: "system",
          senderName: "系统",
          type: "system_event",
        });

        // A gate that needs evidence must not idle forever: hand one bounded
        // internal turn to the role that owns the missing evidence. Otherwise
        // the notice is just a tombstone and the room goes silent again.
        if (!roomQueue.isRunning(room.id)) {
          const orchestrator = new Orchestrator({
            runtime,
            emit,
            maxRounds: 1,
            maxSpeakersPerRound: 1,
            maxMessagesPerTurn: 1,
          });
          roomQueue.enqueue(room.id, async (signal) => {
            try {
              await orchestrator.run({
                projectId: project.id,
                roomId: room.id,
                userMessageId: messageId,
                content,
                mentions: [owner],
                participantKeys: [owner],
                userName: "系统",
                triggerLabel: "系统（阶段门禁未满足）",
                phaseOnly: false,
                userId: project.tenantId,
                signal,
              });
            } catch (error) {
              console.error(
                "[auto-dev] gate owner turn failed",
                error instanceof Error ? error.message : error,
              );
            }
          });
        }
      }
      return;
    }

    lastGateNotice.delete(phaseKey);
    lastPhaseNudge.set(phaseKey, Date.now());
    const messageId = uuidv7();
    const content = [
      "阶段门禁已经满足。",
      `当前阶段：${PHASE_LABELS[from]}；可提议的下一阶段：${PHASE_LABELS[next]}。`,
      "请在团队内部判断是否推进：如果证据足够，用 request_phase 发起内部阶段推进；服务端校验门禁后会直接切换阶段，不需要甲方确认。",
      "如果还不该推进，不要只停在“不推进”：请用 create_task 创建缺失的 workbench/任务（先检查现有任务，避免重复），或明确指出已有任务。可以创建任务，但不要修改已完成任务或审批，也不要询问甲方。",
    ].join("\n");
    await insertMessage({
      id: messageId,
      tenantId: project.tenantId,
      projectId: project.id,
      roomId: room.id,
      senderType: "system",
      senderName: "系统",
      type: "system_event",
      content,
      metadata: { kind: "phase_gate", from, next, trigger },
    });
    const emit = projectEmitter(project.tenantId, project.id);
    await emit(EVENT_TYPES.messageCreated, {
      messageId,
      roomId: room.id,
      senderType: "system",
      senderName: "系统",
      type: "system_event",
    });

    const orchestrator = new Orchestrator({
      runtime,
      emit,
      maxRounds: 1,
      maxSpeakersPerRound: 1,
      maxMessagesPerTurn: 1,
    });
    await new Promise<void>((resolve) => {
      roomQueue.enqueue(room.id, async (signal) => {
        try {
          await orchestrator.run({
            projectId: project.id,
            roomId: room.id,
            userMessageId: messageId,
            content,
            mentions: ["lead"],
            participantKeys: ["lead"],
            userName: "系统",
            triggerLabel: "系统（阶段门禁）",
            phaseOnly: false,
            userId: project.tenantId,
            signal,
          });
        } finally {
          resolve();
        }
      });
    });
  } catch (error) {
    console.error("[auto-dev] phase proposal nudge failed", error);
  } finally {
    releaseLock(phaseNudgeLocks, projectId, phaseToken);
  }
}

/**
 * A client-facing question/decision in the room pauses automatic task starts.
 * The orchestrator already stops adding rounds; this guard also prevents the
 * scheduler from starting a task created earlier in the same turn.
 */
async function hasUnansweredClientQuestion(projectId: string): Promise<boolean> {
  const db = getDb();
  const [question] = await db
    .select({ seq: messages.seq })
    .from(messages)
    .where(
      and(
        eq(messages.projectId, projectId),
        eq(messages.type, "question"),
        sql`coalesce(${messages.metadata}->>'clientQuestion', '') = 'true'`,
      ),
    )
    .orderBy(desc(messages.seq))
    .limit(1);
  if (!question) return false;
  const [reply] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.projectId, projectId),
        eq(messages.senderType, "user"),
        gt(messages.seq, question.seq),
      ),
    )
    .limit(1);
  return !reply;
}

export async function pauseAutoDevelopment(
  projectId: string,
  reason: string,
): Promise<void> {
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project || !project.autoStartTasks) return;
  autoPauseReasons.set(projectId, reason);
  await db
    .update(projects)
    .set({
      autoStartTasks: false,
      autoPauseReason: reason,
      updatedAt: new Date(),
      version: project.version + 1,
    })
    .where(eq(projects.id, projectId));
  const emit = projectEmitter(project.tenantId, project.id);
  await emit(EVENT_TYPES.projectChanged, {
    action: "auto_paused",
    reason,
  });
  const [room] = await db.select().from(rooms).where(eq(rooms.projectId, projectId)).limit(1);
  if (room) {
    const messageId = uuidv7();
    const label = AUTO_PAUSE_LABELS[reason] ?? reason;
    await insertMessage({
      id: messageId,
      tenantId: project.tenantId,
      projectId: project.id,
      roomId: room.id,
      senderType: "system",
      senderName: "系统",
      type: "system_event",
      content: `自动开发已暂停：${label}。处理完该项后会自动继续；如果只想让它停下，请在项目设置里关闭自动开发。`,
      metadata: { kind: "auto_paused", reason },
    });
    await emit(EVENT_TYPES.messageCreated, {
      messageId,
      roomId: room.id,
      senderType: "system",
      senderName: "系统",
      type: "system_event",
    });
  }
}

/** Create and attach a local repository for projects that came without one. */
export async function ensureProjectRepository(projectId: string): Promise<ProjectRow> {
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) throw new Error("project not found");
  if (project.repoPath) return project;

  const repoPath = await ensureProjectRepo({
    root: process.env.PROJECT_REPO_ROOT ?? process.env.DEMO_REPO_ROOT ?? "./data/repos",
    projectId: project.id,
    name: project.name,
  });
  await validateRepoPath(repoPath);
  const [updated] = await db
    .update(projects)
    .set({ repoPath, updatedAt: new Date(), version: project.version + 1 })
    .where(eq(projects.id, project.id))
    .returning();
  if (!updated) throw new Error("project update failed");
  await projectEmitter(project.tenantId, project.id)(EVENT_TYPES.projectChanged, {
    action: "repo_created",
    projectId: project.id,
  });
  return updated;
}

/**
 * A process restart can leave a code task marked in_progress while no worker
 * exists. Requeue those tasks instead of letting auto-development silently skip
 * them forever. A running workQueue (when this is called outside startup) is
 * never disturbed.
 */
export async function recoverOrphanedTasks(): Promise<void> {
  const db = getDb();
  // No live worker survives a process restart. Stop any OpenCode session left
  // behind before marking runs cancelled; otherwise it keeps editing the same
  // worktree in the background while a new run starts.
  const staleRuns = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.status, "running"));
  for (const run of staleRuns) {
    const sessionId = run.metadata?.["sessionId"];
    if (typeof sessionId === "string" && sessionId) {
      await opencodeFetch(`/api/session/${sessionId}/interrupt`, {
        method: "POST",
        timeoutMs: 10_000,
      }).catch(() => undefined);
    }
  }
  await db
    .update(agentRuns)
    .set({ status: "cancelled", endedAt: new Date(), error: "服务重启，运行已中断" })
    .where(eq(agentRuns.status, "running"));
  // Every artifact is internal review material. Migrate any leftover
  // in_review rows so the client never gets an artifact acceptance popup.
  await db
    .update(artifacts)
    .set({ status: "accepted", updatedAt: new Date() })
    .where(eq(artifacts.status, "in_review"));
  // Engineering approvals are internal as well.
  // Never auto-approve product approvals on restart. Only engineering gates
  // are safe to recover; product approvals must stay pending for the client.
  await db
    .update(approvals)
    .set({
      status: "approved",
      decidedBy: "Fucking Code 内部评审",
      decidedAt: new Date(),
      reason: "工程门禁由 QA / Lead 内部评审通过",
    })
    .where(
      and(
        eq(approvals.status, "pending"),
        sql`${approvals.targetType} NOT LIKE 'product%'`,
      ),
    );
  const rows = await db
    .select({ task: tasks, workspace: workspaces })
    .from(tasks)
    .innerJoin(workspaces, eq(workspaces.taskId, tasks.id))
    .where(eq(tasks.status, "in_progress"));
  for (const row of rows) {
    if (workQueue.isRunning(row.workspace.id)) continue;
    await db
      .update(tasks)
      .set({
        status: "ready",
        blockedReason: null,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, row.task.id));
    const [project] = await db
      .select({ tenantId: projects.tenantId })
      .from(projects)
      .where(eq(projects.id, row.task.projectId))
      .limit(1);
    if (project) {
      await projectEmitter(project.tenantId, row.task.projectId)(
        EVENT_TYPES.taskChanged,
        { taskId: row.task.id, action: "recovered", status: "ready" },
      ).catch(() => undefined);
    }
  }
  // A graceful shutdown aborts in-flight runs, so their tasks can be written
  // as failed/blocked moments before the process exits. Requeue those recent
  // aborts instead of leaving the task parked and letting a later step jump the
  // intended order. Only a narrow startup window is considered.
  const startupCutoff = new Date(Date.now() - process.uptime() * 1000 - 5 * 60_000);
  const abortedRows = await db
    .select()
    .from(tasks)
    .where(
      and(
        inArray(tasks.status, ["failed", "blocked"]),
        gt(tasks.updatedAt, startupCutoff),
        sql`(${tasks.blockedReason} ILIKE '%aborted%' OR ${tasks.blockedReason} ILIKE '%运行已中断%' OR ${tasks.blockedReason} ILIKE '%服务重启%')`,
      ),
    );
  if (abortedRows.length) {
    const allTaskRows = await db.select({ id: tasks.id, evidence: tasks.evidence }).from(tasks);
    const superseded = new Set<string>();
    for (const row of allTaskRows) {
      const defectOf = row.evidence?.["defectOf"];
      if (typeof defectOf === "string") superseded.add(defectOf);
    }
    for (const task of abortedRows) {
      if (superseded.has(task.id)) continue;
      const [workspace] = await db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(and(eq(workspaces.projectId, task.projectId), eq(workspaces.taskId, task.id)))
        .limit(1);
      if (workspace && workQueue.isRunning(workspace.id)) continue;
      const [updated] = await db
        .update(tasks)
        .set({
          status: "ready",
          blockedReason: null,
          evidence: {
            ...task.evidence,
            recoveredFromShutdownAt: new Date().toISOString(),
          },
          updatedAt: new Date(),
        })
        .where(and(eq(tasks.id, task.id), inArray(tasks.status, ["failed", "blocked"])))
        .returning();
      if (!updated) continue;
      const [owner] = await db
        .select({ tenantId: projects.tenantId })
        .from(projects)
        .where(eq(projects.id, task.projectId))
        .limit(1);
      if (owner) {
        await projectEmitter(owner.tenantId, task.projectId)(EVENT_TYPES.taskChanged, {
          taskId: task.id,
          action: "recovered",
          status: "ready",
          reason: "shutdown_abort",
        }).catch(() => undefined);
      }
    }
  }

  // A failed task that was superseded by a defect may still own the worktree
  // with the actual implementation. Move that workspace to the defect before
  // the scheduler starts it, instead of starting from a clean main checkout.
  const cancelledRows = await db.select().from(tasks).where(eq(tasks.status, "cancelled"));
  for (const oldTask of cancelledRows) {
    const defectId = (oldTask.evidence as Record<string, unknown> | null)?.["defectTaskId"];
    if (typeof defectId !== "string") continue;
    const [defect] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, defectId), eq(tasks.projectId, oldTask.projectId)))
      .limit(1);
    if (!defect || !["ready", "in_progress", "blocked"].includes(defect.status)) continue;
    const [oldWorkspace] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.taskId, oldTask.id))
      .limit(1);
    if (!oldWorkspace) continue;
    const [existingSuccessor] = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.taskId, defect.id))
      .limit(1);
    if (existingSuccessor) continue;
    await db
      .update(workspaces)
      .set({ taskId: defect.id, status: "ready", updatedAt: new Date() })
      .where(eq(workspaces.id, oldWorkspace.id));
    const [owner] = await db
      .select({ tenantId: projects.tenantId })
      .from(projects)
      .where(eq(projects.id, oldTask.projectId))
      .limit(1);
    if (owner) {
      await projectEmitter(owner.tenantId, oldTask.projectId)(EVENT_TYPES.taskChanged, {
        taskId: defect.id,
        action: "workspace_reused",
        workspaceId: oldWorkspace.id,
      }).catch(() => undefined);
    }
  }
  // Also finish review tasks that were waiting for a human merge before this
  // policy took effect. They already carry a passing verification.
  await mergeInternallyReviewedTasks();
}

/** Clear a scheduler pause reason after a manual toggle. */
export function clearAutoPauseReason(projectId: string): void {
  autoPauseReasons.delete(projectId);
  void getDb()
    .update(projects)
    .set({ autoPauseReason: null })
    .where(eq(projects.id, projectId))
    .catch((error) => {
      console.error("[auto-dev] could not clear pause reason", error);
    });
}

export async function enableAutoDevelopment(projectId: string): Promise<void> {
  if (await hasPendingDecisions(projectId)) {
    throw new Error("还有待决策项，处理完后再继续自动开发。");
  }
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) throw new Error("project not found");
  await db
    .update(projects)
    .set({
      autoStartTasks: true,
      autoPauseReason: null,
      updatedAt: new Date(),
      version: project.version + 1,
    })
    .where(eq(projects.id, projectId));
  await projectEmitter(project.tenantId, project.id)(EVENT_TYPES.projectChanged, {
    action: "auto_resumed",
  });
  pausedProjects.delete(projectId);
  autoPauseReasons.delete(projectId);
  await autoStartNext(projectId);
}

async function dependenciesMet(taskId: string): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .select({ status: tasks.status })
    .from(taskDependencies)
    .innerJoin(tasks, eq(taskDependencies.dependsOnTaskId, tasks.id))
    .where(eq(taskDependencies.taskId, taskId));
  return rows.every((row) => ["done", "cancelled"].includes(row.status));
}

async function ensureWorkspace(
  project: ProjectRow,
  task: TaskRow,
): Promise<typeof workspaces.$inferSelect> {
  const db = getDb();
  const [existing] = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.projectId, project.id), eq(workspaces.taskId, task.id)))
    .limit(1);
  if (existing) return existing;
  if (!project.repoPath) throw new Error("project has no repoPath");
  const info = await createWorkspace({
    repoPath: project.repoPath,
    projectId: project.id,
    taskId: task.id,
  });
  const [created] = await db
    .insert(workspaces)
    .values({
      id: uuidv7(),
      projectId: project.id,
      taskId: task.id,
      path: info.path,
      branch: info.branch,
      baseCommit: info.baseCommit,
      status: "ready",
    })
    .returning();
  if (!created) throw new Error("workspace creation failed");
  return created;
}

async function postTaskFeedback(projectId: string, taskId: string): Promise<boolean> {
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  const [room] = await db.select().from(rooms).where(eq(rooms.projectId, projectId)).limit(1);
  if (!project || !task || !room) return false;
  if (!["review", "failed", "blocked"].includes(task.status)) return false;

  const evidence = (task.evidence ?? {}) as Record<string, unknown>;
  const verification = evidence["verification"] as { verdict?: string } | undefined;
  const testStatus = String(evidence["testStatus"] ?? "unknown");
  const allowPhaseProposal = ["failed", "blocked"].includes(task.status);
  const content = [
    `任务《${task.title}》执行完成。`,
    `任务状态：${task.status}。`,
    `测试：${testStatus}；规格核对：${verification?.verdict ?? "未执行"}。`,
    allowPhaseProposal
      ? "请 QA 做一次简短的验收回馈，Lead 补充下一步；如果失败/阻塞暴露了需要返工或重新规划，用 request_phase 提议回到 coding 或 design 并说明理由。不要创建其他产物、任务、审批或决策，不要向甲方提问。"
      : "请 QA 做一次简短的验收回馈，Lead 补充下一步；只基于已有证据，只发消息，不要创建产物、任务、审批或决策，不要向甲方提问。",
    task.blockedReason ? `当前阻塞：${task.blockedReason}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const feedbackId = uuidv7();
  await insertMessage({
    id: feedbackId,
    tenantId: project.tenantId,
    projectId: project.id,
    roomId: room.id,
    senderType: "system",
    senderName: "系统",
    type: "system_event",
    content,
    metadata: { kind: "task_feedback", taskId: task.id },
  });
  const emit = projectEmitter(project.tenantId, project.id);
  await emit(EVENT_TYPES.messageCreated, {
    messageId: feedbackId,
    roomId: room.id,
    senderType: "system",
    senderName: "系统",
    type: "system_event",
  });

  const orchestrator = new Orchestrator({
    runtime,
    emit,
    maxRounds: 2,
    maxSpeakersPerRound: 1,
    maxMessagesPerTurn: 3,
  });
  await new Promise<void>((resolve) => {
    roomQueue.enqueue(room.id, async (signal) => {
      try {
        await orchestrator.run({
          projectId: project.id,
          roomId: room.id,
          userMessageId: feedbackId,
          content,
          mentions: ["qa"],
          participantKeys: ["qa", "lead"],
          userName: "系统",
          triggerLabel: "系统（任务回执）",
          readOnly: !allowPhaseProposal,
          phaseOnly: allowPhaseProposal,
          userId: project.tenantId,
          signal,
        });
      } finally {
        resolve();
      }
    });
  });

  const [feedbackMessage] = await db
    .select()
    .from(messages)
    .where(eq(messages.id, feedbackId))
    .limit(1);
  const turn = feedbackMessage?.metadata?.["turn"] as TurnSummary | undefined;
  // Task feedback is a status update, not a client decision. If the agents ask
  // a question here, keep the coding queue moving; genuine product questions
  // belong in the normal room conversation.
  return turn?.waitingForUser === true;
}

/**
 * Start one task in a project. This shared entry point is used by the manual
 * route and by the auto-development scheduler, so every run gets the same
 * worktree lifecycle and post-task room feedback.
 */
export async function startTaskForProject(
  project: ProjectRow,
  task: TaskRow,
  options: { auto?: boolean } = {},
): Promise<typeof workspaces.$inferSelect> {
  // Workspace creation is async (dependency bootstrap). Without this lock the
  // periodic scheduler can start a second task while the first is still
  // allocating its worktree.
  const startingToken = claimLock(startingProjects, project.id, 10 * 60_000);
  if (!startingToken) {
    throw new Error("another task is already starting for this project");
  }
  try {
    return await enqueueTaskWork(project, task, options);
  } finally {
    releaseLock(startingProjects, project.id, startingToken);
  }
}

async function ensurePreviewForTask(
  project: ProjectRow,
  task: TaskRow,
): Promise<string | undefined> {
  const existing = previewLocalUrlForProject(project.id) ?? previewUrlForProject(project.id);
  if (existing) return existing;
  if (!project.repoPath) return undefined;
  const text = `${task.title} ${task.description}`;
  const needsPreview =
    task.mode === "workbench" ||
    /预览|seed|演示数据|revoke|撤销|走查|健康检查|回滚|登录|e2e|浏览器/i.test(text);
  if (!needsPreview) return undefined;
  try {
    const preview = await startPreview(project.id, project.repoPath);
    return previewLocalUrlForProject(project.id) ?? preview.url;
  } catch (error) {
    console.error("[auto-dev] could not start preview for task", error);
    return undefined;
  }
}

async function enqueueTaskWork(
  project: ProjectRow,
  task: TaskRow,
  options: { auto?: boolean } = {},
): Promise<typeof workspaces.$inferSelect> {
  const workspace = await ensureWorkspace(project, task);
  if (workQueue.isRunning(workspace.id)) return workspace;
  const emit = projectEmitter(project.tenantId, project.id);
  const previewUrl = await ensurePreviewForTask(project, task);
  const seedUser = process.env.SEED_USERNAME ?? "security";
  const seedPassword = process.env.SEED_PASSWORD ?? "Security!2026";
  workQueue.enqueue(workspace.id, async (signal) => {
    let waitingForUser = false;
    try {
      await runTaskWork({
        projectId: project.id,
        taskId: task.id,
        workspaceId: workspace.id,
        emit,
        signal,
        previewUrl,
        seedUser,
        seedPassword,
      });
    } finally {
      try {
        waitingForUser = await postTaskFeedback(project.id, task.id);
      } catch (error) {
        console.error("[auto-dev] task feedback failed", error);
      }
      let internallyMerged = false;
      try {
        internallyMerged = await autoMergeReviewedTask({
          projectId: project.id,
          taskId: task.id,
          workspaceId: workspace.id,
        });
      } catch (error) {
        console.error("[auto-dev] internal merge failed", error);
      }
      if (internallyMerged) {
        try {
          const openRows = await getDb()
            .select({ id: tasks.id })
            .from(tasks)
            .where(and(eq(tasks.projectId, project.id), inArray(tasks.status, ["proposed", "ready", "in_progress", "review", "testing", "blocked", "failed", "needs_replan", "stale"])));
          if (
            !openRows.length &&
            project.repoPath &&
            (project.phase === "deployment" || project.phase === "operations")
          ) {
            const preview = await startPreview(project.id, project.repoPath);
            const [room] = await getDb()
              .select()
              .from(rooms)
              .where(eq(rooms.projectId, project.id))
              .limit(1);
            if (room) {
              const messageId = uuidv7();
              await insertMessage({
                id: messageId,
                tenantId: project.tenantId,
                projectId: project.id,
                roomId: room.id,
                senderType: "system",
                senderName: "系统",
                type: "system_event",
                content: `当前任务已全部完成，项目预览已启动：${preview.url}`,
                metadata: { kind: "preview_started", url: preview.url, port: preview.port },
              });
              await emit(EVENT_TYPES.messageCreated, {
                messageId,
                roomId: room.id,
                senderType: "system",
                senderName: "系统",
                type: "system_event",
              });
            }
          }
        } catch (error) {
          console.error("[auto-dev] auto preview failed", error);
        }
      }
      const [fresh] = await getDb()
        .select({ status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, task.id))
        .limit(1);
      const failed = fresh ? ["failed", "blocked"].includes(fresh.status) : false;
      if (failed) {
        // A single failed/blocked task must not stop unrelated ready work. Park
        // it for triage; only pause the whole project when nothing else can run.
        const [readyWork] = await getDb()
          .select({ id: tasks.id })
          .from(tasks)
          .where(and(eq(tasks.projectId, project.id), eq(tasks.status, "ready")))
          .limit(1);
        if (readyWork) {
          const [room] = await getDb()
            .select()
            .from(rooms)
            .where(eq(rooms.projectId, project.id))
            .limit(1);
          if (room) {
            const messageId = uuidv7();
            await insertMessage({
              id: messageId,
              tenantId: project.tenantId,
              projectId: project.id,
              roomId: room.id,
              senderType: "system",
              senderName: "系统",
              type: "system_event",
              content: `任务《${task.title}》${fresh?.status === "blocked" ? "被阻塞" : "失败"}，已挂起等待返工/取消；队列里还有其他 ready 任务，自动开发继续。`,
              metadata: { kind: "task_parked", taskId: task.id },
            });
            await emit(EVENT_TYPES.messageCreated, {
              messageId,
              roomId: room.id,
              senderType: "system",
              senderName: "系统",
              type: "system_event",
            });
          }
          return;
        }
        const [room] = await getDb()
          .select()
          .from(rooms)
          .where(eq(rooms.projectId, project.id))
          .limit(1);
        if (room) {
          const messageId = uuidv7();
          await insertMessage({
            id: messageId,
            tenantId: project.tenantId,
            projectId: project.id,
            roomId: room.id,
            senderType: "system",
            senderName: "系统",
            type: "system_event",
            content: `任务《${task.title}》${fresh?.status === "blocked" ? "被阻塞" : "失败"}，已挂起；自动开发保持开启。Lead 会收到内部分诊提示，决定返工/取消/拆分，不需要甲方处理。`,
            metadata: { kind: "task_parked", taskId: task.id, needsTriage: true },
          });
          await emit(EVENT_TYPES.messageCreated, {
            messageId,
            roomId: room.id,
            senderType: "system",
            senderName: "系统",
            type: "system_event",
          });
        }
      }
      if (options.auto && !waitingForUser && !failed) {
        setTimeout(() => {
          void autoStartNext(project.id);
        }, 600);
      }
    }
  });
  return workspace;
}

/**
 * Internal review: a task with a passing QA/spec verification is merged by the
 * team itself. The client is not asked to understand branches, diffs or merge
 * mechanics; they only approve product intent. A conflict becomes an internal
 * blocked task, not a human approval prompt.
 */
async function autoMergeReviewedTask(input: {
  projectId: string;
  taskId: string;
  workspaceId: string;
}): Promise<boolean> {
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, input.projectId)).limit(1);
  if (!project || !project.repoPath) return false;
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, input.taskId), eq(tasks.projectId, input.projectId)))
    .limit(1);
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.id, input.workspaceId), eq(workspaces.projectId, input.projectId)))
    .limit(1);
  if (!task || !workspace) return false;
  const mergeToken = claimLock(internalMergeLocks, task.id, 10 * 60_000);
  if (!mergeToken) return false;
  try {
  const evidence = (task.evidence ?? {}) as Record<string, unknown>;
  const verification = evidence["verification"] as { verdict?: string } | undefined;
  // This is called from the workQueue callback's finally block, where the
  // queue still considers itself running. The code run itself has finished,
  // so the meaningful guard is status + verification.
  // A merge blocked by a transient problem (dirty base repo, lock) is kept in
  // review for the periodic retry. Only give up after repeated failures.
  const recoverableMerge =
    task.status === "blocked" &&
    /^内部自动合并失败/.test(task.blockedReason ?? "") &&
    Number(evidence["mergeAttempts"] ?? 0) < 5;
  if ((task.status !== "review" && !recoverableMerge) || verification?.verdict !== "pass") {
    return false;
  }

  try {
    const merged = await commitAndMergeWorkspace({
      repoPath: project.repoPath,
      workspacePath: workspace.path,
      branch: workspace.branch,
      baseBranch: project.defaultBranch || "main",
      message: task.title,
      authorName: "Fucking Code 内部评审",
      authorEmail: "internal@fucking-code.local",
    });
    const mergedAt = new Date().toISOString();
    await db
      .update(tasks)
      .set({
        status: "done",
        blockedReason: null,
        evidence: {
          ...evidence,
          merge: {
            commit: merged.commit,
            branch: merged.branch,
            baseBranch: merged.baseBranch,
            mergedAt,
            mergedBy: "Fucking Code 内部评审（QA/Lead）",
            automatic: true,
          },
        },
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, task.id));
    await db
      .update(workspaces)
      .set({ status: "merged", updatedAt: new Date() })
      .where(eq(workspaces.id, workspace.id));

    void syncProjectRepo(project.id).catch((error) => {
      console.error("[auto-dev] project repo sync failed", error);
    });

    const [room] = await db.select().from(rooms).where(eq(rooms.projectId, project.id)).limit(1);
    if (room) {
      const messageId = uuidv7();
      await insertMessage({
        id: messageId,
        tenantId: project.tenantId,
        projectId: project.id,
        roomId: room.id,
        senderType: "system",
        senderName: "系统",
        type: "system_event",
        content: `内部评审通过，已自动合并「${task.title}」到 ${merged.baseBranch}（${merged.commit.slice(0, 8)}）。可以点顶部「预览」查看当前项目。`,
        metadata: {
          kind: "internal_merge",
          taskId: task.id,
          workspaceId: workspace.id,
          commit: merged.commit,
        },
      });
      await projectEmitter(project.tenantId, project.id)(EVENT_TYPES.messageCreated, {
        messageId,
        roomId: room.id,
        senderType: "system",
        senderName: "系统",
        type: "system_event",
      });
    }
    await projectEmitter(project.tenantId, project.id)(EVENT_TYPES.taskChanged, {
      taskId: task.id,
      action: "merged",
      status: "done",
      commit: merged.commit,
      internal: true,
    });
    // A manual verify/retry can recover a previously failed task. Clear the
    // in-memory pause only after a successful internal merge; failures still
    // pause until the user explicitly resolves them.
    pausedProjects.delete(project.id);
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const attempts = Number(evidence["mergeAttempts"] ?? 0) + 1;
    const conflict = /CONFLICT|Automatic merge failed|Merge conflict/i.test(reason);
    if (conflict) {
      // A conflicting branch needs the agent to merge main into its worktree
      // and resolve it. Retrying the same merge cannot succeed. Put it back in
      // the queue instead of parking it in review (which would pause the whole
      // project and produce repeated idle notices).
      await db
        .update(tasks)
        .set({
          status: "ready",
          blockedReason: `合并冲突：${reason.slice(0, 900)}\n请在 worktree 内把 main merge 到当前分支、解决冲突并重跑测试；不要把当前分支合并回主分支。`,
          evidence: { ...evidence, mergeAttempts: attempts, mergeConflict: true },
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, task.id));
      await projectEmitter(project.tenantId, project.id)(EVENT_TYPES.taskChanged, {
        taskId: task.id,
        action: "rework",
        status: "ready",
        reason: "merge_conflict",
        attempts,
      }).catch(() => undefined);
      return false;
    }
    // Transient merge failures should heal without user action. Five attempts
    // covers a dirty base repo that the next internal merge/checkout cleans up.
    const giveUp = attempts >= 5;
    await db
      .update(tasks)
      .set({
        status: giveUp ? "blocked" : "review",
        blockedReason: `内部自动合并失败（第 ${attempts} 次）：${reason.slice(0, 760)}`,
        evidence: { ...evidence, mergeAttempts: attempts },
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, task.id));
    await projectEmitter(project.tenantId, project.id)(EVENT_TYPES.taskChanged, {
      taskId: task.id,
      action: "updated",
      status: giveUp ? "blocked" : "review",
      reason: "internal_merge_failed",
      attempts,
    }).catch(() => undefined);
    return false;
  }
  } finally {
    releaseLock(internalMergeLocks, task.id, mergeToken);
  }
}

/** Recover review tasks left over from before automatic internal merging. */
export async function mergeInternallyReviewedTasks(projectId?: string): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ taskId: tasks.id, projectId: tasks.projectId, workspaceId: workspaces.id })
    .from(tasks)
    .innerJoin(workspaces, eq(workspaces.taskId, tasks.id))
    .where(
      projectId
        ? and(inArray(tasks.status, ["review", "blocked"]), eq(tasks.projectId, projectId))
        : inArray(tasks.status, ["review", "blocked"]),
    );
  for (const row of rows) {
    await autoMergeReviewedTask({
      projectId: row.projectId,
      taskId: row.taskId,
      workspaceId: row.workspaceId,
    }).catch((error) => {
      console.error("[auto-dev] internal recovery merge failed", error);
    });
  }
}

/**
 * Pick the next ready task in a build-phase project, respecting dependencies
 * and one running workspace per project. The scheduler is intentionally
 * idempotent; the periodic loop and event hooks may both call it.
 */
export async function autoStartNext(projectId: string): Promise<void> {
  const schedulerToken = claimLock(schedulerLocks, projectId, 30 * 60_000);
  if (!schedulerToken) return;
  const startingSince = startingProjects.get(projectId);
  if (startingSince !== undefined && Date.now() - startingSince < 10 * 60_000) {
    releaseLock(schedulerLocks, projectId, schedulerToken);
    return;
  }
  try {
    const db = getDb();
    let [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project) return;
    if (project.status === "archived") return;
    // Requirements/design may still have read-only workbench tasks (for
    // example the security-design investigation); code tasks stay blocked
    // outside coding by the candidate filter below.
    if (
      !["requirements", "design", "coding", "testing", "deployment", "operations"].includes(
        project.phase,
      )
    ) {
      return;
    }
    if (await hasUnansweredClientQuestion(projectId)) return;

    // Projects can be created before a repository exists. Create one instead
    // of returning silently: a missing repo used to stop the queue forever.
    if (!project.repoPath) {
      try {
        project = await ensureProjectRepository(projectId);
      } catch (error) {
        const [room] = await db
          .select({ id: rooms.id })
          .from(rooms)
          .where(eq(rooms.projectId, projectId))
          .limit(1);
        if (room) {
          await noticeOnce(
            project,
            room.id,
            "repo_missing",
            10 * 60_000,
            `项目没有可用仓库，自动开发暂时无法启动：${
              error instanceof Error ? error.message : String(error)
            }。请检查 PROJECT_REPO_ROOT / 仓库配置。`,
            {},
          ).catch(() => undefined);
        }
        return;
      }
    }
    const repoPath = project.repoPath;
    if (!repoPath) {
      const [room] = await db
        .select({ id: rooms.id })
        .from(rooms)
        .where(eq(rooms.projectId, projectId))
        .limit(1);
      if (room) {
        await noticeOnce(
          project,
          room.id,
          "repo_missing",
          10 * 60_000,
          "项目没有可用仓库，自动开发无法启动；请检查 PROJECT_REPO_ROOT / 仓库配置。",
          {},
        ).catch(() => undefined);
      }
      return;
    }

    try {
      await validateRepoPath(repoPath);
    } catch (error) {
      const [room] = await db
        .select({ id: rooms.id })
        .from(rooms)
        .where(eq(rooms.projectId, projectId))
        .limit(1);
      if (room) {
        await noticeOnce(
          project,
          room.id,
          "repo_invalid",
          10 * 60_000,
          `项目仓库不可用（${repoPath}）：${
            error instanceof Error ? error.message : String(error)
          }。自动开发会保持暂停，修复后自动继续。`,
          { repoPath },
        ).catch(() => undefined);
      }
      return;
    }

    // Artifacts are internal material; a leftover in_review row must not look
    // like an unanswered client decision forever.
    await acceptLegacyInReviewArtifacts(projectId);

    // A task that just reached review is not a human decision yet. Merge
    // verified review tasks before treating review as a pending decision;
    // otherwise the feedback window can persist autoStartTasks=false even
    // after the internal merge succeeds. Internal review does not require the
    // user, so run it even while auto development is paused.
    await mergeInternallyReviewedTasks(projectId);

    if (!project.autoStartTasks) {
      // The reason is persisted so a restart does not turn a system pause into
      // a permanent "user disabled" state.
      const pauseReason = autoPauseReasons.get(projectId) ?? project.autoPauseReason ?? undefined;
      // No recorded system reason means the user turned auto development off.
      if (!pauseReason) return;
      if (await hasPendingDecisions(projectId)) return;
      // The blocker that caused a system pause is gone: resume without making
      // the user click "继续自动开发" again.
      const [resumed] = await db
        .update(projects)
        .set({
          autoStartTasks: true,
          autoPauseReason: null,
          updatedAt: new Date(),
          version: project.version + 1,
        })
        .where(eq(projects.id, projectId))
        .returning();
      if (!resumed) return;
      project = resumed;
      autoPauseReasons.delete(projectId);
      await projectEmitter(project.tenantId, project.id)(EVENT_TYPES.projectChanged, {
        action: "auto_resumed",
        reason: pauseReason,
      });
    } else if (await hasPendingDecisions(projectId)) {
      await pauseAutoDevelopment(projectId, "pending_decisions");
      return;
    }

    const [room] = await db.select().from(rooms).where(eq(rooms.projectId, projectId)).limit(1);
    if (!room) return;
    if (roomQueue.isRunning(room.id)) return;

    const workspaceRows = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.projectId, projectId));
    if (workspaceRows.some((workspace) => workQueue.isRunning(workspace.id))) return;

    // A ghost in_progress task would keep the queue "empty" forever.
    await recoverProjectOrphanedTasks(project, room.id);

    let taskRows = await db
      .select()
      .from(tasks)
      .where(eq(tasks.projectId, projectId))
      .orderBy(asc(tasks.createdAt));

    // Repair proposals before selecting work: an orphaned proposal must not
    // look like "no work left" while silently holding the coding gate closed.
    const proposed = taskRows.filter((task) => task.status === "proposed");
    if (proposed.length) {
      await repairOrphanProposedTasks(project, room, proposed);
      taskRows = await db
        .select()
        .from(tasks)
        .where(eq(tasks.projectId, projectId))
        .orderBy(asc(tasks.createdAt));
    }

    let candidate: TaskRow | undefined;
    for (const task of taskRows) {
      if (task.status !== "ready") continue;
      // Outside coding, only run the read-only tool workbenches (QA walkthrough,
      // security scan, deployment check). Business code changes belong to coding.
      if (project.phase !== "coding" && task.mode !== "workbench") continue;
      if (await dependenciesMet(task.id)) {
        candidate = task;
        break;
      }
    }
    if (!candidate) {
      const stuck = taskRows.filter(
        (task) =>
          ["proposed", "review", "testing", "failed", "blocked", "needs_replan", "stale"].includes(
            task.status,
          ) ||
          // A ready code task in testing/deployment/operations can never be
          // picked by the scheduler. Surface it for internal triage instead of
          // silently leaving a non-empty queue that looks stuck.
          (task.status === "ready" && project.phase !== "coding" && task.mode !== "workbench"),
      );
      // A ready task whose dependencies are still blocked is also unrunnable.
      for (const task of taskRows) {
        if (task.status !== "ready" || stuck.includes(task)) continue;
        if (project.phase !== "coding" && task.mode !== "workbench") continue;
        if (!(await dependenciesMet(task.id))) stuck.push(task);
      }
      if (stuck.length) {
        void nudgeStuckTasks(project.id, stuck);
        return;
      }
      void nudgePhaseProposal(project.id, "no_ready_tasks");
      return;
    }

    const startMessageId = uuidv7();
    await insertMessage({
      id: startMessageId,
      tenantId: project.tenantId,
      projectId: project.id,
      roomId: room.id,
      senderType: "system",
      senderName: "系统",
      type: "system_event",
      content: `自动开发：开始任务《${candidate.title}》。`,
      metadata: { kind: "auto_start", taskId: candidate.id },
    });
    await projectEmitter(project.tenantId, project.id)(EVENT_TYPES.messageCreated, {
      messageId: startMessageId,
      roomId: room.id,
      senderType: "system",
      senderName: "系统",
      type: "system_event",
    });
    try {
      await startTaskForProject(project, candidate, { auto: true });
    } catch (error) {
      // Workspace allocation can fail transiently. Keep the task ready and
      // surface the reason instead of retrying silently every 20 seconds.
      await noticeOnce(
        project,
        room.id,
        "task_start_failed",
        10 * 60_000,
        `任务《${candidate.title}》启动失败：${
          error instanceof Error ? error.message : String(error)
        }。任务保留在 ready，稍后自动重试。`,
        { taskId: candidate.id },
      ).catch(() => undefined);
    }
  } catch (error) {
    console.error("[auto-dev] scheduler failed", error);
  } finally {
    releaseLock(schedulerLocks, projectId, schedulerToken);
  }
}

export function resumeAutoDevelopment(projectId: string): void {
  pausedProjects.delete(projectId);
  // Always schedule one idempotent tick: a new user message may have resolved
  // the condition that paused the queue (question, approval, stale lock).
  setTimeout(() => {
    void autoStartNext(projectId);
  }, 1_000);
}

export async function autoStartAll(): Promise<void> {
  const db = getDb();
  const rows = await db
    .select()
    .from(projects)
    .where(
      inArray(projects.phase, [
        "requirements",
        "design",
        "coding",
        "testing",
        "deployment",
        "operations",
      ]),
    );
  await Promise.all(rows.map((project) => autoStartNext(project.id)));
}

async function nudgeAllPhaseGates(): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(inArray(projects.phase, ["requirements", "design", "coding", "testing", "deployment"]));
  for (const row of rows) {
    await nudgePhaseProposal(row.id, "periodic_gate").catch((error) => {
      console.error("[auto-dev] phase gate nudge failed", error);
    });
  }
}

/**
 * Operations is a persistent state, not a terminal phase. Do a low-frequency
 * health/preview sweep so the room does not look dead, and create an internal
 * DevOps workbench task when the running service actually breaks.
 */
async function operationsHeartbeat(project: ProjectRow): Promise<void> {
  const last = lastOpsHeartbeat.get(project.id) ?? 0;
  if (Date.now() - last < 30 * 60_000) return;
  const [room] = await getDb().select().from(rooms).where(eq(rooms.projectId, project.id)).limit(1);
  if (!room || roomQueue.isRunning(room.id)) return;
  const workspaceRows = await getDb()
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.projectId, project.id));
  if (workspaceRows.some((workspace) => workQueue.isRunning(workspace.id))) return;

  lastOpsHeartbeat.set(project.id, Date.now());
  const port = process.env.PORT ?? "8788";
  const healthStatus = await fetch(`http://127.0.0.1:${port}/health`, {
    signal: AbortSignal.timeout(4_000),
  })
    .then((response) => response.status)
    .catch(() => 0);

  let previewUrl = previewLocalUrlForProject(project.id) ?? previewUrlForProject(project.id);
  let previewStatus = 0;
  if (!previewUrl && project.repoPath) {
    try {
      previewUrl = (await startPreview(project.id, project.repoPath)).url;
    } catch {
      previewUrl = null;
    }
  }
  if (previewUrl) {
    const target = previewUrl.startsWith("http")
      ? previewUrl
      : `http://127.0.0.1:${port}${previewUrl}`;
    previewStatus = await fetch(target, {
      signal: AbortSignal.timeout(4_000),
    })
      .then((response) => response.status)
      .catch(() => 0);
  }

  const healthy = healthStatus === 200 && (!previewUrl || previewStatus === 200);
  const messageId = uuidv7();
  if (healthy) {
    // Healthy heartbeats are intentionally silent. Only incidents belong in
    // the room; periodic "all good" notices bury the actual conversation.
    return;
  }

  const openTasks = await getDb()
    .select({ id: tasks.id, title: tasks.title })
    .from(tasks)
    .where(and(eq(tasks.projectId, project.id), inArray(tasks.status, ["ready", "in_progress", "review", "blocked"])));
  const already = openTasks.some((task) => task.title.startsWith("运维异常："));
  let taskNote = "";
  if (!already) {
    const taskId = uuidv7();
    await getDb().insert(tasks).values({
      id: taskId,
      projectId: project.id,
      title: "运维异常：服务或预览健康检查失败",
      description: [
        "运维巡检发现异常，自动创建 workbench 取证单。",
        `- /health：${healthStatus}`,
        previewUrl ? `- 预览：${previewStatus}（${previewUrl}）` : "- 预览：未运行或启动失败",
        "",
        "请定位服务、预览进程、反代或配置问题；修复后复验 /health 与预览根路径，并回贴原始输出。不要修改业务代码，不要问甲方。",
      ].join("\n"),
      status: "ready",
      mode: "workbench",
      priority: "high",
      roleKey: "devops",
      acceptance: [
        "定位并修复健康检查/预览故障",
        "复验 /health 与预览根路径返回 200",
        "回贴原始命令、响应和剩余风险",
      ],
      evidence: { kind: "ops_heartbeat_alert", healthStatus, previewStatus },
    });
    taskNote = " 已创建 DevOps workbench 任务。";
  }
  await insertMessage({
    id: messageId,
    tenantId: project.tenantId,
    projectId: project.id,
    roomId: room.id,
    senderType: "system",
    senderName: "系统",
    type: "system_event",
    content: [
      "运维巡检发现异常。",
      `- /health：${healthStatus}`,
      previewUrl ? `- 预览：${previewStatus}（${previewUrl}）` : "- 预览：未运行或启动失败",
      taskNote.trim(),
    ].join("\n"),
    metadata: { kind: "ops_alert", healthStatus, previewStatus, previewUrl },
  });
  await projectEmitter(project.tenantId, project.id)(EVENT_TYPES.messageCreated, {
    messageId,
    roomId: room.id,
    senderType: "system",
    senderName: "系统",
    type: "system_event",
  });
  if (!already) void autoStartNext(project.id);
}

async function operationsHeartbeatAll(): Promise<void> {
  const rows = await getDb()
    .select()
    .from(projects)
    .where(and(eq(projects.phase, "operations"), eq(projects.autoStartTasks, true)));
  for (const project of rows) {
    await operationsHeartbeat(project).catch((error) => {
      console.error("[auto-dev] operations heartbeat failed", error);
    });
  }
}

export function startAutoDevelopmentLoop(): void {
  const mergeReviewed = () => {
    void mergeInternallyReviewedTasks().catch((error) => {
      console.error("[auto-dev] periodic internal review failed", error);
    });
  };
  const nudgeGates = () => {
    void nudgeAllPhaseGates().catch((error) => {
      console.error("[auto-dev] periodic phase nudge failed", error);
    });
  };
  const heartbeat = () => {
    void operationsHeartbeatAll().catch((error) => {
      console.error("[auto-dev] operations heartbeat sweep failed", error);
    });
  };
  setTimeout(() => {
    mergeReviewed();
    nudgeGates();
    void autoStartAll();
  }, 4_000).unref();
  // Give the service and its preview one startup window before the first
  // operations heartbeat, otherwise a restart can look like a health incident.
  setTimeout(heartbeat, 3 * 60_000).unref();
  const queueWatchdog = () => {
    try {
      guardStaleQueues();
    } catch (error) {
      console.error("[auto-dev] queue watchdog failed", error);
    }
  };
  setInterval(() => {
    mergeReviewed();
    nudgeGates();
    queueWatchdog();
    void autoStartAll();
  }, 20_000).unref();
  setInterval(heartbeat, 5 * 60_000).unref();
}
