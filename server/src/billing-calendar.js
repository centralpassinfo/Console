'use strict';

/**
 * Billing dates, money formatting and reminder timing. Pure: no database, no
 * clock except the `today` passed in, so every rule here is unit tested.
 *
 * Monthly service is billed in advance on the venue's ANNIVERSARY day, not on
 * the 1st: a contract starting 4 November bills 4 November to 3 December, then
 * 4 December to 3 January, and so on. That is how the first invoices were
 * issued by hand, and it means nobody is ever billed for days before they
 * started.
 */

const { dateOnly } = require('./contracts');

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const pad = (n) => String(n).padStart(2, '0');

function parts(text) {
  const [y, m, d] = String(text).slice(0, 10).split('-').map(Number);
  return { y, m, d };
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function addDays(text, days) {
  const date = new Date(`${String(text).slice(0, 10)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * The anniversary date in a given month. An anchor of the 31st falls on the
 * last day of shorter months rather than spilling into the next one.
 */
function anchorIn(y, m, anchorDay) {
  return `${y}-${pad(m)}-${pad(Math.min(anchorDay, daysInMonth(y, m)))}`;
}

function shiftMonth(y, m, by) {
  const index = y * 12 + (m - 1) + by;
  return { y: Math.floor(index / 12), m: (index % 12) + 1 };
}

/**
 * The monthly period containing `onDate`, for a contract that started on
 * `startDate`. Returns null before the contract starts.
 */
function periodContaining(startDate, onDate) {
  const start = dateOnly(startDate);
  const on = dateOnly(onDate);
  if (!start || !on || on < start) return null;
  const anchorDay = parts(start).d;
  const { y, m } = parts(on);

  // This month's anniversary, or last month's if we have not reached it yet.
  let from = anchorIn(y, m, anchorDay);
  let base = { y, m };
  if (from > on) {
    base = shiftMonth(y, m, -1);
    from = anchorIn(base.y, base.m, anchorDay);
  }
  const next = shiftMonth(base.y, base.m, 1);
  const to = addDays(anchorIn(next.y, next.m, anchorDay), -1);
  return { start: from, end: to, anchorDay };
}

/** "4 November 2026" */
function longDate(text) {
  const value = dateOnly(text);
  if (!value) return '';
  const { y, m, d } = parts(value);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** "4 November to 3 December 2026", dropping the first year when it matches. */
function periodLabel(start, end) {
  const a = parts(start);
  const b = parts(end);
  const first = a.y === b.y ? `${a.d} ${MONTHS[a.m - 1]}` : longDate(start);
  return `${first} to ${longDate(end)}`;
}

/** "1st", "2nd", "3rd", "4th", "11th", "21st", "31st" */
function ordinal(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`;
}

/** "$1,234.50", with a true minus sign for credits: "−$310.00". */
function money(cents) {
  const value = Number(cents) || 0;
  const abs = Math.abs(value);
  const dollars = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${value < 0 ? '-' : ''}$${dollars}.${pad(abs % 100)}`;
}

/** GST on a GST-exclusive amount: one tenth, to the cent. */
function gstOn(cents, registered) {
  return registered ? Math.round(Number(cents) / 10) : 0;
}

/**
 * What the monthly run should do for one contract today: an invoice to draft,
 * or a reason it should not. `existingPeriods` is the set of period starts this
 * venue already has a live monthly invoice for.
 */
function planMonthlyInvoice({ venue, contract, today, existingPeriods = new Set(), settings }) {
  const skip = (reason) => ({ action: 'skip', reason });

  if (venue.status !== 'active') return skip(`Venue is ${venue.status}.`);
  if (!contract || contract.status !== 'signed') return skip('No signed contract.');
  const fee = contract.monthly_fee_cents;
  if (fee === null || fee === undefined) return skip('The contract has no monthly fee.');
  if (Number(fee) <= 0) return skip('The contract’s monthly fee is $0.00.');
  const start = dateOnly(contract.effective_date);
  if (!start) return skip('The contract has no start date, so there is no billing day.');

  const period = periodContaining(start, today);
  if (!period) return skip(`The contract starts ${longDate(start)}.`);

  // A contract that does not auto-renew stops billing at its expiry. A period
  // it only partly covers is pro-rated by day.
  const expiry = dateOnly(contract.expiry_date);
  let end = period.end;
  let amount = Number(fee);
  if (expiry && !contract.auto_renews) {
    if (expiry < period.start) return skip(`The contract ended ${longDate(expiry)}.`);
    if (expiry < period.end) {
      const whole = daysBetween(period.start, period.end) + 1;
      const covered = daysBetween(period.start, expiry) + 1;
      amount = Math.round((Number(fee) * covered) / whole);
      end = expiry;
    }
  }

  if (existingPeriods.has(period.start)) return skip('Already invoiced for this period.');

  const issuedOn = dateOnly(today);
  const description =
    venue.billing_service_description || 'CentralPass platform, hosting and support';
  const partial = end !== period.end;
  return {
    action: 'create',
    invoice: {
      kind: 'monthly',
      periodStart: period.start,
      periodEnd: end,
      issuedOn,
      dueOn: addDays(issuedOn, Number(settings.payment_terms_days ?? 7)),
      amountCents: amount,
      gstCents: gstOn(amount, settings.gst_registered),
      contractId: contract.id,
      lines: [
        {
          description,
          detail: `Monthly, ${periodLabel(period.start, end)}${partial ? ' (part month, contract ends)' : ''}`,
          amountCents: amount,
        },
      ],
      footnote: `Monthly service, billed in advance on the ${ordinal(period.anchorDay)} of each month.`,
    },
  };
}

function daysBetween(fromText, toText) {
  return Math.round(
    (Date.parse(`${toText}T00:00:00Z`) - Date.parse(`${fromText}T00:00:00Z`)) / 86400000,
  );
}

/**
 * Reminder schedule, in days relative to the due date. Negative is before.
 * Order matters: later stages outrank earlier ones.
 */
const REMINDERS = [
  { key: 'due-soon', offset: -2 },
  { key: 'overdue-1', offset: 1 },
  { key: 'overdue-7', offset: 7 },
  { key: 'overdue-14', offset: 14 },
];

/**
 * The one reminder to send today, if any. Only the latest stage reached is
 * considered: if the automation was down for a week, the venue gets the
 * overdue notice, not three stacked catch-up emails. And once a later stage has
 * gone out, an earlier one never does.
 */
function reminderDue({ state, dueOn, today, sentKeys = new Set(), invoiceEmailed }) {
  if (!invoiceEmailed) return null;
  if (!['due', 'part_paid', 'overdue'].includes(state)) return null;
  const offset = daysBetween(dateOnly(dueOn), dateOnly(today));
  const reached = REMINDERS.filter((r) => offset >= r.offset);
  if (!reached.length) return null;
  const latest = reached[reached.length - 1];
  const laterSent = REMINDERS.slice(REMINDERS.indexOf(latest)).some((r) => sentKeys.has(r.key));
  if (laterSent) return null;
  // "Due soon" is only worth sending before the due date itself.
  if (latest.key === 'due-soon' && offset > 0) return null;
  return latest.key;
}

module.exports = {
  daysBetween,
  REMINDERS,
  addDays,
  periodContaining,
  longDate,
  periodLabel,
  ordinal,
  money,
  gstOn,
  planMonthlyInvoice,
  reminderDue,
};
