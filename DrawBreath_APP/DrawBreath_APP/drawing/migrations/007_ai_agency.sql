ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS assistant_state varchar(20) NOT NULL DEFAULT 'hidden',
  ADD COLUMN IF NOT EXISTS assistant_visible_active_seconds integer,
  ADD COLUMN IF NOT EXISTS last_ai_access_active_seconds integer,
  ADD COLUMN IF NOT EXISTS latest_withdrawal_active_seconds integer,
  ADD COLUMN IF NOT EXISTS next_ai_review_active_seconds integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS ai_decisions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  active_seconds integer NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  normalized_decision jsonb NOT NULL DEFAULT '{}'::jsonb,
  prompt_system text NOT NULL DEFAULT '',
  prompt_input text NOT NULL DEFAULT '',
  model_name varchar(160) NOT NULL DEFAULT '',
  fallback boolean NOT NULL DEFAULT false,
  response_error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_drawing_ai_decisions_workspace
  ON ai_decisions(workspace_id, active_seconds DESC);
