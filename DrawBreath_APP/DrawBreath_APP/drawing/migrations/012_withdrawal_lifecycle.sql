ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS flow_consecutive_passes integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS withdrawal_candidate_started_active_seconds integer,
  ADD COLUMN IF NOT EXISTS active_withdrawal_id uuid;

ALTER TABLE ai_decisions
  ADD COLUMN IF NOT EXISTS raw_response jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS flow_evaluations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  active_seconds integer NOT NULL,
  window_seconds integer NOT NULL,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  thresholds jsonb NOT NULL DEFAULT '{}'::jsonb,
  passed boolean NOT NULL,
  consecutive_passes integer NOT NULL DEFAULT 0,
  decision varchar(24) NOT NULL CHECK (decision IN ('not_eligible', 'keep_visible', 'withdraw')),
  evaluated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS withdrawal_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id uuid,
  withdrawal_number integer NOT NULL CHECK (withdrawal_number > 0),
  status varchar(24) NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'fading', 'withdrawn', 'cancelled')),
  candidate_started_active_seconds integer NOT NULL DEFAULT 0,
  candidate_updated_active_seconds integer NOT NULL DEFAULT 0,
  fade_started_active_seconds integer,
  completed_active_seconds integer,
  cancelled_active_seconds integer,
  cancellation_reason varchar(80) NOT NULL DEFAULT '',
  trigger_metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  trigger_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  cancelled_at timestamptz,
  UNIQUE (workspace_id, withdrawal_number)
);

ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS workspaces_active_withdrawal_id_fkey;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_active_withdrawal_id_fkey
  FOREIGN KEY (active_withdrawal_id) REFERENCES withdrawal_events(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_drawing_flow_evaluations_workspace
  ON flow_evaluations(workspace_id, active_seconds DESC);
CREATE INDEX IF NOT EXISTS idx_drawing_withdrawal_events_workspace
  ON withdrawal_events(workspace_id, withdrawal_number DESC);
