import { useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import Brand from '../components/Brand.jsx';
import Icon from '../components/Icon.jsx';
import { useAuth } from '../auth.jsx';

export default function LoginPage() {
  const { user, login } = useAuth();
  const location = useLocation();
  const [form, setForm] = useState({ email: '', password: '', totpCode: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={location.state?.from || '/'} replace />;

  async function handleSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(form);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-panel">
        <div className="login-panel__brand"><Brand /></div>
        <div className="login-panel__copy">
          <span className="eyebrow"><i /> Internal access only</span>
          <h1>Your venues,<br />under control.</h1>
          <p>One private view for service health, plans and paid feature access across every CentralPass venue.</p>
        </div>
        <div className="login-panel__assurance"><Icon name="shield" /><span><strong>Remote control, not a vault.</strong><small>Client payment and admin credentials never live here.</small></span></div>
      </section>
      <section className="login-form-wrap">
        <form className="login-form" onSubmit={handleSubmit}>
          <div className="login-form__heading">
            <span className="login-lock"><Icon name="lock" size={20} /></span>
            <h2>Sign in to Console</h2>
            <p>Password and authenticator code are both required.</p>
          </div>
          {error && <div className="form-alert form-alert--error" role="alert"><Icon name="alert" size={18} />{error}</div>}
          <label className="field">
            <span>Email address</span>
            <input type="email" autoComplete="username" required value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="you@centralpass.au" />
          </label>
          <label className="field">
            <span>Password</span>
            <input type="password" autoComplete="current-password" minLength="12" required value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder="Enter your password" />
          </label>
          <label className="field">
            <span>Authenticator code</span>
            <input className="totp-input" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength="6" required value={form.totpCode} onChange={(event) => setForm({ ...form, totpCode: event.target.value.replace(/\D/g, '').slice(0, 6) })} placeholder="000 000" />
          </label>
          <button className="button button--primary button--wide" type="submit" disabled={busy || form.totpCode.length !== 6}>{busy ? 'Verifying…' : 'Sign in securely'}</button>
          <p className="login-help">No public signup. Accounts are provisioned by CentralPass only.</p>
        </form>
      </section>
    </main>
  );
}

