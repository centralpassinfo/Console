import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import Icon from '../components/Icon.jsx';
import Modal from '../components/Modal.jsx';
import ContractPanel from '../components/ContractPanel.jsx';
import { PlanBadge, StatusBadge } from '../components/Status.jsx';
import { formatDateTime, formatNumber, humanise } from '../format.js';

const FEATURE_TIERS = [
  { key: 'core', title: 'Core platform', description: 'Always included and protected from entitlement changes.', features: ['ordering', 'kitchen', 'menu', 'hours', 'printing'] },
  { key: 'starter', title: 'Starter capability', description: 'Direct order communication.', features: ['order_emails'] },
  { key: 'pro', title: 'Pro capabilities', description: 'Customer context, messaging and reporting.', features: ['order_sms', 'customers', 'discounts', 'analytics'] },
  { key: 'premium', title: 'Premium capabilities', description: 'Growth, bookings and workforce tools.', features: ['offers', 'campaigns', 'bookings', 'timeclock'] },
];

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
  const plan = featureState?.plan;

  return (
    <div className="page page--detail">
      <Link className="back-link" to="/venues"><Icon name="arrowLeft" size={17} />All venues</Link>
      <header className="venue-header">
        <div className="venue-header__identity"><span className="venue-avatar">{venue.name.slice(0, 2).toUpperCase()}</span><div><span className="eyebrow">Venue control</span><h1>{venue.name}</h1><div className="venue-header__badges"><StatusBadge state={serviceState} /><PlanBadge plan={plan} /><span className={`registry-chip registry-chip--${venue.registryStatus}`}>{venue.registryStatus}</span></div></div></div>
        <div className="venue-header__actions">
          <button className="button button--secondary" type="button" onClick={load}><Icon name="refresh" size={17} />Refresh</button>
          <Link className="button button--secondary" to={`/venues/${id}/edit`}><Icon name="edit" size={17} />Edit venue</Link>
        </div>
      </header>

      {plan === 'unconfigured' && <div className="warning-banner" role="alert"><Icon name="alert" /><div><strong>This venue’s plan is not configured.</strong><p>Its PLAN environment variable is missing or invalid, so every billable feature is currently granted. Set PLAN to starter, pro or premium in its Railway backend.</p></div></div>}
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
        <div className="content-card__header content-card__header--feature"><div><span className="eyebrow">Entitlements</span><h2>Feature access</h2><p>Plan defaults come from the venue deployment. Overrides apply immediately and are recorded in both audit trails.</p></div><div className="feature-legend"><span><i className="source-dot source-dot--plan" />Plan default</span><span><i className="source-dot source-dot--override" />Explicit override</span><span><Icon name="lock" size={14} />Core</span></div></div>
        {featureState ? (
          <div className="feature-tiers">
            {FEATURE_TIERS.map((tier) => (
              <div className="feature-tier" key={tier.key}>
                <div className="feature-tier__intro"><span>{tier.title}</span><p>{tier.description}</p></div>
                <div className="feature-list">
                  {tier.features.map((key) => registry[key] && (
                    <FeatureRow
                      key={key}
                      definition={registry[key]}
                      effective={Boolean(featureState.features?.[key])}
                      override={Object.prototype.hasOwnProperty.call(featureState.overrides || {}, key) ? featureState.overrides[key] : undefined}
                      dependencies={featureState.features}
                      onChange={(value) => setChange({ key, value, label: registry[key].label, effective: featureState.features[key] })}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : <div className="unavailable-block"><Icon name="signal" /><h3>Feature data unavailable</h3><p>Restore the venue API connection to inspect or change entitlements.</p></div>}
      </section>

      <section className="detail-grid">
        <article className="content-card audit-card">
          <div className="content-card__header"><div><span className="eyebrow">Venue audit</span><h2>Recent entitlement activity</h2><p>Written by this venue’s own backend.</p></div></div>
          {live?.audit?.length ? <div className="audit-list">{live.audit.slice(0, 12).map((item, index) => <div className="audit-item" key={`${item.created_at}-${index}`}><span className={`audit-icon audit-icon--${item.action === 'clear' ? 'clear' : 'set'}`}><Icon name={item.action === 'clear' ? 'refresh' : 'settings'} size={16} /></span><div><strong>{humanise(item.feature_key)} {item.action === 'clear' ? 'reset to plan' : item.enabled ? 'enabled' : 'disabled'}</strong><small>{item.actor || 'Unknown actor'} · {formatDateTime(item.created_at)}</small></div></div>)}</div> : <div className="empty-inline">No entitlement changes have been recorded by this venue.</div>}
        </article>
        <article className="content-card notes-card">
          <div className="content-card__header"><div><span className="eyebrow">Internal only</span><h2>Billing notes</h2></div></div>
          <p>{venue.billingNotes || 'No billing notes have been added for this venue.'}</p>
          <dl><div><dt>Registry slug</dt><dd>{venue.slug}</dd></div><div><dt>Platform key</dt><dd><Icon name="eyeOff" size={15} />•••• set · never returned</dd></div><div><dt>Key last replaced</dt><dd>{formatDateTime(venue.keyRotatedAt)}</dd></div></dl>
        </article>
      </section>

      {change && (
        <Modal title={`Confirm change for ${venue.name}`} confirmLabel={change.value === null ? 'Reset to plan default' : change.value ? 'Enable feature' : 'Disable feature'} tone={change.value === false ? 'danger' : 'primary'} busy={busy} onClose={() => setChange(null)} onConfirm={applyChange}>
          <p>You are about to <strong>{change.value === null ? 'reset' : change.value ? 'enable' : 'disable'} {change.label}</strong> for <strong>{venue.name}</strong>.</p>
          {change.key === 'customers' && change.value === false && <div className="modal-warning"><Icon name="alert" size={18} />Offers and campaigns will also become unavailable because they require Customers.</div>}
          {change.value === null && <p className="modal-note">The effective setting will return to the <strong>{plan}</strong> plan default.</p>}
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

function FeatureRow({ definition, effective, override, dependencies, onChange }) {
  const core = definition.core;
  const hasOverride = override !== undefined;
  const dependencyBlocked = definition.requires?.some((key) => !dependencies?.[key]);
  let source = core ? 'Always included' : hasOverride ? `Override ${override ? 'on' : 'off'}` : effective ? 'Included by plan' : 'Not in plan';
  if (dependencyBlocked) source = `Blocked · requires ${definition.requires.map(humanise).join(', ')}`;
  return (
    <div className={`feature-row${!effective ? ' is-off' : ''}`}>
      <div className="feature-row__name"><strong>{definition.label}</strong>{definition.requires?.length > 0 && <small>Requires {definition.requires.map(humanise).join(', ')}</small>}</div>
      <span className={`feature-source feature-source--${core ? 'core' : hasOverride ? 'override' : 'plan'}`}>{core && <Icon name="lock" size={13} />}{source}</span>
      <div className="feature-row__actions">
        {!core && hasOverride && <button className="reset-link" type="button" onClick={() => onChange(null)}>Reset</button>}
        {core ? <span className="locked-switch" aria-label="Core feature locked on"><Icon name="lock" size={14} /></span> : <button type="button" className={`switch${effective ? ' is-on' : ''}`} role="switch" aria-checked={effective} aria-label={dependencyBlocked ? `${definition.label} unavailable until its dependency is enabled` : `${effective ? 'Disable' : 'Enable'} ${definition.label}`} disabled={dependencyBlocked} onClick={() => onChange(!effective)}><span /></button>}
      </div>
    </div>
  );
}
