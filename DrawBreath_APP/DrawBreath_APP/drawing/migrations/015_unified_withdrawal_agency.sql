ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS withdrawal_review_request_id uuid,
  ADD COLUMN IF NOT EXISTS withdrawal_review_claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS withdrawal_review_active_seconds integer,
  ADD COLUMN IF NOT EXISTS assistant_response_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS assistant_response_request_id uuid;

UPDATE tasks
SET rule_version = 'withdrawal_rules_v1'
WHERE rule_version IS DISTINCT FROM 'withdrawal_rules_v1';

ALTER TABLE tasks ALTER COLUMN rule_version SET DEFAULT 'withdrawal_rules_v1';
