import { DEFAULT_ROLES } from "@devteam/domain";
import { getClient } from "./client.js";

export const DEV_IDS = {
  tenant: "01900000-0000-7000-8000-000000000001",
  user: "01900000-0000-7000-8000-000000000002",
  project: "01900000-0000-7000-8000-000000000003",
  room: "01900000-0000-7000-8000-000000000004",
  leadRole: "01900000-0000-7000-8000-000000000101",
  welcomeMessage: "01900000-0000-7000-8000-000000000201",
} as const;

const ROLE_ID_BASE = 0x101;

function roleId(index: number): string {
  const suffix = (ROLE_ID_BASE + index).toString(16).padStart(12, "0");
  return `01900000-0000-7000-8000-${suffix}`;
}

/**
 * Idempotent local bootstrap: one tenant, one human, one demo project, one
 * room, the default team, and an opening message from the Lead.
 */
export async function seed(): Promise<void> {
  const c = getClient();

  await c.query(
    `INSERT INTO tenants (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
    [DEV_IDS.tenant, "Local Workspace"],
  );

  await c.query(
    `INSERT INTO users (id, tenant_id, email, display_name)
     VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
    [DEV_IDS.user, DEV_IDS.tenant, "dev@local", "开发者"],
  );

  // Keep the local seed account login-compatible after email validation was
  // added to the auth flow. The user id never changes.
  await c.query(
    `UPDATE users SET email = 'dev@local.test' WHERE id = $1 AND email = 'dev@local'`,
    [DEV_IDS.user],
  );
  await c.query(
    `UPDATE users SET is_admin = TRUE, is_active = TRUE WHERE id = $1`,
    [DEV_IDS.user],
  );

  await c.query(
    `INSERT INTO projects
       (id, tenant_id, name, slug, description, phase, status, default_branch)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO NOTHING`,
    [
      DEV_IDS.project,
      DEV_IDS.tenant,
      "Acme Notes（示例项目）",
      "acme-notes",
      "一个轻量的 Markdown 笔记应用：支持笔记的创建、编辑、标签和全文搜索。这是用来体验团队协作流程的示例项目，你可以直接改需求，或新建自己的项目。",
      "intake",
      "active",
      "main",
    ],
  );

  await c.query(
    `INSERT INTO project_members (project_id, user_id, role)
     VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`,
    [DEV_IDS.project, DEV_IDS.user],
  );

  await c.query(
    `INSERT INTO rooms (id, project_id, name, kind)
     VALUES ($1, $2, $3, 'main') ON CONFLICT (id) DO NOTHING`,
    [DEV_IDS.room, DEV_IDS.project, "团队聊天室"],
  );

  for (const [index, role] of DEFAULT_ROLES.entries()) {
    await c.query(
      `INSERT INTO agent_roles
         (id, project_id, key, display_name, description, system_prompt, color, capabilities, sort_order, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, TRUE)
       ON CONFLICT (project_id, key) DO NOTHING`,
      [
        roleId(index),
        DEV_IDS.project,
        role.key,
        role.displayName,
        role.description,
        role.systemPrompt,
        role.color,
        JSON.stringify(role.capabilities),
        role.sortOrder,
      ],
    );
  }

  const count = await c.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM messages WHERE room_id = $1`,
    [DEV_IDS.room],
  );
  if ((count.rows[0]?.n ?? 0) === 0) {
    await c.query(
      `INSERT INTO messages
         (id, tenant_id, project_id, room_id, sender_type, sender_id, sender_name, type, content, metadata)
       VALUES ($1, $2, $3, $4, 'agent', $5, 'Lead', 'system_event', $6, $7::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [
        DEV_IDS.welcomeMessage,
        DEV_IDS.tenant,
        DEV_IDS.project,
        DEV_IDS.room,
        DEV_IDS.leadRole,
        "团队已就位。我是 Lead，PM、Architect、Frontend、Backend、QA 都在线。\n\n直接说你想要的产品，或者这次要改什么。我们会按「需求 → 设计 → 任务 → 开发 → 测试 → 交付」推进；需要谁发言就 @ 谁。",
        JSON.stringify({ seeded: true }),
      ],
    );
  }
}
