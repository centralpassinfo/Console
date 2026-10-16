'use strict';

const { pool } = require('./db');
const { describeInvoice, summarizeVenueBilling } = require('./billing');

/** Invoices with their payments and derived state, for one or more venues. */
async function loadEntries(venueIds, db = pool) {
  const ids = venueIds.map(Number).filter(Number.isInteger);
  if (!ids.length) return [];
  const { rows: invoices } = await db.query(
    `SELECT * FROM venue_invoices WHERE venue_id = ANY($1::int[]) ORDER BY issued_on DESC, id DESC`,
    [ids]
  );
  const { rows: payments } = await db.query(
    `SELECT * FROM venue_payments WHERE venue_id = ANY($1::int[]) ORDER BY received_on ASC, id ASC`,
    [ids]
  );
  const byInvoice = new Map();
  for (const payment of payments) {
    if (!byInvoice.has(payment.invoice_id)) byInvoice.set(payment.invoice_id, []);
    byInvoice.get(payment.invoice_id).push(payment);
  }
  return invoices.map((invoice) => {
    const invoicePayments = byInvoice.get(invoice.id) || [];
    return { invoice, payments: invoicePayments, description: describeInvoice(invoice, invoicePayments) };
  });
}

/** Every invoice for a venue, each with its payments and derived state. */
function loadLedger(venueId, db = pool) {
  return loadEntries([venueId], db);
}

/** Venue-level billing standing for the venue list and its attention count. */
async function billingSummaries(venueIds, db = pool) {
  const entries = await loadEntries(venueIds, db);
  const summaries = new Map();
  for (const id of venueIds) {
    summaries.set(id, summarizeVenueBilling(entries.filter(({ invoice }) => invoice.venue_id === id)));
  }
  return summaries;
}

module.exports = { loadLedger, billingSummaries };
