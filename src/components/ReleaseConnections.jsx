import { useRef, useState } from 'react';
import { api } from '../api.js';
import { formatReleaseTime } from '../releaseTime.mjs';
import useDialogFocus from '../useDialogFocus.js';

export function ReleaseSourceCard({ source = {}, onChange }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function act(connect) {
    setBusy(true);
    setError('');
    try {
      const result = await api(
        connect ? '/releases/source' : '/releases/sync',
        { method: 'POST', body: connect ? { githubToken: token } : {} },
      );
      setToken('');
      await onChange(result.message);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const tokenForm = (
    <form
      className="release-connection-form"
      onSubmit={(e) => {
        e.preventDefault();
        act(true);
      }}
    >
      <label>
        GitHub read token
        <input
          type="password"
          autoComplete="new-password"
          required
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Paste once to connect Platform"
        />
      </label>
      <p>
        Give the token Contents and Actions read access to the Platform
        repository. It is encrypted, shared by Console and the worker, and never
        displayed again.
      </p>
      <button className="button button--primary" disabled={busy || !token}>
        {busy ? 'Connecting…' : 'Connect GitHub'}
      </button>
    </form>
  );
  return (
    <section className="content-card release-source-card">
      <div className="content-card__header">
        <div>
          <h2>Platform releases</h2>
          <p>
            {source.repository || 'CentralPass/centralpass-platform'} ·{' '}
            {source.connected ? 'Connected' : 'Connect once for all venues'}
          </p>
        </div>
        {source.connected && (
          <button
            className="button button--primary"
            disabled={busy}
            onClick={() => act(false)}
          >
            {busy ? 'Checking…' : 'Check for releases'}
          </button>
        )}
      </div>
      <ol className="release-flow">
        <li>
          <strong>Push to main</strong>
          <span>Commit and push your Platform changes.</span>
        </li>
        <li>
          <strong>CI checks the code</strong>
          <span>Tests and portal builds must pass.</span>
        </li>
        <li>
          <strong>Release appears here</strong>
          <span>Version, commit and notes are filled automatically.</span>
        </li>
        <li>
          <strong>Deploy by venue</strong>
          <span>Automatic venues update; approve or schedule the others.</span>
        </li>
      </ol>
      <div className="release-source-status">
        <p>
          {source.message ||
            (source.connected
              ? 'The worker checks for tested builds between deployments. You can also check now.'
              : 'A single GitHub connection replaces manual version and commit entry.')}
        </p>
        {source.lastChecked && (
          <small>Last checked {formatReleaseTime(source.lastChecked)}</small>
        )}
        {(error || source.error) && (
          <p className="release-error" role="alert">
            {error || source.error}
          </p>
        )}
      </div>
      {source.connected ? (
        <details className="release-advanced">
          <summary>Change GitHub connection</summary>
          {tokenForm}
        </details>
      ) : (
        tokenForm
      )}
    </section>
  );
}

export function RailwaySetupDialog({ target, onClose, onSaved, onAdvanced }) {
  const [token, setToken] = useState('');
  const [discovery, setDiscovery] = useState(null);
  const [services, setServices] = useState(target.services);
  const [employeeUrl, setEmployeeUrl] = useState(target.employeeUrl || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef(null);
  useDialogFocus(ref, { busy, onClose });
  async function discover() {
    setBusy(true);
    setError('');
    try {
      const { discovered } = await api(
        `/releases/targets/${target.venueId}/discover`,
        { method: 'POST', body: { railwayToken: token } },
      );
      const suggested = { ...discovered.suggested };
      for (const role of Object.keys(suggested))
        if (
          target.configured &&
          ['staff', 'employee'].includes(role) &&
          !target.services[role]
        )
          suggested[role] = '';
        else if (
          discovered.services.some((s) => s.id === target.services[role])
        )
          suggested[role] = target.services[role];
      setServices(suggested);
      setDiscovery(discovered);
      setEmployeeUrl(
        target.employeeUrl ||
          discovered.services.find((s) => s.id === suggested.employee)
            ?.urls[0] ||
          '',
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function connect(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/releases/targets/${target.venueId}/connect`, {
        method: 'POST',
        body: {
          railwayToken: token,
          services,
          employeeUrl,
          manageUpdates: true,
        },
      });
      await onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      ref={ref}
      tabIndex={-1}
      className="release-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Connect Railway for ${target.name}`}
    >
      <form
        className="content-card release-form"
        onSubmit={
          discovery
            ? connect
            : (e) => {
                e.preventDefault();
                discover();
              }
        }
      >
        <h2>Connect Railway · {target.name}</h2>
        <p>
          Paste this venue’s project token. Console finds the project,
          production environment, services and portal addresses for you.
        </p>
        <label>
          {target.configured
            ? 'Project token (leave empty to use the saved token)'
            : 'Railway project token'}
          <input
            type="password"
            autoComplete="new-password"
            required={!target.configured}
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              setDiscovery(null);
            }}
            placeholder={
              target.configured
                ? 'Saved token will be used'
                : 'Paste project token'
            }
          />
        </label>
        {discovery && (
          <>
            <div className="release-discovery-summary">
              <strong>{discovery.projectName}</strong>
              <span>Environment: {discovery.environmentName}</span>
            </div>
            <p>
              Confirm which service runs each part of this venue. Matches are
              selected automatically where they are clear.
            </p>
            <div className="release-fields">
              {[
                ['backend', 'Backend'],
                ['admin', 'Owner dashboard'],
                ['staff', 'Staff portal (optional)'],
                ['employee', 'Employee portal (optional)'],
              ].map(([role, label]) => (
                <label key={role}>
                  {label}
                  <select
                    aria-label={label}
                    required={role === 'backend' || role === 'admin'}
                    value={services[role] || ''}
                    onChange={(e) => {
                      setServices({ ...services, [role]: e.target.value });
                      if (role === 'employee')
                        setEmployeeUrl(
                          discovery.services.find(
                            (s) => s.id === e.target.value,
                          )?.urls[0] || '',
                        );
                    }}
                  >
                    <option value="">
                      {role === 'staff' || role === 'employee'
                        ? 'Not used'
                        : 'Choose a service'}
                    </option>
                    {discovery.services.map((s) => (
                      <option
                        key={s.id}
                        value={s.id}
                        disabled={Object.entries(services).some(
                          ([other, id]) => other !== role && id === s.id,
                        )}
                      >
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            {services.employee &&
              !discovery.services.find((s) => s.id === services.employee)?.urls
                .length && (
                <label>
                  Employee portal URL
                  <input
                    type="url"
                    required
                    value={employeeUrl}
                    onChange={(e) => setEmployeeUrl(e.target.value)}
                  />
                </label>
              )}
            <p className="release-setup-note">
              Connecting sets these services’ component folders and disables
              Railway’s direct automatic deployments in{' '}
              <strong>{discovery.environmentName}</strong>. Console’s per-venue
              automatic-update switch will control future releases.
            </p>
          </>
        )}
        {error && (
          <p className="release-error" role="alert">
            {error}
          </p>
        )}
        <div className="release-actions">
          <button
            type="button"
            className="button button--secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button className="button button--primary" disabled={busy}>
            {busy
              ? discovery
                ? 'Connecting…'
                : 'Finding services…'
              : discovery
                ? 'Connect venue'
                : 'Find services'}
          </button>
        </div>
        <button
          type="button"
          className="release-advanced-button"
          disabled={busy}
          onClick={onAdvanced}
        >
          Advanced: enter deployment IDs manually
        </button>
      </form>
    </section>
  );
}
