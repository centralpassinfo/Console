-- Setup credentials are separate from environment-scoped deployment tokens.
CREATE TABLE IF NOT EXISTS console_railway_setup_access (
  scope TEXT PRIMARY KEY,
  setup_token TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
