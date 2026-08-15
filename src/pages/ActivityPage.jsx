import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import Icon from '../components/Icon.jsx';
import { formatDateTime, humanise } from '../format.js';

export default function ActivityPage() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/audit?limit=200').then((payload) => setItems(payload.audit)).catch((requestError) => setError(requestError.message)).finally(() => setLoading(false));
  }, []);

  return (
    <div className="page">
      <header className="page-header"><div><span className="eyebrow">Console audit</span><h1>Activity</h1><p>Every registry and entitlement write initiated from CentralPass Console.</p></div></header>
      {error && <div className="form-alert form-alert--error"><Icon name="alert" size={18} />{error}</div>}
      <section className="content-card">
        <div className="content-card__header"><div><h2>Cross-venue history</h2><p>This local trail complements the entitlement audit held independently by each venue.</p></div></div>
        {loading ? <div className="loading-block">Loading audit history…</div> : items.length ? <div className="activity-table-wrap"><table className="activity-table"><thead><tr><th>Action</th><th>Venue</th><th>Actor</th><th>Outcome / detail</th><th>Time</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><span className="action-label"><Icon name={item.action.includes('contract') ? 'file' : item.action.includes('features') ? 'settings' : item.action.includes('auth') ? 'lock' : 'venues'} size={16} />{humanise(item.action.replace(/\./g, ' '))}</span></td><td>{item.venue_id ? <Link to={`/venues/${item.venue_id}`}>{item.venue_name || `Venue ${item.venue_id}`}</Link> : 'Console'}</td><td>{item.actor}</td><td><AuditDetail detail={item.detail} /></td><td>{formatDateTime(item.created_at)}</td></tr>)}</tbody></table></div> : <div className="empty-state empty-state--compact"><h3>No console activity yet</h3><p>Venue registry, contract and feature changes will appear here.</p></div>}
      </section>
    </div>
  );
}

function AuditDetail({ detail }) {
  if (!detail) return <span className="muted">—</span>;
  if (detail.overrides) {
    return <span>{Object.entries(detail.overrides).map(([key, value]) => `${humanise(key)} → ${value === null ? 'plan default' : value ? 'on' : 'off'}`).join(', ')}{detail.outcome && <em className={`outcome outcome--${detail.outcome}`}>{detail.outcome}</em>}</span>;
  }
  if (detail.name) return <span>{detail.name}{detail.registryStatus ? ` · ${detail.registryStatus}` : ''}</span>;
  if (detail.email) return <span>{detail.email}</span>;
  return <span className="muted">Recorded</span>;
}
