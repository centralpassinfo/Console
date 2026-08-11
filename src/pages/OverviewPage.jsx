import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import Icon from '../components/Icon.jsx';
import VenueTable from '../components/VenueTable.jsx';
import { formatNumber, formatDateTime } from '../format.js';

export default function OverviewPage() {
  const [venues, setVenues] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [checkedAt, setCheckedAt] = useState(null);

  const load = useCallback(async (quiet = false) => {
    quiet ? setRefreshing(true) : setLoading(true);
    setError('');
    try {
      const payload = await api('/venues');
      setVenues(payload.venues);
      setCheckedAt(payload.checkedAt);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(() => load(true), 60000);
    return () => window.clearInterval(timer);
  }, [load]);

  const summary = useMemo(() => {
    const active = venues.filter((venue) => venue.registryStatus !== 'offboarded');
    return {
      total: active.length,
      operational: active.filter((venue) => venue.live?.state === 'online').length,
      attention: active.filter((venue) => ['degraded', 'down', 'unreachable'].includes(venue.live?.state) || venue.live?.platform?.plan === 'unconfigured').length,
      orders: active.reduce((sum, venue) => sum + Number(venue.live?.platform?.counts?.orders_today || 0), 0),
    };
  }, [venues]);

  return (
    <div className="page">
      <header className="page-header">
        <div><span className="eyebrow">Fleet overview</span><h1>Good afternoon.</h1><p>Live service health and venue activity across CentralPass.</p></div>
        <div className="page-header__actions">
          {checkedAt && <span className="last-refresh">Last refresh<br /><strong>{formatDateTime(checkedAt)}</strong></span>}
          <button className="button button--secondary" type="button" onClick={() => load(true)} disabled={refreshing}><Icon name="refresh" size={17} className={refreshing ? 'spin' : ''} />{refreshing ? 'Refreshing' : 'Refresh'}</button>
          <Link className="button button--primary" to="/venues/new"><Icon name="plus" size={17} />Add venue</Link>
        </div>
      </header>

      {error && <div className="form-alert form-alert--error" role="alert"><Icon name="alert" size={18} />{error}<button type="button" onClick={() => load()}>Try again</button></div>}

      <section className="summary-grid" aria-label="Venue summary">
        <article className="summary-card"><div className="summary-card__icon summary-card__icon--blue"><Icon name="venues" /></div><span>Managed venues</span><strong>{loading ? '—' : summary.total}</strong><small>Active registry records</small></article>
        <article className="summary-card"><div className="summary-card__icon summary-card__icon--green"><Icon name="signal" /></div><span>Operational now</span><strong>{loading ? '—' : `${summary.operational}/${summary.total}`}</strong><small>{summary.total && summary.operational === summary.total ? 'All systems responding' : 'Based on latest check'}</small></article>
        <article className={`summary-card${summary.attention ? ' summary-card--attention' : ''}`}><div className="summary-card__icon summary-card__icon--amber"><Icon name="alert" /></div><span>Needs attention</span><strong>{loading ? '—' : summary.attention}</strong><small>Outages, access or plan issues</small></article>
        <article className="summary-card"><div className="summary-card__icon summary-card__icon--ink"><Icon name="orders" /></div><span>Orders today</span><strong>{loading ? '—' : formatNumber(summary.orders)}</strong><small>Across responding venues</small></article>
      </section>

      <section className="content-card">
        <div className="content-card__header"><div><h2>Venue operations</h2><p>Each check runs independently, so one unavailable venue cannot hold up the fleet.</p></div><Link className="text-link" to="/venues">View all venues <Icon name="chevron" size={16} /></Link></div>
        {loading ? <VenueTableSkeleton /> : venues.length ? <VenueTable venues={venues} /> : <EmptyVenues />}
      </section>

      <section className="security-note"><Icon name="shield" /><div><strong>Client credentials stay isolated.</strong><p>This console stores only CentralPass platform keys, encrypted at rest. Stripe, venue admin, R2, SMS and JWT secrets remain in each venue’s own deployment.</p></div></section>
    </div>
  );
}

function VenueTableSkeleton() {
  return <div className="skeleton-list" aria-label="Loading venues">{[1, 2, 3].map((item) => <div className="skeleton-row" key={item}><i /><span /><span /><span /><span /></div>)}</div>;
}

function EmptyVenues() {
  return <div className="empty-state"><span><Icon name="venues" size={28} /></span><h3>Add your first venue</h3><p>Register its API domain and CentralPass platform key to begin monitoring service health.</p><Link className="button button--primary" to="/venues/new"><Icon name="plus" size={17} />Add venue</Link></div>;
}

