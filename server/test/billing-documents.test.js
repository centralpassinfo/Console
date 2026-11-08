'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const calendar = require('../src/billing-calendar');
const { invoiceInput, settingsInput } = require('../src/billing-input');
const { buildInvoiceDocument, renderInvoicePdf } = require('../src/invoice-document');
const { sendEmail } = require('../src/brevo');
const { startBillingWorker } = require('../src/billing-worker');
const config = {
  seller_name: 'CentralPass',
  seller_legal_name: 'QA Partnership',
  abn: '51824753556',
  address: 'Test Street',
  email: 'accounts@example.test',
  bank_account_name: 'Test',
  bank_bsb: '000000',
  bank_account_number: '99999999',
  invoice_prefix: 'CP',
  payment_terms_days: 7,
  gst_registered: false,
  auto_generate: true,
  auto_send: false,
  auto_remind: false,
  automation_start_on: null,
};
test('the hourly worker prevents overlapping ticks and drains its own run on shutdown', async () => {
  let calls = 0,
    release;
  const stop = startBillingWorker({
    intervalMs: 5,
    run: () => {
      calls++;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(calls, 1);
  const stopped = stop();
  release();
  await stopped;
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(calls, 1);
});
test('anchored periods remain contiguous through month ends, leap years and year boundaries', async () => {
  const { billingPeriod } = await import('../../src/billing-form.mjs');
  for (const anchor of [1, 4, 28, 29, 30, 31])
    for (const year of [2024, 2025, 2026, 2027])
      for (let month = 1; month <= 12; month++) {
        const start = `2023-01-${String(anchor).padStart(2, '0')}`,
          on = `${year}-${String(month).padStart(2, '0')}-28`;
        const period = calendar.periodContaining(start, on);
        assert.ok(period.start <= on && period.end >= on);
        assert.deepEqual(billingPeriod(start, on), { start: period.start, end: period.end });
        const next = calendar.periodContaining(start, calendar.addDays(period.end, 1));
        assert.equal(next.start, calendar.addDays(period.end, 1));
      }
  assert.equal(calendar.periodContaining('2026-11-04', '2026-11-03'), null);
  assert.deepEqual(calendar.periodContaining('2026-11-04', '2026-11-04'), {
    start: '2026-11-04',
    end: '2026-12-03',
    anchorDay: 4,
  });
});
test('monthly plans enforce status, expiry, exact-cent proration and seven-day terms', () => {
  const contract = {
    id: 1,
    status: 'signed',
    effective_date: '2026-11-04',
    monthly_fee_cents: 4000,
    auto_renews: false,
    expiry_date: '2026-11-18',
  };
  const plan = calendar.planMonthlyInvoice({
    venue: { status: 'active' },
    contract,
    today: '2026-11-04',
    settings: config,
  });
  assert.equal(plan.invoice.amountCents, 2000);
  assert.equal(plan.invoice.gstCents, 0);
  assert.equal(plan.invoice.dueOn, '2026-11-11');
  assert.equal(plan.invoice.periodEnd, '2026-11-18');
  for (const status of ['draft', 'sent', 'terminated', 'expired'])
    assert.equal(
      calendar.planMonthlyInvoice({
        venue: { status: 'active' },
        contract: { ...contract, status },
        today: '2026-11-04',
        settings: config,
      }).action,
      'skip',
    );
  assert.equal(
    calendar.planMonthlyInvoice({
      venue: { status: 'suspended' },
      contract,
      today: '2026-11-04',
      settings: config,
    }).action,
    'skip',
  );
  assert.equal(
    calendar.planMonthlyInvoice({
      venue: { status: 'active' },
      contract,
      today: '2026-12-04',
      settings: config,
    }).action,
    'skip',
  );
});
test('reminders only follow an emailed unpaid invoice and never catch up with a pile of messages', () => {
  const input = {
    state: 'overdue',
    dueOn: '2026-11-11',
    today: '2026-11-25',
    invoiceEmailed: true,
  };
  assert.equal(calendar.reminderDue(input), 'overdue-14');
  assert.equal(calendar.reminderDue({ ...input, sentKeys: new Set(['overdue-14']) }), null);
  for (const state of ['paid', 'draft', 'void', 'written_off'])
    assert.equal(calendar.reminderDue({ ...input, state }), null);
  assert.equal(calendar.reminderDue({ ...input, invoiceEmailed: false }), null);
  assert.equal(calendar.reminderDue({ ...input, today: '2026-11-09', state: 'due' }), 'due-soon');
});
test('invoice validation preserves credits, rejects GST while unregistered and rejects impossible dates', () => {
  const value = {
    kind: 'setup',
    issuedOn: '2026-11-04',
    dueOn: '2026-11-11',
    lines: [
      { description: 'Project', amount: '620' },
      { description: 'Deposit credit', amount: '-310.00' },
    ],
  };
  assert.equal(invoiceInput(value, config).amountCents, 31000);
  for (const input of [
    { ...value, gst: '31' },
    { ...value, dueOn: '2026-02-30' },
    { ...value, lines: [{ description: 'Credit', amount: '-1' }] },
    { ...value, lines: [] },
  ])
    assert.throws(() => invoiceInput(input, config));
  assert.equal(settingsInput(config).gst_registered, false);
  assert.throws(() => settingsInput({ ...config, abn: '12345678901' }));
  assert.throws(() => settingsInput({ ...config, auto_send: true }));
});
test('documents reflect paid/void states, credit lines and no-GST wording', async () => {
  const invoice = {
    invoice_number: 'CP-2026-004',
    status: 'sent',
    kind: 'setup',
    amount_cents: 31000,
    gst_cents: 0,
    issued_on: '2026-11-04',
    due_on: '2026-11-11',
  };
  const args = {
    invoice,
    lineItems: [
      { position: 1, description: 'Deposit', amount_cents: -31000 },
      { position: 0, description: 'Project', amount_cents: 62000 },
    ],
    settings: config,
    venue: { name: 'QA Cafe', billing_address: 'Test road' },
  };
  const model = buildInvoiceDocument({ ...args, description: { state: 'paid', paidCents: 31000 } });
  assert.equal(model.title, 'Invoice');
  assert.equal(model.badge.label, 'PAID');
  assert.equal(model.pay, null);
  assert.equal(model.dueCents, 0);
  assert.equal(model.items[1].credit, true);
  const bytes = await renderInvoicePdf(model);
  assert.ok(bytes.subarray(0, 8).toString().startsWith('%PDF-1.'));
  const voided = buildInvoiceDocument({ ...args, description: { state: 'void', paidCents: 0 } });
  assert.equal(voided.dueCents, 0);
  assert.equal(voided.pay, null);
});
test('Brevo sends a server-side key, UUID idempotency key and base64 PDF; disabled means no network', async () => {
  let calls = 0,
    request;
  const env = {
    BREVO_API_KEY: 'synthetic-key',
    BILLING_FROM_EMAIL: 'accounts@example.test',
    BILLING_SEND_ENABLED: 'true',
  };
  const fetchImpl = async (url, options) => {
    calls++;
    request = { url, ...options };
    return { ok: true, json: async () => ({ messageId: 'qa-message' }) };
  };
  const payload = {
    to: 'qa@example.test',
    cc: 'qa@example.test; copy@example.test',
    subject: 'Invoice',
    html: '<p>Test</p>',
    text: 'Test',
    operationKey: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d',
    attachments: [{ name: 'qa.pdf', content: Buffer.from('%PDF-test') }],
  };
  assert.equal((await sendEmail(payload, { env, fetchImpl })).messageId, 'qa-message');
  const body = JSON.parse(request.body);
  assert.equal(body.headers.idempotencyKey, payload.operationKey);
  assert.equal(Buffer.from(body.attachment[0].content, 'base64').toString(), '%PDF-test');
  assert.deepEqual(body.cc, [{ email: 'copy@example.test' }]);
  await assert.rejects(
    sendEmail(payload, { env: { ...env, BILLING_SEND_ENABLED: 'false' }, fetchImpl }),
  );
  assert.equal(calls, 1);
  await assert.rejects(
    sendEmail(payload, {
      env,
      fetchImpl: async () => ({
        ok: false,
        status: 500,
        json: async () => ({ message: 'secret' }),
      }),
    }),
    (error) => !error.definitive && !error.message.includes('secret'),
  );
});
