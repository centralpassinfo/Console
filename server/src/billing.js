'use strict';

/**
 * Billing state, derived rather than stored.
 *
 * venue_invoices.status only holds states a human chose: draft, sent, void,
 * written_off. Whether an invoice is paid, part paid or overdue is computed here
 * from its payments and today's date, because "overdue" happens through the
 * passage of time with no event to write. A stored flag would need a scheduled
 * job to stay true and would go quietly wrong the first time that job did not
 * run. Derived, it is right at every read.
 */

const { dateOnly } = require('./contracts');

const INVOICE_KINDS = ['setup', 'monthly', 'usage', 'other'];
const INVOICE_STATUSES = ['draft', 'sent', 'void', 'written_off'];
const PAYMENT_METHODS = ['bank_transfer', 'becs', 'card', 'cash', 'other'];
const PAYMENT_SOURCES = ['manual', 'stripe'];

/** Whole days from one YYYY-MM-DD to another. Negative when `to` is earlier. */
function daysBetween(fromText, toText) {
  const from = Date.parse(`${fromText}T00:00:00Z`);
  const to = Date.parse(`${toText}T00:00:00Z`);
  return Math.round((to - from) / 86400000);
}

/** What the venue owes on this line, GST included. */
function invoiceTotalCents(invoice) {
  return Number(invoice.amount_cents ?? invoice.amountCents ?? 0)
    + Number(invoice.gst_cents ?? invoice.gstCents ?? 0);
}

function paidCents(payments = []) {
  return payments.reduce((sum, payment) => sum + Number(payment.amount_cents ?? payment.amountCents ?? 0), 0);
}

/** The most recent payment date, or null when nothing has been received. */
function lastPaymentOn(payments = []) {
  const dates = payments.map((payment) => dateOnly(payment.received_on ?? payment.receivedOn)).filter(Boolean).sort();
  return dates[dates.length - 1] || null;
}

/**
 * One of: draft, void, written_off, paid, overdue, part_paid, due.
 *
 * Order matters. Overdue is checked before part_paid so a half-settled invoice
 * that has passed its due date reports as overdue, which is the more urgent fact.
 */
function invoiceState(invoice, payments = [], today = new Date()) {
  const status = invoice.status;
  if (status !== 'sent') return status;

  const total = invoiceTotalCents(invoice);
  const paid = paidCents(payments);
  // A zero-total line is settled by definition, which is how a venue on mates'
  // rates shows as square rather than permanently owing nothing.
  if (paid >= total) return 'paid';

  const due = dateOnly(invoice.due_on ?? invoice.dueOn);
  if (due && dateOnly(today) > due) return 'overdue';
  return paid > 0 ? 'part_paid' : 'due';
}

/** An invoice with its money and timeliness worked out. */
function describeInvoice(invoice, payments = [], today = new Date()) {
  const total = invoiceTotalCents(invoice);
  const paid = paidCents(payments);
  const state = invoiceState(invoice, payments, today);
  const due = dateOnly(invoice.due_on ?? invoice.dueOn);
  const settledOn = state === 'paid' ? lastPaymentOn(payments) : null;

  let daysLate = 0;
  if (settledOn && due) daysLate = Math.max(0, daysBetween(due, settledOn));
  else if (state === 'overdue' && due) daysLate = Math.max(0, daysBetween(due, dateOnly(today)));

  return {
    state,
    totalCents: total,
    paidCents: paid,
    outstandingCents: Math.max(0, total - paid),
    settledOn,
    // Only meaningful once settled; null while an invoice is still running.
    onTime: settledOn && due ? settledOn <= due : null,
    daysLate,
  };
}

/**
 * Venue-level standing across every invoice.
 *
 * `onTimeRate` counts only settled invoices. Written-off and void lines are
 * excluded deliberately: a debt you gave up on is not a late payment, and
 * folding it in would flatter or punish the rate depending on which you did.
 */
function summarizeVenueBilling(entries = [], today = new Date()) {
  const live = entries.filter(({ description }) => ['due', 'part_paid', 'overdue'].includes(description.state));
  const overdue = live.filter(({ description }) => description.state === 'overdue');
  const settled = entries.filter(({ description }) => description.state === 'paid');
  const onTimeCount = settled.filter(({ description }) => description.onTime).length;

  const upcoming = live
    .map(({ invoice }) => dateOnly(invoice.due_on ?? invoice.dueOn))
    .filter(Boolean)
    .sort();

  let state = 'none';
  if (overdue.length) state = 'overdue';
  else if (entries.length) state = 'good_standing';

  return {
    state,
    invoiceCount: entries.length,
    outstandingCents: live.reduce((sum, { description }) => sum + description.outstandingCents, 0),
    overdueCents: overdue.reduce((sum, { description }) => sum + description.outstandingCents, 0),
    overdueCount: overdue.length,
    oldestOverdueDays: overdue.reduce((worst, { description }) => Math.max(worst, description.daysLate), 0),
    nextDueOn: upcoming[0] || null,
    settledCount: settled.length,
    onTimeRate: settled.length ? onTimeCount / settled.length : null,
  };
}

function publicInvoice(row, description = null) {
  return {
    id: row.id,
    venueId: row.venue_id,
    contractId: row.contract_id,
    invoiceNumber: row.invoice_number,
    kind: row.kind,
    periodStart: dateOnly(row.period_start),
    periodEnd: dateOnly(row.period_end),
    issuedOn: dateOnly(row.issued_on),
    dueOn: dateOnly(row.due_on),
    amountCents: row.amount_cents,
    gstCents: row.gst_cents,
    currency: row.currency,
    status: row.status,
    stripeInvoiceId: row.stripe_invoice_id,
    notes: row.notes,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(description ? { billing: description } : {}),
  };
}

function publicPayment(row) {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    venueId: row.venue_id,
    receivedOn: dateOnly(row.received_on),
    amountCents: row.amount_cents,
    method: row.method,
    source: row.source,
    stripePaymentIntentId: row.stripe_payment_intent_id,
    reference: row.reference,
    recordedBy: row.recorded_by,
    createdAt: row.created_at,
  };
}

module.exports = {
  INVOICE_KINDS,
  INVOICE_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_SOURCES,
  daysBetween,
  invoiceTotalCents,
  paidCents,
  lastPaymentOn,
  invoiceState,
  describeInvoice,
  summarizeVenueBilling,
  publicInvoice,
  publicPayment,
};
