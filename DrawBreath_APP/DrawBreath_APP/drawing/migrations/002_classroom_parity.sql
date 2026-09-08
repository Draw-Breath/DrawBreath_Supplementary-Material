CREATE TABLE IF NOT EXISTS student_accounts (
  id uuid PRIMARY KEY,
  student_code varchar(80) NOT NULL UNIQUE,
  student_number varchar(80) NOT NULL,
  student_number_key varchar(80) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS student_exit_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS student_whitelist_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS voice_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS intervention_mode varchar(20) NOT NULL DEFAULT 'timer',
  ADD COLUMN IF NOT EXISTS intervention_interval_seconds integer NOT NULL DEFAULT 120,
  ADD COLUMN IF NOT EXISTS max_interventions integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS snapshot_interval_seconds integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS ai_appear_seconds integer NOT NULL DEFAULT 300,
  ADD COLUMN IF NOT EXISTS flow_window_seconds integer NOT NULL DEFAULT 120,
  ADD COLUMN IF NOT EXISTS flow_idle_seconds integer NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS flow_evaluation_interval_seconds integer NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS withdrawal_seconds integer NOT NULL DEFAULT 12,
  ADD COLUMN IF NOT EXISTS reopen_cooldown_seconds integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS minimum_operations integer NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS ai_policy varchar(20) NOT NULL DEFAULT 'adaptive',
  ADD COLUMN IF NOT EXISTS ai_lifecycle_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE participants
  ADD COLUMN IF NOT EXISTS student_account_id uuid REFERENCES student_accounts(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS consent_confirmed boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS idx_participants_task_account
  ON participants(task_id, student_account_id) WHERE student_account_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_student_whitelist (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  student_number varchar(80) NOT NULL,
  student_number_key varchar(80) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, student_number_key)
);
