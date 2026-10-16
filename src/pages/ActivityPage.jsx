import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import Icon from '../components/Icon.jsx';
import { formatCurrencyCents, formatDate, formatDateTime, humanise } from '../format.js';
import { releaseLabel } from '../releaseLabel.mjs';

function actionIcon(action) {
  if (action.startsWith('contract')) return 'file';
  if (action.startsWith('billing')) return 'orders';
  if (action.startsWith('release') || action.startsWith('tablet')) return 'refresh';
  if (action.startsWith('operator')) return 'users';
  if (action.includes('features')) return 'settings';
  if (action.startsWith('auth')) return 'lock';
  return 'venues';
}

export default function ActivityPage() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/audit?limit=200').then((payload) => setItems(payload.audit)).catch((requestError) => setError(requestError.message)).finally(() => setLoading(false));
  }, []);

  return (
    <div className="page">
      <header className="page-header"><div><span className="eyebrow">Console audit</span><h1>Activity</h1><p>Every registry, commercial, release, access and entitlement change made through CentralPass Console.</p></div></header>
      {error && <div className="form-alert form-alert--error"><Icon name="alert" size={18} />{error}</div>}
      <section className="content-card">
        <div className="content-card__header"><div><h2>Cross-venue history</h2><p>This local trail complements the entitlement audit held independently by each venue.</p></div></div>
        {loading ? <div className="loading-block">Loading audit history…</div> : items.length ? <div className="activity-table-wrap"><table className="activity-table"><thead><tr><th>Action</th><th>Venue</th><th>Actor</th><th>Outcome / detail</th><th>Time</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><span className="action-label"><Icon name={actionIcon(item.action)} size={16} />{humanise(item.action.replace(/\./g, ' '))}</span></td><td>{item.venue_id ? <Link to={`/venues/${item.venue_id}`}>{item.venue_name || `Venue ${item.venue_id}`}</Link> : 'Console'}</td><td>{item.actor}</td><td><AuditDetail action={item.action} detail={item.detail} /></td><td>{formatDateTime(item.created_at)}</td></tr>)}</tbody></table></div> : <div className="empty-state empty-state--compact"><h3>No console activity yet</h3><p>Venue registry, contract and feature changes will appear here.</p></div>}
      </section>
    </div>
  );
}

const join = (...parts) => parts.filter(Boolean).join(' · ');
const release = (detail) => (detail.version || detail.commit ? releaseLabel({ version: detail.version, commit: detail.commit }) : null);

/** A one-line summary of what an audit entry recorded, by kind of action. */
function describe(action, detail) {
  if (action.startsWith('contract.')) {
    return join(detail.title, detail.status && humanise(detail.status), detail.fileName, detail.expiryDate && `expires ${formatDate(detail.expiryDate)}`);
  }
  if (action.startsWith('billing.invoice')) {
    const total = detail.amountCents != null ? formatCurrencyCents(Number(detail.amountCents) + Number(detail.gstCents || 0)) : null;
    return join(detail.invoiceNumber, detail.kind && humanise(detail.kind), detail.status && humanise(detail.status), total, detail.dueOn && `due ${formatDate(detail.dueOn)}`);
  }
  if (action === 'billing.payment.recorded') {
    return join(formatCurrencyCents(detail.amountCents), detail.invoiceNumber && `against ${detail.invoiceNumber}`, detail.method && humanise(detail.method), detail.resultingState && `now ${humanise(detail.resultingState).toLowerCase()}`);
  }
  if (action === 'billing.payment.removed') return join(formatCurrencyCents(detail.amountCents), detail.receivedOn && `received ${formatDate(detail.receivedOn)}`);
  if (action === 'tablet.approved') return join(`Tablet app ${detail.version}`, detail.channel, detail.rollback && 'rollback', detail.checksum && `checksum ${detail.checksum.slice(0, 10)}…`);
  if (action === 'release.automatic_policy.updated') return detail.enabled ? 'Automatic updates on' : 'Approval required';
  if (action.startsWith('release.target')) return join(detail.projectId && `project ${detail.projectId.slice(0, 8)}`, detail.services && Object.keys(detail.services).map(humanise).join(', '), detail.code && humanise(detail.code.toLowerCase()));
  if (action === 'release.source.connected') return detail.repository;
  if (action.startsWith('release.')) {
    return join(release(detail), detail.scheduledAt && `scheduled ${formatDateTime(detail.scheduledAt)}`, detail.reason, detail.error);
  }
  if (action.startsWith('operator.')) {
    return join(detail.name, detail.email, detail.password && 'new password', detail.authenticator && 'new authenticator');
  }
  return null;
}

function AuditDetail({ action, detail }) {
  if (!detail) return <span className="muted">—</span>;
  if (detail.overrides) {
    return <span>{Object.entries(detail.overrides).map(([key, value]) => `${humanise(key)} → ${value ? 'on' : 'off'}`).join(', ')}{detail.outcome && <em className={`outcome outcome--${detail.outcome}`}>{detail.outcome}</em>}</span>;
  }
  const summary = describe(action, detail);
  if (summary) return <span>{summary}</span>;
  if (detail.name) return <span>{detail.name}{detail.registryStatus ? ` · ${detail.registryStatus}` : ''}</span>;
  if (detail.email) return <span>{detail.email}</span>;
  return <span className="muted">Recorded</span>;
}
