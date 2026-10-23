import { and, asc, eq } from "drizzle-orm";
import { Orchestrator } from "@devteam/agents";
import { EVENT_TYPES, type TurnSummary } from "@devteam/contracts";
import {
  getDb,
  insertMessage,
  approvals,
  artifacts,
  decisions,
  messages,
  projects,
  rooms,
  taskDependencies,
  tasks,
  workspaces,
  type ProjectRow,
  type TaskRow,
} from "@devteam/db";
import { uuidv7 } from "@devteam/domain";
import { createWorkspace, runTaskWork, validateRepoPath } from "@devteam/workspace";
import { projectEmitter, roomQueue, runtime, workQueue } from "./orchestration.js";

const schedulerLocks = new Set<string>();
const pausedProjects = new Set<string>();

export async function hasPendingDecisions(projectId: string): Promise<boolean> {
  const db = getDb();
  const [pendingApprovals, pendingArtifacts, proposedDecisions] = await Promise.all([
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
    db
      .select({ id: decisions.id })
      .from(decisions)
      .where(and(eq(decisions.projectId, projectId), eq(decisions.status, "proposed")))
      .limit(1),
  ]);
  return pendingApprovals.length > 0 || pendingArtifacts.length > 0 || proposedDecisions.length > 0;
}

export async function pauseAutoDevelopment(
  projectId: string,
  reason: string,
): Promise<void> {
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project || !project.autoStartTasks) return;
  await db
    .update(projects)
    .set({ autoStartTasks: false, updatedAt: new Date(), version: project.version + 1 })
    .where(eq(projects.id, projectId));
  await projectEmitter(project.tenantId, project.id)(EVENT_TYPES.projectChanged, {
    action: "auto_paused",
    reason,
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
    .set({ autoStartTasks: true, updatedAt: new Date(), version: project.version + 1 })
    .where(eq(projects.id, projectId));
  await projectEmitter(project.tenantId, project.id)(EVENT_TYPES.projectChanged, {
    action: "auto_resumed",
  });
  pausedProjects.delete(projectId);
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
  const content = [
    `任务《${task.title}》执行完成。`,
    `任务状态：${task.status}。`,
    `测试：${testStatus}；规格核对：${verification?.verdict ?? "未执行"}。`,
    "请 QA 做一次简短的验收回馈，Lead 补充下一步；只基于已有证据，只发消息，不要创建产物、任务、审批或决策，不要向甲方提问。",
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
  if (turn?.waitingForUser) pausedProjects.add(project.id);
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
  const workspace = await ensureWorkspace(project, task);
  if (workQueue.isRunning(workspace.id)) return workspace;
  const emit = projectEmitter(project.tenantId, project.id);
  workQueue.enqueue(workspace.id, async (signal) => {
    let waitingForUser = false;
    try {
      await runTaskWork({
        projectId: project.id,
        taskId: task.id,
        workspaceId: workspace.id,
        emit,
        signal,
      });
    } finally {
      try {
        waitingForUser = await postTaskFeedback(project.id, task.id);
      } catch (error) {
        console.error("[auto-dev] task feedback failed", error);
      }
      const [fresh] = await getDb()
        .select({ status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, task.id))
        .limit(1);
      const failed = fresh ? ["failed", "blocked"].includes(fresh.status) : false;
      if (failed) {
        pausedProjects.add(project.id);
        if (options.auto) {
          await getDb()
            .update(projects)
            .set({ autoStartTasks: false, updatedAt: new Date() })
            .where(eq(projects.id, project.id));
          await emit(EVENT_TYPES.projectChanged, {
            action: "auto_paused",
            reason: "task_failed",
          });
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
              content: `自动开发已暂停：任务《${task.title}》${fresh?.status === "blocked" ? "被阻塞" : "失败"}。修正问题并重新开启自动开发后再继续。`,
              metadata: { kind: "auto_paused", taskId: task.id },
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
 * Pick the next ready task in a build-phase project, respecting dependencies
 * and one running workspace per project. The scheduler is intentionally
 * idempotent; the periodic loop and event hooks may both call it.
 */
export async function autoStartNext(projectId: string): Promise<void> {
  if (schedulerLocks.has(projectId) || pausedProjects.has(projectId)) return;
  schedulerLocks.add(projectId);
  try {
    const db = getDb();
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project) return;
    if (project.phase !== "build" || !project.autoStartTasks || !project.repoPath) return;
    if (project.status === "archived") return;
    try {
      await validateRepoPath(project.repoPath);
    } catch {
      return;
    }
    if (await hasPendingDecisions(projectId)) {
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

    const taskRows = await db
      .select()
      .from(tasks)
      .where(eq(tasks.projectId, projectId))
      .orderBy(asc(tasks.createdAt));
    let candidate: TaskRow | undefined;
    for (const task of taskRows) {
      if (task.status !== "ready") continue;
      if (await dependenciesMet(task.id)) {
        candidate = task;
        break;
      }
    }
    if (!candidate) return;

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
    await startTaskForProject(project, candidate, { auto: true });
  } catch (error) {
    console.error("[auto-dev] scheduler failed", error);
  } finally {
    schedulerLocks.delete(projectId);
  }
}

export function resumeAutoDevelopment(projectId: string): void {
  if (!pausedProjects.delete(projectId)) return;
  setTimeout(() => {
    void autoStartNext(projectId);
  }, 1_000);
}

export async function autoStartAll(): Promise<void> {
  const db = getDb();
  const rows = await db.select().from(projects).where(eq(projects.phase, "build"));
  await Promise.all(rows.map((project) => autoStartNext(project.id)));
}

export function startAutoDevelopmentLoop(): void {
  setTimeout(() => {
    void autoStartAll();
  }, 4_000).unref();
  setInterval(() => {
    void autoStartAll();
  }, 20_000).unref();
}
