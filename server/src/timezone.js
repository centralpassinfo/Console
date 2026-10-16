'use strict';

// Every CentralPass venue trades in South Australia. Console decides "today"
// for contract expiry and invoice lateness in the same zone, not in UTC or in
// whatever zone the host happens to run.
const CONSOLE_TIMEZONE = process.env.CONSOLE_TIMEZONE || 'Australia/Adelaide';

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: CONSOLE_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The calendar date of an instant in the Console timezone, as YYYY-MM-DD. */
function localDate(instant = new Date()) {
  return formatter.format(instant);
}

module.exports = { CONSOLE_TIMEZONE, localDate };
