// Every CentralPass venue trades in South Australia, so Console shows and
// schedules everything in one zone, whatever the operator's device uses.
export const CONSOLE_TIMEZONE = 'Australia/Adelaide';
export const CONSOLE_TIMEZONE_LABEL = 'Adelaide time';

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: CONSOLE_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Today (or another instant) as a YYYY-MM-DD date in the Console timezone. */
export function localDate(instant = new Date()) {
  return dateFormatter.format(instant);
}

/** Calendar arithmetic on YYYY-MM-DD text, free of any timezone. */
export function addDays(text, days) {
  const date = new Date(`${text}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The first and last day of the month containing a YYYY-MM-DD date. */
export function monthBounds(text) {
  const [year, month] = text.split('-').map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  return { start: `${prefix}-01`, end: `${prefix}-${String(last).padStart(2, '0')}` };
}

/** The hour of day (0-23) in the Console timezone. */
export function localHour(instant = new Date()) {
  return Number(new Intl.DateTimeFormat('en-AU', { timeZone: CONSOLE_TIMEZONE, hour: 'numeric', hourCycle: 'h23' }).format(instant));
}
