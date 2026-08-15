CREATE TABLE IF NOT EXISTS venue_contracts (
  id                   SERIAL PRIMARY KEY,
  venue_id             INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  title                TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft', 'sent', 'signed', 'expired', 'terminated')),
  effective_date       DATE,
  expiry_date          DATE,
  signed_at            DATE,
  setup_fee_cents      INTEGER CHECK (setup_fee_cents IS NULL OR setup_fee_cents >= 0),
  monthly_fee_cents    INTEGER CHECK (monthly_fee_cents IS NULL OR monthly_fee_cents >= 0),
  auto_renews          BOOLEAN NOT NULL DEFAULT FALSE,
  notice_period_days   INTEGER CHECK (notice_period_days IS NULL OR notice_period_days BETWEEN 0 AND 730),
  notes                TEXT,
  original_filename    TEXT NOT NULL,
  media_type           TEXT NOT NULL DEFAULT 'application/pdf'
                       CHECK (media_type = 'application/pdf'),
  file_size_bytes      INTEGER NOT NULL CHECK (file_size_bytes > 0 AND file_size_bytes <= 10485760),
  encrypted_file       BYTEA NOT NULL,
  file_sha256          CHAR(64) NOT NULL,
  created_by           TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expiry_date IS NULL OR effective_date IS NULL OR expiry_date >= effective_date)
);

CREATE INDEX IF NOT EXISTS venue_contracts_venue_idx
  ON venue_contracts (venue_id, created_at DESC);

CREATE INDEX IF NOT EXISTS venue_contracts_expiry_idx
  ON venue_contracts (expiry_date)
  WHERE status = 'signed';
