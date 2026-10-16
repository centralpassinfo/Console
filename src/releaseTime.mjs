export const RELEASE_TIMEZONE = 'Australia/Sydney';
export function formatReleaseTime(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-AU', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: RELEASE_TIMEZONE,
    timeZoneName: 'short',
  }).format(new Date(value));
}
// datetime-local contains no offset. Resolve it in the timezone named in the
// form, independently of the browser/server timezone. Reject DST gaps/folds.
export function releaseScheduleUtc(value) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))
    throw new Error('Enter a valid Sydney date and time.');
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: RELEASE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const nominal = Date.parse(`${value}:00Z`),
    matches = [];
  for (let offset = -14 * 60; offset <= 14 * 60; offset += 15) {
    const instant = new Date(nominal - offset * 60000);
    const p = Object.fromEntries(
      formatter.formatToParts(instant).map((x) => [x.type, x.value]),
    );
    if (`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}` === value)
      matches.push(instant.toISOString());
  }
  if (matches.length !== 1)
    throw new Error(
      'That Sydney time is skipped or repeated during a daylight-saving change. Choose another time.',
    );
  return matches[0];
}
