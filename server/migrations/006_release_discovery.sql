CREATE TABLE IF NOT EXISTS console_release_source (
  id INTEGER PRIMARY KEY CHECK (id=1),
  repository_url TEXT NOT NULL,
  github_token TEXT,
  last_sync_at TIMESTAMPTZ,
  last_sync_error TEXT,
  last_sync_message TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE console_releases ADD COLUMN IF NOT EXISTS source_run_id BIGINT;
ALTER TABLE console_releases ADD COLUMN IF NOT EXISTS source_run_number INTEGER;
ALTER TABLE console_releases ADD COLUMN IF NOT EXISTS source_run_url TEXT;
