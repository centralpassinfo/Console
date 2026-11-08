-- Billing documents, sending and automation.
--
-- 003 recorded what was invoiced and paid. This adds what is needed to actually
-- produce and send the invoice: CentralPass's own details as the seller, the
-- venue's billing contact, multi-line invoices (a balance invoice subtracts a
-- deposit), a per-year invoice number sequence, and a record of every email.
--
-- Migrations here are re-applied on every boot, so everything below is idempotent.

-- ── The seller: CentralPass itself ──────────────────────────────────────────
-- One row. These are the details printed in the From block and the How to pay
-- panel of every invoice, edited in Console Billing → Settings.
CREATE TABLE IF NOT EXISTS billing_settings (
  id                   INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  seller_name          TEXT NOT NULL DEFAULT 'CentralPass',
  -- The registered entity, e.g. "H Agarwal & T Sharma trading as CentralPass".
  seller_legal_name    TEXT,
  abn                  TEXT,
  address              TEXT,
  email                TEXT NOT NULL DEFAULT 'contact@centralpass.au',
  -- Not registered: plain "Invoice", no GST line. Registered: "Tax invoice"
  -- and GST shown. Only change this once the ATO registration is in place.
  gst_registered       BOOLEAN NOT NULL DEFAULT FALSE,
  bank_account_name    TEXT,
  bank_bsb             TEXT,
  bank_account_number  TEXT,
  payment_terms_days   INTEGER NOT NULL DEFAULT 7 CHECK (payment_terms_days BETWEEN 0 AND 90),
  invoice_prefix       TEXT NOT NULL DEFAULT 'CP' CHECK (invoice_prefix ~ '^[A-Z]{1,6}$'),

  -- Automation switches. Generation is on: it only ever makes drafts. Sending
  -- and reminders start off so the first automated month can be checked by eye.
  auto_generate        BOOLEAN NOT NULL DEFAULT TRUE,
  auto_send            BOOLEAN NOT NULL DEFAULT FALSE,
  auto_remind          BOOLEAN NOT NULL DEFAULT FALSE,
  -- Set only after historic invoices have been entered and reviewed.
  automation_start_on  DATE,

  last_run_at          TIMESTAMPTZ,
  last_run_summary     JSONB,
  updated_by           TEXT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO billing_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── The buyer: each venue's billing contact ─────────────────────────────────
ALTER TABLE venues ADD COLUMN IF NOT EXISTS billing_name TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS billing_contact TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS billing_email TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS billing_cc TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS billing_address TEXT;
-- The line printed on every monthly invoice, e.g. "Website hosting, CentralPass
-- bookings platform and support". Differs per venue because the service does.
ALTER TABLE venues ADD COLUMN IF NOT EXISTS billing_service_description TEXT;

-- ── Invoices: what the document needs beyond the ledger ─────────────────────
ALTER TABLE venue_invoices ADD COLUMN IF NOT EXISTS footnote TEXT;
ALTER TABLE venue_invoices ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
-- 'manual' when an operator recorded it, 'automatic' when the monthly run did.
ALTER TABLE venue_invoices ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE venue_invoices ADD COLUMN IF NOT EXISTS seller_snapshot JSONB;
ALTER TABLE venue_invoices ADD COLUMN IF NOT EXISTS buyer_snapshot JSONB;
ALTER TABLE venue_invoices ADD COLUMN IF NOT EXISTS gst_registered BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE venue_invoices ADD COLUMN IF NOT EXISTS operation_key TEXT UNIQUE;
ALTER TABLE venue_payments ADD COLUMN IF NOT EXISTS operation_key TEXT UNIQUE;
DO $$ BEGIN
  ALTER TABLE venue_invoices ADD CONSTRAINT venue_invoices_origin_check
    CHECK (origin IN ('manual', 'automatic'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Lines. An invoice without lines is rendered as one line built from its kind,
-- period and notes, so every invoice recorded before this migration still
-- renders. When lines exist, venue_invoices.amount_cents is their sum.
CREATE TABLE IF NOT EXISTS venue_invoice_lines (
  id            SERIAL PRIMARY KEY,
  invoice_id    INTEGER NOT NULL REFERENCES venue_invoices(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL DEFAULT 0,
  description   TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  detail        TEXT CHECK (detail IS NULL OR length(detail) <= 300),
  -- Negative for a credit, e.g. "Less deposit received (invoice CP-2026-001)".
  amount_cents  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS venue_invoice_lines_invoice_idx ON venue_invoice_lines (invoice_id, position);

-- ── Invoice numbers ─────────────────────────────────────────────────────────
-- CP-2026-001, CP-2026-002, … restarting each year. The allocator also looks at
-- invoice numbers already recorded, so invoices issued before Console existed
-- (and entered by hand) are never reused.
CREATE TABLE IF NOT EXISTS invoice_number_counters (
  prefix      TEXT NOT NULL,
  year        INTEGER NOT NULL,
  last_value  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (prefix, year)
);

-- ── Every email sent about an invoice ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS venue_invoice_emails (
  id                   SERIAL PRIMARY KEY,
  invoice_id           INTEGER REFERENCES venue_invoices(id) ON DELETE CASCADE,
  venue_id             INTEGER REFERENCES venues(id) ON DELETE CASCADE,
  purpose              TEXT NOT NULL CHECK (purpose IN ('invoice', 'reminder', 'receipt', 'test')),
  -- For reminders: which one ('due-soon', 'overdue-1', 'overdue-7', 'overdue-14').
  -- Unique per invoice once sent, which is what makes reminders safe to retry.
  reminder_key         TEXT,
  to_email             TEXT NOT NULL,
  cc_email             TEXT,
  subject              TEXT NOT NULL,
  document             JSONB,
  status               TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed', 'unknown')),
  operation_key        TEXT NOT NULL UNIQUE,
  provider_key         TEXT NOT NULL,
  provider_message_id  TEXT,
  error                TEXT,
  sent_by              TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Recovery after a worker dies: uncertain sends are retained, never auto-retried.
ALTER TABLE venue_invoice_emails ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS venue_invoice_emails_invoice_idx ON venue_invoice_emails (invoice_id, created_at DESC);
CREATE INDEX IF NOT EXISTS venue_invoice_emails_created_idx ON venue_invoice_emails (created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS venue_invoice_emails_reminder_key
  ON venue_invoice_emails (invoice_id, reminder_key)
  WHERE status = 'sent' AND reminder_key IS NOT NULL;
