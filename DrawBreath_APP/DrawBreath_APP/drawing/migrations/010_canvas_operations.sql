CREATE TABLE IF NOT EXISTS canvas_operations (
  id uuid PRIMARY KEY,
  client_operation_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  operation_type varchar(30) NOT NULL CHECK (operation_type IN ('stroke', 'erase', 'undo', 'redo', 'clear')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  active_seconds integer NOT NULL DEFAULT 0,
  occurred_at_client timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, client_operation_id),
  UNIQUE (workspace_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_canvas_operations_workspace_seq
  ON canvas_operations(workspace_id, seq);
