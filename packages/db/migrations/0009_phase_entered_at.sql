-- Scope phase gates to evidence produced for the current phase.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS phase_entered_at TIMESTAMPTZ NOT NULL DEFAULT now();
