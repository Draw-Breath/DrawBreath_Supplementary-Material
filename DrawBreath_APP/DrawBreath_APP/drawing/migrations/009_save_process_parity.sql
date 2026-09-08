ALTER TABLE canvas_snapshots
  ADD COLUMN IF NOT EXISTS snapshot_kind varchar(20) NOT NULL DEFAULT 'legacy';

CREATE INDEX IF NOT EXISTS idx_canvas_snapshots_workspace_kind
  ON canvas_snapshots(workspace_id, snapshot_kind, created_at DESC);
