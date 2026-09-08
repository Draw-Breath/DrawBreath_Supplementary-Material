CREATE TABLE IF NOT EXISTS canvas_snapshots (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  image_path text NOT NULL,
  active_seconds integer NOT NULL DEFAULT 0,
  operation_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canvas_snapshots_workspace
  ON canvas_snapshots(workspace_id, created_at DESC);
