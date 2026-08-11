CREATE TABLE IF NOT EXISTS venues (
  id                SERIAL PRIMARY KEY,
  name              TEXT NOT NULL,
  slug              TEXT NOT NULL UNIQUE,
  api_url           TEXT NOT NULL,
  site_url          TEXT,
  admin_url         TEXT,
  staff_url         TEXT,
  platform_api_key  TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'suspended', 'offboarded')),
  billing_notes     TEXT,
  key_rotated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS console_users (
  id                SERIAL PRIMARY KEY,
  email             TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  password_hash     TEXT NOT NULL,
  totp_secret       TEXT NOT NULL,
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS console_audit (
  id          SERIAL PRIMARY KEY,
  venue_id    INTEGER REFERENCES venues(id) ON DELETE SET NULL,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  detail      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS console_audit_created_idx
  ON console_audit (created_at DESC);

CREATE INDEX IF NOT EXISTS venues_status_idx
  ON venues (status);

