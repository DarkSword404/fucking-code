import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type {
  Artifact,
  ArtifactVersion,
  Decision,
  Message,
  Project,
  Room,
} from "@devteam/contracts";
import { getDb } from "./client.js";
import {
  agentRoles,
  agentRuns,
  approvals,
  artifacts,
  artifactVersions,
  decisions,
  events,
  memories,
  messages,
  projectMembers,
  projects,
  rooms,
  tasks,
  users,
} from "./schema.js";

export type MessageInsert = typeof messages.$inferInsert;
export type EventRow = typeof events.$inferSelect;

export async function emitEvent(input: {
  tenantId: string;
  projectId: string;
  type: string;
  payload: Record<string, unknown>;
}): Promise<EventRow> {
  const db = getDb();
  const [row] = await db.insert(events).values(input).returning();
  if (!row) throw new Error("failed to persist event");
  return row;
}

export async function insertMessage(input: MessageInsert) {
  const db = getDb();
  const [row] = await db.insert(messages).values(input).returning();
  if (!row) throw new Error("failed to persist message");
  return row;
}

export async function listProjectsForUser(userId: string) {
  const db = getDb();
  return db
    .select({ project: projects, role: projectMembers.role })
    .from(projectMembers)
    .innerJoin(projects, eq(projectMembers.projectId, projects.id))
    .where(eq(projectMembers.userId, userId))
    .orderBy(desc(projects.updatedAt));
}

export async function findProjectForUser(projectId: string, userId: string) {
  const db = getDb();
  const rows = await db
    .select({ project: projects, role: projectMembers.role })
    .from(projectMembers)
    .innerJoin(projects, eq(projectMembers.projectId, projects.id))
    .where(and(eq(projects.id, projectId), eq(projectMembers.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function mainRoom(projectId: string) {
  const db = getDb();
  const rows = await db
    .select()
    .from(rooms)
    .where(and(eq(rooms.projectId, projectId), eq(rooms.kind, "main")))
    .limit(1);
  return rows[0] ?? null;
}

export interface RoomBundle {
  project: typeof projects.$inferSelect;
  room: typeof rooms.$inferSelect;
  roles: Array<typeof agentRoles.$inferSelect>;
  messages: Array<typeof messages.$inferSelect>;
  tasks: Array<typeof tasks.$inferSelect>;
  artifacts: Array<typeof artifacts.$inferSelect>;
  versions: Array<typeof artifactVersions.$inferSelect>;
  decisions: Array<typeof decisions.$inferSelect>;
  approvals: Array<typeof approvals.$inferSelect>;
  memories: Array<typeof memories.$inferSelect>;
}

const visibleMessage = sql`coalesce(${messages.metadata}->>'kind', '') NOT IN ('gate_waiting', 'ops_heartbeat')`;

export async function loadRoomBundle(
  projectId: string,
  roomId: string,
  messageLimit = 30,
): Promise<RoomBundle | null> {
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) return null;
  const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
  if (!room || room.projectId !== projectId) return null;

  const [roles, recent, taskRows, artifactRows, decisionRows, approvalRows, memoryRows] = await Promise.all([
    db.select().from(agentRoles).where(eq(agentRoles.projectId, projectId)).orderBy(agentRoles.sortOrder),
    db
      .select()
      .from(messages)
      .where(and(eq(messages.roomId, roomId), visibleMessage))
      .orderBy(desc(messages.seq))
      .limit(messageLimit),
    db.select().from(tasks).where(eq(tasks.projectId, projectId)).orderBy(desc(tasks.updatedAt)),
    db.select().from(artifacts).where(eq(artifacts.projectId, projectId)).orderBy(desc(artifacts.updatedAt)),
    db.select().from(decisions).where(eq(decisions.projectId, projectId)).orderBy(desc(decisions.createdAt)),
    db.select().from(approvals).where(eq(approvals.projectId, projectId)).orderBy(desc(approvals.createdAt)),
    db
      .select()
      .from(memories)
      .where(and(eq(memories.projectId, projectId), eq(memories.status, "accepted")))
      .orderBy(desc(memories.updatedAt))
      .limit(20),
  ]);

  const artifactIds = artifactRows.map((a) => a.id);
  const versionRows = artifactIds.length
    ? await db
        .select()
        .from(artifactVersions)
        .where(inArray(artifactVersions.artifactId, artifactIds))
        .orderBy(desc(artifactVersions.version))
    : [];

  return {
    project,
    room,
    roles,
    messages: recent.reverse(),
    tasks: taskRows,
    artifacts: artifactRows,
    versions: versionRows,
    decisions: decisionRows,
    approvals: approvalRows,
    memories: memoryRows,
  };
}

export async function latestArtifactContent(artifactId: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(artifactVersions)
    .where(eq(artifactVersions.artifactId, artifactId))
    .orderBy(desc(artifactVersions.version))
    .limit(1);
  return row ?? null;
}

export async function messagePage(roomId: string, cursor: number | null, limit = 40) {
  const db = getDb();
  // Idle notices and healthy heartbeats are diagnostic events, not
  // conversation. Keeping them in the page window would push real discussion
  // out and leave the chat looking empty.
  const scope = cursor
    ? and(eq(messages.roomId, roomId), sql`${messages.seq} < ${cursor}`, visibleMessage)
    : and(eq(messages.roomId, roomId), visibleMessage);
  const rows = await db
    .select()
    .from(messages)
    .where(scope)
    .orderBy(desc(messages.seq))
    .limit(limit);
  return rows.reverse();
}

export type ProjectRow = typeof projects.$inferSelect;
export type RoomRow = typeof rooms.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type ArtifactRow = typeof artifacts.$inferSelect;
export type ArtifactVersionRow = typeof artifactVersions.$inferSelect;
export type DecisionRow = typeof decisions.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;
export type RoleRow = typeof agentRoles.$inferSelect;
export type RunRow = typeof agentRuns.$inferSelect;
export type UserRow = typeof users.$inferSelect;

export type { Project, Room, Message, Artifact, ArtifactVersion, Decision };
