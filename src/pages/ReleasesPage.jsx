import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import Modal from '../components/Modal.jsx';
import Icon from '../components/Icon.jsx';
import {
  formatReleaseTime as formatDateTime,
  releaseScheduleUtc,
} from '../releaseTime.mjs';
import '../releases.css';
import useDialogFocus from '../useDialogFocus.js';
import {
  ReleaseSourceCard,
  RailwaySetupDialog,
} from '../components/ReleaseConnections.jsx';
function releaseLabel(release) {
  return release.source_run_number
    ? `Build ${release.source_run_number}`
    : release.version?.startsWith('commit-')
      ? `Update ${release.commit_sha.slice(0, 8)}`
      : release.version;
}
const active = ['queued', 'deploying', 'verifying', 'interrupted'];
const emptyRelease = {
  version: '',
  commitSha: '',
  notes: '',
  tablet: false,
  appId: 'au.com.caffeprimofirle.staff',
  channel: 'production',
  bundleVersion: '',
  checksum: '',
};
function CheckAll({ checked, mixed, onChange, disabled }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label="Select all eligible venues shown"
      checked={checked}
      disabled={disabled}
      onChange={onChange}
    />
  );
}
export default function ReleasesPage() {
  const [params] = useSearchParams();
  const [data, setData] = useState(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [releaseId, setReleaseId] = useState(''),
    [query, setQuery] = useState(''),
    [schedule, setSchedule] = useState('');
  const [selected, setSelected] = useState(
    () => new Set(params.get('venue') ? [Number(params.get('venue'))] : []),
  );
  const [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(null),
    [formError, setFormError] = useState('');
  const [newRelease, setNewRelease] = useState(null),
    [target, setTarget] = useState(null);
  const formDialogRef = useRef(null);
  useDialogFocus(formDialogRef, {
    open: Boolean(newRelease || target?.manual),
    busy,
    onClose: () => {
      setNewRelease(null);
      setTarget(null);
    },
  });
  const load = useCallback(async () => {
    try {
      setData(await api('/releases'));
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, []);
  useEffect(() => {
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [load]);
  const venues = data?.venues || [],
    releases = data?.releases || [],
    rollouts = data?.rollouts || [];
  const release = releases.find((r) => String(r.id) === releaseId);
  const blocking = new Map(
    rollouts
      .filter((r) => active.includes(r.status))
      .map((r) => [r.venue_id, r]),
  );
  const eligible = (v) =>
    v.status === 'active' && v.configured && !blocking.has(v.id);
  const filtered = venues.filter((v) =>
    `${v.name} ${v.slug}`.toLowerCase().includes(query.toLowerCase()),
  );
  const shownEligible = filtered.filter(eligible),
    chosen = venues.filter((v) => selected.has(v.id));
  const validSelection = chosen.length > 0 && chosen.every(eligible);
  const workerOnline =
    data?.worker.lastSeen &&
    Date.now() - new Date(data.worker.lastSeen).getTime() < 45000;
  function toggle(id) {
    setSelected((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }
  async function saveRelease(e) {
    e.preventDefault();
    setBusy(true);
    setFormError('');
    try {
      const f = newRelease;
      const { release: r, automaticallyQueued = 0 } = await api('/releases', {
        method: 'POST',
        body: {
          version: f.version,
          commitSha: f.commitSha,
          notes: f.notes,
          tabletBundle: f.tablet
            ? {
                appId: f.appId,
                channel: f.channel,
                version: f.bundleVersion,
                checksum: f.checksum,
              }
            : null,
        },
      });
      setReleaseId(String(r.id));
      setNewRelease(null);
      setNotice(
        automaticallyQueued
          ? `Release ${r.version} queued automatically for ${automaticallyQueued} venue${automaticallyQueued === 1 ? '' : 's'}. Other venues still require approval.`
          : `Release ${r.version} is ready for approval.`,
      );
      await load();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setBusy(false);
    }
  }
  function editTarget(v) {
    setFormError('');
    setTarget({
      venueId: v.id,
      name: v.name,
      projectId: v.project_id || '',
      environmentId: v.environment_id || '',
      services: {
        backend: '',
        admin: '',
        staff: '',
        employee: '',
        ...v.services,
      },
      employeeUrl: v.employee_url || '',
      railwayToken: '',
      autoDeployDisabled: false,
      configured: v.configured,
    });
  }
  async function saveTarget(e) {
    e.preventDefault();
    setBusy(true);
    setFormError('');
    try {
      await api(`/releases/targets/${target.venueId}`, {
        method: 'PUT',
        body: target,
      });
      setTarget(null);
      setNotice('Deployment setup saved.');
      await load();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function applyConfirmation() {
    setBusy(true);
    setFormError('');
    try {
      if (confirm.kind === 'policy') {
        await api(`/releases/venues/${confirm.venue.id}/automatic`, {
          method: 'PUT',
          body: { enabled: confirm.enabled },
        });
        setNotice(
          `${confirm.venue.name}: ${confirm.enabled ? 'automatic updates enabled' : 'approval required for future updates'}.`,
        );
      } else if (confirm.kind === 'approve') {
        await api('/releases/approve', {
          method: 'POST',
          body: {
            releaseId: confirm.release.id,
            venueIds: confirm.venues.map((v) => v.id),
            scheduledAt: confirm.scheduledAt,
          },
        });
        setSelected(new Set());
        setNotice(
          `Update approved for ${confirm.venues.length} venue${confirm.venues.length === 1 ? '' : 's'}.`,
        );
      } else {
        await api(`/releases/${confirm.job.id}/${confirm.kind}`, {
          method: 'POST',
          body: { acknowledged: true },
        });
        setNotice(
          confirm.kind === 'cancel'
            ? 'Queued update cancelled.'
            : 'Interrupted update closed.',
        );
      }
      setConfirm(null);
      await load();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page releases-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">Controlled updates</span>
          <h1>Releases</h1>
          <p>
            Approve releases for one or several venues, or enable automatic
            updates per venue.
          </p>
        </div>
        <div className="release-actions">
          <button className="button button--secondary" onClick={load}>
            <Icon name="refresh" size={17} />
            Refresh
          </button>
          <details className="release-advanced-menu">
            <summary>Advanced</summary>
            <button
              className="button button--primary"
              onClick={() => {
                setFormError('');
                setNewRelease({ ...emptyRelease });
              }}
            >
              <Icon name="plus" size={17} />
              Register release manually
            </button>
          </details>
        </div>
      </header>
      {error && (
        <div className="form-alert form-alert--error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="form-alert form-alert--success" role="status">
          {notice}
        </div>
      )}
      {data && !workerOnline && (
        <div className="release-warning" role="status">
          <strong>Deployment worker is offline.</strong> Approvals stay queued
          until the worker is running. Last seen:{' '}
          {data.worker.lastSeen
            ? formatDateTime(data.worker.lastSeen)
            : 'never'}
          .
        </div>
      )}
      {!data ? (
        <div className="loading-block">Loading release history…</div>
      ) : (
        <>
          <ReleaseSourceCard
            source={data.source}
            onChange={async (message) => {
              setNotice(message);
              await load();
            }}
          />
          <section className="content-card">
            <div className="content-card__header">
              <div>
                <h2>Choose a release</h2>
                <p>Release versions and commits are fixed once created.</p>
              </div>
            </div>
            <div className="release-fields">
              <label>
                Version
                <select
                  aria-label="Release version"
                  value={releaseId}
                  onChange={(e) => setReleaseId(e.target.value)}
                >
                  <option value="">Select a release</option>
                  {releases.map((r) => (
                    <option key={r.id} value={r.id}>
                      {releaseLabel(r)} · {r.notes.split('\n')[0].slice(0, 85)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Deploy at (Sydney time)
                <input
                  aria-label="Deploy at"
                  type="datetime-local"
                  value={schedule}
                  onChange={(e) => setSchedule(e.target.value)}
                />
                <small>Leave empty to deploy when a worker is available.</small>
              </label>
            </div>
            {!releases.length && (
              <p className="release-help">
                Push Platform changes to main and wait for CI to pass. Console
                discovers the release automatically—there is no version or
                commit SHA to enter.
              </p>
            )}
            {release && (
              <div className="release-notes">
                <strong>{releaseLabel(release)}</strong>
                <code>{release.commit_sha}</code>
                <p>{release.notes}</p>
                {release.source_run_url && (
                  <a
                    className="release-build-link"
                    href={release.source_run_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View successful build on GitHub
                  </a>
                )}
                {release.tablet_bundle && (
                  <small>
                    Includes tablet bundle {release.tablet_bundle.version} (
                    {release.tablet_bundle.channel}).
                  </small>
                )}
              </div>
            )}
          </section>
          <section className="content-card">
            <div className="content-card__header">
              <div>
                <h2>Choose venues</h2>
                <p>
                  {selected.size} selected. Each venue keeps its own approval
                  and history.
                </p>
              </div>
              <button
                className="button button--secondary"
                disabled={!selected.size}
                onClick={() => setSelected(new Set())}
              >
                Clear selection
              </button>
            </div>
            <div className="toolbar">
              <label className="search-box">
                <Icon name="search" size={18} />
                <input
                  aria-label="Search venues"
                  type="search"
                  placeholder="Search venues"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <span className="muted">
                {shownEligible.length} eligible shown
              </span>
            </div>
            <div className="release-table-wrap">
              <table className="release-table">
                <thead>
                  <tr>
                    <th>
                      <CheckAll
                        checked={
                          shownEligible.length > 0 &&
                          shownEligible.every((v) => selected.has(v.id))
                        }
                        mixed={
                          shownEligible.some((v) => selected.has(v.id)) &&
                          !shownEligible.every((v) => selected.has(v.id))
                        }
                        disabled={!shownEligible.length}
                        onChange={() =>
                          setSelected((prev) => {
                            const n = new Set(prev),
                              all = shownEligible.every((v) => n.has(v.id));
                            shownEligible.forEach((v) =>
                              all ? n.delete(v.id) : n.add(v.id),
                            );
                            return n;
                          })
                        }
                      />
                    </th>
                    <th>Venue</th>
                    <th>Last verified release</th>
                    <th>Update access</th>
                    <th>Automatic updates</th>
                    <th>Setup</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((v) => (
                    <tr key={v.id}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Select ${v.name}`}
                          checked={selected.has(v.id)}
                          disabled={!eligible(v) && !selected.has(v.id)}
                          onChange={() => toggle(v.id)}
                        />
                      </td>
                      <td>
                        <Link to={`/venues/${v.id}`}>{v.name}</Link>
                        <small>{v.slug}</small>
                      </td>
                      <td>{v.last_verified_version || 'Not recorded'}</td>
                      <td>
                        <span>
                          {blocking.get(v.id)?.status ||
                            (v.status !== 'active'
                              ? v.status
                              : v.configured
                                ? 'Ready for approval'
                                : 'Setup required')}
                        </span>
                      </td>
                      <td>
                        <button
                          type="button"
                          role="switch"
                          className={`switch${v.automatic_updates ? ' is-on' : ''}`}
                          aria-checked={v.automatic_updates === true}
                          aria-label={`Automatic updates for ${v.name}`}
                          disabled={
                            busy ||
                            (!v.automatic_updates &&
                              (!v.configured || v.status !== 'active'))
                          }
                          onClick={() => {
                            setFormError('');
                            setConfirm({
                              kind: 'policy',
                              venue: v,
                              enabled: !v.automatic_updates,
                            });
                          }}
                        >
                          <span />
                        </button>
                        <small>
                          {v.automatic_updates
                            ? 'New releases go live automatically'
                            : 'Approval required'}
                        </small>
                      </td>
                      <td>
                        <button
                          className="button button--secondary"
                          disabled={blocking.has(v.id)}
                          onClick={() => editTarget(v)}
                        >
                          {v.configured ? 'Edit setup' : 'Configure'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!filtered.length && (
              <div className="empty-inline">No matching venues.</div>
            )}
            <div className="release-approval-bar">
              <span>
                {selected.size} venue{selected.size === 1 ? '' : 's'} selected
                {!validSelection && selected.size > 0
                  ? ' · Remove venues that are no longer eligible.'
                  : ''}
              </span>
              <button
                className="button button--primary"
                disabled={!release || !validSelection || busy}
                onClick={() => {
                  setFormError('');
                  try {
                    setConfirm({
                      kind: 'approve',
                      release,
                      venues: chosen,
                      scheduledAt: releaseScheduleUtc(schedule),
                    });
                  } catch (e) {
                    setError(e.message);
                  }
                }}
              >
                Review approval
              </button>
            </div>
          </section>
          <section className="content-card">
            <div className="content-card__header">
              <div>
                <h2>Deployment history</h2>
                <p>
                  Success means all configured portals were checked against the
                  approved commit.
                </p>
              </div>
            </div>
            {!rollouts.length ? (
              <div className="empty-inline">
                No updates have been approved yet.
              </div>
            ) : (
              <div className="release-history">
                {rollouts.map((job) => (
                  <article key={job.id} className="release-job">
                    <div>
                      <strong>
                        {job.venue_name} · {job.version}
                      </strong>
                      <small>
                        {job.approval_mode === 'automatic'
                          ? 'Automatic update policy'
                          : `Approved by ${job.approved_by}`}{' '}
                        · Scheduled {formatDateTime(job.scheduled_at)}
                      </small>
                      <div className="release-progress">
                        {Object.entries(job.progress || {}).map(
                          ([key, value]) => (
                            <span key={key}>
                              {key}: {value}
                            </span>
                          ),
                        )}
                      </div>
                      {job.error && (
                        <p className="release-error">{job.error}</p>
                      )}
                    </div>
                    <div className="release-job__status">
                      <span
                        className={`release-state release-state--${job.status}`}
                      >
                        {job.status}
                      </span>
                      {job.status === 'queued' && (
                        <button
                          className="button button--secondary"
                          onClick={() => {
                            setFormError('');
                            setConfirm({ kind: 'cancel', job });
                          }}
                        >
                          Cancel
                        </button>
                      )}
                      {job.status === 'interrupted' && (
                        <button
                          className="button button--secondary"
                          onClick={() => {
                            setFormError('');
                            setConfirm({ kind: 'resolve', job });
                          }}
                        >
                          Resolve
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </>
      )}
      {newRelease && (
        <section
          ref={formDialogRef}
          tabIndex={-1}
          className="release-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="New release"
        >
          <form className="content-card release-form" onSubmit={saveRelease}>
            <h2>New release</h2>
            <p>
              Use a tested commit from the configured Platform repository.
              Automatic-update venues will queue this release. Other venues
              require approval.
            </p>
            <div className="release-fields">
              <label>
                Version
                <input
                  required
                  maxLength={50}
                  value={newRelease.version}
                  onChange={(e) =>
                    setNewRelease({ ...newRelease, version: e.target.value })
                  }
                  placeholder="1.9.0"
                />
              </label>
              <label>
                Full commit SHA
                <input
                  required
                  pattern="[a-f0-9]{40}"
                  value={newRelease.commitSha}
                  onChange={(e) =>
                    setNewRelease({ ...newRelease, commitSha: e.target.value })
                  }
                />
              </label>
            </div>
            <label>
              What changed
              <textarea
                required
                rows={5}
                maxLength={12000}
                value={newRelease.notes}
                onChange={(e) =>
                  setNewRelease({ ...newRelease, notes: e.target.value })
                }
              />
            </label>
            <label className="release-check">
              <input
                type="checkbox"
                checked={newRelease.tablet}
                onChange={(e) =>
                  setNewRelease({ ...newRelease, tablet: e.target.checked })
                }
              />
              Include an installed tablet app update
            </label>
            {newRelease.tablet && (
              <>
                <p>
                  Upload the inactive bundle to each selected venue first.
                  Approval checks its exact checksum.
                </p>
                <div className="release-fields">
                  {[
                    ['appId', 'App ID'],
                    ['channel', 'Channel'],
                    ['bundleVersion', 'Bundle version'],
                    ['checksum', 'SHA-256 checksum'],
                  ].map(([key, label]) => (
                    <label key={key}>
                      {label}
                      <input
                        required
                        value={newRelease[key]}
                        onChange={(e) =>
                          setNewRelease({
                            ...newRelease,
                            [key]: e.target.value,
                          })
                        }
                      />
                    </label>
                  ))}
                </div>
              </>
            )}
            {formError && (
              <p role="alert" className="release-error">
                {formError}
              </p>
            )}
            <div className="release-actions">
              <button
                type="button"
                className="button button--secondary"
                disabled={busy}
                onClick={() => setNewRelease(null)}
              >
                Cancel
              </button>
              <button className="button button--primary" disabled={busy}>
                {busy ? 'Saving…' : 'Create release'}
              </button>
            </div>
          </form>
        </section>
      )}
      {target && !target.manual && (
        <RailwaySetupDialog
          target={target}
          onClose={() => setTarget(null)}
          onAdvanced={() => setTarget({ ...target, manual: true })}
          onSaved={async () => {
            setTarget(null);
            setNotice(
              'Railway connected. Service folders and deployment controls were verified.',
            );
            await load();
          }}
        />
      )}
      {target?.manual && (
        <section
          ref={formDialogRef}
          tabIndex={-1}
          className="release-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`Deployment setup for ${target.name}`}
        >
          <form className="content-card release-form" onSubmit={saveTarget}>
            <h2>Deployment setup · {target.name}</h2>
            <p>
              Use this venue’s Railway project token. Saved tokens are encrypted
              and never displayed.
            </p>
            <div className="release-fields">
              {[
                ['projectId', 'Project ID'],
                ['environmentId', 'Environment ID'],
              ].map(([key, label]) => (
                <label key={key}>
                  {label}
                  <input
                    required
                    value={target[key]}
                    onChange={(e) =>
                      setTarget({ ...target, [key]: e.target.value })
                    }
                  />
                </label>
              ))}
              {[
                ['backend', 'Backend service ID'],
                ['admin', 'Admin service ID'],
                ['staff', 'Staff service ID (optional)'],
                ['employee', 'Employee service ID (optional)'],
              ].map(([key, label]) => (
                <label key={key}>
                  {label}
                  <input
                    required={key === 'backend' || key === 'admin'}
                    value={target.services[key]}
                    onChange={(e) =>
                      setTarget({
                        ...target,
                        services: { ...target.services, [key]: e.target.value },
                      })
                    }
                  />
                </label>
              ))}
              <label>
                Employee portal URL
                <input
                  type="url"
                  required={Boolean(target.services.employee)}
                  value={target.employeeUrl}
                  onChange={(e) =>
                    setTarget({ ...target, employeeUrl: e.target.value })
                  }
                />
              </label>
              <label>
                {target.configured
                  ? 'Replace project token (optional)'
                  : 'Railway project token'}
                <input
                  autoComplete="new-password"
                  type="password"
                  required={!target.configured}
                  value={target.railwayToken}
                  onChange={(e) =>
                    setTarget({ ...target, railwayToken: e.target.value })
                  }
                />
              </label>
            </div>
            <label className="release-check">
              <input
                type="checkbox"
                required
                checked={target.autoDeployDisabled}
                onChange={(e) =>
                  setTarget({ ...target, autoDeployDisabled: e.target.checked })
                }
              />
              I have disabled automatic deployments for every production service
              and configured each service’s component root directory.
            </label>
            {formError && (
              <p role="alert" className="release-error">
                {formError}
              </p>
            )}
            <div className="release-actions">
              <button
                className="button button--secondary"
                type="button"
                disabled={busy}
                onClick={() => setTarget(null)}
              >
                Cancel
              </button>
              <button className="button button--primary" disabled={busy}>
                {busy ? 'Saving…' : 'Save setup'}
              </button>
            </div>
          </form>
        </section>
      )}
      {confirm && (
        <Modal
          title={
            confirm.kind === 'policy'
              ? `${confirm.enabled ? 'Enable automatic updates' : 'Require approval'} · ${confirm.venue.name}`
              : confirm.kind === 'approve'
                ? `Approve ${confirm.release.version}`
                : confirm.kind === 'cancel'
                  ? 'Cancel queued update'
                  : 'Resolve interrupted deployment'
          }
          busy={busy}
          confirmLabel={
            confirm.kind === 'policy'
              ? confirm.enabled
                ? 'Enable automatic updates'
                : 'Require approval'
              : confirm.kind === 'approve'
                ? `Approve ${confirm.venues.length} venue${confirm.venues.length === 1 ? '' : 's'}`
                : confirm.kind === 'cancel'
                  ? 'Cancel update'
                  : 'Confirm stopped and close'
          }
          onClose={() => setConfirm(null)}
          onConfirm={applyConfirmation}
        >
          {confirm.kind === 'policy' ? (
            <p>
              {confirm.enabled
                ? `New published releases will deploy to ${confirm.venue.name} without per-release approval. The latest available release will be queued when this venue is ready.`
                : `${confirm.venue.name} will require approval for future releases. Queued automatic updates will be cancelled; any deployment already running will finish.`}
            </p>
          ) : confirm.kind === 'approve' ? (
            <>
              <p>
                Deploy <strong>{confirm.release.version}</strong> (
                {confirm.release.commit_sha.slice(0, 8)}){' '}
                {confirm.scheduledAt
                  ? `at ${formatDateTime(confirm.scheduledAt)}`
                  : 'when a worker is available'}{' '}
                to:
              </p>
              <ul>
                {confirm.venues.map((v) => (
                  <li key={v.id}>{v.name}</li>
                ))}
              </ul>
              <p>
                Each venue’s backend updates first. Its configured portals then
                update in parallel, and several venues can update at once. A
                failure can leave a venue partly updated; progress is recorded
                separately for each venue.
              </p>
            </>
          ) : confirm.kind === 'cancel' ? (
            <p>
              Cancel the queued {confirm.job.version} update for{' '}
              {confirm.job.venue_name}?
            </p>
          ) : (
            <p>
              Before closing this update, stop its previous worker and any
              pending Railway deployments for {confirm.job.venue_name}, then
              inspect the running versions. Confirm only after those deployments
              can no longer continue. This closes the record as failed and
              permits a new approval.
            </p>
          )}
          {formError && (
            <p role="alert" className="release-error">
              {formError}
            </p>
          )}
        </Modal>
      )}
    </div>
  );
}
