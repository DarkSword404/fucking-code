-- Last automatic/manual push of the project's base branch to its remote.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS repo_sync_status TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS repo_sync_error TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS repo_synced_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS repo_synced_commit TEXT;
