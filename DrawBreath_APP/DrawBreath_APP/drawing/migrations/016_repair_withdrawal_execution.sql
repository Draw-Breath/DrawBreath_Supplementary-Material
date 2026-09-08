UPDATE withdrawal_events AS withdrawal
SET status = 'cancelled',
    cancelled_active_seconds = workspace.active_seconds,
    cancellation_reason = 'stale-visible-withdrawal-reference',
    cancelled_at = now()
FROM workspaces AS workspace
WHERE workspace.active_withdrawal_id = withdrawal.id
  AND workspace.assistant_state NOT IN ('fading', 'withdrawn')
  AND withdrawal.status IN ('candidate', 'fading');

UPDATE workspaces
SET active_withdrawal_id = NULL,
    withdrawal_candidate_started_active_seconds = NULL,
    next_ai_review_active_seconds = 0,
    updated_at = now()
WHERE status = 'draft'
  AND assistant_state NOT IN ('fading', 'withdrawn')
  AND active_withdrawal_id IS NOT NULL;

UPDATE workspaces
SET withdrawal_review_request_id = NULL,
    withdrawal_review_claimed_at = NULL,
    withdrawal_review_active_seconds = NULL,
    assistant_response_pending = false,
    assistant_response_request_id = NULL,
    next_ai_review_active_seconds = 0,
    updated_at = now()
WHERE status = 'draft'
  AND (
    withdrawal_review_request_id IS NOT NULL
    OR assistant_response_pending = true
    OR assistant_response_request_id IS NOT NULL
  );
