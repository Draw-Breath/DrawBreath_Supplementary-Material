ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS background_original_name text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS background_mime_type varchar(80) NOT NULL DEFAULT 'image/png';
