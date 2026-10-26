import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  APPROVAL_STATUSES,
  DECISION_STATUSES,
  EVENT_TYPES,
  PHASE_LABELS,
  PRIORITIES,
  WORKFLOW_PHASES,
  type TaskStatus,
  type WorkflowPhase,
} from "@devteam/contracts";
import { Orchestrator } from "@devteam/agents";
import {
  runCommand,
  runTaskWork,
  commitAndMergeWorkspace,
  createWorkspace,
  listFiles,
  readRepoContext,
  readRepoFile,
  listRepoFiles,
  readWorkspaceFile,
  removeProjectWorkspaceDirectory,
  pushWorkspaceBranch,
  removeWorkspace,
  removeWorkspaceDirectory,
  validateRepoPath,
  verifyTaskWork,
  workspaceDiff,
  writeWorkspaceFile,
} from "@devteam/workspace";
import {
  agentRoles,
  agentRuns,
  approvals,
  artifacts,
  artifactVersions,
  auditEvents,
  captureAcceptedSpec,
  decisions,
  events as eventsTable,
  findProjectForUser,
  getDb,
  insertMessage,
  inviteCodes,
  loadRoomBundle,
  memories,
  messagePage,
  messages,
  projectMembers,
  projects,
  sessions,
  taskDependencies,
  tasks,
  tenants,
  testRuns,
  users,
  workspaces,
  type ProjectRow,
  type UserRow,
} from "@devteam/db";
import {
  canTransitionPhase,
  canTransitionTask,
  gateRequirementsForTransition,
  nextPhase,
  phaseIndex,
  uuidv7,
} from "@devteam/domain";
import { createSession, destroySession, publicUser } from "./auth.js";
import { isDemoMode } from "./demo.js";
import {
  authenticate,
  HttpError,
  jsonError,
  originGuard,
  requestId,
  type AppEnv,
} from "./http.js";
import {
  autoStartNext,
  enableAutoDevelopment,
  hasPendingDecisions,
  ensureProjectRepository,
  nudgePhaseProposal,
  pauseAutoDevelopment,
  resumeAutoDevelopment,
  startTaskForProject,
} from "./auto-dev.js";
import { projectEmitter, roomQueue, runtime, workQueue } from "./orchestration.js";
import { hashPassword, safeEqual, verifyPassword } from "./password.js";
import { joinPresence, leavePresence, listPresence, touchPresence } from "./presence.js";
import { createPullRequest } from "./github.js";
import { createProjectForUser } from "./provision.js";
import { buildSnapshot, roomFor } from "./snapshot.js";

const app = new Hono<AppEnv>();

app.use("*", requestId);
app.use("*", originGuard);
app.use(
  "*",
  cors({
    origin: (origin) => {
      const allowed = (
        process.env.WEB_ORIGIN ??
        "http://127.0.0.1:5174,http://localhost:5174,http://127.0.0.1:5173"
      ).split(",");
      if (!origin) return allowed[0]!;
      return allowed.includes(origin) ? origin : allowed[0]!;
    },
    credentials: true,
    allowHeaders: ["content-type", "authorization", "x-user-id", "x-request-id"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  }),
);
app.use("/api/*", authenticate);
app.onError((error, c) => jsonError(c, error));

app.get("/health", (c) =>
  c.json({
    ok: true,
    runtime: runtime.name,
    version: "0.1.0",
    build: process.env.APP_BUILD ?? "dev",
    time: new Date().toISOString(),
  }),
);

async function requireProject(c: Context<AppEnv>) {
  const user = c.get("user");
  const projectId = c.req.param("projectId");
  if (!projectId) throw new HttpError(400, "MISSING_PROJECT", "projectId is required.");
  const access = await findProjectForUser(projectId, user.id);
  if (!access) {
    throw new HttpError(404, "PROJECT_ACCESS_DENIED", "You do not have access to this project.");
  }
  return access;
}

async function requireProjectEditor(c: Context<AppEnv>) {
  const access = await requireProject(c);
  if (access.role === "viewer") {
    throw new HttpError(403, "READ_ONLY", "Viewers have read-only access to this project.");
  }
  return access;
}

async function requireProjectOwner(c: Context<AppEnv>) {
  const access = await requireProject(c);
  if (access.role !== "owner") {
    throw new HttpError(403, "FORBIDDEN", "Only a project owner can manage members.");
  }
  return access;
}

async function ensureNotLastOwner(projectId: string, userId: string): Promise<void> {
  const db = getDb();
  const owners = await db
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.role, "owner")));
  if (owners.length <= 1 && owners[0]?.userId === userId) {
    throw new HttpError(409, "LAST_OWNER", "A project must keep at least one owner.");
  }
}

async function assertProjectIdle(projectId: string): Promise<void> {
  const room = await roomFor({ id: projectId } as ProjectRow);
  if (roomQueue.isRunning(room.id)) {
    throw new HttpError(
      409,
      "PROJECT_BUSY",
      "A conversation turn is still running. Stop it before deleting the project.",
    );
  }
  const db = getDb();
  const rows = await db.select().from(workspaces).where(eq(workspaces.projectId, projectId));
  if (rows.some((workspace) => workQueue.isRunning(workspace.id))) {
    throw new HttpError(
      409,
      "PROJECT_BUSY",
      "A code task or verification is still running. Wait for it to finish before deleting the project.",
    );
  }
}

async function audit(input: {
  tenantId: string;
  projectId?: string | null;
  actorType: string;
  actorId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  detail?: Record<string, unknown>;
}) {
  const db = getDb();
  await db.insert(auditEvents).values({
    id: uuidv7(),
    tenantId: input.tenantId,
    projectId: input.projectId ?? null,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    action: input.action,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    detail: input.detail ?? {},
  });
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

const attempts = new Map<string, { count: number; resetAt: number }>();

function clientIp(c: Context<AppEnv>): string {
  return (
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    "local"
  );
}

function enforceRateLimit(key: string, limit: number, windowMs: number): void {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  entry.count += 1;
  if (entry.count > limit) {
    throw new HttpError(429, "RATE_LIMITED", "Too many attempts. Please wait and try again.");
  }
}

function clearRateLimit(key: string): void {
  attempts.delete(key);
}

const demoUsage = { day: "", global: 0, users: new Map<string, number>() };

const repoContextCache = new Map<string, { text: string; at: number }>();

async function repoContextFor(project: { repoPath: string | null }): Promise<string | undefined> {
  if (!project.repoPath) return undefined;
  const cached = repoContextCache.get(project.repoPath);
  if (cached && Date.now() - cached.at < 60_000) return cached.text;
  try {
    const text = await readRepoContext(project.repoPath);
    repoContextCache.set(project.repoPath, { text, at: Date.now() });
    return text;
  } catch {
    return undefined;
  }
}
function enforceDemoMessageLimit(userId: string): void {
  if (!isDemoMode()) return;
  const day = new Date().toISOString().slice(0, 10);
  if (demoUsage.day !== day) {
    demoUsage.day = day;
    demoUsage.global = 0;
    demoUsage.users.clear();
  }
  const perUser = Number(process.env.DEMO_MESSAGES_PER_USER_PER_DAY ?? 20);
  const global = Number(process.env.DEMO_MESSAGES_PER_DAY ?? 200);
  const used = demoUsage.users.get(userId) ?? 0;
  if (used >= perUser) {
    throw new HttpError(429, "DEMO_MESSAGE_LIMIT", `演示模式每人每天最多 ${perUser} 条消息。`);
  }
  if (demoUsage.global >= global) {
    throw new HttpError(429, "DEMO_CAPACITY", "演示今天已满，请明天再试。");
  }
  demoUsage.users.set(userId, used + 1);
  demoUsage.global += 1;
}

async function hasActiveInvite(): Promise<boolean> {
  if (process.env.SIGNUP_INVITE_CODE) return true;
  const rows = await getDb().select().from(inviteCodes).where(eq(inviteCodes.active, true));
  return rows.some(
    (row) =>
      row.uses < row.maxUses && (!row.expiresAt || row.expiresAt.getTime() > Date.now()),
  );
}

app.get("/api/v1/auth/config", async (c) =>
  c.json({
    authMode: process.env.AUTH_MODE ?? "dev",
    registrationEnabled: await hasActiveInvite(),
    demoMode: process.env.DEMO_MODE === "1",
  }),
);

const registerSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(200),
  displayName: z.string().trim().min(1).max(60),
  inviteCode: z.string().min(1).max(200),
});

app.post("/api/v1/auth/register", async (c) => {
  enforceRateLimit(`register:${clientIp(c)}`, 5, 60 * 60 * 1000);
  const body = registerSchema.parse(await c.req.json());
  const db = getDb();

  const [dbInvite] = await db
    .select()
    .from(inviteCodes)
    .where(and(eq(inviteCodes.code, body.inviteCode), eq(inviteCodes.active, true)))
    .limit(1);
  const validDbInvite = Boolean(
    dbInvite &&
      dbInvite.uses < dbInvite.maxUses &&
      (!dbInvite.expiresAt || dbInvite.expiresAt.getTime() > Date.now()),
  );
  const envInvite = process.env.SIGNUP_INVITE_CODE;
  const validEnvInvite = Boolean(envInvite && safeEqual(body.inviteCode, envInvite));

  if (!validDbInvite && !validEnvInvite) {
    if (!envInvite && !(await hasActiveInvite())) {
      throw new HttpError(
        403,
        "REGISTRATION_DISABLED",
        "Registration is disabled. Ask the operator for an invite.",
      );
    }
    throw new HttpError(403, "INVALID_INVITE", "Invalid or expired invite code.");
  }

  const email = body.email.toLowerCase();
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) throw new HttpError(409, "EMAIL_TAKEN", "An account with this email already exists.");

  const tenantId = uuidv7();
  await db.insert(tenants).values({
    id: tenantId,
    name: `${body.displayName} 的工作区`,
  });

  const [user] = await db
    .insert(users)
    .values({
      id: uuidv7(),
      tenantId,
      email,
      displayName: body.displayName,
      passwordHash: hashPassword(body.password),
      isAdmin: false,
      isActive: true,
    })
    .returning();
  if (!user) throw new HttpError(500, "REGISTER_FAILED", "Could not create the account.");

  const project = await createProjectForUser({
    user,
    name: "我的第一个项目",
    description: "在这里描述你想做的产品，团队会从需求澄清开始。",
  });

  if (validDbInvite && dbInvite) {
    await db
      .update(inviteCodes)
      .set({ uses: dbInvite.uses + 1 })
      .where(eq(inviteCodes.id, dbInvite.id));
  }

  await createSession(c, user.id);
  return c.json(
    {
      user: publicUser(user),
      projectId: project.id,
      authMode: process.env.AUTH_MODE ?? "dev",
    },
    201,
  );
});

const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(200),
});

app.post("/api/v1/auth/login", async (c) => {
  const ipKey = `login:${clientIp(c)}`;
  enforceRateLimit(ipKey, 10, 15 * 60 * 1000);
  const body = loginSchema.parse(await c.req.json());
  const email = body.email.toLowerCase();
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

  if (user && !user.isActive) {
    throw new HttpError(403, "ACCOUNT_DISABLED", "This account has been disabled.");
  }
  if (!user || !verifyPassword(body.password, user.passwordHash)) {
    throw new HttpError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
  }

  clearRateLimit(ipKey);
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  await createSession(c, user.id);
  return c.json({ user: publicUser(user), authMode: process.env.AUTH_MODE ?? "dev" });
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(8).max(200),
});

app.post("/api/v1/me/password", async (c) => {
  const user = c.get("user");
  const body = changePasswordSchema.parse(await c.req.json());
  if (!user.passwordHash) {
    throw new HttpError(400, "PASSWORD_NOT_SET", "This account does not use a password.");
  }
  if (!verifyPassword(body.currentPassword, user.passwordHash)) {
    throw new HttpError(400, "INVALID_PASSWORD", "Current password is incorrect.");
  }
  if (body.currentPassword === body.newPassword) {
    throw new HttpError(400, "SAME_PASSWORD", "New password must differ from the current password.");
  }
  const db = getDb();
  await db
    .update(users)
    .set({ passwordHash: hashPassword(body.newPassword) })
    .where(eq(users.id, user.id));
  await db.delete(sessions).where(eq(sessions.userId, user.id));
  await createSession(c, user.id);
  await audit({
    tenantId: user.tenantId,
    projectId: null,
    actorType: "user",
    actorId: user.id,
    action: "user.password_changed",
    targetType: "user",
    targetId: user.id,
  });
  return c.json({ ok: true });
});

app.post("/api/v1/auth/logout", async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Admin console
// ---------------------------------------------------------------------------

function requireAdmin(c: Context<AppEnv>): UserRow {
  const user = c.get("user");
  if (!user.isAdmin) throw new HttpError(403, "FORBIDDEN", "Admin only.");
  return user;
}

function safeUser(user: UserRow) {
  const { passwordHash: _passwordHash, ...rest } = user;
  return rest;
}

app.get("/api/v1/admin/stats", async (c) => {
  requireAdmin(c);
  const db = getDb();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [userCount] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
  const [activeUsers] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(eq(users.isActive, true));
  const [projectCount] = await db.select({ n: sql<number>`count(*)::int` }).from(projects);
  const [messageCount] = await db.select({ n: sql<number>`count(*)::int` }).from(messages);
  const [messagesToday] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(messages)
    .where(gt(messages.createdAt, startOfDay));
  const [runsToday] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(agentRuns)
    .where(gt(agentRuns.createdAt, startOfDay));
  const [activeInvites] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(inviteCodes)
    .where(eq(inviteCodes.active, true));

  return c.json({
    users: userCount?.n ?? 0,
    activeUsers: activeUsers?.n ?? 0,
    projects: projectCount?.n ?? 0,
    messages: messageCount?.n ?? 0,
    messagesToday: messagesToday?.n ?? 0,
    runsToday: runsToday?.n ?? 0,
    activeInvites: activeInvites?.n ?? 0,
  });
});

app.get("/api/v1/admin/users", async (c) => {
  requireAdmin(c);
  const db = getDb();
  const rows = await db.select().from(users).orderBy(desc(users.createdAt));
  const projectCounts = await db
    .select({ userId: projectMembers.userId, n: sql<number>`count(*)::int` })
    .from(projectMembers)
    .groupBy(projectMembers.userId);
  const messageCounts = await db
    .select({ senderId: messages.senderId, n: sql<number>`count(*)::int` })
    .from(messages)
    .where(eq(messages.senderType, "user"))
    .groupBy(messages.senderId);
  const projectsByUser = new Map(projectCounts.map((row) => [row.userId, row.n]));
  const messagesByUser = new Map(messageCounts.map((row) => [row.senderId, row.n]));
  return c.json({
    items: rows.map((user) => ({
      ...safeUser(user),
      projectCount: projectsByUser.get(user.id) ?? 0,
      messageCount: messagesByUser.get(user.id) ?? 0,
    })),
  });
});

const adminUserPatchSchema = z.object({
  isActive: z.boolean().optional(),
  isAdmin: z.boolean().optional(),
});

app.patch("/api/v1/admin/users/:userId", async (c) => {
  const admin = requireAdmin(c);
  const body = adminUserPatchSchema.parse(await c.req.json());
  const db = getDb();
  const [target] = await db
    .select()
    .from(users)
    .where(eq(users.id, c.req.param("userId")))
    .limit(1);
  if (!target) throw new HttpError(404, "USER_NOT_FOUND", "User not found.");
  if (target.id === admin.id && (body.isActive === false || body.isAdmin === false)) {
    throw new HttpError(400, "SELF_LOCKOUT", "You cannot disable or demote your own account.");
  }
  if (
    target.isAdmin &&
    target.isActive &&
    (body.isAdmin === false || body.isActive === false)
  ) {
    const [admins] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .where(and(eq(users.isAdmin, true), eq(users.isActive, true)));
    if ((admins?.n ?? 0) <= 1) {
      throw new HttpError(409, "LAST_ADMIN", "At least one active admin is required.");
    }
  }

  const [updated] = await db
    .update(users)
    .set({
      isActive: body.isActive ?? target.isActive,
      isAdmin: body.isAdmin ?? target.isAdmin,
    })
    .where(eq(users.id, target.id))
    .returning();

  if (body.isActive === false) {
    await db.delete(sessions).where(eq(sessions.userId, target.id));
  }

  await audit({
    tenantId: admin.tenantId,
    projectId: null,
    actorType: "admin",
    actorId: admin.id,
    action: "admin.user.updated",
    targetType: "user",
    targetId: target.id,
    detail: { isActive: updated?.isActive, isAdmin: updated?.isAdmin },
  });

  return c.json(updated ? safeUser(updated) : null);
});

const adminPasswordSchema = z.object({ password: z.string().min(8).max(200) });

app.post("/api/v1/admin/users/:userId/password", async (c) => {
  const admin = requireAdmin(c);
  const body = adminPasswordSchema.parse(await c.req.json());
  const db = getDb();
  const [target] = await db
    .select()
    .from(users)
    .where(eq(users.id, c.req.param("userId")))
    .limit(1);
  if (!target) throw new HttpError(404, "USER_NOT_FOUND", "User not found.");

  await db
    .update(users)
    .set({ passwordHash: hashPassword(body.password) })
    .where(eq(users.id, target.id));
  if (target.id !== admin.id) {
    await db.delete(sessions).where(eq(sessions.userId, target.id));
  }

  await audit({
    tenantId: admin.tenantId,
    projectId: null,
    actorType: "admin",
    actorId: admin.id,
    action: "admin.user.password_reset",
    targetType: "user",
    targetId: target.id,
  });
  return c.json({ ok: true });
});

async function cleanupProjectWorkspaces(
  projectRows: Array<{ id: string; repoPath: string | null }>,
): Promise<void> {
  if (!projectRows.length) return;
  const db = getDb();
  const repoByProject = new Map(projectRows.map((project) => [project.id, project.repoPath]));
  const rows = await db
    .select()
    .from(workspaces)
    .where(inArray(workspaces.projectId, projectRows.map((project) => project.id)));
  for (const workspace of rows) {
    const repoPath = repoByProject.get(workspace.projectId);
    try {
      if (repoPath) await removeWorkspace(repoPath, workspace.path, workspace.branch);
      else await removeWorkspaceDirectory(workspace.path);
    } catch (error) {
      console.error("[admin] failed to remove workspace", workspace.path, error);
    }
  }
  for (const project of projectRows) {
    try {
      await removeProjectWorkspaceDirectory(project.id);
    } catch (error) {
      console.error("[admin] failed to remove project workspace directory", project.id, error);
    }
  }
}

app.delete("/api/v1/admin/users/:userId", async (c) => {
  const admin = requireAdmin(c);
  const db = getDb();
  const [target] = await db
    .select()
    .from(users)
    .where(eq(users.id, c.req.param("userId")))
    .limit(1);
  if (!target) throw new HttpError(404, "USER_NOT_FOUND", "User not found.");
  if (target.id === admin.id) {
    throw new HttpError(400, "SELF_DELETE", "You cannot delete your own account.");
  }

  const ownedProjects = await db
    .select({ id: projects.id, repoPath: projects.repoPath })
    .from(projects)
    .where(eq(projects.tenantId, target.tenantId));
  for (const project of ownedProjects) await assertProjectIdle(project.id);
  await cleanupProjectWorkspaces(ownedProjects);

  // A personal tenant owns exactly one user's projects; cascading the tenant
  // removes the account, projects, chat, tasks and artifacts in one go.
  await db.delete(tenants).where(eq(tenants.id, target.tenantId));
  await audit({
    tenantId: admin.tenantId,
    projectId: null,
    actorType: "admin",
    actorId: admin.id,
    action: "admin.user.deleted",
    targetType: "user",
    targetId: target.id,
    detail: { email: target.email },
  });
  return c.json({ ok: true });
});

app.get("/api/v1/admin/projects", async (c) => {
  requireAdmin(c);
  const db = getDb();
  const rows = await db.select().from(projects).orderBy(desc(projects.updatedAt));
  const owners = await db
    .select({
      projectId: projectMembers.projectId,
      email: users.email,
      displayName: users.displayName,
    })
    .from(projectMembers)
    .innerJoin(users, eq(projectMembers.userId, users.id))
    .where(eq(projectMembers.role, "owner"));
  const taskCounts = await db
    .select({ projectId: tasks.projectId, n: sql<number>`count(*)::int` })
    .from(tasks)
    .groupBy(tasks.projectId);
  const artifactCounts = await db
    .select({ projectId: artifacts.projectId, n: sql<number>`count(*)::int` })
    .from(artifacts)
    .groupBy(artifacts.projectId);
  const messageCounts = await db
    .select({ projectId: messages.projectId, n: sql<number>`count(*)::int` })
    .from(messages)
    .groupBy(messages.projectId);

  const ownerByProject = new Map(owners.map((row) => [row.projectId, row]));
  const tasksByProject = new Map(taskCounts.map((row) => [row.projectId, row.n]));
  const artifactsByProject = new Map(artifactCounts.map((row) => [row.projectId, row.n]));
  const messagesByProject = new Map(messageCounts.map((row) => [row.projectId, row.n]));

  return c.json({
    items: rows.map((project) => ({
      ...project,
      owner: ownerByProject.get(project.id) ?? null,
      taskCount: tasksByProject.get(project.id) ?? 0,
      artifactCount: artifactsByProject.get(project.id) ?? 0,
      messageCount: messagesByProject.get(project.id) ?? 0,
    })),
  });
});

app.delete("/api/v1/admin/projects/:projectId", async (c) => {
  const admin = requireAdmin(c);
  const db = getDb();
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, c.req.param("projectId")))
    .limit(1);
  if (!project) throw new HttpError(404, "PROJECT_NOT_FOUND", "Project not found.");
  await assertProjectIdle(project.id);
  await cleanupProjectWorkspaces([{ id: project.id, repoPath: project.repoPath }]);
  await db.delete(projects).where(eq(projects.id, project.id));
  await audit({
    tenantId: admin.tenantId,
    projectId: null,
    actorType: "admin",
    actorId: admin.id,
    action: "admin.project.deleted",
    targetType: "project",
    targetId: project.id,
    detail: { name: project.name },
  });
  return c.json({ ok: true });
});

app.get("/api/v1/admin/invites", async (c) => {
  requireAdmin(c);
  const rows = await getDb()
    .select()
    .from(inviteCodes)
    .orderBy(desc(inviteCodes.createdAt));
  return c.json({ items: rows });
});

const createInviteSchema = z.object({
  label: z.string().max(80).optional(),
  maxUses: z.number().int().min(1).max(1000).optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

app.post("/api/v1/admin/invites", async (c) => {
  const admin = requireAdmin(c);
  const body = createInviteSchema.parse(await c.req.json());
  const db = getDb();
  const [row] = await db
    .insert(inviteCodes)
    .values({
      id: uuidv7(),
      code: `devteam-${randomBytes(5).toString("hex")}`,
      label: body.label ?? "",
      createdBy: admin.id,
      maxUses: body.maxUses ?? 1,
      expiresAt: body.expiresInDays
        ? new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000)
        : null,
      active: true,
    })
    .returning();
  await audit({
    tenantId: admin.tenantId,
    projectId: null,
    actorType: "admin",
    actorId: admin.id,
    action: "admin.invite.created",
    targetType: "invite",
    targetId: row?.id,
    detail: { label: row?.label, maxUses: row?.maxUses },
  });
  return c.json(row, 201);
});

app.delete("/api/v1/admin/invites/:inviteId", async (c) => {
  const admin = requireAdmin(c);
  const db = getDb();
  await db.delete(inviteCodes).where(eq(inviteCodes.id, c.req.param("inviteId")));
  await audit({
    tenantId: admin.tenantId,
    projectId: null,
    actorType: "admin",
    actorId: admin.id,
    action: "admin.invite.revoked",
    targetType: "invite",
    targetId: c.req.param("inviteId"),
  });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Session / identity
// ---------------------------------------------------------------------------

app.get("/api/v1/me", (c) => c.json(publicUser(c.get("user"))));

app.get("/api/v1/runtime", (c) =>
  c.json({
    name: runtime.name,
    model: {
      provider: process.env.AGENT_MODEL_PROVIDER ?? "opencode-go",
      id: process.env.AGENT_MODEL_ID ?? "deepseek-v4.1-flash",
    },
  }),
);

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

app.get("/api/v1/projects", async (c) => {
  const user = c.get("user");
  const db = getDb();
  const rows = await db
    .select({ project: projects, role: projectMembers.role })
    .from(projectMembers)
    .innerJoin(projects, eq(projectMembers.projectId, projects.id))
    .where(eq(projectMembers.userId, user.id))
    .orderBy(desc(projects.updatedAt));
  return c.json({
    items: rows.map((row) => ({
      ...row.project,
      membershipRole: row.role,
      ...(isDemoMode() ? { repoPath: null, repoUrl: null } : {}),
    })),
  });
});

const createProjectSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(4000).optional(),
  repoUrl: z.string().max(500).optional(),
  repoPath: z.string().max(500).optional(),
});

app.post("/api/v1/projects", async (c) => {
  const user = c.get("user");
  const body = createProjectSchema.parse(await c.req.json());
  if (body.repoPath) {
    try {
      await validateRepoPath(body.repoPath);
    } catch (error) {
      throw new HttpError(
        400,
        "REPO_PATH_INVALID",
        `仓库路径不可用：${error instanceof Error ? error.message : String(error)}。请在项目设置中填写 ALLOWED_REPO_ROOTS 下的有效 Git 仓库。`,
      );
    }
  }
  const project = await createProjectForUser({
    user,
    name: body.name,
    description: body.description,
    repoUrl: body.repoUrl ?? null,
    repoPath: body.repoPath ?? null,
  });

  await projectEmitter(project.tenantId, project.id)(EVENT_TYPES.projectChanged, {
    action: "created",
    name: project.name,
  });
  await audit({
    tenantId: project.tenantId,
    projectId: project.id,
    actorType: "user",
    actorId: user.id,
    action: "project.created",
    targetType: "project",
    targetId: project.id,
  });

  return c.json(await buildSnapshot(project), 201);
});

app.get("/api/v1/projects/:projectId", async (c) => {
  const { project } = await requireProject(c);
  return c.json(await buildSnapshot(project));
});

const patchProjectSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(4000).optional(),
  repoUrl: z.string().max(500).nullable().optional(),
  repoPath: z.string().max(500).nullable().optional(),
  defaultBranch: z.string().max(120).optional(),
  budgetCents: z.number().int().min(0).max(100_000_000).optional(),
  status: z.enum(["active", "archived"]).optional(),
  autoStartTasks: z.boolean().optional(),
  expectedVersion: z.number().int().positive().optional(),
});

app.patch("/api/v1/projects/:projectId", async (c) => {
  const { project, role } = await requireProject(c);
  if (role === "viewer") throw new HttpError(403, "FORBIDDEN", "Viewers cannot edit projects.");
  const body = patchProjectSchema.parse(await c.req.json());
  if (body.expectedVersion !== undefined && body.expectedVersion !== project.version) {
    throw new HttpError(
      409,
      "PROJECT_CONFLICT",
      "This project was changed by someone else. Reload before saving.",
    );
  }
  if (isDemoMode() && (body.repoPath !== undefined || body.repoUrl !== undefined)) {
    throw new HttpError(403, "DEMO_MODE", "Repository settings are disabled in demo mode.");
  }
  if (body.repoPath) {
    try {
      await validateRepoPath(body.repoPath);
    } catch (error) {
      throw new HttpError(
        400,
        "REPO_PATH_INVALID",
        `仓库路径不可用：${error instanceof Error ? error.message : String(error)}。请在项目设置中填写 ALLOWED_REPO_ROOTS 下的有效 Git 仓库。`,
      );
    }
  }
  const db = getDb();
  const { expectedVersion: _expectedVersion, ...patch } = body;
  const [updated] = await db
    .update(projects)
    .set({ ...patch, updatedAt: new Date(), version: project.version + 1 })
    .where(eq(projects.id, project.id))
    .returning();
  if (!updated) throw new HttpError(404, "PROJECT_NOT_FOUND", "Project not found.");
  await projectEmitter(updated.tenantId, updated.id)(EVENT_TYPES.projectChanged, {
    action: "updated",
  });
  if (updated.autoStartTasks) void autoStartNext(updated.id);
  return c.json(await buildSnapshot(updated));
});

app.post("/api/v1/projects/:projectId/auto/start", async (c) => {
  const user = c.get("user");
  const { project: initialProject } = await requireProjectEditor(c);
  let project = initialProject;
  if (!project.repoPath) {
    try {
      project = await ensureProjectRepository(project.id);
    } catch (error) {
      throw new HttpError(
        400,
        "REPO_AUTO_CONFIGURE_FAILED",
        `自动创建项目仓库失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (await hasPendingDecisions(project.id)) {
    throw new HttpError(
      409,
      "PENDING_DECISIONS",
      "还有待决策项，处理完后再继续自动开发。",
    );
  }
  try {
    await enableAutoDevelopment(project.id);
  } catch (error) {
    throw new HttpError(409, "AUTO_START_FAILED", error instanceof Error ? error.message : String(error));
  }
  await audit({
    tenantId: project.tenantId,
    projectId: project.id,
    actorType: "user",
    actorId: user.id,
    action: "project.auto_started",
    targetType: "project",
    targetId: project.id,
  });
  return c.json(await buildSnapshot((await getDb().select().from(projects).where(eq(projects.id, project.id)).limit(1))[0]!));
});

app.delete("/api/v1/projects/:projectId", async (c) => {
  const user = c.get("user");
  const { project, role } = await requireProject(c);
  if (role !== "owner") {
    throw new HttpError(403, "FORBIDDEN", "Only the project owner can delete this project.");
  }

  await assertProjectIdle(project.id);

  const db = getDb();
  const workspaceRows = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.projectId, project.id));
  await cleanupProjectWorkspaces([{ id: project.id, repoPath: project.repoPath }]);
  await db.delete(projects).where(eq(projects.id, project.id));
  await projectEmitter(project.tenantId, project.id)(EVENT_TYPES.projectChanged, {
    action: "deleted",
    name: project.name,
  });
  await audit({
    tenantId: user.tenantId,
    projectId: null,
    actorType: "user",
    actorId: user.id,
    action: "project.deleted",
    targetType: "project",
    targetId: project.id,
    detail: { name: project.name, workspaces: workspaceRows.length },
  });
  return c.json({ ok: true });
});

const addProjectMemberSchema = z.object({
  email: z.string().trim().email().max(254),
  role: z.enum(["owner", "member", "viewer"]).default("member"),
});

app.get("/api/v1/projects/:projectId/members", async (c) => {
  const { project } = await requireProject(c);
  const db = getDb();
  const rows = await db
    .select({
      projectId: projectMembers.projectId,
      userId: projectMembers.userId,
      role: projectMembers.role,
      displayName: users.displayName,
      email: users.email,
    })
    .from(projectMembers)
    .innerJoin(users, eq(projectMembers.userId, users.id))
    .where(eq(projectMembers.projectId, project.id))
    .orderBy(
      sql`case ${projectMembers.role} when 'owner' then 0 when 'member' then 1 else 2 end`,
      asc(users.displayName),
    );
  return c.json({ items: rows });
});

app.post("/api/v1/projects/:projectId/members", async (c) => {
  const user = c.get("user");
  const { project } = await requireProjectOwner(c);
  const body = addProjectMemberSchema.parse(await c.req.json());
  const db = getDb();
  const email = body.email.toLowerCase();
  const [target] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!target) {
    throw new HttpError(404, "USER_NOT_FOUND", "No account uses that email. Ask them to register first.");
  }
  if (!target.isActive) {
    throw new HttpError(400, "USER_INACTIVE", "That account is disabled.");
  }
  const [existing] = await db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, target.id)))
    .limit(1);
  if (existing) {
    throw new HttpError(409, "ALREADY_MEMBER", "That user is already a member of this project.");
  }
  await db.insert(projectMembers).values({
    projectId: project.id,
    userId: target.id,
    role: body.role,
  });
  await projectEmitter(project.tenantId, project.id)(EVENT_TYPES.projectChanged, {
    action: "members_updated",
    userId: target.id,
    role: body.role,
  });
  await audit({
    tenantId: project.tenantId,
    projectId: project.id,
    actorType: "user",
    actorId: user.id,
    action: "project.member_added",
    targetType: "project_member",
    targetId: `${project.id}:${target.id}`,
    detail: { email: target.email, role: body.role },
  });
  return c.json(
    {
      projectId: project.id,
      userId: target.id,
      role: body.role,
      displayName: target.displayName,
      email: target.email,
    },
    201,
  );
});

const updateProjectMemberSchema = z.object({
  role: z.enum(["owner", "member", "viewer"]),
});

app.patch("/api/v1/projects/:projectId/members/:userId", async (c) => {
  const user = c.get("user");
  const { project } = await requireProjectOwner(c);
  const body = updateProjectMemberSchema.parse(await c.req.json());
  const userId = c.req.param("userId");
  const db = getDb();
  const [membership] = await db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, userId)))
    .limit(1);
  if (!membership) throw new HttpError(404, "MEMBER_NOT_FOUND", "Project member not found.");
  if (membership.role === "owner" && body.role !== "owner") {
    await ensureNotLastOwner(project.id, userId);
  }
  await db
    .update(projectMembers)
    .set({ role: body.role })
    .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, userId)));
  await projectEmitter(project.tenantId, project.id)(EVENT_TYPES.projectChanged, {
    action: "members_updated",
    userId,
    role: body.role,
  });
  await audit({
    tenantId: project.tenantId,
    projectId: project.id,
    actorType: "user",
    actorId: user.id,
    action: "project.member_role_changed",
    targetType: "project_member",
    targetId: `${project.id}:${userId}`,
    detail: { previousRole: membership.role, role: body.role },
  });
  return c.json({ projectId: project.id, userId, role: body.role });
});

app.delete("/api/v1/projects/:projectId/members/:userId", async (c) => {
  const user = c.get("user");
  const { project } = await requireProjectOwner(c);
  const userId = c.req.param("userId");
  const db = getDb();
  const [membership] = await db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, userId)))
    .limit(1);
  if (!membership) throw new HttpError(404, "MEMBER_NOT_FOUND", "Project member not found.");
  if (userId === user.id) {
    throw new HttpError(400, "SELF_REMOVE", "You cannot remove your own membership.");
  }
  if (membership.role === "owner") {
    await ensureNotLastOwner(project.id, userId);
  }
  await db
    .delete(projectMembers)
    .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, userId)));
  await projectEmitter(project.tenantId, project.id)(EVENT_TYPES.projectChanged, {
    action: "members_updated",
    userId,
    removed: true,
  });
  await audit({
    tenantId: project.tenantId,
    projectId: project.id,
    actorType: "user",
    actorId: user.id,
    action: "project.member_removed",
    targetType: "project_member",
    targetId: `${project.id}:${userId}`,
    detail: { previousRole: membership.role },
  });
  return c.json({ ok: true });
});

const memorySchema = z.object({
  type: z.string().trim().min(1).max(40).default("fact"),
  title: z.string().trim().min(1).max(240),
  content: z.string().trim().min(1).max(20_000),
  status: z.enum(["proposed", "accepted", "rejected", "superseded"]).optional(),
});

app.get("/api/v1/projects/:projectId/memories", async (c) => {
  const { project } = await requireProject(c);
  const rows = await getDb()
    .select()
    .from(memories)
    .where(eq(memories.projectId, project.id))
    .orderBy(desc(memories.updatedAt));
  return c.json({ items: rows });
});

app.post("/api/v1/projects/:projectId/memories", async (c) => {
  const user = c.get("user");
  const { project } = await requireProjectEditor(c);
  const body = memorySchema.parse(await c.req.json());
  const db = getDb();
  const existingRows = await db
    .select()
    .from(memories)
    .where(eq(memories.projectId, project.id));
  const normalizedTitle = body.title.trim().toLowerCase();
  const existing = existingRows.find(
    (item) =>
      item.type === body.type && item.title.trim().toLowerCase() === normalizedTitle,
  );
  if (existing) {
    const [merged] = await db
      .update(memories)
      .set({
        content: body.content,
        status: "proposed",
        version: existing.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(memories.id, existing.id))
      .returning();
    await projectEmitter(project.tenantId, project.id)("memory.changed", {
      memoryId: existing.id,
      action: "merged",
      status: "proposed",
    });
    await audit({
      tenantId: project.tenantId,
      projectId: project.id,
      actorType: "user",
      actorId: user.id,
      action: "memory.merged",
      targetType: "memory",
      targetId: existing.id,
      detail: { title: merged?.title, version: merged?.version },
    });
    return c.json(merged, 200);
  }
  const [memory] = await db
    .insert(memories)
    .values({
      id: uuidv7(),
      projectId: project.id,
      type: body.type,
      title: body.title,
      content: body.content,
      status: body.status ?? "proposed",
    })
    .returning();
  await projectEmitter(project.tenantId, project.id)("memory.changed", {
    memoryId: memory!.id,
    action: "created",
    status: memory!.status,
  });
  await audit({
    tenantId: project.tenantId,
    projectId: project.id,
    actorType: "user",
    actorId: user.id,
    action: "memory.created",
    targetType: "memory",
    targetId: memory!.id,
    detail: { title: memory!.title, type: memory!.type },
  });
  return c.json(memory, 201);
});

const patchMemorySchema = z.object({
  type: z.string().trim().min(1).max(40).optional(),
  title: z.string().trim().min(1).max(240).optional(),
  content: z.string().trim().min(1).max(20_000).optional(),
  status: z.enum(["proposed", "accepted", "rejected", "superseded"]).optional(),
});

app.patch("/api/v1/projects/:projectId/memories/:memoryId", async (c) => {
  const user = c.get("user");
  const { project } = await requireProjectEditor(c);
  const body = patchMemorySchema.parse(await c.req.json());
  const db = getDb();
  const [memory] = await db
    .select()
    .from(memories)
    .where(and(eq(memories.id, c.req.param("memoryId")), eq(memories.projectId, project.id)))
    .limit(1);
  if (!memory) throw new HttpError(404, "MEMORY_NOT_FOUND", "Memory not found.");
  const contentChanged =
    body.title !== undefined || body.content !== undefined || body.type !== undefined;
  const [updated] = await db
    .update(memories)
    .set({
      type: body.type ?? memory.type,
      title: body.title ?? memory.title,
      content: body.content ?? memory.content,
      status: body.status ?? memory.status,
      version: contentChanged ? memory.version + 1 : memory.version,
      updatedAt: new Date(),
    })
    .where(eq(memories.id, memory.id))
    .returning();
  await projectEmitter(project.tenantId, project.id)("memory.changed", {
    memoryId: memory.id,
    action: body.status ? body.status : "updated",
    status: updated?.status,
  });
  await audit({
    tenantId: project.tenantId,
    projectId: project.id,
    actorType: "user",
    actorId: user.id,
    action: body.status ? `memory.${body.status}` : "memory.updated",
    targetType: "memory",
    targetId: memory.id,
    detail: { title: updated?.title },
  });
  return c.json(updated);
});

app.delete("/api/v1/projects/:projectId/memories/:memoryId", async (c) => {
  const user = c.get("user");
  const { project } = await requireProjectEditor(c);
  const db = getDb();
  const [memory] = await db
    .select()
    .from(memories)
    .where(and(eq(memories.id, c.req.param("memoryId")), eq(memories.projectId, project.id)))
    .limit(1);
  if (!memory) throw new HttpError(404, "MEMORY_NOT_FOUND", "Memory not found.");
  await db.delete(memories).where(eq(memories.id, memory.id));
  await projectEmitter(project.tenantId, project.id)("memory.changed", {
    memoryId: memory.id,
    action: "deleted",
  });
  await audit({
    tenantId: project.tenantId,
    projectId: project.id,
    actorType: "user",
    actorId: user.id,
    action: "memory.deleted",
    targetType: "memory",
    targetId: memory.id,
    detail: { title: memory.title },
  });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

app.get("/api/v1/projects/:projectId/messages", async (c) => {
  const { project } = await requireProject(c);
  const room = await roomFor(project);
  const cursorRaw = c.req.query("cursor");
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 40), 1), 100);
  const cursor = cursorRaw ? Number(cursorRaw) : null;
  const rows = await messagePage(room.id, Number.isFinite(cursor) ? cursor : null, limit);
  return c.json({
    items: rows,
    nextCursor: rows.length ? String(rows[0]!.seq) : null,
  });
});

const postMessageSchema = z.object({
  content: z.string().min(1).max(20_000),
  mentions: z.array(z.string().max(40)).max(5).optional(),
  participants: z.array(z.string().max(40)).max(8).optional(),
  replyToId: z.string().uuid().optional(),
});

app.post("/api/v1/projects/:projectId/messages", async (c) => {
  const user = c.get("user");
  const { project } = await requireProjectEditor(c);
  const room = await roomFor(project);
  const body = postMessageSchema.parse(await c.req.json());
  enforceDemoMessageLimit(user.id);
  const repoContext = await repoContextFor(project);

  const messageId = uuidv7();
  const message = await insertMessage({
    id: messageId,
    tenantId: project.tenantId,
    projectId: project.id,
    roomId: room.id,
    senderType: "user",
    senderId: user.id,
    senderName: user.displayName,
    type: "discussion",
    content: body.content,
    replyToId: body.replyToId ?? null,
    metadata: { mentions: body.mentions ?? [] },
  });

  const emit = projectEmitter(project.tenantId, project.id);
  await emit(EVENT_TYPES.messageCreated, {
    messageId,
    roomId: room.id,
    senderName: user.displayName,
    senderType: "user",
    type: "discussion",
  });

  const orchestrator = new Orchestrator({ runtime, emit });
  roomQueue.enqueue(room.id, (signal) =>
    orchestrator.run({
      projectId: project.id,
      roomId: room.id,
      userMessageId: messageId,
      content: body.content,
      mentions: body.mentions,
      participantKeys: body.participants,
      repoContext,
      userId: user.id,
      userName: user.displayName,
      signal,
    }),
  );
  resumeAutoDevelopment(project.id);

  return c.json(message, 201);
});

app.post("/api/v1/projects/:projectId/stop", async (c) => {
  const { project } = await requireProjectEditor(c);
  const room = await roomFor(project);
  const stopped = roomQueue.stop(room.id);
  await projectEmitter(project.tenantId, project.id)(EVENT_TYPES.orchestrationFinished, {
    stopped,
    reason: "user_requested",
  });
  return c.json({ stopped });
});

// ---------------------------------------------------------------------------
// Server-sent events (durable cursor, not a runtime cursor)
// ---------------------------------------------------------------------------

app.get("/api/v1/projects/:projectId/presence", async (c) => {
  const { project } = await requireProject(c);
  return c.json({ items: listPresence(project.id) });
});

app.get("/api/v1/projects/:projectId/events", async (c) => {
  const user = c.get("user");
  const { project } = await requireProject(c);
  const cursorRaw = Number(c.req.query("cursor") ?? 0);
  const start = Number.isFinite(cursorRaw) ? cursorRaw : 0;
  const db = getDb();

  c.header("cache-control", "no-cache");
  c.header("x-accel-buffering", "no");

  return streamSSE(c, async (stream) => {
    let last = start;
    let lastPresence = 0;
    joinPresence(project.id, { id: user.id, displayName: user.displayName });
    try {
      await stream.writeSSE({ event: "ready", data: JSON.stringify({ cursor: last }) });
      while (!stream.aborted) {
        const rows = await db
          .select()
          .from(eventsTable)
          .where(and(eq(eventsTable.projectId, project.id), gt(eventsTable.seq, last)))
          .orderBy(asc(eventsTable.seq))
          .limit(200);
        for (const row of rows) {
          last = row.seq;
          await stream.writeSSE({
            event: "workspace",
            id: String(row.seq),
            data: JSON.stringify(row),
          });
        }
        if (Date.now() - lastPresence > 4_000) {
          touchPresence(project.id, user.id);
          await stream.writeSSE({
            event: "presence",
            data: JSON.stringify({ users: listPresence(project.id) }),
          });
          lastPresence = Date.now();
        }
        await stream.sleep(700);
      }
    } finally {
      leavePresence(project.id, user.id);
    }
  });
});

const patchRoleSchema = z.object({
  inRoom: z.boolean().optional(),
  enabled: z.boolean().optional(),
  modelProvider: z.string().max(64).nullable().optional(),
  modelId: z.string().max(120).nullable().optional(),
});

app.patch("/api/v1/projects/:projectId/roles/:roleKey", async (c) => {
  const { project } = await requireProjectEditor(c);
  const body = patchRoleSchema.parse(await c.req.json());
  const db = getDb();
  const [role] = await db
    .select()
    .from(agentRoles)
    .where(
      and(
        eq(agentRoles.projectId, project.id),
        eq(agentRoles.key, c.req.param("roleKey")),
      ),
    )
    .limit(1);
  if (!role) throw new HttpError(404, "ROLE_NOT_FOUND", "Agent role not found.");

  const [updated] = await db
    .update(agentRoles)
    .set({
      inRoom: body.inRoom ?? role.inRoom,
      enabled: body.enabled ?? role.enabled,
      modelProvider: body.modelProvider === undefined ? role.modelProvider : body.modelProvider,
      modelId: body.modelId === undefined ? role.modelId : body.modelId,
    })
    .where(eq(agentRoles.id, role.id))
    .returning();

  await projectEmitter(project.tenantId, project.id)(EVENT_TYPES.projectChanged, {
    action: "role_updated",
    roleKey: role.key,
    inRoom: updated?.inRoom,
    enabled: updated?.enabled,
  });
  return c.json(updated);
});

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const createTaskSchema = z.object({
  title: z.string().min(1).max(240),
  description: z.string().max(20_000).optional(),
  roleKey: z.string().max(40).nullable().optional(),
  priority: z.enum(PRIORITIES as unknown as [string, ...string[]]).optional(),
  acceptance: z.array(z.string().max(500)).max(20).optional(),
});

app.post("/api/v1/projects/:projectId/tasks", async (c) => {
  const user = c.get("user");
  const { project } = await requireProjectEditor(c);
  const body = createTaskSchema.parse(await c.req.json());
  const spec = await captureAcceptedSpec(project.id);
  if (!spec) {
    throw new HttpError(
      409,
      "SPEC_NOT_ACCEPTED",
      "请先接受当前 PRD 和验收标准，再创建任务。",
    );
  }
  const db = getDb();
  const [task] = await db
    .insert(tasks)
    .values({
      id: uuidv7(),
      projectId: project.id,
      title: body.title,
      description: body.description ?? "",
      status: "ready",
      priority: body.priority ?? "medium",
      roleKey: body.roleKey ?? null,
      requirementVersion: spec.prd.version,
      spec: spec as unknown as Record<string, unknown>,
      acceptance: body.acceptance ?? [],
    })
    .returning();
  await projectEmitter(project.tenantId, project.id)(EVENT_TYPES.taskChanged, {
    taskId: task!.id,
    action: "created",
    title: task!.title,
    status: "ready",
  });
  void autoStartNext(project.id);
  await audit({
    tenantId: project.tenantId,
    projectId: project.id,
    actorType: "user",
    actorId: user.id,
    action: "task.created",
    targetType: "task",
    targetId: task!.id,
    detail: { title: task!.title, status: "ready", acceptance: task!.acceptance.length },
  });
  return c.json(task, 201);
});

app.get("/api/v1/projects/:projectId/tasks", async (c) => {
  const { project } = await requireProject(c);
  const db = getDb();
  const rows = await db
    .select()
    .from(tasks)
    .where(eq(tasks.projectId, project.id))
    .orderBy(desc(tasks.updatedAt));
  return c.json({ items: rows });
});

const patchTaskSchema = z.object({
  title: z.string().min(1).max(240).optional(),
  description: z.string().max(20_000).optional(),
  status: z.enum([
    "proposed",
    "ready",
    "in_progress",
    "blocked",
    "review",
    "testing",
    "done",
    "failed",
    "cancelled",
    "stale",
    "needs_replan",
  ]).optional(),
  priority: z.enum(PRIORITIES as unknown as [string, ...string[]]).optional(),
  roleKey: z.string().max(40).nullable().optional(),
  blockedReason: z.string().max(2000).nullable().optional(),
  evidence: z.string().max(8000).optional(),
  acceptance: z.array(z.string().max(500)).max(20).optional(),
  expectedUpdatedAt: z.string().datetime().optional(),
});

app.patch("/api/v1/projects/:projectId/tasks/:taskId", async (c) => {
  const user = c.get("user");
  const { project } = await requireProjectEditor(c);
  const body = patchTaskSchema.parse(await c.req.json());
  const db = getDb();
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, c.req.param("taskId")), eq(tasks.projectId, project.id)))
    .limit(1);
  if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "Task not found.");
  if (
    body.expectedUpdatedAt &&
    new Date(body.expectedUpdatedAt).getTime() !== task.updatedAt.getTime()
  ) {
    throw new HttpError(
      409,
      "TASK_CONFLICT",
      "This task was changed by someone else. Reload before saving.",
    );
  }
  if (body.status && !canTransitionTask(task.status as TaskStatus, body.status as TaskStatus)) {
    throw new HttpError(409, "TASK_ILLEGAL_TRANSITION", `Cannot move task from ${task.status} to ${body.status}.`);
  }

  const specChanged =
    body.title !== undefined || body.description !== undefined || body.acceptance !== undefined;
  const workspaceRows = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.projectId, project.id), eq(workspaces.taskId, task.id)));
  if (
    workspaceRows.some((workspace) => workQueue.isRunning(workspace.id)) &&
    (body.status !== undefined || specChanged)
  ) {
    throw new HttpError(
      409,
      "TASK_RUNNING",
      "This task has a running code task or verification. Wait for it to finish before changing its status or spec.",
    );
  }
  if (specChanged && ["done", "cancelled"].includes(task.status)) {
    throw new HttpError(
      409,
      "TASK_CLOSED",
      "Closed tasks cannot change their title, description or acceptance criteria.",
    );
  }
  const reopened = specChanged && ["review", "testing"].includes(task.status);
  const nextStatus = reopened ? "in_progress" : body.status ?? task.status;
  const nextBlockedReason = reopened
    ? "任务描述或验收标准已修改，需要重新核对"
    : body.blockedReason === undefined
      ? task.blockedReason
      : body.blockedReason;

  const [updated] = await db
    .update(tasks)
    .set({
      title: body.title ?? task.title,
      description: body.description ?? task.description,
      status: nextStatus,
      priority: body.priority ?? task.priority,
      roleKey: body.roleKey === undefined ? task.roleKey : body.roleKey,
      blockedReason: nextBlockedReason,
      evidence: body.evidence
        ? { ...task.evidence, note: body.evidence, at: new Date().toISOString() }
        : task.evidence,
      acceptance: body.acceptance ?? task.acceptance,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, task.id))
    .returning();

  await projectEmitter(project.tenantId, project.id)(EVENT_TYPES.taskChanged, {
    taskId: task.id,
    action: "updated",
    status: updated?.status,
  });
  void autoStartNext(project.id);
  if (updated?.status === "done") void nudgePhaseProposal(project.id, "task_done");
  await audit({
    tenantId: project.tenantId,
    projectId: project.id,
    actorType: "user",
    actorId: user.id,
    action: "task.updated",
    targetType: "task",
    targetId: task.id,
    detail: {
      title: updated?.title,
      status: updated?.status,
      previousStatus: task.status,
      specChanged,
      reopened,
    },
  });
  return c.json(updated);
});

app.delete("/api/v1/projects/:projectId/tasks/:taskId", async (c) => {
  const user = c.get("user");
  const { project } = await requireProjectEditor(c);
  const db = getDb();
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, c.req.param("taskId")), eq(tasks.projectId, project.id)))
    .limit(1);
  if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "Task not found.");

  const workspaceRows = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.projectId, project.id), eq(workspaces.taskId, task.id)));
  if (workspaceRows.some((workspace) => workQueue.isRunning(workspace.id))) {
    throw new HttpError(
      409,
      "TASK_RUNNING",
      "This task has a running code task or verification. Wait for it to finish before deleting.",
    );
  }

  for (const workspace of workspaceRows) {
    try {
      if (project.repoPath) await removeWorkspace(project.repoPath, workspace.path, workspace.branch);
      else await removeWorkspaceDirectory(workspace.path);
    } catch (error) {
      console.error("[tasks] failed to remove workspace", workspace.path, error);
    }
  }

  await db
    .delete(workspaces)
    .where(and(eq(workspaces.projectId, project.id), eq(workspaces.taskId, task.id)));
  await db.delete(tasks).where(eq(tasks.id, task.id));

  await audit({
    tenantId: project.tenantId,
    projectId: project.id,
    actorType: "user",
    actorId: user.id,
    action: "task.deleted",
    targetType: "task",
    targetId: task.id,
    detail: {
      title: task.title,
      status: task.status,
      workspaces: workspaceRows.length,
    },
  });
  await projectEmitter(project.tenantId, project.id)(EVENT_TYPES.taskChanged, {
    taskId: task.id,
    action: "deleted",
    title: task.title,
    status: task.status,
  });
  return c.json({ ok: true });
});

app.get("/api/v1/projects/:projectId/tasks/:taskId/dependencies", async (c) => {
  const { project } = await requireProject(c);
  const db = getDb();
  const [task] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, c.req.param("taskId")), eq(tasks.projectId, project.id)))
    .limit(1);
  if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "Task not found.");
  const rows = await db
    .select({
      taskId: taskDependencies.taskId,
      dependsOnTaskId: taskDependencies.dependsOnTaskId,
      title: tasks.title,
      status: tasks.status,
    })
    .from(taskDependencies)
    .innerJoin(tasks, eq(taskDependencies.dependsOnTaskId, tasks.id))
    .where(eq(taskDependencies.taskId, task.id));
  return c.json({ items: rows });
});

const addDependencySchema = z.object({ dependsOnTaskId: z.string().uuid() });

app.post("/api/v1/projects/:projectId/tasks/:taskId/dependencies", async (c) => {
  const user = c.get("user");
  const { project } = await requireProjectEditor(c);
  const body = addDependencySchema.parse(await c.req.json());
  const taskId = c.req.param("taskId");
  if (taskId === body.dependsOnTaskId) {
    throw new HttpError(400, "SELF_DEPENDENCY", "A task cannot depend on itself.");
  }
  const db = getDb();
  const taskRows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.projectId, project.id), inArray(tasks.id, [taskId, body.dependsOnTaskId])));
  if (taskRows.length !== 2) {
    throw new HttpError(404, "TASK_NOT_FOUND", "Both tasks must belong to this project.");
  }
  const all = await db
    .select({ taskId: taskDependencies.taskId, dependsOnTaskId: taskDependencies.dependsOnTaskId })
    .from(taskDependencies)
    .innerJoin(tasks, eq(taskDependencies.taskId, tasks.id))
    .where(eq(tasks.projectId, project.id));
  const edges = new Map<string, string[]>();
  for (const edge of all) {
    edges.set(edge.taskId, [...(edges.get(edge.taskId) ?? []), edge.dependsOnTaskId]);
  }
  const stack = [body.dependsOnTaskId];
  const seen = new Set<string>();
  while (stack.length) {
    const current = stack.pop()!;
    if (current === taskId) {
      throw new HttpError(409, "DEPENDENCY_CYCLE", "That dependency would create a cycle.");
    }
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...(edges.get(current) ?? []));
  }
  const [existing] = await db
    .select()
    .from(taskDependencies)
    .where(
      and(
        eq(taskDependencies.taskId, taskId),
        eq(taskDependencies.dependsOnTaskId, body.dependsOnTaskId),
      ),
    )
    .limit(1);
  if (!existing) {
    await db.insert(taskDependencies).values({
      taskId,
      dependsOnTaskId: body.dependsOnTaskId,
    });
  }
  await projectEmitter(project.tenantId, project.id)(EVENT_TYPES.taskChanged, {
    taskId,
    action: "dependencies_updated",
    dependsOnTaskId: body.dependsOnTaskId,
  });
  await audit({
    tenantId: project.tenantId,
    projectId: project.id,
    actorType: "user",
    actorId: user.id,
    action: "task.dependency_added",
    targetType: "task",
    targetId: taskId,
    detail: { dependsOnTaskId: body.dependsOnTaskId },
  });
  return c.json({ ok: true });
});

app.delete(
  "/api/v1/projects/:projectId/tasks/:taskId/dependencies/:dependsOnTaskId",
  async (c) => {
    const user = c.get("user");
    const { project } = await requireProjectEditor(c);
    const taskId = c.req.param("taskId");
    const dependsOnTaskId = c.req.param("dependsOnTaskId");
    const db = getDb();
    const [task] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.projectId, project.id)))
      .limit(1);
    if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "Task not found.");
    await db
      .delete(taskDependencies)
      .where(
        and(
          eq(taskDependencies.taskId, taskId),
          eq(taskDependencies.dependsOnTaskId, dependsOnTaskId),
        ),
      );
    await projectEmitter(project.tenantId, project.id)(EVENT_TYPES.taskChanged, {
      taskId,
      action: "dependencies_updated",
      dependsOnTaskId,
    });
    await audit({
      tenantId: project.tenantId,
      projectId: project.id,
      actorType: "user",
      actorId: user.id,
      action: "task.dependency_removed",
      targetType: "task",
      targetId: taskId,
      detail: { dependsOnTaskId },
    });
    return c.json({ ok: true });
  },
);

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

app.get("/api/v1/projects/:projectId/artifacts", async (c) => {
  const { project } = await requireProject(c);
  const db = getDb();
  const rows = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.projectId, project.id))
    .orderBy(desc(artifacts.updatedAt));
  return c.json({ items: rows });
});

app.get("/api/v1/projects/:projectId/artifacts/:artifactId", async (c) => {
  const { project } = await requireProject(c);
  const db = getDb();
  const [artifact] = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.id, c.req.param("artifactId")), eq(artifacts.projectId, project.id)))
    .limit(1);
  if (!artifact) throw new HttpError(404, "ARTIFACT_NOT_FOUND", "Artifact not found.");
  const versions = await db
    .select()
    .from(artifactVersions)
    .where(eq(artifactVersions.artifactId, artifact.id))
    .orderBy(desc(artifactVersions.version));
  return c.json({
    ...artifact,
    content: versions[0]?.content ?? "",
    summary: versions[0]?.summary ?? "",
    versions,
  });
});

const artifactDecisionSchema = z.object({ status: z.enum(["accepted", "rejected"]), note: z.string().max(2000).optional() });

app.post("/api/v1/projects/:projectId/artifacts/:artifactId/decision", async (c) => {
  const user = c.get("user");
  const { project } = await requireProjectEditor(c);
  const body = artifactDecisionSchema.parse(await c.req.json());
  const db = getDb();
  const [artifact] = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.id, c.req.param("artifactId")), eq(artifacts.projectId, project.id)))
    .limit(1);
  if (!artifact) throw new HttpError(404, "ARTIFACT_NOT_FOUND", "Artifact not found.");
  const [updated] = await db
    .update(artifacts)
    .set({ status: body.status, updatedAt: new Date() })
    .where(eq(artifacts.id, artifact.id))
    .returning();
  await projectEmitter(project.tenantId, project.id)(EVENT_TYPES.artifactChanged, {
    artifactId: artifact.id,
    action: body.status,
    kind: artifact.kind,
    title: artifact.title,
  });
  await audit({
    tenantId: project.tenantId,
    projectId: project.id,
    actorType: "user",
    actorId: user.id,
    action: `artifact.${body.status}`,
    targetType: "artifact",
    targetId: artifact.id,
    detail: { note: body.note ?? null },
  });
  await pauseAutoDevelopment(project.id, "artifact_decision");
  if (body.status === "accepted") void nudgePhaseProposal(project.id, "artifact_accepted");
  return c.json(updated);
});

const BATCH_ACCEPT_KINDS = new Set([
  "design",
  "api_contract",
  "plan",
  "note",
  "repo_analysis",
  "diff",
  "test_report",
  "spec_review",
]);

app.post("/api/v1/projects/:projectId/artifacts/accept-pending", async (c) => {
  const user = c.get("user");
  const { project } = await requireProjectEditor(c);
  const db = getDb();
  const rows = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.projectId, project.id), eq(artifacts.status, "in_review")));
  const accepted = rows.filter((artifact) => BATCH_ACCEPT_KINDS.has(artifact.kind));
  const skipped = rows.filter((artifact) => !BATCH_ACCEPT_KINDS.has(artifact.kind));
  const now = new Date();
  for (const artifact of accepted) {
    await db
      .update(artifacts)
      .set({ status: "accepted", updatedAt: now })
      .where(eq(artifacts.id, artifact.id));
    await projectEmitter(project.tenantId, project.id)(EVENT_TYPES.artifactChanged, {
      artifactId: artifact.id,
      action: "accepted",
      kind: artifact.kind,
      title: artifact.title,
    });
  }
  if (accepted.length) {
    await audit({
      tenantId: project.tenantId,
      projectId: project.id,
      actorType: "user",
      actorId: user.id,
      action: "artifact.batch_accepted",
      targetType: "project",
      targetId: project.id,
      detail: { artifactIds: accepted.map((artifact) => artifact.id) },
    });
  }
  if (accepted.length) {
    await pauseAutoDevelopment(project.id, "artifact_batch_accepted");
    void nudgePhaseProposal(project.id, "artifacts_batch_accepted");
  }
  return c.json({
    accepted: accepted.length,
    skipped: skipped.map((artifact) => ({ kind: artifact.kind, title: artifact.title })),
  });
});

// ---------------------------------------------------------------------------
// Decisions & approvals
// ---------------------------------------------------------------------------

app.get("/api/v1/projects/:projectId/decisions", async (c) => {
  const { project } = await requireProject(c);
  const db = getDb();
  const rows = await db
    .select()
    .from(decisions)
    .where(eq(decisions.projectId, project.id))
    .orderBy(desc(decisions.createdAt));
  return c.json({ items: rows });
});

const decideSchema = z.object({
  status: z.enum(DECISION_STATUSES as unknown as [string, ...string[]]),
  reason: z.string().max(2000).optional(),
});

app.post("/api/v1/projects/:projectId/decisions/:decisionId/decide", async (c) => {
  const user = c.get("user");
  const { project } = await requireProjectEditor(c);
  const body = decideSchema.parse(await c.req.json());
  if (!["accepted", "rejected", "superseded"].includes(body.status)) {
    throw new HttpError(400, "INVALID_STATUS", "Decision status must be accepted, rejected or superseded.");
  }
  const db = getDb();
  const [decision] = await db
    .select()
    .from(decisions)
    .where(and(eq(decisions.id, c.req.param("decisionId")), eq(decisions.projectId, project.id)))
    .limit(1);
  if (!decision) throw new HttpError(404, "DECISION_NOT_FOUND", "Decision not found.");
  const [updated] = await db
    .update(decisions)
    .set({ status: body.status, decidedBy: user.displayName, decidedAt: new Date() })
    .where(eq(decisions.id, decision.id))
    .returning();
  await projectEmitter(project.tenantId, project.id)(EVENT_TYPES.decisionChanged, {
    decisionId: decision.id,
    action: body.status,
    title: decision.title,
  });
  await pauseAutoDevelopment(project.id, "decision");
  return c.json(updated);
});

app.get("/api/v1/projects/:projectId/approvals", async (c) => {
  const { project } = await requireProject(c);
  const db = getDb();
  const rows = await db
    .select()
    .from(approvals)
    .where(eq(approvals.projectId, project.id))
    .orderBy(desc(approvals.createdAt));
  return c.json({ items: rows });
});

async function ensurePhaseApproval(project: ProjectRow, to: WorkflowPhase, version: number) {
  // Entering a human-gated phase creates the approval object, so the gate is
  // actionable instead of an empty checklist item.
  if (to !== "review" && to !== "deliver") return;
  const db = getDb();
  const targetType = to === "review" ? "phase_review" : "delivery";
  const title = to === "review" ? "代码评审" : "交付审批";
  const [existing] = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      and(
        eq(approvals.projectId, project.id),
        eq(approvals.targetType, targetType),
        eq(approvals.status, "pending"),
      ),
    )
    .limit(1);
  if (existing) return;
  const approvalId = uuidv7();
  await db.insert(approvals).values({
    id: approvalId,
    projectId: project.id,
    targetType,
    targetVersion: version,
    title,
    status: "pending",
    requestedBy: "system",
    reason: `进入${PHASE_LABELS[to]}阶段需要人工确认。`,
  });
  await projectEmitter(project.tenantId, project.id)(EVENT_TYPES.approvalChanged, {
    approvalId,
    action: "requested",
    title,
    targetType,
  });
}

const approvalDecisionSchema = z.object({
  status: z.enum(APPROVAL_STATUSES as unknown as [string, ...string[]]),
  reason: z.string().max(2000).optional(),
});

app.post("/api/v1/projects/:projectId/approvals/:approvalId/decide", async (c) => {
  const user = c.get("user");
  const { project } = await requireProjectEditor(c);
  const body = approvalDecisionSchema.parse(await c.req.json());
  if (!["approved", "rejected"].includes(body.status)) {
    throw new HttpError(400, "INVALID_STATUS", "Approval status must be approved or rejected.");
  }
  const db = getDb();
  const [approval] = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.id, c.req.param("approvalId")), eq(approvals.projectId, project.id)))
    .limit(1);
  if (!approval) throw new HttpError(404, "APPROVAL_NOT_FOUND", "Approval not found.");
  if (approval.status !== "pending") throw new HttpError(409, "APPROVAL_SETTLED", "Approval already settled.");

  const phasePrefix = "phase_transition:";
  const phaseTarget = approval.targetType.startsWith(phasePrefix)
    ? (approval.targetType.slice(phasePrefix.length) as WorkflowPhase)
    : null;
  if (phaseTarget && !(WORKFLOW_PHASES as readonly string[]).includes(phaseTarget)) {
    throw new HttpError(400, "INVALID_PHASE_TARGET", "Phase proposal has an unknown target.");
  }
  const from = project.phase as WorkflowPhase;
  let transitionRequirements: Awaited<ReturnType<typeof gateRequirementsForTransition>> = [];
  if (body.status === "approved" && phaseTarget) {
    if (!canTransitionPhase(from, phaseTarget)) {
      throw new HttpError(
        409,
        "ILLEGAL_PHASE_TRANSITION",
        `Cannot move phase from ${from} to ${phaseTarget}.`,
      );
    }
    const bundle = await loadRoomBundle(project.id, (await roomFor(project)).id, 0);
    if (!bundle) throw new HttpError(404, "PROJECT_NOT_FOUND", "Project not found.");
    transitionRequirements = gateRequirementsForTransition(from, phaseTarget, {
      artifacts: bundle.artifacts.map((a) => ({ kind: a.kind, status: a.status, title: a.title })),
      tasks: bundle.tasks.map((t) => ({ status: t.status })),
      approvals: bundle.approvals.map((a) => ({ targetType: a.targetType, status: a.status })),
    });
    if (!transitionRequirements.every((r) => r.met)) {
      throw new HttpError(
        409,
        "PHASE_GATE_NOT_MET",
        "This phase transition is not ready yet.",
        { requirements: transitionRequirements },
      );
    }
  }

  const [updated] = await db
    .update(approvals)
    .set({
      status: body.status,
      decidedBy: user.displayName,
      decidedAt: new Date(),
      reason: body.reason ?? approval.reason,
    })
    .where(eq(approvals.id, approval.id))
    .returning();
  await projectEmitter(project.tenantId, project.id)(EVENT_TYPES.approvalChanged, {
    approvalId: approval.id,
    action: body.status,
    title: approval.title,
  });

  if (body.status === "approved" && phaseTarget) {
    const [updatedProject] = await db
      .update(projects)
      .set({ phase: phaseTarget, updatedAt: new Date(), version: project.version + 1 })
      .where(eq(projects.id, project.id))
      .returning();
    if (!updatedProject) throw new HttpError(404, "PROJECT_NOT_FOUND", "Project not found.");
    await projectEmitter(project.tenantId, project.id)(EVENT_TYPES.phaseChanged, {
      from,
      to: phaseTarget,
      by: user.displayName,
      agileLoop: phaseIndex(phaseTarget) <= phaseIndex(from),
      approvalId: approval.id,
    });
    await ensurePhaseApproval(project, phaseTarget, updatedProject.version);
    await audit({
      tenantId: project.tenantId,
      projectId: project.id,
      actorType: "user",
      actorId: user.id,
      action: "phase.changed",
      targetType: "project",
      targetId: project.id,
      detail: {
        from,
        to: phaseTarget,
        agileLoop: phaseIndex(phaseTarget) <= phaseIndex(from),
        approvalId: approval.id,
        requirements: transitionRequirements,
      },
    });
  }

  await audit({
    tenantId: project.tenantId,
    projectId: project.id,
    actorType: "user",
    actorId: user.id,
    action: `approval.${body.status}`,
    targetType: "approval",
    targetId: approval.id,
    detail: { reason: body.reason ?? null, phaseTarget },
  });
  await pauseAutoDevelopment(project.id, "approval");
  // A phase-transition approval already consumed the transition; do not chain
  // straight into another phase proposal. Review/delivery approvals are
  // different: they unlock the next forward step for the Lead to ask about.
  if (body.status === "approved" && !phaseTarget) {
    void nudgePhaseProposal(project.id, "approval_approved");
  }
  return c.json(updated);
});

// ---------------------------------------------------------------------------
// Workflow phase
// ---------------------------------------------------------------------------

const advanceSchema = z.object({
  to: z.enum(WORKFLOW_PHASES as unknown as [string, ...string[]]).optional(),
  note: z.string().max(2000).optional(),
  force: z.boolean().optional(),
});

app.post("/api/v1/projects/:projectId/advance", async (c) => {
  const user = c.get("user");
  const { project, role } = await requireProjectEditor(c);
  const body = advanceSchema.parse(await c.req.json());
  if (await hasPendingDecisions(project.id)) {
    throw new HttpError(
      409,
      "PENDING_DECISIONS",
      "Resolve pending decisions before changing phase; the AI proposal is the normal path.",
    );
  }
  const from = project.phase as WorkflowPhase;
  const to = (body.to ?? nextPhase(from)) as WorkflowPhase | null;
  if (!to) throw new HttpError(409, "WORKFLOW_COMPLETE", "Workflow is already complete.");
  if (!canTransitionPhase(from, to)) {
    throw new HttpError(
      409,
      "ILLEGAL_PHASE_TRANSITION",
      `Cannot move phase from ${from} to ${to}.`,
    );
  }

  const bundle = await loadRoomBundle(project.id, (await roomFor(project)).id, 0);
  if (!bundle) throw new HttpError(404, "PROJECT_NOT_FOUND", "Project not found.");
  const gateCtx = {
    artifacts: bundle.artifacts.map((a) => ({ kind: a.kind, status: a.status, title: a.title })),
    tasks: bundle.tasks.map((t) => ({ status: t.status })),
    approvals: bundle.approvals.map((a) => ({ targetType: a.targetType, status: a.status })),
  };
  const requirements = gateRequirementsForTransition(from, to, gateCtx);

  if (body.force) {
    if (!body.note) throw new HttpError(400, "FORCE_REASON_REQUIRED", "Forcing a phase change requires a note.");
    if (role !== "owner") throw new HttpError(403, "FORBIDDEN", "Only the project owner can force a phase change.");
  } else if (!requirements.every((r) => r.met)) {
    throw new HttpError(409, "PHASE_GATE_NOT_MET", "Phase requirements are not met.", {
      requirements,
    });
  }

  const db = getDb();
  const [updated] = await db
    .update(projects)
    .set({ phase: to, updatedAt: new Date(), version: project.version + 1 })
    .where(eq(projects.id, project.id))
    .returning();
  if (!updated) throw new HttpError(404, "PROJECT_NOT_FOUND", "Project not found.");

  await projectEmitter(project.tenantId, project.id)(EVENT_TYPES.phaseChanged, {
    from,
    to,
    by: user.displayName,
    forced: Boolean(body.force),
  });
  if (to === "build") void autoStartNext(project.id);

  await ensurePhaseApproval(project, to, updated.version);
  await audit({
    tenantId: project.tenantId,
    projectId: project.id,
    actorType: "user",
    actorId: user.id,
    action: "phase.changed",
    targetType: "project",
    targetId: project.id,
    detail: {
      from,
      to,
      forced: Boolean(body.force),
      note: body.note ?? null,
      agileLoop: phaseIndex(to) <= phaseIndex(from),
    },
  });

  return c.json(await buildSnapshot(updated));
});

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

app.get("/api/v1/projects/:projectId/runs", async (c) => {
  const { project } = await requireProject(c);
  const db = getDb();
  const rows = await db
    .select({ run: agentRuns, role: agentRoles })
    .from(agentRuns)
    .innerJoin(agentRoles, eq(agentRuns.roleId, agentRoles.id))
    .where(eq(agentRuns.projectId, project.id))
    .orderBy(desc(agentRuns.createdAt))
    .limit(50);
  return c.json({
    items: rows.map((row) => ({ ...row.run, roleKey: row.role.key, roleName: row.role.displayName })),
  });
});

// ---------------------------------------------------------------------------
// Code workspaces
// ---------------------------------------------------------------------------

async function requireWorkspace(c: Context<AppEnv>) {
  if (isDemoMode()) {
    throw new HttpError(403, "DEMO_MODE", "Code workspaces are disabled in demo mode.");
  }
  const user = c.get("user");
  const workspaceId = c.req.param("workspaceId");
  if (!workspaceId) throw new HttpError(400, "MISSING_WORKSPACE", "workspaceId is required.");
  const db = getDb();
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!workspace) throw new HttpError(404, "WORKSPACE_NOT_FOUND", "Workspace not found.");
  const access = await findProjectForUser(workspace.projectId, user.id);
  if (!access) throw new HttpError(404, "PROJECT_ACCESS_DENIED", "You do not have access to this workspace.");
  return { workspace, project: access.project, role: access.role };
}

app.get("/api/v1/projects/:projectId/workspaces", async (c) => {
  if (isDemoMode()) {
    throw new HttpError(403, "DEMO_MODE", "Code workspaces are disabled in demo mode.");
  }
  const { project } = await requireProject(c);
  const db = getDb();
  const rows = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.projectId, project.id))
    .orderBy(desc(workspaces.createdAt));
  return c.json({ items: rows });
});

app.get("/api/v1/projects/:projectId/repo/files", async (c) => {
  if (isDemoMode()) {
    throw new HttpError(403, "DEMO_MODE", "Repository browsing is disabled in demo mode.");
  }
  const { project } = await requireProject(c);
  if (!project.repoPath) {
    throw new HttpError(400, "REPO_NOT_CONFIGURED", "This project has no repository path.");
  }
  try {
    return c.json({ items: await listRepoFiles(project.repoPath) });
  } catch (error) {
    throw new HttpError(
      400,
      "REPO_PATH_INVALID",
      `仓库路径不可用：${error instanceof Error ? error.message : String(error)}。请在项目设置中修正。`,
    );
  }
});

app.get("/api/v1/projects/:projectId/repo/file", async (c) => {
  if (isDemoMode()) {
    throw new HttpError(403, "DEMO_MODE", "Repository browsing is disabled in demo mode.");
  }
  const { project } = await requireProject(c);
  if (!project.repoPath) {
    throw new HttpError(400, "REPO_NOT_CONFIGURED", "This project has no repository path.");
  }
  const path = c.req.query("path");
  if (!path) throw new HttpError(400, "MISSING_PATH", "path is required.");
  try {
    return c.json({ path, content: await readRepoFile(project.repoPath, path) });
  } catch (error) {
    throw new HttpError(
      400,
      "REPO_PATH_INVALID",
      `仓库路径不可用：${error instanceof Error ? error.message : String(error)}。请在项目设置中修正。`,
    );
  }
});

app.post("/api/v1/projects/:projectId/tasks/:taskId/work", async (c) => {
  if (isDemoMode()) {
    throw new HttpError(403, "DEMO_MODE", "Code execution is disabled in demo mode.");
  }
  const { project } = await requireProjectEditor(c);
  if (!project.repoPath) {
    throw new HttpError(
      400,
      "REPO_NOT_CONFIGURED",
      "This project has no repository path. Set repoPath before running code tasks.",
    );
  }
  const db = getDb();
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, c.req.param("taskId")), eq(tasks.projectId, project.id)))
    .limit(1);
  if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "Task not found.");
  if (["done", "cancelled"].includes(task.status)) {
    throw new HttpError(409, "TASK_NOT_RUNNABLE", `Task is ${task.status}.`);
  }
  const unmetDependencies = await db
    .select({ title: tasks.title, status: tasks.status })
    .from(taskDependencies)
    .innerJoin(tasks, eq(taskDependencies.dependsOnTaskId, tasks.id))
    .where(eq(taskDependencies.taskId, task.id));
  const blocking = unmetDependencies.filter(
    (dependency) => !["done", "cancelled"].includes(dependency.status),
  );
  if (blocking.length) {
    throw new HttpError(
      409,
      "DEPENDENCIES_NOT_MET",
      `Finish dependency tasks first: ${blocking.map((item) => item.title).join(", ")}`,
    );
  }

  try {
    const workspace = await startTaskForProject(project, task, {
      auto: project.autoStartTasks,
    });
    return c.json({ workspace, queued: true }, 202);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpError(
      400,
      message.includes("repository path") ? "REPO_PATH_INVALID" : "WORKSPACE_CREATE_FAILED",
      message.includes("repository path")
        ? `仓库路径不可用：${message}。请在项目设置中修正。`
        : message,
    );
  }
});

app.get("/api/v1/workspaces/:workspaceId/files", async (c) => {
  const { workspace } = await requireWorkspace(c);
  try {
    return c.json({ items: await listFiles(workspace.path) });
  } catch (error) {
    throw new HttpError(400, "FILES_LIST_FAILED", error instanceof Error ? error.message : String(error));
  }
});

app.get("/api/v1/workspaces/:workspaceId/file", async (c) => {
  const { workspace } = await requireWorkspace(c);
  const path = c.req.query("path");
  if (!path) throw new HttpError(400, "MISSING_PATH", "path is required.");
  try {
    return c.json({ path, content: await readWorkspaceFile(workspace.path, path) });
  } catch (error) {
    throw new HttpError(400, "FILE_READ_FAILED", error instanceof Error ? error.message : String(error));
  }
});

app.get("/api/v1/workspaces/:workspaceId/diff", async (c) => {
  const { workspace } = await requireWorkspace(c);
  const diff = await workspaceDiff(workspace.path, workspace.baseCommit);
  return c.json({ diff });
});

app.get("/api/v1/workspaces/:workspaceId/test-runs", async (c) => {
  const { workspace } = await requireWorkspace(c);
  const db = getDb();
  const rows = await db
    .select()
    .from(testRuns)
    .where(eq(testRuns.workspaceId, workspace.id))
    .orderBy(desc(testRuns.createdAt))
    .limit(30);
  return c.json({ items: rows });
});

const writeFileSchema = z.object({
  path: z.string().min(1).max(500),
  content: z.string().max(200_000),
});

app.put("/api/v1/workspaces/:workspaceId/file", async (c) => {
  const user = c.get("user");
  const { workspace, project, role } = await requireWorkspace(c);
  if (role === "viewer") {
    throw new HttpError(403, "READ_ONLY", "Viewers cannot edit workspace files.");
  }
  const body = writeFileSchema.parse(await c.req.json());
  const db = getDb();
  if (workQueue.isRunning(workspace.id)) {
    throw new HttpError(409, "WORK_ALREADY_RUNNING", "A code run or verification is already running.");
  }

  let task: typeof tasks.$inferSelect | undefined;
  if (workspace.taskId) {
    [task] = await db.select().from(tasks).where(eq(tasks.id, workspace.taskId)).limit(1);
    if (task && ["done", "cancelled"].includes(task.status)) {
      throw new HttpError(
        409,
        "TASK_CLOSED",
        "This task is closed. Create a new task instead of editing its workspace.",
      );
    }
  }

  try {
    await writeWorkspaceFile(workspace.path, body.path, body.content);
  } catch (error) {
    throw new HttpError(400, "FILE_WRITE_FAILED", error instanceof Error ? error.message : String(error));
  }

  let taskReopened = false;
  if (task && ["review", "testing"].includes(task.status)) {
    await db
      .update(tasks)
      .set({
        status: "in_progress",
        blockedReason: "代码已被人工修改，需要重新运行测试与规格核对",
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, task.id));
    await projectEmitter(project.tenantId, project.id)(EVENT_TYPES.taskChanged, {
      taskId: task.id,
      action: "reopened",
      title: task.title,
      status: "in_progress",
      reason: "human_edit",
    });
    taskReopened = true;
  }

  await audit({
    tenantId: project.tenantId,
    projectId: project.id,
    actorType: "user",
    actorId: user.id,
    action: "workspace.file_edited",
    targetType: "workspace",
    targetId: workspace.id,
    detail: { path: body.path, taskReopened, bytes: body.content.length },
  });
  await projectEmitter(project.tenantId, project.id)("workspace.file.changed", {
    workspaceId: workspace.id,
    path: body.path,
    by: user.displayName,
    taskReopened,
  });

  return c.json({ path: body.path, taskReopened });
});

app.post("/api/v1/workspaces/:workspaceId/verify", async (c) => {
  const { workspace, project, role } = await requireWorkspace(c);
  if (role === "viewer") {
    throw new HttpError(403, "READ_ONLY", "Viewers cannot run verification.");
  }
  if (!workspace.taskId) {
    throw new HttpError(400, "NO_TASK", "This workspace is not linked to a task.");
  }
  const db = getDb();
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, workspace.taskId), eq(tasks.projectId, project.id)))
    .limit(1);
  if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "Task not found.");
  if (["done", "cancelled"].includes(task.status)) {
    throw new HttpError(409, "TASK_CLOSED", `Task is ${task.status}.`);
  }
  if (workQueue.isRunning(workspace.id)) {
    throw new HttpError(409, "WORK_ALREADY_RUNNING", "A code run or verification is already running.");
  }
  const emit = projectEmitter(project.tenantId, project.id);
  workQueue.enqueue(workspace.id, (signal) =>
    verifyTaskWork({
      projectId: project.id,
      taskId: task.id,
      workspaceId: workspace.id,
      emit,
      signal,
    }),
  );
  return c.json({ queued: true }, 202);
});

app.post("/api/v1/workspaces/:workspaceId/merge", async (c) => {
  const user = c.get("user");
  const { workspace, project, role } = await requireWorkspace(c);
  if (role === "viewer") {
    throw new HttpError(403, "READ_ONLY", "Viewers cannot merge code.");
  }
  if (!project.repoPath) {
    throw new HttpError(400, "REPO_NOT_CONFIGURED", "This project has no repository path.");
  }
  if (!workspace.taskId) {
    throw new HttpError(400, "NO_TASK", "This workspace is not linked to a task.");
  }
  if (workQueue.isRunning(workspace.id)) {
    throw new HttpError(409, "WORK_ALREADY_RUNNING", "Wait for the current code run or verification to finish.");
  }
  const db = getDb();
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, workspace.taskId), eq(tasks.projectId, project.id)))
    .limit(1);
  if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "Task not found.");
  const evidence = (task.evidence ?? {}) as Record<string, unknown>;
  const verification = evidence["verification"] as { verdict?: string } | undefined;
  const previousMerge = evidence["merge"] as
    | { commit?: string; branch?: string; baseBranch?: string }
    | undefined;
  // A double click (or a retry after a successful merge) should be harmless.
  if (task.status === "done" && previousMerge?.commit) {
    return c.json({
      commit: previousMerge.commit,
      branch: previousMerge.branch ?? workspace.branch,
      baseBranch: previousMerge.baseBranch ?? project.defaultBranch,
    });
  }
  if (task.status !== "review") {
    throw new HttpError(
      409,
      "TASK_NOT_READY",
      "只有 review 状态的任务才能验收合并；测试或验证中的任务请等完成。",
    );
  }
  if (verification?.verdict !== "pass") {
    throw new HttpError(409, "SPEC_NOT_PASSED", "规格核对还没有通过，不能验收合并。");
  }

  let merged: { commit: string; branch: string; baseBranch: string };
  try {
    merged = await commitAndMergeWorkspace({
      repoPath: project.repoPath,
      workspacePath: workspace.path,
      branch: workspace.branch,
      baseBranch: project.defaultBranch || "main",
      message: task.title,
      authorName: user.displayName,
      authorEmail: user.email,
    });
  } catch (error) {
    throw new HttpError(
      409,
      "MERGE_FAILED",
      error instanceof Error ? error.message : String(error),
    );
  }

  const room = await roomFor(project);
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
          mergedBy: user.displayName,
        },
      },
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, task.id));
  await db
    .update(workspaces)
    .set({ status: "merged", updatedAt: new Date() })
    .where(eq(workspaces.id, workspace.id));

  const messageId = uuidv7();
  await insertMessage({
    id: messageId,
    tenantId: project.tenantId,
    projectId: project.id,
    roomId: room.id,
    senderType: "system",
    senderName: "系统",
    type: "system_event",
    content: `已验收并合并「${task.title}」到 ${merged.baseBranch}（${merged.commit.slice(0, 8)}）。`,
    metadata: {
      kind: "merge",
      taskId: task.id,
      workspaceId: workspace.id,
      commit: merged.commit,
      baseBranch: merged.baseBranch,
    },
  });
  await projectEmitter(project.tenantId, project.id)(EVENT_TYPES.messageCreated, {
    messageId,
    roomId: room.id,
    senderName: "系统",
    senderType: "system",
    type: "system_event",
  });
  await projectEmitter(project.tenantId, project.id)(EVENT_TYPES.taskChanged, {
    taskId: task.id,
    action: "merged",
    status: "done",
    commit: merged.commit,
    baseBranch: merged.baseBranch,
  });
  await projectEmitter(project.tenantId, project.id)("workspace.merged", {
    workspaceId: workspace.id,
    taskId: task.id,
    commit: merged.commit,
    baseBranch: merged.baseBranch,
  });
  await audit({
    tenantId: project.tenantId,
    projectId: project.id,
    actorType: "user",
    actorId: user.id,
    action: "task.merged",
    targetType: "task",
    targetId: task.id,
    detail: {
      branch: merged.branch,
      baseBranch: merged.baseBranch,
      commit: merged.commit,
    },
  });
  await pauseAutoDevelopment(project.id, "task_merged");
  void nudgePhaseProposal(project.id, "task_merged");
  return c.json(merged);
});

app.post("/api/v1/workspaces/:workspaceId/pull-request", async (c) => {
  const user = c.get("user");
  const { workspace, project, role } = await requireWorkspace(c);
  if (role === "viewer") {
    throw new HttpError(403, "READ_ONLY", "Viewers cannot push code.");
  }
  if (!project.repoPath) {
    throw new HttpError(400, "REPO_NOT_CONFIGURED", "This project has no repository path.");
  }
  if (!workspace.taskId) {
    throw new HttpError(400, "NO_TASK", "This workspace is not linked to a task.");
  }
  if (workQueue.isRunning(workspace.id)) {
    throw new HttpError(409, "WORK_ALREADY_RUNNING", "Wait for the current code run or verification to finish.");
  }
  const db = getDb();
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, workspace.taskId), eq(tasks.projectId, project.id)))
    .limit(1);
  if (!task) throw new HttpError(404, "TASK_NOT_FOUND", "Task not found.");
  if (task.status !== "review") {
    throw new HttpError(409, "TASK_NOT_READY", "Only a task in review can open a pull request.");
  }

  let pushed: { commit: string; remote: string; branch: string };
  try {
    pushed = await pushWorkspaceBranch({
      repoPath: project.repoPath,
      workspacePath: workspace.path,
      branch: workspace.branch,
      remoteUrl: project.repoUrl,
      message: task.title,
      authorName: user.displayName,
      authorEmail: user.email,
    });
  } catch (error) {
    throw new HttpError(
      409,
      "PUSH_FAILED",
      error instanceof Error ? error.message : String(error),
    );
  }

  let pullRequest: { url: string; number: number } | null = null;
  let warning: string | null = null;
  try {
    pullRequest = await createPullRequest({
      remote: project.repoUrl ?? pushed.remote,
      branch: pushed.branch,
      baseBranch: project.defaultBranch || "main",
      title: task.title,
      body: [
        "## Fucking Code 自动提交",
        "",
        task.description || "（无任务描述）",
        "",
        "### 验收标准",
        ...(task.acceptance.length ? task.acceptance.map((item) => `- ${item}`) : ["- 无"]),
      ].join("\n"),
    });
    if (!pullRequest) {
      warning = process.env.GITHUB_TOKEN
        ? "已推送分支，但远程不是 GitHub 仓库，未创建 PR。"
        : "已推送分支；未配置 GITHUB_TOKEN，未创建 PR。";
    }
  } catch (error) {
    warning = error instanceof Error ? error.message : String(error);
  }

  const evidence = (task.evidence ?? {}) as Record<string, unknown>;
  await db
    .update(tasks)
    .set({
      evidence: {
        ...evidence,
        pullRequest: {
          commit: pushed.commit,
          branch: pushed.branch,
          remote: pushed.remote,
          url: pullRequest?.url ?? null,
          number: pullRequest?.number ?? null,
          pushedAt: new Date().toISOString(),
          warning,
        },
      },
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, task.id));
  await projectEmitter(project.tenantId, project.id)(EVENT_TYPES.taskChanged, {
    taskId: task.id,
    action: "pull_request",
    branch: pushed.branch,
    prUrl: pullRequest?.url ?? null,
  });
  await audit({
    tenantId: project.tenantId,
    projectId: project.id,
    actorType: "user",
    actorId: user.id,
    action: "task.pull_request",
    targetType: "task",
    targetId: task.id,
    detail: {
      branch: pushed.branch,
      commit: pushed.commit,
      prUrl: pullRequest?.url ?? null,
      warning,
    },
  });
  return c.json({ ...pushed, pullRequest, warning });
});

app.post("/api/v1/workspaces/:workspaceId/cancel", async (c) => {
  const user = c.get("user");
  const { workspace, project, role } = await requireWorkspace(c);
  if (role === "viewer") {
    throw new HttpError(403, "READ_ONLY", "Viewers cannot cancel code runs.");
  }
  const cancelled = workQueue.stop(workspace.id);
  if (!cancelled) {
    throw new HttpError(409, "WORK_NOT_RUNNING", "No code run or verification is currently running.");
  }
  await projectEmitter(project.tenantId, project.id)("workspace.run.cancelled", {
    workspaceId: workspace.id,
    by: user.displayName,
  });
  await audit({
    tenantId: project.tenantId,
    projectId: project.id,
    actorType: "user",
    actorId: user.id,
    action: "workspace.run_cancelled",
    targetType: "workspace",
    targetId: workspace.id,
  });
  return c.json({ cancelled: true });
});

const commandSchema = z.object({ command: z.string().min(1).max(500) });

app.post("/api/v1/workspaces/:workspaceId/commands", async (c) => {
  const user = c.get("user");
  const { workspace, project, role } = await requireWorkspace(c);
  if (role === "viewer") {
    throw new HttpError(403, "READ_ONLY", "Viewers cannot run workspace commands.");
  }
  const body = commandSchema.parse(await c.req.json());
  const result = await runCommand(workspace.path, body.command, 180_000);
  const id = uuidv7();
  const db = getDb();
  await db.insert(testRuns).values({
    id,
    projectId: project.id,
    workspaceId: workspace.id,
    command: result.command,
    exitCode: result.exitCode,
    status: result.status,
    output: result.output.slice(0, 50_000),
    durationMs: result.durationMs,
  });
  await projectEmitter(project.tenantId, project.id)("workspace.command.finished", {
    workspaceId: workspace.id,
    command: result.command,
    status: result.status,
    exitCode: result.exitCode,
    by: user.displayName,
  });
  return c.json({ ...result, testRunId: id });
});

app.all("/api/*", (c) =>
  c.json(
    {
      error: {
        code: "NOT_FOUND",
        message: "Not found.",
        requestId: c.get("requestId") ?? "",
      },
    },
    404,
  ),
);

export { app };
