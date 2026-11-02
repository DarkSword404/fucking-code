-- First-class delivery iteration: scope, tasks, evidence, gates.
CREATE TABLE IF NOT EXISTS iterations (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planning',
  base_commit TEXT,
  target_commit TEXT,
  scope JSONB NOT NULL DEFAULT '[]'::jsonb,
  plan_artifact_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT iterations_project_name_unique UNIQUE (project_id, name)
);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS current_iteration_id UUID;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS iteration_id UUID;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS acceptance_refs JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS gate_key TEXT;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS iteration_id UUID;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS acceptance_refs JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS commit TEXT;
