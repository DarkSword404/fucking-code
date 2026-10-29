-- Extracted archive contents for chat attachments.
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS extracted_path TEXT;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS entry_count INTEGER;
