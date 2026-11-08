export function billingPeriod(start, on) {
  const anchor = Number((start || on).slice(8, 10));
  const point = (year, month) =>
    new Date(
      Date.UTC(year, month, Math.min(anchor, new Date(Date.UTC(year, month + 1, 0)).getUTCDate())),
    )
      .toISOString()
      .slice(0, 10);
  const [year, month] = on.split('-').map(Number);
  let offset = month - 1;
  if (point(year, offset) > on && (!start || start <= on)) offset--;
  const from = start && start > on ? start : point(year, offset);
  const [fy, fm] = from.split('-').map(Number);
  const next = point(fy, fm);
  return {
    start: from,
    end: new Date(Date.parse(next + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10),
  };
}
