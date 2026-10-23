import { and, eq } from "drizzle-orm";
import { DEFAULT_ROLES, slugify, uuidv7 } from "@devteam/domain";
import {
  agentRoles,
  getDb,
  insertMessage,
  projectMembers,
  projects,
  rooms,
  type ProjectRow,
  type UserRow,
} from "@devteam/db";
import { isDemoMode } from "./demo.js";

const WELCOME = [
  "团队已就位。我是 Lead，PM、Architect、Frontend、Backend、QA 都在线。",
  "",
  "直接说你想要的产品，或者这次要改什么。我们会按「需求 → 设计 → 任务 → 开发 → 测试 → 交付」推进；需要谁发言就 @ 谁。",
].join("\n");

/**
 * Creates a project, its main room, the default team and the opening message.
 * Shared by the API and self-service registration so a new account never lands
 * in an empty, unusable workspace.
 */
export async function createProjectForUser(input: {
  user: UserRow;
  name: string;
  description?: string;
  repoUrl?: string | null;
  repoPath?: string | null;
}): Promise<ProjectRow> {
  const db = getDb();
  let slug = slugify(input.name);
  const clash = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.tenantId, input.user.tenantId), eq(projects.slug, slug)))
    .limit(1);
  if (clash.length) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;

  const projectId = uuidv7();
  const roomId = uuidv7();

  const [project] = await db
    .insert(projects)
    .values({
      id: projectId,
      tenantId: input.user.tenantId,
      name: input.name,
      slug,
      description: input.description ?? "",
      phase: "intake",
      status: "active",
      repoUrl: isDemoMode() ? null : input.repoUrl ?? null,
      repoPath: isDemoMode() ? null : input.repoPath ?? null,
    })
    .returning();
  if (!project) throw new Error("project insert failed");

  await db.insert(projectMembers).values({
    projectId,
    userId: input.user.id,
    role: "owner",
  });

  await db.insert(rooms).values({
    id: roomId,
    projectId,
    name: "团队聊天室",
    kind: "main",
  });

  for (const role of DEFAULT_ROLES) {
    await db.insert(agentRoles).values({
      id: uuidv7(),
      projectId,
      key: role.key,
      displayName: role.displayName,
      description: role.description,
      systemPrompt: role.systemPrompt,
      color: role.color,
      capabilities: role.capabilities,
      sortOrder: role.sortOrder,
      enabled: true,
      inRoom: true,
    });
  }

  const [lead] = await db
    .select()
    .from(agentRoles)
    .where(and(eq(agentRoles.projectId, projectId), eq(agentRoles.key, "lead")))
    .limit(1);

  await insertMessage({
    id: uuidv7(),
    tenantId: input.user.tenantId,
    projectId,
    roomId,
    senderType: "agent",
    senderId: lead?.id ?? null,
    senderName: "Lead",
    type: "system_event",
    content: WELCOME,
    metadata: { seeded: true },
  });

  return project;
}
