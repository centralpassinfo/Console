export const stateLabels = {
  online: 'Operational',
  degraded: 'Needs attention',
  down: 'Down',
  unreachable: 'Unreachable',
  offboarded: 'Offboarded',
  checking: 'Checking',
};

export function StatusBadge({ state = 'checking', label }) {
  return (
    <span className={`status-badge status-badge--${state}`}>
      <i aria-hidden="true" />
      {label || stateLabels[state] || state}
    </span>
  );
}

export function PlanBadge({ plan }) {
  const value = plan || 'unknown';
  const unconfigured = value === 'unconfigured';
  return (
    <span
      className={`plan-badge plan-badge--${value}`}
      title={unconfigured ? 'PLAN is missing or invalid. This venue currently receives every billable feature.' : undefined}
    >
      {unconfigured ? 'Plan not configured' : value}
    </span>
  );
}

