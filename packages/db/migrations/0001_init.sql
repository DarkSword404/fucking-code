-- Fucking Code — initial PostgreSQL schema.
-- Applied idempotently at boot by packages/db/src/migrate.ts.
-- Production note: replace with versioned migrations before the first release.

CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT,
  last_login_at TIMESTAMPTZ,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, email),
  UNIQUE (email)
);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS invite_codes (
  id UUID PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  created_by UUID,
  max_uses INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  phase TEXT NOT NULL DEFAULT 'intake',
  status TEXT NOT NULL DEFAULT 'active',
  repo_url TEXT,
  repo_path TEXT,
  default_branch TEXT NOT NULL DEFAULT 'main',
  base_commit TEXT,
  budget_cents INTEGER NOT NULL DEFAULT 0,
  spent_cents INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, slug),
  CONSTRAINT chk_project_phase CHECK (phase IN
    ('intake','discovery','design','planning','build','test','review','deliver','done'))
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS rooms (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'main',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_roles (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL,
  model_provider TEXT,
  model_id TEXT,
  color TEXT NOT NULL DEFAULT '#888888',
  capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  in_room BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, key)
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES agent_roles(id) ON DELETE CASCADE,
  trigger_message_id UUID,
  workspace_id UUID,
  status TEXT NOT NULL DEFAULT 'queued',
  model_provider TEXT,
  model_id TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  error TEXT,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_run_status CHECK (status IN
    ('queued','starting','running','waiting_input','waiting_approval','succeeded',
     'failed','cancel_requested','cancelled','timed_out','orphaned'))
);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  seq BIGSERIAL NOT NULL UNIQUE,
  sender_type TEXT NOT NULL,
  sender_id UUID,
  sender_name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'discussion',
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  reply_to_id UUID,
  task_id UUID,
  artifact_id UUID,
  decision_id UUID,
  run_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_sender_type CHECK (sender_type IN ('user','agent','system')),
  CONSTRAINT chk_message_type CHECK (type IN
    ('discussion','question','proposal','review_request','decision','task_handoff',
     'artifact','blocker','system_event'))
);

CREATE INDEX IF NOT EXISTS idx_messages_room_seq ON messages(room_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_project_seq ON messages(project_id, seq DESC);

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'proposed',
  priority TEXT NOT NULL DEFAULT 'medium',
  role_key TEXT,
  created_from_message_id UUID,
  requirement_version INTEGER NOT NULL DEFAULT 1,
  spec JSONB NOT NULL DEFAULT '{}'::jsonb,
  acceptance JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  blocked_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_task_status CHECK (status IN
    ('proposed','ready','in_progress','blocked','review','testing','done',
     'failed','cancelled','stale','needs_replan'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_task_id),
  CONSTRAINT chk_no_self_dependency CHECK (task_id <> depends_on_task_id)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  artifact_key TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  current_version INTEGER NOT NULL DEFAULT 1,
  created_by_type TEXT NOT NULL DEFAULT 'agent',
  created_by_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, kind, title)
);

CREATE INDEX IF NOT EXISTS idx_artifacts_project_kind ON artifacts(project_id, kind);

CREATE TABLE IF NOT EXISTS artifact_versions (
  id UUID PRIMARY KEY,
  artifact_id UUID NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  source_message_id UUID,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (artifact_id, version)
);

CREATE TABLE IF NOT EXISTS decisions (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  rationale TEXT NOT NULL DEFAULT '',
  alternatives JSONB NOT NULL DEFAULT '[]'::jsonb,
  proposed_by TEXT,
  decided_by TEXT,
  source_message_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS approvals (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  target_id UUID,
  target_version INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by TEXT,
  decided_by TEXT,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_approvals_project_status ON approvals(project_id, status);

CREATE TABLE IF NOT EXISTS memories (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  version INTEGER NOT NULL DEFAULT 1,
  source_message_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence REAL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS events (
  seq BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  project_id UUID NOT NULL,
  type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_project_seq ON events(project_id, seq);

CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  project_id UUID,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Code workspaces and test evidence
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  path TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_commit TEXT,
  status TEXT NOT NULL DEFAULT 'ready',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_workspaces_project ON workspaces(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS test_runs (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  command TEXT NOT NULL,
  exit_code INTEGER,
  status TEXT NOT NULL DEFAULT 'running',
  output TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS workspace_id UUID;
ALTER TABLE agent_roles ADD COLUMN IF NOT EXISTS in_room BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS artifact_key TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS spec JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS idx_artifacts_project_key ON artifacts(project_id, kind, artifact_key);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users(email);

