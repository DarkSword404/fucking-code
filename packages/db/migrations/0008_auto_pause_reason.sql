-- Distinguish a system pause from a user pause across restarts.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS auto_pause_reason TEXT;
