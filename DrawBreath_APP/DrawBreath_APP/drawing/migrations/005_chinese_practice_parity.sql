ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS ai_min_visible_seconds integer NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS flow_consecutive_passes integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS ai_access_quiet_seconds integer NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS withdrawal_candidate_seconds integer NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS withdrawal_fade_milliseconds integer NOT NULL DEFAULT 2500,
  ADD COLUMN IF NOT EXISTS post_withdrawal_observation_seconds integer NOT NULL DEFAULT 90,
  ADD COLUMN IF NOT EXISTS rule_version varchar(80) NOT NULL DEFAULT 'withdrawal_rules_v1',
  ADD COLUMN IF NOT EXISTS artwork_pass_score integer NOT NULL DEFAULT 55;

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_time_limit_seconds_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_time_limit_seconds_check CHECK (time_limit_seconds BETWEEN 0 AND 7200);

ALTER TABLE tasks ALTER COLUMN time_limit_seconds SET DEFAULT 900;
ALTER TABLE tasks ALTER COLUMN snapshot_interval_seconds SET DEFAULT 30;
ALTER TABLE tasks ALTER COLUMN ai_appear_seconds SET DEFAULT 120;
ALTER TABLE tasks ALTER COLUMN flow_window_seconds SET DEFAULT 30;
ALTER TABLE tasks ALTER COLUMN flow_idle_seconds SET DEFAULT 10;
ALTER TABLE tasks ALTER COLUMN flow_evaluation_interval_seconds SET DEFAULT 15;
ALTER TABLE tasks ALTER COLUMN reopen_cooldown_seconds SET DEFAULT 180;
ALTER TABLE tasks ALTER COLUMN ai_policy SET DEFAULT 'adaptive';
ALTER TABLE tasks ALTER COLUMN ai_lifecycle_enabled SET DEFAULT true;
