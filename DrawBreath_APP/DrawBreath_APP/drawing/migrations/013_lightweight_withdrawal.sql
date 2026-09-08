ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS last_assistant_response_active_seconds integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_assistant_response_operation_seq integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_ai_review_operation_seq integer NOT NULL DEFAULT 0;

ALTER TABLE tasks ALTER COLUMN rule_version SET DEFAULT 'withdrawal_light_gate_ai_v2';
