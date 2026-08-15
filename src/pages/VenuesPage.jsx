import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import Icon from '../components/Icon.jsx';
import VenueTable from '../components/VenueTable.jsx';

export default function VenuesPage() {
  const [venues, setVenues] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    api('/venues').then((payload) => setVenues(payload.venues)).catch((requestError) => setError(requestError.message)).finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => venues.filter((venue) => {
    const matchesQuery = `${venue.name} ${venue.slug} ${venue.apiUrl}`.toLowerCase().includes(query.toLowerCase());
    const state = venue.live?.state;
    const matchesFilter = filter === 'all'
      || (filter === 'attention' && (['degraded', 'down', 'unreachable'].includes(state) || venue.live?.platform?.plan === 'unconfigured' || ['missing', 'expiring', 'expired'].includes(venue.contractSummary?.state)))
      || filter === state
      || filter === venue.registryStatus;
    return matchesQuery && matchesFilter;
  }), [venues, query, filter]);

  return (
    <div className="page">
      <header className="page-header"><div><span className="eyebrow">Registry</span><h1>Venues</h1><p>Connection details, live plans and current service status.</p></div><Link className="button button--primary" to="/venues/new"><Icon name="plus" size={17} />Add venue</Link></header>
      {error && <div className="form-alert form-alert--error"><Icon name="alert" size={18} />{error}</div>}
      <section className="content-card">
        <div className="toolbar">
          <label className="search-box"><Icon name="search" size={18} /><span className="sr-only">Search venues</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search venues or API domains" /></label>
          <div className="filter-tabs" role="group" aria-label="Filter venues">
            {['all', 'online', 'attention', 'offboarded'].map((value) => <button key={value} type="button" className={filter === value ? 'is-active' : ''} onClick={() => setFilter(value)}>{value === 'online' ? 'Operational' : value.charAt(0).toUpperCase() + value.slice(1)}</button>)}
          </div>
        </div>
        {loading ? <div className="loading-block">Checking venue connections…</div> : filtered.length ? <VenueTable venues={filtered} /> : <div className="empty-state empty-state--compact"><h3>No matching venues</h3><p>Change the search or status filter.</p></div>}
      </section>
    </div>
  );
}
