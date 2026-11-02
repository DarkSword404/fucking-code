import { and, desc, eq, ne } from "drizzle-orm";
import type { TaskStatus, WorkflowPhase } from "@devteam/contracts";
import { EVENT_TYPES, PHASE_LABELS } from "@devteam/contracts";
import {
  getDb,
  artifacts,
  artifactVersions,
  approvals,
  captureAcceptedSpec,
  decisions,
  insertMessage,
  iterations,
  memories,
  projects,
  taskDependencies,
  tasks,
  type RoomBundle,
  type RoleRow,
} from "@devteam/db";
import {
  assertTaskTransition,
  canTransitionPhase,
  canonicalArtifactKey,
  gateRequirementsForTransition,
  initialArtifactStatus,
  isEngineeringTopic,
  missingAcceptanceCoverage,
  normalizeAcceptanceId,
  uuidv7,
  type AskUserAction,
  type BlockAction,
  type CreateArtifactAction,
  type CreateTaskAction,
  type HandoffAction,
  type ProposeDecisionAction,
  type PublishPlanAction,
  type RememberAction,
  type RequestApprovalAction,
  type RequestPhaseAction,
  type SetPhaseAction,
  type UpdateTaskAction,
  type ValidatedAgentAction,
} from "@devteam/domain";

export type EmitFn = (type: string, payload: Record<string, unknown>) => Promise<void>;

export interface ApplyContext {
  bundle: RoomBundle;
  actorRole: RoleRow;
  messageId: string;
  emit: EmitFn;
}

export interface ApplyResult {
  taskIds: string[];
  artifactIds: string[];
  decisionIds: string[];
  approvalIds: string[];
  memoryIds: string[];
  handoffTo: string | null;
  askedUser: boolean;
  blocked: boolean;
  notes: string[];
}

const now = () => new Date();

/** Phase transitions are internal; only product decisions/approvals notify the client. */
function orderedActions(actions: ValidatedAgentAction[]): ValidatedAgentAction[] {
  const rank: Record<string, number> = {
    publish_plan: 0,
    create_artifact: 1,
    create_task: 2,
    update_task: 3,
  };
  return [...actions].sort(
    (a, b) => (rank[a.type] ?? 9) - (rank[b.type] ?? 9),
  );
}

function normalizeTaskTitle(value: string): string {
  return value
    // Models often append the mention to the title: "... @backend".
    .replace(/@[a-z][a-z0-9_-]*/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Resolve a task reference from an action. Exact id wins; exact title is next;
 * then a normalized title (mentions/whitespace stripped). This keeps a model's
 * harmless " @backend" suffix from turning a real cancellation into a no-op.
 */
async function resolveTaskRef(
  projectId: string,
  ref: { taskId?: string; taskTitle?: string },
): Promise<{ task?: typeof tasks.$inferSelect; ambiguous?: boolean }> {
  const db = getDb();
  if (ref.taskId) {
    const [row] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), eq(tasks.id, ref.taskId)))
      .limit(1);
    return { task: row };
  }
  const raw = (ref.taskTitle ?? "").trim();
  if (!raw) return {};
  const rows = await db.select().from(tasks).where(eq(tasks.projectId, projectId));
  const exact = rows.filter((row) => row.title === raw);
  if (exact.length === 1) return { task: exact[0] };
  const target = normalizeTaskTitle(raw);
  if (!target) return {};
  const normalized = rows.filter((row) => normalizeTaskTitle(row.title) === target);
  if (normalized.length === 1) return { task: normalized[0] };
  if (normalized.length > 1) {
    // Prefer an open task; a closed one with the same title is historical.
    const open = normalized.filter((row) => !["done", "cancelled"].includes(row.status));
    if (open.length === 1) return { task: open[0] };
    return { ambiguous: true };
  }
  // Tolerate a truncated title (agents sometimes cut long titles).
  const partial = rows.filter((row) => {
    const candidate = normalizeTaskTitle(row.title);
    return (
      candidate.length >= 8 &&
      target.length >= 8 &&
      (candidate.startsWith(target) || target.startsWith(candidate))
    );
  });
  if (partial.length === 1) return { task: partial[0] };
  if (partial.length > 1) {
    const open = partial.filter((row) => !["done", "cancelled"].includes(row.status));
    if (open.length === 1) return { task: open[0] };
    return { ambiguous: true };
  }
  return {};
}

export async function applyActions(
  actions: ValidatedAgentAction[],
  ctx: ApplyContext,
): Promise<ApplyResult> {
  const db = getDb();
  const result: ApplyResult = {
    taskIds: [],
    artifactIds: [],
    decisionIds: [],
    approvalIds: [],
    memoryIds: [],
    handoffTo: null,
    askedUser: false,
    blocked: false,
    notes: [],
  };

  async function proposePhase(target: WorkflowPhase, reason: string, source: string) {
    // Phase control belongs to the Lead (stage owners own content, not the
    // lifecycle switch). Other roles must raise a finding/task or ask Lead.
    if (ctx.actorRole.key !== "lead") {
      result.notes.push(`${source} ignored: only Lead controls stage transitions`);
      return;
    }
    const from = ctx.bundle.project.phase as WorkflowPhase;
    if (!canTransitionPhase(from, target)) {
      result.notes.push(
        `${source} ignored: ${from} -> ${target} is not a legal agile transition`,
      );
      return;
    }
    const gateCtx = {
      artifacts: ctx.bundle.artifacts.map((x) => ({
        kind: x.kind,
        status: x.status,
        title: x.title,
        updatedAt: x.updatedAt,
        acceptanceRefs: x.acceptanceRefs,
        commit: x.commit,
      })),
      tasks: ctx.bundle.tasks.map((x) => ({
        status: x.status,
        mode: x.mode,
        acceptanceRefs: x.acceptanceRefs,
        gateKey: x.gateKey,
        iterationId: x.iterationId,
      })),
      approvals: ctx.bundle.approvals.map((x) => ({ targetType: x.targetType, status: x.status })),
      phaseEnteredAt: ctx.bundle.project.phaseEnteredAt,
      acceptanceIds: ctx.bundle.acceptanceIds,
      iterationId: ctx.bundle.currentIteration?.id ?? null,
      targetCommit: ctx.bundle.currentIteration?.targetCommit ?? null,
    };
    const requirements = gateRequirementsForTransition(from, target, gateCtx);
    if (!requirements.every((r) => r.met)) {
      const missing = requirements.filter((r) => !r.met).map((r) => r.label).join("、");
      result.notes.push(`${source} ignored: phase gate not met (${missing})`);
      return;
    }

    const nextVersion = ctx.bundle.project.version + 1;
    const id = uuidv7();
    const title = `进入「${PHASE_LABELS[target]}」阶段`;
    const proposalReason = reason.trim() || "AI 判断当前阶段可以继续推进。";
    await db
      .update(projects)
      .set({
        phase: target,
        phaseEnteredAt: new Date(),
        updatedAt: new Date(),
        version: nextVersion,
      })
      .where(eq(projects.id, ctx.bundle.project.id));
    if (ctx.bundle.currentIteration) {
      await db
        .update(iterations)
        .set({
          status:
            target === "coding"
              ? "active"
              : target === "operations"
                ? "released"
                : undefined,
          updatedAt: new Date(),
        })
        .where(eq(iterations.id, ctx.bundle.currentIteration.id));
    }
    ctx.bundle.project.phase = target;
    ctx.bundle.project.version = nextVersion;

    // Keep an approved approval row as the audit trail, but do not surface a
    // client popup for a process transition.
    await db.insert(approvals).values({
      id,
      projectId: ctx.bundle.project.id,
      targetType: `phase_transition:${target}`,
      targetId: ctx.bundle.project.id,
      targetVersion: nextVersion,
      title,
      status: "approved",
      requestedBy: ctx.actorRole.key,
      decidedBy: "Fucking Code 内部评审",
      decidedAt: new Date(),
      reason: proposalReason,
    });
    result.approvalIds.push(id);
    await ctx.emit(EVENT_TYPES.phaseChanged, {
      from,
      to: target,
      by: ctx.actorRole.key,
      internal: true,
    });
    await ctx.emit(EVENT_TYPES.approvalChanged, {
      approvalId: id,
      action: "approved",
      title,
      targetType: `phase_transition:${target}`,
      internal: true,
    });
    result.notes.push(`phase changed internally: ${from} -> ${target}`);
  }

  for (const action of orderedActions(actions)) {
    try {
      switch (action.type) {
        case "create_task": {
          const phase = ctx.bundle.project.phase;
          if (phase === "requirements") {
            result.notes.push(
              `create_task ignored: task planning belongs to design/coding, not requirements (current: ${phase})`,
            );
            break;
          }
          const a = action as CreateTaskAction;
          const acceptanceRefs = (a.acceptanceRefs ?? [])
            .map(normalizeAcceptanceId)
            .filter((id): id is string => Boolean(id));
          if (a.mode !== "workbench" && !acceptanceRefs.length && !a.gateKey) {
            result.notes.push(
              `create_task rejected: code task must reference at least one AC (acceptanceRefs) or a gateKey: ${a.title}`,
            );
            break;
          }
          const spec = await captureAcceptedSpec(ctx.bundle.project.id);
          if (!spec) {
            result.notes.push(
              "create_task ignored: the current PRD and acceptance criteria are not accepted",
            );
            break;
          }
          const existing = await db
            .select({ id: tasks.id })
            .from(tasks)
            .where(and(eq(tasks.projectId, ctx.bundle.project.id), eq(tasks.title, a.title), ne(tasks.status, "cancelled")))
            .limit(1);
          if (existing.length) {
            result.notes.push(`task already exists: ${a.title}`);
            break;
          }
          const id = uuidv7();
          await db.insert(tasks).values({
            id,
            projectId: ctx.bundle.project.id,
            title: a.title,
            description: a.description,
            status: "proposed",
            mode: a.mode ?? "code",
            priority: a.priority,
            roleKey: a.role ?? null,
            iterationId: ctx.bundle.currentIteration?.id ?? null,
            acceptanceRefs,
            gateKey: a.gateKey ?? null,
            createdFromMessageId: ctx.messageId,
            requirementVersion: spec.prd.version,
            spec: spec as unknown as Record<string, unknown>,
            acceptance: a.acceptance,
            updatedAt: now(),
          });
          result.taskIds.push(id);
          await ctx.emit(EVENT_TYPES.taskChanged, {
            taskId: id,
            action: "created",
            title: a.title,
            status: "proposed",
          });
          break;
        }

        case "update_task": {
          const a = action as UpdateTaskAction;
          if (!a.taskId && !a.taskTitle) {
            result.notes.push("update_task requires taskId or taskTitle");
            break;
          }
          const resolved = await resolveTaskRef(ctx.bundle.project.id, {
            taskId: a.taskId,
            taskTitle: a.taskTitle,
          });
          const task = resolved.task;
          if (!task) {
            result.notes.push(
              resolved.ambiguous
                ? `task title is ambiguous, pass taskId: ${a.taskTitle}`
                : `task not found: ${a.taskId ?? a.taskTitle}`,
            );
            break;
          }
          if (a.status === "in_progress") {
            result.notes.push(
              "update_task rejected: in_progress is set by the work runner; set ready to queue the task",
            );
            break;
          }
          if (a.status) assertTaskTransition(task.status as TaskStatus, a.status as TaskStatus);
          await db
            .update(tasks)
            .set({
              status: a.status ?? task.status,
              roleKey: a.roleKey ?? task.roleKey,
              acceptanceRefs:
                a.acceptanceRefs === undefined
                  ? task.acceptanceRefs
                  : a.acceptanceRefs
                      .map(normalizeAcceptanceId)
                      .filter((id): id is string => Boolean(id)),
              gateKey: a.gateKey === undefined ? task.gateKey : a.gateKey,
              blockedReason: a.blockedReason ?? (a.status === "blocked" ? task.blockedReason : null),
              evidence: a.evidence
                ? { ...task.evidence, note: a.evidence, at: new Date().toISOString() }
                : task.evidence,
              updatedAt: now(),
            })
            .where(eq(tasks.id, task.id));
          result.taskIds.push(task.id);
          await ctx.emit(EVENT_TYPES.taskChanged, {
            taskId: task.id,
            action: "updated",
            status: a.status ?? task.status,
          });
          break;
        }

        case "create_artifact": {
          const a = action as CreateArtifactAction;
          const artifactKey = canonicalArtifactKey(a.kind, a.title);
          const byKey = await db
            .select()
            .from(artifacts)
            .where(
              and(
                eq(artifacts.projectId, ctx.bundle.project.id),
                eq(artifacts.kind, a.kind),
                eq(artifacts.artifactKey, artifactKey),
              ),
            )
            .orderBy(desc(artifacts.updatedAt))
            .limit(1);
          const byTitle = byKey[0]
            ? []
            : await db
                .select()
                .from(artifacts)
                .where(
                  and(
                    eq(artifacts.projectId, ctx.bundle.project.id),
                    eq(artifacts.kind, a.kind),
                    eq(artifacts.title, a.title),
                  ),
                )
                .limit(1);
          const existing = byKey[0] ?? byTitle[0];
          if (existing) {
            const version = existing.currentVersion + 1;
            await db.insert(artifactVersions).values({
              id: uuidv7(),
              artifactId: existing.id,
              version,
              content: a.content,
              summary: a.summary,
              sourceMessageId: ctx.messageId,
              createdBy: ctx.actorRole.key,
            });
            await db
              .update(artifacts)
              .set({
                artifactKey,
                title: a.title,
                currentVersion: version,
                status: initialArtifactStatus(a.kind),
                iterationId: ctx.bundle.currentIteration?.id ?? null,
                acceptanceRefs: (a.acceptanceRefs ?? [])
                  .map(normalizeAcceptanceId)
                  .filter((id): id is string => Boolean(id)),
                commit: a.commit ?? null,
                updatedAt: now(),
              })
              .where(eq(artifacts.id, existing.id));
            result.artifactIds.push(existing.id);
            await ctx.emit(EVENT_TYPES.artifactChanged, {
              artifactId: existing.id,
              artifactKey,
              action: "version_created",
              version,
              kind: existing.kind,
              title: a.title,
            });
          } else {
            const id = uuidv7();
            await db.insert(artifacts).values({
              id,
              projectId: ctx.bundle.project.id,
              kind: a.kind,
              artifactKey,
              title: a.title,
              status: initialArtifactStatus(a.kind),
              currentVersion: 1,
              iterationId: ctx.bundle.currentIteration?.id ?? null,
              acceptanceRefs: (a.acceptanceRefs ?? [])
                .map(normalizeAcceptanceId)
                .filter((id): id is string => Boolean(id)),
              commit: a.commit ?? null,
              createdByType: "agent",
              createdById: ctx.actorRole.id,
              updatedAt: now(),
            });
            await db.insert(artifactVersions).values({
              id: uuidv7(),
              artifactId: id,
              version: 1,
              content: a.content,
              summary: a.summary,
              sourceMessageId: ctx.messageId,
              createdBy: ctx.actorRole.key,
            });
            result.artifactIds.push(id);
            await ctx.emit(EVENT_TYPES.artifactChanged, {
              artifactId: id,
              artifactKey,
              action: "created",
              version: 1,
              kind: a.kind,
              title: a.title,
            });
          }
          // A new PRD/acceptance revision is a scope change. If it arrives
          // after planning, go back to design and invalidate the old plan;
          // otherwise the team enters coding with no tasks for the new scope.
          if (a.kind === "prd" || a.kind === "acceptance_criteria") {
            const [fresh] = await db
              .select({ phase: projects.phase, version: projects.version })
              .from(projects)
              .where(eq(projects.id, ctx.bundle.project.id))
              .limit(1);
            if (
              fresh &&
              ["coding", "testing", "deployment", "operations"].includes(fresh.phase)
            ) {
              // A changed PRD/AC opens a fresh planning iteration. The plan
              // publisher fills scope/tasks; until then the phase is design.
              let [planningIteration] = await db
                .select()
                .from(iterations)
                .where(
                  and(
                    eq(iterations.projectId, ctx.bundle.project.id),
                    eq(iterations.status, "planning"),
                  ),
                )
                .limit(1);
              if (!planningIteration) {
                const iterationId = uuidv7();
                [planningIteration] = await db
                  .insert(iterations)
                  .values({
                    id: iterationId,
                    tenantId: ctx.bundle.project.tenantId,
                    projectId: ctx.bundle.project.id,
                    name: `next-${Date.now()}`,
                    status: "planning",
                    baseCommit: ctx.bundle.project.baseCommit,
                    scope: [],
                  })
                  .returning();
              }
              await db
                .update(projects)
                .set({
                  phase: "design",
                  phaseEnteredAt: now(),
                  currentIterationId: planningIteration?.id ?? null,
                  updatedAt: now(),
                  version: fresh.version + 1,
                })
                .where(eq(projects.id, ctx.bundle.project.id));
              await ctx.emit(EVENT_TYPES.phaseChanged, {
                from: fresh.phase,
                to: "design",
                by: ctx.actorRole.key,
                reason: "spec_change_replan",
                artifactKind: a.kind,
              });
              const messageId = uuidv7();
              await insertMessage({
                id: messageId,
                tenantId: ctx.bundle.project.tenantId,
                projectId: ctx.bundle.project.id,
                roomId: ctx.bundle.room.id,
                senderType: "system",
                senderName: "系统",
                type: "system_event",
                content: `检测到 ${a.kind} 变更：「${a.title}」。项目已自动回到 design 重新规划；旧 plan/design 不再满足门禁，必须先产出覆盖新范围的新计划，才能回到 coding。`,
                metadata: {
                  kind: "spec_change_replan",
                  from: fresh.phase,
                  artifactKind: a.kind,
                },
              });
              await ctx.emit(EVENT_TYPES.messageCreated, {
                messageId,
                roomId: ctx.bundle.room.id,
                senderType: "system",
                senderName: "系统",
                type: "system_event",
              });
              result.notes.push(
                `phase reset to design: ${a.kind} changed scope during ${fresh.phase}`,
              );
            }
          }
          break;
        }

        case "publish_plan": {
          const a = action as PublishPlanAction;
          const scope = [...new Set(a.scope.map(normalizeAcceptanceId).filter((id): id is string => Boolean(id)))];
          if (!scope.length) {
            result.notes.push("publish_plan rejected: scope contains no valid AC IDs");
            break;
          }
          const planRefs = a.tasks.flatMap((task) =>
            (task.acceptanceRefs ?? []).map(normalizeAcceptanceId).filter((id): id is string => Boolean(id)),
          );
          const missing = missingAcceptanceCoverage(
            scope,
            a.tasks.map((task) => ({
              status: "proposed",
              acceptanceRefs: task.acceptanceRefs ?? [],
            })),
          );
          if (missing.length) {
            result.notes.push(
              `publish_plan rejected: ACs without tasks: ${missing.join(", ")}`,
            );
            break;
          }
          const [current] = await db
            .select()
            .from(projects)
            .where(eq(projects.id, ctx.bundle.project.id))
            .limit(1);
          const [currentIteration] = current?.currentIterationId
            ? await db
                .select()
                .from(iterations)
                .where(eq(iterations.id, current.currentIterationId))
                .limit(1)
            : [];
          const [byName] = await db
            .select()
            .from(iterations)
            .where(
              and(
                eq(iterations.projectId, ctx.bundle.project.id),
                eq(iterations.name, a.name),
              ),
            )
            .limit(1);
          const existing =
            currentIteration && currentIteration.status === "planning"
              ? currentIteration
              : byName;
          const iterationId = existing?.id ?? uuidv7();
          if (existing) {
            await db
              .update(iterations)
              .set({
                name: a.name,
                baseCommit: a.baseCommit ?? existing.baseCommit,
                targetCommit: a.targetCommit ?? existing.targetCommit,
                scope,
                status: "planning",
                updatedAt: now(),
              })
              .where(eq(iterations.id, iterationId));
          } else {
            await db.insert(iterations).values({
              id: iterationId,
              tenantId: ctx.bundle.project.tenantId,
              projectId: ctx.bundle.project.id,
              name: a.name,
              status: "planning",
              baseCommit: a.baseCommit ?? null,
              targetCommit: a.targetCommit ?? null,
              scope,
            });
          }
          const currentTasks = await db
            .select()
            .from(tasks)
            .where(eq(tasks.projectId, ctx.bundle.project.id));
          const byTitle = new Map(currentTasks.map((task) => [task.title, task]));
          const byId = new Map(currentTasks.map((task) => [task.id, task]));
          const created: Array<{ id: string; title: string }> = [];
          for (const spec of a.tasks) {
            const acceptanceRefs = (spec.acceptanceRefs ?? [])
              .map(normalizeAcceptanceId)
              .filter((id): id is string => Boolean(id));
            const existingTask = spec.taskId
              ? byId.get(spec.taskId)
              : byTitle.get(spec.title);
            if (existingTask) {
              // Adopt a legacy/ad-hoc task into this iteration instead of
              // creating a duplicate with the same title.
              if (!existingTask.iterationId || existingTask.iterationId === iterationId) {
                await db
                  .update(tasks)
                  .set({
                    iterationId,
                    acceptanceRefs,
                    gateKey: spec.gateKey ?? null,
                    roleKey: spec.role,
                    mode: spec.mode,
                    priority: spec.priority,
                    updatedAt: now(),
                  })
                  .where(eq(tasks.id, existingTask.id));
              }
              created.push({ id: existingTask.id, title: existingTask.title });
              continue;
            }
            const id = uuidv7();
            await db.insert(tasks).values({
              id,
              projectId: ctx.bundle.project.id,
              title: spec.title,
              description: spec.description,
              status: "proposed",
              mode: spec.mode,
              priority: spec.priority,
              roleKey: spec.role,
              iterationId,
              acceptanceRefs,
              gateKey: spec.gateKey ?? null,
              createdFromMessageId: ctx.messageId,
              requirementVersion: 1,
              acceptance: spec.acceptance,
              updatedAt: now(),
            });
            created.push({ id, title: spec.title });
          }
          // Dependencies by title, after all tasks exist.
          for (const spec of a.tasks) {
            const task = created.find((row) => row.title === spec.title);
            if (!task) continue;
            for (const depTitle of spec.dependsOn ?? []) {
              const dep = created.find((row) => row.title === depTitle);
              if (!dep || dep.id === task.id) continue;
              await db
                .insert(taskDependencies)
                .values({ taskId: task.id, dependsOnTaskId: dep.id })
                .onConflictDoNothing();
            }
          }
          const [projectRow] = await db
            .select()
            .from(projects)
            .where(eq(projects.id, ctx.bundle.project.id))
            .limit(1);
          if (projectRow) {
            await db
              .update(projects)
              .set({
                currentIterationId: iterationId,
                phase: ["coding", "testing", "deployment", "operations"].includes(
                  projectRow.phase,
                )
                  ? "design"
                  : projectRow.phase,
                phaseEnteredAt: ["coding", "testing", "deployment", "operations"].includes(
                  projectRow.phase,
                )
                  ? now()
                  : projectRow.phaseEnteredAt,
                updatedAt: now(),
                version: projectRow.version + 1,
              })
              .where(eq(projects.id, projectRow.id));
          }
          result.taskIds.push(...created.map((row) => row.id));
          await ctx.emit(EVENT_TYPES.taskChanged, {
            action: "plan_published",
            iterationId,
            scope,
            taskCount: created.length,
          });
          result.notes.push(
            `plan published: ${a.name}, ${created.length} tasks, ${scope.length} ACs`,
          );
          break;
        }

        case "propose_decision": {
          const a = action as ProposeDecisionAction;
          const existing = await db
            .select({ id: decisions.id })
            .from(decisions)
            .where(and(eq(decisions.projectId, ctx.bundle.project.id), eq(decisions.title, a.title)))
            .limit(1);
          if (existing.length) {
            result.notes.push(`decision already exists: ${a.title}`);
            break;
          }
          // Engineering choices are team-internal. Do not put them in front of
          // the client and do not pause auto development for them.
          const internal = isEngineeringTopic(`${a.title} ${a.rationale}`);
          const id = uuidv7();
          await db.insert(decisions).values({
            id,
            projectId: ctx.bundle.project.id,
            title: a.title,
            status: internal ? "accepted" : "proposed",
            rationale: a.rationale,
            alternatives: a.alternatives,
            proposedBy: ctx.actorRole.key,
            decidedBy: internal ? "Fucking Code 内部" : null,
            decidedAt: internal ? new Date() : null,
            sourceMessageId: ctx.messageId,
          });
          result.decisionIds.push(id);
          await ctx.emit(EVENT_TYPES.decisionChanged, {
            decisionId: id,
            action: internal ? "accepted" : "proposed",
            title: a.title,
            internal,
          });
          if (internal) {
            result.notes.push(`engineering decision auto-accepted internally: ${a.title}`);
          }
          break;
        }

        case "request_approval": {
          const a = action as RequestApprovalAction;
          const existing = await db
            .select({ id: approvals.id })
            .from(approvals)
            .where(
              and(
                eq(approvals.projectId, ctx.bundle.project.id),
                eq(approvals.targetType, a.targetType),
                eq(approvals.title, a.title),
                eq(approvals.status, "pending"),
              ),
            )
            .limit(1);
          if (existing.length) {
            result.notes.push(`approval already pending: ${a.title}`);
            break;
          }
          // Only product approvals belong to the client. Phase review, delivery,
          // merge and other engineering gates are internal.
          const clientFacing = /^product/i.test(a.targetType);
          const id = uuidv7();
          await db.insert(approvals).values({
            id,
            projectId: ctx.bundle.project.id,
            targetType: a.targetType,
            targetId: a.targetId ?? null,
            targetVersion: ctx.bundle.project.version,
            title: a.title,
            status: clientFacing ? "pending" : "approved",
            requestedBy: ctx.actorRole.key,
            decidedBy: clientFacing ? null : "Fucking Code 内部",
            decidedAt: clientFacing ? null : new Date(),
            reason: a.reason,
          });
          result.approvalIds.push(id);
          await ctx.emit(EVENT_TYPES.approvalChanged, {
            approvalId: id,
            action: clientFacing ? "requested" : "approved",
            title: a.title,
            targetType: a.targetType,
            internal: !clientFacing,
          });
          if (!clientFacing) {
            result.notes.push(`engineering approval auto-approved internally: ${a.title}`);
          }
          break;
        }

        case "remember": {
          const a = action as RememberAction;
          const existing = await db
            .select()
            .from(memories)
            .where(and(eq(memories.projectId, ctx.bundle.project.id), eq(memories.title, a.title)))
            .limit(1);
          if (existing[0]) {
            await db
              .update(memories)
              .set({
                content: a.content,
                status: "proposed",
                version: existing[0].version + 1,
                updatedAt: new Date(),
              })
              .where(eq(memories.id, existing[0].id));
            result.notes.push(`memory updated: ${a.title}`);
            await ctx.emit("memory.changed", {
              memoryId: existing[0].id,
              action: "merged",
              title: a.title,
            });
            break;
          }
          const id = uuidv7();
          await db.insert(memories).values({
            id,
            projectId: ctx.bundle.project.id,
            type: a.kind,
            title: a.title,
            content: a.content,
            status: "proposed",
            sourceMessageIds: [ctx.messageId],
          });
          result.memoryIds.push(id);
          await ctx.emit("memory.changed", {
            memoryId: id,
            action: "proposed",
            title: a.title,
          });
          break;
        }

        case "request_phase": {
          const a = action as RequestPhaseAction;
          await proposePhase(a.phase as WorkflowPhase, a.reason, "request_phase");
          break;
        }

        case "set_phase": {
          const a = action as SetPhaseAction;
          // Older prompts emitted set_phase. Treat it as an internal phase
          // request; gates are still checked above.
          await proposePhase(
            a.phase as WorkflowPhase,
            a.reason ?? "AI 建议推进到下一阶段。",
            "set_phase (legacy)",
          );
          break;
        }

        case "handoff": {
          const a = action as HandoffAction;
          if (a.to !== ctx.actorRole.key) result.handoffTo = a.to;
          break;
        }

        case "ask_user": {
          const a = action as AskUserAction;
          if (isEngineeringTopic(a.question)) {
            result.notes.push(
              "ask_user ignored: engineering detail belongs to the team; decide internally or create a workbench task",
            );
            break;
          }
          result.askedUser = true;
          result.notes.push(`question: ${a.question}`);
          break;
        }

        case "block": {
          const a = action as BlockAction;
          result.blocked = true;
          result.notes.push(`blocked: ${a.reason}`);
          break;
        }

        default:
          result.notes.push(`unsupported action: ${(action as { type?: string }).type ?? "unknown"}`);
      }
    } catch (error) {
      result.notes.push(
        `action ${action.type} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return result;
}
