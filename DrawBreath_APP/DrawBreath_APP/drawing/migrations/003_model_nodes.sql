CREATE TABLE IF NOT EXISTS model_nodes (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  label varchar(100) NOT NULL,
  base_url text NOT NULL,
  model_name varchar(160) NOT NULL,
  encrypted_api_key text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_model_nodes_owner ON model_nodes(owner_id, enabled, priority, created_at);
