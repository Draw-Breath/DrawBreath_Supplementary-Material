ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS new_attempts_allowed boolean NOT NULL DEFAULT true;

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS attempt_number integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS timing_started_at timestamptz;

ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS workspaces_participant_id_key;

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_canvas_width_check;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_canvas_height_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_canvas_width_check CHECK (canvas_width BETWEEN 1 AND 4096);
ALTER TABLE tasks ADD CONSTRAINT tasks_canvas_height_check CHECK (canvas_height BETWEEN 1 AND 4096);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_participant_attempt
  ON workspaces(participant_id, attempt_number);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_one_active_attempt
  ON workspaces(participant_id) WHERE status = 'draft';

CREATE INDEX IF NOT EXISTS idx_workspaces_task_attempt
  ON workspaces(task_id, participant_id, attempt_number DESC);
