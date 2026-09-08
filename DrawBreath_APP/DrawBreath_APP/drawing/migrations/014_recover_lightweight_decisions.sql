ALTER TABLE ai_decisions
  ADD COLUMN IF NOT EXISTS raw_response jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE tasks ALTER COLUMN rule_version SET DEFAULT 'withdrawal_light_gate_ai_v2';

UPDATE workspaces AS workspace
SET last_ai_review_operation_seq = workspace.last_assistant_response_operation_seq,
    next_ai_review_active_seconds = 0,
    updated_at = now()
FROM tasks AS task
WHERE workspace.task_id = task.id
  AND workspace.status = 'draft'
  AND task.rule_version = 'withdrawal_light_gate_ai_v2'
  AND workspace.last_ai_review_operation_seq > workspace.last_assistant_response_operation_seq;
