CREATE TABLE IF NOT EXISTS staff_users (
  id uuid PRIMARY KEY,
  username varchar(80) NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name varchar(100) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
  title varchar(160) NOT NULL,
  join_code varchar(12) NOT NULL UNIQUE,
  status varchar(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'closed')),
  prompt text NOT NULL,
  instructions text NOT NULL DEFAULT '',
  background_path text NOT NULL,
  canvas_width integer NOT NULL DEFAULT 1200 CHECK (canvas_width BETWEEN 400 AND 2400),
  canvas_height integer NOT NULL DEFAULT 800 CHECK (canvas_height BETWEEN 300 AND 1800),
  time_limit_seconds integer NOT NULL DEFAULT 2700 CHECK (time_limit_seconds BETWEEN 60 AND 14400),
  ai_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS participants (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  display_name varchar(100) NOT NULL,
  student_number varchar(100) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, student_number)
);
CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY,
  participant_id uuid NOT NULL UNIQUE REFERENCES participants(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  draft_image_path text,
  final_image_path text,
  active_seconds integer NOT NULL DEFAULT 0,
  operation_count integer NOT NULL DEFAULT 0,
  status varchar(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted')),
  submitted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS assistant_messages (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role varchar(20) NOT NULL CHECK (role IN ('student', 'assistant')),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_participants_task ON participants(task_id, created_at);
