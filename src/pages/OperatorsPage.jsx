import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import Icon from '../components/Icon.jsx';
import { formatDateTime } from '../format.js';

const EMPTY_NEW = { name: '', email: '', password: '', confirmCode: '' };

function groupSecret(secret) {
  return secret.replace(/(.{4})/g, '$1 ').trim();
}

// Shown once, straight after an account is created or its authenticator reset.
function AuthenticatorSetup({ setup, operator, onDone }) {
  return (
    <div className="contract-form operator-setup" role="status">
      <div className="contract-form__heading"><div><h3>Authenticator for {operator.name}</h3><p>Add this to {operator.name}’s authenticator app now. It is shown once and cannot be viewed again.</p></div></div>
      <ol className="operator-setup__steps">
        <li>In the authenticator app (1Password, Bitwarden, Google Authenticator), add an account and choose to enter a setup key.</li>
        <li>Account: <strong>CentralPass Console</strong> · {operator.email}</li>
        <li>Key: <code className="operator-secret">{groupSecret(setup.secret)}</code> (time based, 6 digits)</li>
      </ol>
      <details className="release-advanced"><summary>Setup link for password managers</summary><code className="operator-uri">{setup.uri}</code></details>
      <div className="contract-form__footer"><p><Icon name="shield" size={16} />Give the password to {operator.name} separately from this key.</p><div><button className="button button--primary" type="button" onClick={onDone}>I have added it</button></div></div>
    </div>
  );
}

export default function OperatorsPage() {
  const { user } = useAuth();
  const [operators, setOperators] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [adding, setAdding] = useState(null);
  const [action, setAction] = useState(null);
  const [setup, setSetup] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const payload = await api('/operators');
      setOperators(payload.operators);
      setError('');
    } catch (requestError) { setError(requestError.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function create(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api('/operators', { method: 'POST', body: adding });
      setAdding(null);
      setSetup({ operator: result.operator, setup: result.authenticator });
      await load();
    } catch (requestError) { setError(requestError.fields?.[0]?.message || requestError.message); }
    finally { setBusy(false); }
  }

  async function apply(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { operator, kind, confirmCode, password, authenticator } = action;
      let signedOut = false;
      if (kind === 'active') {
        await api(`/operators/${operator.id}/active`, { method: 'PUT', body: { active: !operator.active, confirmCode } });
        setNotice(`${operator.name} ${operator.active ? 'was deactivated and signed out everywhere' : 'can sign in again'}.`);
      } else {
        const result = await api(`/operators/${operator.id}/reset`, { method: 'POST', body: { password, authenticator, confirmCode } });
        if (result.authenticator) setSetup({ operator: result.operator, setup: result.authenticator });
        setNotice(`${operator.name}’s ${[password && 'password', authenticator && 'authenticator'].filter(Boolean).join(' and ')} ${password && authenticator ? 'were' : 'was'} reset. Their existing sessions have ended.`);
        // Resetting yourself ends this session too. Keep a new key on screen
        // until it is saved; the sign-in page follows "I have added it".
        signedOut = result.signedOut;
        if (signedOut && !result.authenticator) window.dispatchEvent(new Event('console:signed-out'));
      }
      setAction(null);
      if (!signedOut) await load();
    } catch (requestError) { setError(requestError.fields?.[0]?.message || requestError.message); }
    finally { setBusy(false); }
  }

  const confirmField = (value, onChange) => (
    <label className="field"><span>Your authenticator code</span><input required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength="6" value={value} onChange={(event) => onChange(event.target.value.replace(/\D/g, ''))} placeholder="123456" /><em>Confirms this change. A code works once.</em></label>
  );

  return (
    <div className="page">
      <header className="page-header"><div><span className="eyebrow">Access</span><h1>Operators</h1><p>Who can sign in to Console. Every change is confirmed with your authenticator code and recorded in Activity.</p></div>{!adding && <button className="button button--primary" type="button" onClick={() => { setAction(null); setError(''); setAdding({ ...EMPTY_NEW }); }}><Icon name="plus" size={17} />Add operator</button>}</header>
      {notice && <div className="form-alert form-alert--success" role="status"><Icon name="check" size={18} />{notice}<button type="button" onClick={() => setNotice('')} aria-label="Dismiss"><Icon name="x" size={16} /></button></div>}
      {error && !adding && !action && <div className="form-alert form-alert--error" role="alert"><Icon name="alert" size={18} />{error}</div>}

      <section className="content-card">
        {setup && <AuthenticatorSetup setup={setup.setup} operator={setup.operator} onDone={() => { setSetup(null); if (setup.operator.id === user?.id) window.dispatchEvent(new Event('console:signed-out')); }} />}
        {adding && (
          <form className="contract-form" onSubmit={create}>
            <div className="contract-form__heading"><div><h3>Add an operator</h3><p>They sign in with this email, the password you set, and the authenticator key shown next.</p></div><button className="icon-button" type="button" onClick={() => setAdding(null)} aria-label="Close"><Icon name="x" /></button></div>
            {error && <div className="form-alert form-alert--error" role="alert"><Icon name="alert" size={18} />{error}</div>}
            <div className="contract-form__grid">
              <label className="field"><span>Name</span><input required minLength="2" maxLength="120" value={adding.name} onChange={(event) => setAdding({ ...adding, name: event.target.value })} /></label>
              <label className="field"><span>Email</span><input required type="email" value={adding.email} onChange={(event) => setAdding({ ...adding, email: event.target.value })} /></label>
              <label className="field"><span>Password</span><input required type="password" autoComplete="new-password" minLength="14" value={adding.password} onChange={(event) => setAdding({ ...adding, password: event.target.value })} /><em>At least 14 characters.</em></label>
              {confirmField(adding.confirmCode, (confirmCode) => setAdding({ ...adding, confirmCode }))}
            </div>
            <div className="contract-form__footer"><p><Icon name="shield" size={16} />The authenticator key is shown once after saving.</p><div><button className="button button--secondary" type="button" onClick={() => setAdding(null)} disabled={busy}>Cancel</button><button className="button button--primary" type="submit" disabled={busy}>{busy ? 'Adding…' : 'Add operator'}</button></div></div>
          </form>
        )}
        {action && (
          <form className="contract-form" onSubmit={apply}>
            <div className="contract-form__heading"><div><h3>{action.kind === 'active' ? `${action.operator.active ? 'Deactivate' : 'Reactivate'} ${action.operator.name}` : `Reset access for ${action.operator.name}`}</h3><p>{action.kind === 'active' ? (action.operator.active ? 'They are signed out everywhere straight away and cannot sign in until reactivated.' : 'They can sign in again with their existing password and authenticator.') : 'Their existing sessions end. Use this for a lost phone or a forgotten password.'}</p></div><button className="icon-button" type="button" onClick={() => setAction(null)} aria-label="Close"><Icon name="x" /></button></div>
            {error && <div className="form-alert form-alert--error" role="alert"><Icon name="alert" size={18} />{error}</div>}
            <div className="contract-form__grid">
              {action.kind === 'reset' && (
                <>
                  <label className="field"><span>New password<small>Optional</small></span><input type="password" autoComplete="new-password" minLength="14" value={action.password} onChange={(event) => setAction({ ...action, password: event.target.value })} /><em>Leave empty to keep the current one.</em></label>
                  <label className="contract-checkbox"><input type="checkbox" checked={action.authenticator} onChange={(event) => setAction({ ...action, authenticator: event.target.checked })} /><span><strong>Issue a new authenticator key</strong><small>The old one stops working.</small></span></label>
                </>
              )}
              {confirmField(action.confirmCode, (confirmCode) => setAction({ ...action, confirmCode }))}
            </div>
            <div className="contract-form__footer"><p><Icon name="info" size={16} />Recorded in Activity.</p><div><button className="button button--secondary" type="button" onClick={() => setAction(null)} disabled={busy}>Cancel</button><button className={`button button--${action.kind === 'active' && action.operator.active ? 'danger' : 'primary'}`} type="submit" disabled={busy || (action.kind === 'reset' && !action.password && !action.authenticator)}>{busy ? 'Saving…' : action.kind === 'active' ? (action.operator.active ? 'Deactivate' : 'Reactivate') : 'Reset access'}</button></div></div>
          </form>
        )}
        {loading ? <div className="loading-block">Loading operators…</div> : (
          <div className="contract-list">
            {operators.map((operator) => (
              <article className="operator-row" key={operator.id}>
                <span className="avatar">{operator.name.slice(0, 1).toUpperCase()}</span>
                <div><h3>{operator.name}{operator.id === user?.id && <small> (you)</small>}</h3><span>{operator.email} · {operator.lastLoginAt ? `last signed in ${formatDateTime(operator.lastLoginAt)}` : 'never signed in'}</span></div>
                <span className={`billing-badge billing-badge--${operator.active ? 'paid' : 'none'}`}>{operator.active ? 'Active' : 'Deactivated'}</span>
                <div className="contract-record__actions">
                  <button className="button button--secondary" type="button" onClick={() => { setAdding(null); setError(''); setAction({ kind: 'reset', operator, password: '', authenticator: false, confirmCode: '' }); }}><Icon name="key" size={15} />Reset</button>
                  {operator.id !== user?.id && <button className="button button--secondary" type="button" onClick={() => { setAdding(null); setError(''); setAction({ kind: 'active', operator, confirmCode: '' }); }}>{operator.active ? 'Deactivate' : 'Reactivate'}</button>}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
