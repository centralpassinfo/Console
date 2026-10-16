// Releases found from CI are named commit-<40 characters>. Show them by build
// number or short commit everywhere, never by the raw name.
export function releaseLabel(release) {
  if (!release) return 'Not recorded';
  if (release.source_run_number) return `Build ${release.source_run_number}`;
  const commit = release.commit_sha || release.commit || '';
  if (release.version?.startsWith('commit-')) return `Update ${(commit || release.version.slice(7)).slice(0, 8)}`;
  return release.version || 'Unknown release';
}

const PROGRESS_LABELS = {
  backend: 'Backend',
  admin: 'Owner dashboard',
  staff: 'Staff portal',
  employee: 'Employee portal',
  tablet: 'Tablet app',
};
const STATE_LABELS = {
  uploading: 'uploading',
  verifying: 'checking',
  verified: 'verified',
  approving: 'approving',
  approved: 'approved',
};

/** Deployment progress as readable steps; Railway deployment IDs are kept out. */
export function progressSteps(progress = {}) {
  return Object.entries(progress)
    .filter(([key]) => !key.endsWith('_deployment'))
    .map(([key, value]) => ({ key, label: PROGRESS_LABELS[key] || key, state: STATE_LABELS[value] || value }));
}
