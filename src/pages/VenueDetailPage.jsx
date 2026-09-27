import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import Icon from '../components/Icon.jsx';
import Modal from '../components/Modal.jsx';
import ContractPanel from '../components/ContractPanel.jsx';
import { StatusBadge } from '../components/Status.jsx';
import { formatDateTime, formatNumber, humanise } from '../format.js';

export default function VenueDetailPage() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [change, setChange] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try { setData(await api(`/venues/${id}`)); }
    catch (requestError) { setError(requestError.message); }
    finally { setLoading(false); }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const featureState = data?.live?.status;
  const registry = useMemo(() => Object.fromEntries((featureState?.registry || []).map((feature) => [feature.key, feature])), [featureState]);

  async function applyChange() {
    if (!change) return;
    setBusy(true);
    setNotice('');
    try {
      const payload = await api(`/venues/${id}/features`, { method: 'PUT', body: { overrides: { [change.key]: change.value } } });
      setData((current) => ({
        ...current,
        live: { ...current.live, status: { ...current.live.status, ...payload.features } },
      }));
      setNotice(`${registry[change.key]?.label || humanise(change.key)} was updated.`);
      setChange(null);
    } catch (requestError) {
      setChange((current) => ({ ...current, error: requestError.message }));
    } finally { setBusy(false); }
  }

  if (loading) return <div className="page"><div className="detail-loading"><span className="spinner" /><p>Contacting venue services…</p></div></div>;
  if (error || !data) return <div className="page"><div className="error-state"><Icon name="alert" size={28} /><h1>Venue could not be loaded</h1><p>{error}</p><button className="button button--secondary" onClick={load}>Try again</button></div></div>;

  const { venue, live, contracts = [] } = data;
  const serviceState = live?.error ? (live.errorCode === 'UNREACHABLE' || live.errorCode === 'TIMEOUT' ? 'unreachable' : 'degraded') : 'online';

  return (
    <div className="page page--detail">
      <Link className="back-link" to="/venues"><Icon name="arrowLeft" size={17} />All venues</Link>
      <header className="venue-header">
        <div className="venue-header__identity"><span className="venue-avatar">{venue.name.slice(0, 2).toUpperCase()}</span><div><span className="eyebrow">Venue control</span><h1>{venue.name}</h1><div className="venue-header__badges"><StatusBadge state={serviceState} /><span className={`registry-chip registry-chip--${venue.registryStatus}`}>{venue.registryStatus}</span></div></div></div>
        <div className="venue-header__actions">
          <button className="button button--secondary" type="button" onClick={load}><Icon name="refresh" size={17} />Refresh</button>
          <Link className="button button--secondary" to={`/venues/${id}/edit`}><Icon name="edit" size={17} />Edit venue</Link>
        </div>
      </header>

      {live?.error && <div className="danger-banner" role="alert"><Icon name="alert" /><div><strong>Live controls are unavailable.</strong><p>{live.error} The registry record is still available, but no entitlement change can be made until the connection recovers.</p></div></div>}
      {notice && <div className="form-alert form-alert--success" role="status"><Icon name="check" size={18} />{notice}<button type="button" onClick={() => setNotice('')} aria-label="Dismiss"><Icon name="x" size={16} /></button></div>}

      <section className="detail-grid detail-grid--top">
        <article className="content-card service-card">
          <div className="content-card__header"><div><h2>Service snapshot</h2><p>Live from the venue API, not copied into this console.</p></div><StatusBadge state={serviceState} /></div>
          <div className="service-metrics">
            <div><span>Orders today</span><strong>{featureState?.counts ? formatNumber(featureState.counts.orders_today) : '—'}</strong></div>
            <div><span>Customers</span><strong>{featureState?.counts ? formatNumber(featureState.counts.customers) : '—'}</strong></div>
            <div><span>Response time</span><strong>{live?.latencyMs != null ? `${live.latencyMs} ms` : '—'}</strong></div>
            <div><span>Last checked</span><strong className="metric-date">{live?.checkedAt ? formatDateTime(live.checkedAt) : '—'}</strong></div>
          </div>
        </article>
        <article className="content-card links-card">
          <div className="content-card__header"><div><h2>Venue surfaces</h2><p>Open the venue’s own customer and team tools.</p></div></div>
          <div className="surface-links">
            <SurfaceLink label="Customer website" url={venue.siteUrl} />
            <SurfaceLink label="Owner dashboard" url={venue.adminUrl} />
            <SurfaceLink label="Staff operations" url={venue.staffUrl} />
            <SurfaceLink label="Venue API" url={venue.apiUrl} />
          </div>
        </article>
      </section>

      <ContractPanel venueId={venue.id} initialContracts={contracts} />

      <section className="content-card feature-panel">
        <div className="content-card__header content-card__header--feature"><div><span className="eyebrow">Venue features</span><h2>Feature access</h2><p>Switch on exactly what this venue uses. Every change takes effect immediately and is audited. A new venue starts with all features off.</p></div></div>
        {featureState ? (
          <div className="feature-access-list">
                <div className="feature-list">
                  {(featureState.registry || []).map(({ key }) => registry[key] && (
                    <FeatureRow
                      key={key}
                      definition={registry[key]}
                      effective={Boolean(featureState.features?.[key])}
                      assigned={Boolean(featureState.assignments?.[key])}
                      dependencies={featureState.features}
                      onChange={(value) => setChange({ key, value, label: registry[key].label, effective: featureState.features[key] })}
                    />
                  ))}
                </div>
          </div>
        ) : <div className="unavailable-block"><Icon name="signal" /><h3>Feature data unavailable</h3><p>Restore the venue API connection to inspect or change entitlements.</p></div>}
      </section>

      <section className="detail-grid">
        <article className="content-card audit-card">
          <div className="content-card__header"><div><span className="eyebrow">Venue audit</span><h2>Recent entitlement activity</h2><p>Written by this venue’s own backend.</p></div></div>
          {live?.audit?.length ? <div className="audit-list">{live.audit.slice(0, 12).map((item, index) => <div className="audit-item" key={`${item.created_at}-${index}`}><span className="audit-icon audit-icon--set"><Icon name="settings" size={16} /></span><div><strong>{humanise(item.feature_key)} {item.enabled ? 'enabled' : 'disabled'}</strong><small>{item.actor || 'Unknown actor'} · {formatDateTime(item.created_at)}</small></div></div>)}</div> : <div className="empty-inline">No feature changes have been recorded by this venue.</div>}
        </article>
        <article className="content-card notes-card">
          <div className="content-card__header"><div><span className="eyebrow">Internal only</span><h2>Billing notes</h2></div></div>
          <p>{venue.billingNotes || 'No billing notes have been added for this venue.'}</p>
          <dl><div><dt>Registry slug</dt><dd>{venue.slug}</dd></div><div><dt>Platform key</dt><dd><Icon name="eyeOff" size={15} />•••• set · never returned</dd></div><div><dt>Key last replaced</dt><dd>{formatDateTime(venue.keyRotatedAt)}</dd></div></dl>
        </article>
      </section>

      {change && (
        <Modal title={`Confirm change for ${venue.name}`} confirmLabel={change.value ? 'Enable feature' : 'Disable feature'} tone={change.value === false ? 'danger' : 'primary'} busy={busy} onClose={() => setChange(null)} onConfirm={applyChange}>
          <p>You are about to <strong>{change.value ? 'enable' : 'disable'} {change.label}</strong> for <strong>{venue.name}</strong>.</p>
          {change.value === false && (featureState?.registry || []).some((feature) => feature.requires?.includes(change.key) && featureState.features?.[feature.key]) && (
            <div className="modal-warning"><Icon name="alert" size={18} />This will also turn off {featureState.registry.filter((feature) => feature.requires?.includes(change.key) && featureState.features?.[feature.key]).map((feature) => feature.label).join(', ')} until their requirements are enabled again.</div>
          )}
          {change.error && <div className="form-alert form-alert--error"><Icon name="alert" size={18} />{change.error}</div>}
        </Modal>
      )}
    </div>
  );
}

function SurfaceLink({ label, url }) {
  if (!url) return <div className="surface-link is-empty"><span>{label}</span><small>Not configured</small></div>;
  return <a className="surface-link" href={url} target="_blank" rel="noreferrer"><span>{label}</span><small>{url.replace(/^https?:\/\//, '')}</small><Icon name="external" size={17} /></a>;
}

function FeatureRow({ definition, effective, assigned, dependencies, onChange }) {
  const dependencyBlocked = definition.requires?.some((key) => !dependencies?.[key]);
  let source = assigned ? 'On' : 'Off';
  if (dependencyBlocked) source = `Blocked · requires ${definition.requires.map(humanise).join(', ')}`;
  return (
    <div className={`feature-row${!effective ? ' is-off' : ''}`}>
      <div className="feature-row__name"><strong>{definition.label}</strong>{definition.requires?.length > 0 && <small>Requires {definition.requires.map(humanise).join(', ')}</small>}</div>
      <span className={`feature-source${effective ? ' feature-source--override' : ''}`}>{source}</span>
      <div className="feature-row__actions">
        <button type="button" className={`switch${assigned ? ' is-on' : ''}`} role="switch" aria-checked={assigned} aria-label={dependencyBlocked && !assigned ? `${definition.label} unavailable until its dependency is enabled` : `${assigned ? 'Disable' : 'Enable'} ${definition.label}`} disabled={dependencyBlocked && !assigned} onClick={() => onChange(!assigned)}><span /></button>
      </div>
    </div>
  );
}
