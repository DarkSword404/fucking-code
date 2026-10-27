-- Six-stage lifecycle, keeping operations as a persistent service state.
ALTER TABLE projects DROP CONSTRAINT IF EXISTS chk_project_phase;
ALTER TABLE projects ALTER COLUMN phase SET DEFAULT 'requirements';
UPDATE projects SET phase = CASE phase
  WHEN 'intake' THEN 'requirements'
  WHEN 'discovery' THEN 'requirements'
  WHEN 'design' THEN 'design'
  WHEN 'planning' THEN 'design'
  WHEN 'build' THEN 'coding'
  WHEN 'test' THEN 'testing'
  WHEN 'review' THEN 'testing'
  WHEN 'deliver' THEN 'deployment'
  WHEN 'done' THEN 'operations'
  ELSE phase
END
WHERE phase IN ('intake','discovery','design','planning','build','test','review','deliver','done');
ALTER TABLE projects ADD CONSTRAINT chk_project_phase CHECK
  (phase IN ('requirements','design','coding','testing','deployment','operations'));
