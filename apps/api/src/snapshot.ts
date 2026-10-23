import { desc, eq, sql } from "drizzle-orm";
import type { ProjectSnapshot, WorkflowPhase } from "@devteam/contracts";
import {
  agentRoles,
  agentRuns,
  events,
  getDb,
  loadRoomBundle,
  mainRoom,
  type ProjectRow,
} from "@devteam/db";
import { canAdvance, gateRequirements, nextPhase } from "@devteam/domain";
import { isDemoMode } from "./demo.js";
import { HttpError } from "./http.js";

export async function roomFor(project: ProjectRow) {
  const room = await mainRoom(project.id);
  if (!room) throw new HttpError(500, "ROOM_MISSING", "Project has no main room.");
  return room;
}

export async function buildSnapshot(project: ProjectRow): Promise<ProjectSnapshot> {
  const room = await roomFor(project);
  const bundle = await loadRoomBundle(project.id, room.id, 0);
  if (!bundle) throw new HttpError(404, "PROJECT_NOT_FOUND", "Project not found.");

  const db = getDb();
  const runRows = await db
    .select({ run: agentRuns, role: agentRoles })
    .from(agentRuns)
    .innerJoin(agentRoles, eq(agentRuns.roleId, agentRoles.id))
    .where(eq(agentRuns.projectId, project.id))
    .orderBy(desc(agentRuns.createdAt))
    .limit(20);

  const gateCtx = {
    artifacts: bundle.artifacts.map((a) => ({ kind: a.kind, status: a.status, title: a.title })),
    tasks: bundle.tasks.map((t) => ({ status: t.status })),
    approvals: bundle.approvals.map((a) => ({ targetType: a.targetType, status: a.status })),
  };

  const [cursorRow] = await db
    .select({ max: sql<number>`coalesce(max(${events.seq}), 0)::int` })
    .from(events)
    .where(eq(events.projectId, project.id));

  return {
    project: (isDemoMode()
      ? { ...bundle.project, repoPath: null, repoUrl: null }
      : bundle.project) as never,
    room: bundle.room as never,
    roles: bundle.roles as never,
    tasks: bundle.tasks as never,
    artifacts: bundle.artifacts as never,
    decisions: bundle.decisions as never,
    approvals: bundle.approvals as never,
    runs: runRows.map((row) => ({
      ...row.run,
      roleKey: row.role.key,
      roleName: row.role.displayName,
    })) as never,
    phaseRequirements: gateRequirements(bundle.project.phase as WorkflowPhase, gateCtx),
    nextPhase: nextPhase(bundle.project.phase as WorkflowPhase),
    canAdvance: canAdvance(bundle.project.phase as WorkflowPhase, gateCtx),
    eventCursor: cursorRow?.max ?? 0,
  };
}
