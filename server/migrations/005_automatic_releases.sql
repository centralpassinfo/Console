ALTER TABLE venues ADD COLUMN IF NOT EXISTS automatic_updates BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE venue_release_rollouts ADD COLUMN IF NOT EXISTS approval_mode TEXT NOT NULL DEFAULT 'manual'
  CHECK (approval_mode IN ('manual','automatic'));
