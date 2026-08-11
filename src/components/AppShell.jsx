import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import Brand from './Brand.jsx';
import Icon from './Icon.jsx';
import { useAuth } from '../auth.jsx';

const nav = [
  { to: '/', label: 'Overview', icon: 'dashboard', end: true },
  { to: '/venues', label: 'Venues', icon: 'venues' },
  { to: '/activity', label: 'Activity', icon: 'activity' },
];

export default function AppShell() {
  const { user, logout } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }, [location.pathname]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <aside className={`sidebar${mobileOpen ? ' is-open' : ''}`}>
        <div className="sidebar__top">
          <Brand />
          <button className="icon-button sidebar__close" type="button" aria-label="Close navigation" onClick={() => setMobileOpen(false)}><Icon name="x" /></button>
        </div>
        <nav className="sidebar__nav" aria-label="Primary navigation">
          <span className="nav-label">Manage</span>
          {nav.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} onClick={() => setMobileOpen(false)}>
              <Icon name={item.icon} size={19} />{item.label}
            </NavLink>
          ))}
          <span className="nav-label nav-label--second">Quick action</span>
          <NavLink to="/venues/new" onClick={() => setMobileOpen(false)}><Icon name="plus" size={19} />Add venue</NavLink>
        </nav>
        <div className="sidebar__security">
          <Icon name="shield" size={18} />
          <span><strong>Private control plane</strong><small>Venue keys stay server-side</small></span>
        </div>
        <div className="sidebar__user">
          <span className="avatar">{user?.name?.slice(0, 1).toUpperCase() || 'C'}</span>
          <span><strong>{user?.name}</strong><small>{user?.email}</small></span>
          <button className="icon-button" type="button" onClick={logout} title="Sign out" aria-label="Sign out"><Icon name="logOut" size={18} /></button>
        </div>
      </aside>
      {mobileOpen && <button className="sidebar-scrim" type="button" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}
      <div className="app-content">
        <header className="mobile-header">
          <button className="icon-button" type="button" aria-label="Open navigation" onClick={() => setMobileOpen(true)}><Icon name="menu" /></button>
          <Brand compact />
        </header>
        <main id="main-content"><Outlet /></main>
      </div>
    </div>
  );
}
