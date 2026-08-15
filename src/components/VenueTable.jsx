import { Link } from 'react-router-dom';
import Icon from './Icon.jsx';
import { ContractBadge } from './ContractPanel.jsx';
import { PlanBadge, StatusBadge } from './Status.jsx';
import { formatNumber, relativeTime } from '../format.js';

export default function VenueTable({ venues }) {
  return (
    <div className="table-wrap">
      <table className="venue-table">
        <thead>
          <tr>
            <th>Venue</th>
            <th>Status</th>
            <th>Plan</th>
            <th>Contract</th>
            <th className="numeric">Orders today</th>
            <th className="numeric">Customers</th>
            <th>Last checked</th>
            <th><span className="sr-only">Open venue</span></th>
          </tr>
        </thead>
        <tbody>
          {venues.map((venue) => {
            const live = venue.live || { state: 'checking' };
            const platform = live.platform || {};
            const warning = platform.plan === 'unconfigured';
            const contractState = venue.contractSummary?.state || 'missing';
            const contractWarning = ['missing', 'expiring', 'expired'].includes(contractState);
            const trouble = ['down', 'unreachable'].includes(live.state);
            return (
              <tr key={venue.id} className={`${trouble ? 'is-trouble' : ''}${warning || contractWarning ? ' is-warning' : ''}`}>
                <td data-label="Venue">
                  <Link className="venue-name" to={`/venues/${venue.id}`}>
                    <span className="venue-monogram">{venue.name.slice(0, 2).toUpperCase()}</span>
                    <span><strong>{venue.name}</strong><small>{venue.apiUrl.replace(/^https?:\/\//, '')}</small></span>
                  </Link>
                </td>
                <td data-label="Status">
                  <StatusBadge state={live.state || 'checking'} />
                  {live.error && <small className="status-detail" title={live.error}>{live.error}</small>}
                </td>
                <td data-label="Plan"><PlanBadge plan={platform.plan} /></td>
                <td data-label="Contract"><ContractBadge state={contractState} /></td>
                <td data-label="Orders today" className="numeric metric-cell">{platform.counts ? formatNumber(platform.counts.orders_today) : '—'}</td>
                <td data-label="Customers" className="numeric metric-cell">{platform.counts ? formatNumber(platform.counts.customers) : '—'}</td>
                <td data-label="Last checked"><span title={live.checkedAt}>{relativeTime(live.checkedAt)}</span>{live.latencyMs != null && <small className="latency">{live.latencyMs} ms</small>}</td>
                <td className="row-action"><Link to={`/venues/${venue.id}`} aria-label={`Open ${venue.name}`}><Icon name="chevron" size={18} /></Link></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
