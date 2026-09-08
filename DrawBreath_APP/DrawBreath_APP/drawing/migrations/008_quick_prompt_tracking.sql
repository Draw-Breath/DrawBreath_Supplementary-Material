ALTER TABLE assistant_messages
  ADD COLUMN IF NOT EXISTS quick_prompt_key varchar(40) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS conversation_id uuid;

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS active_conversation_id uuid;

UPDATE assistant_messages messages
SET conversation_id = source.conversation_id
FROM (
  SELECT DISTINCT workspace_id, workspace_id AS conversation_id
  FROM assistant_messages
) source
WHERE messages.workspace_id = source.workspace_id
  AND messages.conversation_id IS NULL;

UPDATE workspaces workspace
SET active_conversation_id = source.conversation_id
FROM (
  SELECT workspace_id, max(conversation_id::text)::uuid AS conversation_id
  FROM assistant_messages
  WHERE conversation_id IS NOT NULL
  GROUP BY workspace_id
) source
WHERE workspace.id = source.workspace_id
  AND workspace.active_conversation_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_drawing_assistant_messages_conversation
  ON assistant_messages(workspace_id, conversation_id, id);
