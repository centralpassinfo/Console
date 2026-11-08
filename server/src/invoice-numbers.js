'use strict';

/**
 * Invoice numbers: CP-2026-001, CP-2026-002, … restarting each year.
 *
 * Must be called inside a transaction on `client`. The counter row is locked
 * for the rest of that transaction, so two runs can never take the same number.
 * The next value also clears any number already recorded by hand (invoices
 * issued before Console existed), so CP-2026-003 entered manually means the
 * first generated invoice is CP-2026-004.
 */
async function allocateInvoiceNumber(client, { prefix = 'CP', issuedOn, reserveOnly = false }) {
  if (!/^[A-Z]{1,6}$/.test(prefix)) throw new Error('Invalid invoice prefix.');
  const year = Number(String(issuedOn).slice(0, 4));
  if (!Number.isInteger(year) || year < 2000)
    throw new Error('A valid issue date is needed for the invoice number.');

  await client.query(
    `INSERT INTO invoice_number_counters (prefix, year, last_value) VALUES ($1, $2, 0)
     ON CONFLICT (prefix, year) DO NOTHING`,
    [prefix, year],
  );
  const counter = await client.query(
    'SELECT last_value FROM invoice_number_counters WHERE prefix = $1 AND year = $2 FOR UPDATE',
    [prefix, year],
  );
  if (reserveOnly) return null;
  const recorded = await client.query(
    // Manual numbers take the same row lock but do not consume a number.
    `SELECT COALESCE(MAX(substring(invoice_number FROM '^' || $1 || '-' || $2 || '-(\\d+)$')::numeric), 0) AS max
       FROM venue_invoices
      WHERE invoice_number ~ ('^' || $1 || '-' || $2 || '-\\d+$')`,
    [prefix, String(year)],
  );

  const next = Math.max(Number(counter.rows[0].last_value), Number(recorded.rows[0].max)) + 1;
  if (!Number.isSafeInteger(next) || next > 999999999)
    throw new Error('Invoice sequence is too large. Review the recorded invoice numbers.');
  await client.query(
    'UPDATE invoice_number_counters SET last_value = $3 WHERE prefix = $1 AND year = $2',
    [prefix, year, next],
  );
  return formatInvoiceNumber(prefix, year, next);
}

function formatInvoiceNumber(prefix, year, value) {
  return `${prefix}-${year}-${String(value).padStart(3, '0')}`;
}

module.exports = { allocateInvoiceNumber, formatInvoiceNumber };
