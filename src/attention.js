// One definition of "needs attention", shared by the Overview count, the venue
// filter and the venue table, so the three can never disagree.
export function attentionReasons(venue) {
  const reasons = [];
  const state = venue.live?.state;
  if (['degraded', 'down', 'unreachable'].includes(state)) reasons.push('Service');
  if (['missing', 'expiring', 'expired'].includes(venue.contractSummary?.state)) reasons.push('Contract');
  if (venue.billingSummary?.state === 'overdue') reasons.push('Overdue invoice');
  if (['interrupted', 'failed'].includes(venue.latestRollout?.status)) reasons.push('Update stopped');
  return reasons;
}

export function needsAttention(venue) {
  return venue.registryStatus !== 'offboarded' && attentionReasons(venue).length > 0;
}
