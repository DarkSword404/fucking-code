-- Tasks are either normal coding work or a read-only tool workbench
-- (QA walkthrough, security scan, deployment check).
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'code';
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS chk_task_mode;
ALTER TABLE tasks ADD CONSTRAINT chk_task_mode CHECK (mode IN ('code','workbench'));
