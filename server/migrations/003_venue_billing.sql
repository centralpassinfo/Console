-- Billing ledger: what CentralPass invoiced a venue, and what the venue paid.
--
-- This is Flow B in CENTRALPASS_OPERATIONS.md section 3 (the venue pays us). It is
-- deliberately separate from venue_contracts: the contract is the agreement and
-- carries the agreed setup and monthly fees, while these tables record what was
-- actually billed and actually received. A monthly invoice can differ from the
-- contracted fee because SMS above the bundled allowance is charged at cost plus
-- margin, so the amount lives on the invoice rather than being read from the
-- contract each period.
--
-- Migrations here are re-applied on every boot, so everything below is idempotent.

CREATE TABLE IF NOT EXISTS venue_invoices (
  id                SERIAL PRIMARY KEY,
  venue_id          INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  contract_id       INTEGER REFERENCES venue_contracts(id) ON DELETE SET NULL,
  invoice_number    TEXT NOT NULL UNIQUE,
  kind              TEXT NOT NULL
                    CHECK (kind IN ('setup', 'monthly', 'usage', 'other')),
  period_start      DATE,
  period_end        DATE,
  issued_on         DATE NOT NULL,
  due_on            DATE NOT NULL,
  amount_cents      INTEGER NOT NULL CHECK (amount_cents >= 0),
  gst_cents         INTEGER NOT NULL DEFAULT 0 CHECK (gst_cents >= 0),
  currency          TEXT NOT NULL DEFAULT 'AUD' CHECK (currency = 'AUD'),

  -- Only states that are a human decision live here. 'paid' and 'overdue' are
  -- NOT columns: they are derived from venue_payments and the current date in
  -- src/billing.js. An invoice becomes overdue purely through the passage of
  -- time, with no event to trigger a write, so a stored flag would need a nightly
  -- job to stay honest and would drift silently the first time that job failed.
  status            TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'sent', 'void', 'written_off')),

  -- Null until Stripe Billing is live. When it is, the webhook writes the same
  -- rows with this populated; nothing else about this schema changes.
  stripe_invoice_id TEXT UNIQUE,

  notes             TEXT,
  created_by        TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CHECK (due_on >= issued_on),
  CHECK (period_start IS NULL OR period_end IS NULL OR period_end >= period_start),
  -- A monthly line covers a period; a setup fee does not.
  CHECK (kind <> 'monthly' OR (period_start IS NOT NULL AND period_end IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS venue_invoices_venue_idx ON venue_invoices (venue_id);
CREATE INDEX IF NOT EXISTS venue_invoices_due_idx ON venue_invoices (due_on);

-- One monthly invoice per venue per period. Partial indexes so setup and usage
-- lines, which have no period, are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS venue_invoices_period_key
  ON venue_invoices (venue_id, period_start, period_end)
  WHERE kind = 'monthly' AND status <> 'void';

CREATE TABLE IF NOT EXISTS venue_payments (
  id                       SERIAL PRIMARY KEY,
  invoice_id               INTEGER NOT NULL REFERENCES venue_invoices(id) ON DELETE CASCADE,
  venue_id                 INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  received_on              DATE NOT NULL,
  amount_cents             INTEGER NOT NULL CHECK (amount_cents > 0),
  method                   TEXT NOT NULL
                           CHECK (method IN ('bank_transfer', 'becs', 'card', 'cash', 'other')),

  -- 'manual' is a human recording money that arrived. 'stripe' is written by the
  -- Stripe Billing webhook once that exists. Both produce identical rows, which
  -- is what stops the two from becoming two disagreeing ledgers.
  source                   TEXT NOT NULL DEFAULT 'manual'
                           CHECK (source IN ('manual', 'stripe')),
  stripe_payment_intent_id TEXT UNIQUE,

  reference                TEXT,
  recorded_by              TEXT NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS venue_payments_invoice_idx ON venue_payments (invoice_id);
CREATE INDEX IF NOT EXISTS venue_payments_venue_idx ON venue_payments (venue_id);
