'use strict';
const { parseMoneyToCents } = require('./contracts');
const { splitAddresses } = require('./brevo');

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}
function date(value, label = 'Date') {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value + 'T00:00:00Z')) ||
    new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value ||
    value < '2000-01-01' ||
    value > '2199-12-31'
  )
    fail(`${label} must be a valid calendar date.`);
  return value;
}
function text(value, max = 300, label = 'Value') {
  if (value == null) return '';
  if (
    typeof value !== 'string' ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
  )
    fail(`${label} is invalid or too long.`);
  return value.trim();
}
function addresses(value, single = false) {
  const values = [
    ...new Set(splitAddresses(text(value, 500, 'Email')).map((item) => item.toLowerCase())),
  ];
  if (
    values.length > (single ? 1 : 5) ||
    values.some((item) => !/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(item))
  )
    fail('Enter valid email addresses (up to five, separated by commas).');
  return values.join(', ');
}
function signedMoney(value) {
  const input = String(value ?? '').trim(),
    negative = input.startsWith('-');
  const cents = parseMoneyToCents(negative ? input.slice(1) : input);
  if (cents == null) fail('Enter an amount for every invoice line.');
  return negative ? -cents : cents;
}
function invoiceInput(input, settings) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Provide invoice fields.');
  if (!['monthly', 'setup', 'usage', 'other'].includes(input.kind)) fail('Choose an invoice type.');
  const issuedOn = date(input.issuedOn, 'Issue date'),
    dueOn = date(input.dueOn, 'Due date');
  if (dueOn < issuedOn) fail('Due date cannot precede the issue date.');
  const periodStart = input.periodStart ? date(input.periodStart, 'Period start') : null;
  const periodEnd = input.periodEnd ? date(input.periodEnd, 'Period end') : null;
  if (
    !!periodStart !== !!periodEnd ||
    (periodEnd && periodEnd < periodStart) ||
    (input.kind === 'monthly' && !periodStart)
  )
    fail('Provide a valid service period.');
  let lines;
  if (input.lines !== undefined) {
    if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > 30)
      fail('Provide between 1 and 30 invoice lines.');
    lines = input.lines.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item))
        fail('Provide valid invoice lines.');
      const description = text(item.description, 300, 'Description');
      if (!description) fail('Every invoice line needs a description.');
      return {
        description,
        detail: text(item.detail, 300, 'Line detail'),
        amountCents: signedMoney(item.amount),
      };
    });
  } else
    lines = [
      {
        description:
          input.kind === 'monthly' ? 'CentralPass platform, hosting and support' : 'Services',
        detail: '',
        amountCents: signedMoney(input.amount),
      },
    ];
  const amountCents = lines.reduce((sum, item) => sum + item.amountCents, 0);
  if (!Number.isSafeInteger(amountCents) || amountCents < 0 || amountCents > 1000000000)
    fail('Invoice lines must total between $0 and $10,000,000.');
  const gstCents = settings.gst_registered ? Math.round(amountCents / 10) : 0;
  if (!settings.gst_registered && Number(input.gst || 0) !== 0)
    fail('No GST can be charged while the seller is not GST-registered.');
  const invoiceNumber = text(input.invoiceNumber, 40, 'Invoice number');
  const numbered = invoiceNumber.match(/^[A-Z]{1,6}-\d{4}-(\d+)$/);
  if (numbered && Number(numbered[1]) > 999999999) fail('Invoice sequence is too large.');
  if (invoiceNumber && !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(invoiceNumber))
    fail('Use letters, numbers, dots, slashes or hyphens in invoice numbers.');
  const status = input.status || 'draft';
  if (!['draft', 'sent', 'void', 'written_off'].includes(status))
    fail('Choose a valid invoice status.');
  if (
    input.contractId &&
    (!Number.isSafeInteger(Number(input.contractId)) || Number(input.contractId) < 1)
  )
    fail('Choose a valid contract.');
  return {
    kind: input.kind,
    issuedOn,
    dueOn,
    periodStart,
    periodEnd,
    invoiceNumber,
    status,
    contractId: Number(input.contractId) || null,
    lines,
    amountCents,
    gstCents,
    notes: text(input.notes, 3000, 'Notes'),
    footnote: text(input.footnote, 1000, 'Footnote'),
  };
}
const SETTINGS_TEXT = [
  'seller_name',
  'seller_legal_name',
  'abn',
  'address',
  'email',
  'bank_account_name',
  'bank_bsb',
  'bank_account_number',
  'invoice_prefix',
];
function settingsInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    fail('Provide billing settings.');
  const out = {};
  for (const key of SETTINGS_TEXT) out[key] = text(input[key], key === 'address' ? 1000 : 160, key);
  out.email = addresses(out.email, true);
  if (!out.seller_name || !out.email) fail('Business name and reply email are required.');
  if (!/^[A-Z]{1,6}$/.test(out.invoice_prefix))
    fail('Invoice prefix must be 1 to 6 uppercase letters.');
  out.abn = out.abn.replace(/\s/g, '');
  if (out.abn) {
    const digits = [...out.abn].map(Number);
    digits[0]--;
    if (
      !/^\d{11}$/.test(out.abn) ||
      digits.reduce(
        (sum, digit, index) => sum + digit * [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19][index],
        0,
      ) %
        89 !==
        0
    )
      fail('Enter a valid 11-digit ABN.');
  }
  if (out.bank_bsb && !/^\d{3}-?\d{3}$/.test(out.bank_bsb)) fail('BSB must contain six digits.');
  if (out.bank_account_number && !/^\d{5,12}$/.test(out.bank_account_number))
    fail('Account number must contain 5 to 12 digits.');
  for (const key of ['gst_registered', 'auto_generate', 'auto_send', 'auto_remind']) {
    if (typeof input[key] !== 'boolean') fail(`${key} must be on or off.`);
    out[key] = input[key];
  }
  out.payment_terms_days = Number(input.payment_terms_days);
  if (
    !Number.isInteger(out.payment_terms_days) ||
    out.payment_terms_days < 0 ||
    out.payment_terms_days > 90
  )
    fail('Payment terms must be 0 to 90 days.');
  out.automation_start_on = input.automation_start_on
    ? date(input.automation_start_on, 'Automation start')
    : null;
  if ((out.auto_send || out.auto_remind) && !out.automation_start_on)
    fail('Review historic invoices and set an automation start date first.');
  return out;
}
function contactInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    fail('Provide billing contact fields.');
  const out = {};
  for (const key of [
    'billing_name',
    'billing_contact',
    'billing_address',
    'billing_service_description',
  ])
    out[key] = text(input[key], key === 'billing_address' ? 1000 : 300, key);
  out.billing_email = addresses(input.billing_email, true);
  out.billing_cc = addresses(input.billing_cc);
  return out;
}
module.exports = {
  fail,
  date,
  text,
  addresses,
  signedMoney,
  invoiceInput,
  settingsInput,
  contactInput,
};
