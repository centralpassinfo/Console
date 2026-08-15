'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  invoiceState,
  describeInvoice,
  summarizeVenueBilling,
  invoiceTotalCents,
  daysBetween,
} = require('../src/billing');

const TODAY = new Date('2026-08-15T00:00:00Z');

const sent = (overrides = {}) => ({
  status: 'sent',
  amount_cents: 30000,
  gst_cents: 3000,
  due_on: '2026-08-31',
  ...overrides,
});

const paid = (amount, on) => ({ amount_cents: amount, received_on: on });

test('unsent invoice states pass through untouched', () => {
  assert.equal(invoiceState({ status: 'draft' }, [], TODAY), 'draft');
  assert.equal(invoiceState({ status: 'void' }, [], TODAY), 'void');
  assert.equal(invoiceState({ status: 'written_off' }, [], TODAY), 'written_off');
});

test('a sent invoice runs through due, part paid and paid', () => {
  assert.equal(invoiceState(sent(), [], TODAY), 'due');
  assert.equal(invoiceState(sent(), [paid(10000, '2026-08-10')], TODAY), 'part_paid');
  assert.equal(invoiceState(sent(), [paid(33000, '2026-08-10')], TODAY), 'paid');
});

test('paid compares against the GST-inclusive total, not the ex-GST amount', () => {
  assert.equal(invoiceTotalCents(sent()), 33000);
  // 30000 covers the amount but not the GST, so it is only part paid.
  assert.equal(invoiceState(sent(), [paid(30000, '2026-08-10')], TODAY), 'part_paid');
});

test('an overdue invoice reports overdue even when partly paid', () => {
  const overdue = sent({ due_on: '2026-08-01' });
  assert.equal(invoiceState(overdue, [], TODAY), 'overdue');
  // The more urgent fact wins: half the money in and past due is still overdue.
  assert.equal(invoiceState(overdue, [paid(10000, '2026-07-20')], TODAY), 'overdue');
});

test('a zero-total invoice is settled, so a venue on mates rates reads as square', () => {
  assert.equal(invoiceState(sent({ amount_cents: 0, gst_cents: 0 }), [], TODAY), 'paid');
});

test('due date is inclusive: paying on the due date is on time', () => {
  const description = describeInvoice(sent(), [paid(33000, '2026-08-31')], TODAY);
  assert.equal(description.state, 'paid');
  assert.equal(description.onTime, true);
  assert.equal(description.daysLate, 0);
});

test('lateness is measured from the due date to the settling payment', () => {
  const description = describeInvoice(
    sent({ due_on: '2026-07-31' }),
    [paid(20000, '2026-07-20'), paid(13000, '2026-08-06')],
    TODAY
  );
  assert.equal(description.state, 'paid');
  assert.equal(description.settledOn, '2026-08-06');
  assert.equal(description.onTime, false);
  assert.equal(description.daysLate, 6);
});

test('an unpaid overdue invoice accrues lateness against today', () => {
  const description = describeInvoice(sent({ due_on: '2026-08-05' }), [], TODAY);
  assert.equal(description.daysLate, 10);
  assert.equal(description.outstandingCents, 33000);
  // Still running, so timeliness is not yet a fact.
  assert.equal(description.onTime, null);
});

test('venue summary reports overdue money and the worst age', () => {
  const entries = [
    { invoice: sent({ due_on: '2026-07-01' }), description: describeInvoice(sent({ due_on: '2026-07-01' }), [], TODAY) },
    { invoice: sent({ due_on: '2026-08-30' }), description: describeInvoice(sent({ due_on: '2026-08-30' }), [], TODAY) },
  ];
  const summary = summarizeVenueBilling(entries, TODAY);
  assert.equal(summary.state, 'overdue');
  assert.equal(summary.overdueCount, 1);
  assert.equal(summary.overdueCents, 33000);
  assert.equal(summary.oldestOverdueDays, 45);
  assert.equal(summary.outstandingCents, 66000);
  assert.equal(summary.nextDueOn, '2026-07-01');
});

test('a venue with everything settled is in good standing', () => {
  const invoice = sent();
  const entries = [{ invoice, description: describeInvoice(invoice, [paid(33000, '2026-08-02')], TODAY) }];
  const summary = summarizeVenueBilling(entries, TODAY);
  assert.equal(summary.state, 'good_standing');
  assert.equal(summary.outstandingCents, 0);
  assert.equal(summary.onTimeRate, 1);
});

test('on-time rate counts only settled invoices, ignoring write-offs', () => {
  const onTimeInvoice = sent();
  const lateInvoice = sent({ due_on: '2026-07-01' });
  const entries = [
    { invoice: onTimeInvoice, description: describeInvoice(onTimeInvoice, [paid(33000, '2026-08-20')], TODAY) },
    { invoice: lateInvoice, description: describeInvoice(lateInvoice, [paid(33000, '2026-07-15')], TODAY) },
    // A debt you gave up on is not a late payment, so it must not drag the rate.
    { invoice: { status: 'written_off' }, description: describeInvoice({ status: 'written_off' }, [], TODAY) },
  ];
  const summary = summarizeVenueBilling(entries, TODAY);
  assert.equal(summary.settledCount, 2);
  assert.equal(summary.onTimeRate, 0.5);
});

test('a venue with no invoices is neither good nor overdue', () => {
  assert.deepEqual(summarizeVenueBilling([], TODAY).state, 'none');
  assert.equal(summarizeVenueBilling([], TODAY).onTimeRate, null);
});

test('day arithmetic spans months without drifting', () => {
  assert.equal(daysBetween('2026-07-31', '2026-08-06'), 6);
  assert.equal(daysBetween('2026-08-31', '2026-08-31'), 0);
  assert.equal(daysBetween('2026-08-31', '2026-08-30'), -1);
});
