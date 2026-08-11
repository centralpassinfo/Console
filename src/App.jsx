import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import AppShell from './components/AppShell.jsx';
import Brand from './components/Brand.jsx';
import ActivityPage from './pages/ActivityPage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import OverviewPage from './pages/OverviewPage.jsx';
import VenueDetailPage from './pages/VenueDetailPage.jsx';
import VenueFormPage from './pages/VenueFormPage.jsx';
import VenuesPage from './pages/VenuesPage.jsx';

function Protected({ children }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="boot-screen"><Brand /><span className="spinner" /><p>Securing Console…</p></div>;
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<Protected><AppShell /></Protected>}>
        <Route index element={<OverviewPage />} />
        <Route path="venues" element={<VenuesPage />} />
        <Route path="venues/new" element={<VenueFormPage />} />
        <Route path="venues/:id" element={<VenueDetailPage />} />
        <Route path="venues/:id/edit" element={<VenueFormPage />} />
        <Route path="activity" element={<ActivityPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

