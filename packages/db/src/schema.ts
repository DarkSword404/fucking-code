import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  createdAt,
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    passwordHash: text("password_hash"),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    isAdmin: boolean("is_admin").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt,
  },
  (t) => [unique("users_tenant_email_unique").on(t.tenantId, t.email), unique("users_email_unique").on(t.email)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    createdAt,
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  },
  (t) => [unique("sessions_token_hash_unique").on(t.tokenHash)],
);

export const repoTokens = pgTable(
  "repo_tokens",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull().default(""),
    tokenHash: text("token_hash").notNull().unique(),
    createdBy: uuid("created_by"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt,
  },
  (t) => [index("repo_tokens_project_idx").on(t.projectId)],
);

export const inviteCodes = pgTable("invite_codes", {
  id: uuid("id").primaryKey(),
  code: text("code").notNull().unique(),
  label: text("label").notNull().default(""),
  createdBy: uuid("created_by"),
  maxUses: integer("max_uses").notNull().default(1),
  uses: integer("uses").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  active: boolean("active").notNull().default(true),
  createdAt,
});

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description").notNull().default(""),
    phase: text("phase").notNull().default("requirements"),
    status: text("status").notNull().default("active"),
    repoUrl: text("repo_url"),
    repoPath: text("repo_path"),
    repoSyncStatus: text("repo_sync_status").notNull().default("idle"),
    repoSyncError: text("repo_sync_error"),
    repoSyncedAt: timestamp("repo_synced_at", { withTimezone: true }),
    repoSyncedCommit: text("repo_synced_commit"),
    defaultBranch: text("default_branch").notNull().default("main"),
    baseCommit: text("base_commit"),
    budgetCents: integer("budget_cents").notNull().default(0),
    spentCents: integer("spent_cents").notNull().default(0),
    autoStartTasks: boolean("auto_start_tasks").notNull().default(true),
    /**
     * Non-null means the system paused auto development (pending decision,
     * approval, failed task). NULL means the user turned it off. Persisted so
     * a restart does not mistake a system pause for a user pause.
     */
    autoPauseReason: text("auto_pause_reason"),
    version: integer("version").notNull().default(1),
    createdAt,
    updatedAt,
  },
  (t) => [unique("projects_tenant_slug_unique").on(t.tenantId, t.slug)],
);

export const projectMembers = pgTable(
  "project_members",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("owner"),
    createdAt,
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] })],
);

export const rooms = pgTable("rooms", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: text("kind").notNull().default("main"),
  createdAt,
});

export const agentRoles = pgTable(
  "agent_roles",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    displayName: text("display_name").notNull(),
    description: text("description").notNull().default(""),
    systemPrompt: text("system_prompt").notNull(),
    modelProvider: text("model_provider"),
    modelId: text("model_id"),
    color: text("color").notNull().default("#888888"),
    capabilities: jsonb("capabilities").$type<string[]>().notNull().default([]),
    enabled: boolean("enabled").notNull().default(true),
    inRoom: boolean("in_room").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt,
  },
  (t) => [unique("agent_roles_project_key_unique").on(t.projectId, t.key)],
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => agentRoles.id, { onDelete: "cascade" }),
    triggerMessageId: uuid("trigger_message_id"),
    workspaceId: uuid("workspace_id"),
    status: text("status").notNull().default("queued"),
    modelProvider: text("model_provider"),
    modelId: text("model_id"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    error: text("error"),
    costCents: integer("cost_cents").notNull().default(0),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt,
  },
  (t) => [index("idx_agent_runs_project").on(t.projectId, t.createdAt)],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    seq: bigserial("seq", { mode: "number" }).notNull().unique(),
    senderType: text("sender_type").notNull(),
    senderId: uuid("sender_id"),
    senderName: text("sender_name").notNull(),
    type: text("type").notNull().default("discussion"),
    content: text("content").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    replyToId: uuid("reply_to_id"),
    taskId: uuid("task_id"),
    artifactId: uuid("artifact_id"),
    decisionId: uuid("decision_id"),
    runId: uuid("run_id"),
    createdAt,
  },
  (t) => [index("idx_messages_room_seq").on(t.roomId, t.seq)],
);

export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    path: text("path").notNull(),
    extractedPath: text("extracted_path"),
    entryCount: integer("entry_count"),
    createdBy: uuid("created_by"),
    createdAt,
  },
  (t) => [index("attachments_project_idx").on(t.projectId, t.messageId)],
);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").notNull().default("proposed"),
    mode: text("mode").notNull().default("code"),
    priority: text("priority").notNull().default("medium"),
    roleKey: text("role_key"),
    createdFromMessageId: uuid("created_from_message_id"),
    requirementVersion: integer("requirement_version").notNull().default(1),
    spec: jsonb("spec").$type<Record<string, unknown>>().notNull().default({}),
    acceptance: jsonb("acceptance").$type<string[]>().notNull().default([]),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default({}),
    blockedReason: text("blocked_reason"),
    createdAt,
    updatedAt,
  },
  (t) => [index("idx_tasks_project_status").on(t.projectId, t.status)],
);

export const taskDependencies = pgTable(
  "task_dependencies",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    dependsOnTaskId: uuid("depends_on_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.dependsOnTaskId] })],
);

export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    artifactKey: text("artifact_key").notNull().default(""),
    title: text("title").notNull(),
    status: text("status").notNull().default("draft"),
    currentVersion: integer("current_version").notNull().default(1),
    createdByType: text("created_by_type").notNull().default("agent"),
    createdById: uuid("created_by_id"),
    createdAt,
    updatedAt,
  },
  (t) => [unique("artifacts_project_kind_title_unique").on(t.projectId, t.kind, t.title)],
);

export const artifactVersions = pgTable(
  "artifact_versions",
  {
    id: uuid("id").primaryKey(),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    content: text("content").notNull(),
    summary: text("summary").notNull().default(""),
    sourceMessageId: uuid("source_message_id"),
    createdBy: text("created_by"),
    createdAt,
  },
  (t) => [unique("artifact_versions_artifact_version_unique").on(t.artifactId, t.version)],
);

export const decisions = pgTable("decisions", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  status: text("status").notNull().default("proposed"),
  rationale: text("rationale").notNull().default(""),
  alternatives: jsonb("alternatives").$type<string[]>().notNull().default([]),
  proposedBy: text("proposed_by"),
  decidedBy: text("decided_by"),
  sourceMessageId: uuid("source_message_id"),
  createdAt,
  decidedAt: timestamp("decided_at", { withTimezone: true }),
});

export const approvals = pgTable("approvals", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  targetType: text("target_type").notNull(),
  targetId: uuid("target_id"),
  targetVersion: integer("target_version").notNull().default(1),
  title: text("title").notNull(),
  status: text("status").notNull().default("pending"),
  requestedBy: text("requested_by"),
  decidedBy: text("decided_by"),
  reason: text("reason"),
  createdAt,
  decidedAt: timestamp("decided_at", { withTimezone: true }),
});

export const memories = pgTable("memories", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  status: text("status").notNull().default("proposed"),
  version: integer("version").notNull().default(1),
  sourceMessageIds: jsonb("source_message_ids").$type<string[]>().notNull().default([]),
  confidence: real("confidence"),
  createdAt,
  updatedAt,
});

export const events = pgTable("events", {
  seq: bigserial("seq", { mode: "number" }).primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  projectId: uuid("project_id").notNull(),
  type: text("type").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  createdAt,
});

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  projectId: uuid("project_id"),
  actorType: text("actor_type").notNull(),
  actorId: text("actor_id"),
  action: text("action").notNull(),
  targetType: text("target_type"),
  targetId: text("target_id"),
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
  createdAt,
});

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    path: text("path").notNull(),
    branch: text("branch").notNull(),
    baseCommit: text("base_commit"),
    status: text("status").notNull().default("ready"),
    createdAt,
    updatedAt,
  },
  (t) => [unique("workspaces_project_task_unique").on(t.projectId, t.taskId)],
);

export const testRuns = pgTable("test_runs", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  command: text("command").notNull(),
  exitCode: integer("exit_code"),
  status: text("status").notNull().default("running"),
  output: text("output").notNull().default(""),
  durationMs: integer("duration_ms"),
  createdAt,
});

export type Schema = {
  tenants: typeof tenants;
  users: typeof users;
  projects: typeof projects;
  projectMembers: typeof projectMembers;
  rooms: typeof rooms;
  agentRoles: typeof agentRoles;
  agentRuns: typeof agentRuns;
  messages: typeof messages;
  tasks: typeof tasks;
  taskDependencies: typeof taskDependencies;
  artifacts: typeof artifacts;
  artifactVersions: typeof artifactVersions;
  decisions: typeof decisions;
  approvals: typeof approvals;
  memories: typeof memories;
  events: typeof events;
  auditEvents: typeof auditEvents;
};
