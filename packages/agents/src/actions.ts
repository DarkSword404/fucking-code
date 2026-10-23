import { and, desc, eq, ne } from "drizzle-orm";
import type { TaskStatus, WorkflowPhase } from "@devteam/contracts";
import { EVENT_TYPES } from "@devteam/contracts";
import {
  getDb,
  artifacts,
  artifactVersions,
  approvals,
  captureAcceptedSpec,
  decisions,
  memories,
  projects,
  tasks,
  type RoomBundle,
  type RoleRow,
} from "@devteam/db";
import {
  assertTaskTransition,
  canAdvance,
  canonicalArtifactKey,
  gateRequirements,
  nextPhase,
  uuidv7,
  type AskUserAction,
  type BlockAction,
  type CreateArtifactAction,
  type CreateTaskAction,
  type HandoffAction,
  type ProposeDecisionAction,
  type RememberAction,
  type RequestApprovalAction,
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

/**
 * Phase changes are applied before other actions so an agent can move the
 * project into planning and create tasks in the same turn. The transition is
 * still validated against the phase gates.
 */
function orderedActions(actions: ValidatedAgentAction[]): ValidatedAgentAction[] {
  return [...actions].sort((a, b) => {
    const weight = (type: string) => (type === "set_phase" ? -1 : 0);
    return weight(a.type) - weight(b.type);
  });
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

  for (const action of orderedActions(actions)) {
    try {
      switch (action.type) {
        case "create_task": {
          const phase = ctx.bundle.project.phase;
          if (["intake", "discovery", "design"].includes(phase)) {
            result.notes.push(
              `create_task ignored: tasks are only allowed from planning onward (current: ${phase})`,
            );
            break;
          }
          const a = action as CreateTaskAction;
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
            status: a.role ? "ready" : "proposed",
            priority: a.priority,
            roleKey: a.role ?? null,
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
            status: a.role ? "ready" : "proposed",
          });
          break;
        }

        case "update_task": {
          const a = action as UpdateTaskAction;
          if (!a.taskId && !a.taskTitle) {
            result.notes.push("update_task requires taskId or taskTitle");
            break;
          }
          const rows = await db
            .select()
            .from(tasks)
            .where(
              and(
                eq(tasks.projectId, ctx.bundle.project.id),
                a.taskId ? eq(tasks.id, a.taskId) : eq(tasks.title, a.taskTitle!),
              ),
            )
            .limit(1);
          const task = rows[0];
          if (!task) {
            result.notes.push(`task not found: ${a.taskId ?? a.taskTitle}`);
            break;
          }
          if (a.status) assertTaskTransition(task.status as TaskStatus, a.status as TaskStatus);
          await db
            .update(tasks)
            .set({
              status: a.status ?? task.status,
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
                status: "in_review",
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
              status: "in_review",
              currentVersion: 1,
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
          const id = uuidv7();
          await db.insert(decisions).values({
            id,
            projectId: ctx.bundle.project.id,
            title: a.title,
            status: "proposed",
            rationale: a.rationale,
            alternatives: a.alternatives,
            proposedBy: ctx.actorRole.key,
            sourceMessageId: ctx.messageId,
          });
          result.decisionIds.push(id);
          await ctx.emit(EVENT_TYPES.decisionChanged, { decisionId: id, action: "proposed", title: a.title });
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
          const id = uuidv7();
          await db.insert(approvals).values({
            id,
            projectId: ctx.bundle.project.id,
            targetType: a.targetType,
            targetId: a.targetId ?? null,
            targetVersion: ctx.bundle.project.version,
            title: a.title,
            status: "pending",
            requestedBy: ctx.actorRole.key,
            reason: a.reason,
          });
          result.approvalIds.push(id);
          await ctx.emit(EVENT_TYPES.approvalChanged, {
            approvalId: id,
            action: "requested",
            title: a.title,
            targetType: a.targetType,
          });
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

        case "set_phase": {
          const a = action as SetPhaseAction;
          const from = ctx.bundle.project.phase as WorkflowPhase;
          const expected = nextPhase(from);
          if (expected !== a.phase) {
            result.notes.push(`phase action ignored: ${from} -> ${a.phase} is not the next legal step`);
            break;
          }
          const gateCtx = {
            artifacts: ctx.bundle.artifacts.map((x) => ({ kind: x.kind, status: x.status, title: x.title })),
            tasks: ctx.bundle.tasks.map((x) => ({ status: x.status })),
            approvals: ctx.bundle.approvals.map((x) => ({ targetType: x.targetType, status: x.status })),
          };
          if (!canAdvance(from, gateCtx)) {
            const missing = gateRequirements(from, gateCtx)
              .filter((r) => !r.met)
              .map((r) => r.label)
              .join("、");
            result.notes.push(`phase action ignored: gate not met (${missing})`);
            break;
          }
          await db
            .update(projects)
            .set({ phase: a.phase, updatedAt: now(), version: ctx.bundle.project.version + 1 })
            .where(eq(projects.id, ctx.bundle.project.id));
          ctx.bundle.project.phase = a.phase;
          await ctx.emit(EVENT_TYPES.phaseChanged, { from, to: a.phase, by: ctx.actorRole.key });
          break;
        }

        case "handoff": {
          const a = action as HandoffAction;
          if (a.to !== ctx.actorRole.key) result.handoffTo = a.to;
          break;
        }

        case "ask_user": {
          const a = action as AskUserAction;
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
