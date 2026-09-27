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
