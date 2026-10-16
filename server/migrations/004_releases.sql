CREATE TABLE IF NOT EXISTS console_releases (
  id SERIAL PRIMARY KEY, version TEXT NOT NULL UNIQUE,
  commit_sha TEXT NOT NULL CHECK (commit_sha ~ '^[a-f0-9]{40}$'),
  notes TEXT NOT NULL, tablet_bundle JSONB,
  created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS venue_deployment_targets (
  venue_id INTEGER PRIMARY KEY REFERENCES venues(id),
  project_id UUID NOT NULL, environment_id UUID NOT NULL,
  services JSONB NOT NULL, employee_url TEXT,
  railway_token TEXT NOT NULL,
  auto_deploy_disabled BOOLEAN NOT NULL CHECK (auto_deploy_disabled),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id,environment_id)
);
CREATE TABLE IF NOT EXISTS venue_release_rollouts (
  id SERIAL PRIMARY KEY,
  venue_id INTEGER NOT NULL REFERENCES venues(id),
  release_id INTEGER NOT NULL REFERENCES console_releases(id),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN
    ('queued','deploying','verifying','succeeded','failed','interrupted','cancelled')),
  approved_by TEXT NOT NULL, approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ, heartbeat_at TIMESTAMPTZ,
  progress JSONB NOT NULL DEFAULT '{}'::jsonb, error TEXT,
  target_snapshot JSONB NOT NULL, venue_snapshot JSONB NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_venue_rollout
  ON venue_release_rollouts(venue_id) WHERE status IN ('queued','deploying','verifying','interrupted');
CREATE INDEX IF NOT EXISTS rollout_queue ON venue_release_rollouts(scheduled_at) WHERE status = 'queued';
CREATE TABLE IF NOT EXISTS console_release_workers (
  id TEXT PRIMARY KEY, heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
