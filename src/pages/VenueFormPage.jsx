import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import Icon from '../components/Icon.jsx';

const initialForm = { name: '', slug: '', apiUrl: '', siteUrl: '', adminUrl: '', staffUrl: '', registryStatus: 'active', billingNotes: '', platformApiKey: '' };

export default function VenueFormPage() {
  const { id } = useParams();
  const editing = Boolean(id);
  const navigate = useNavigate();
  const [form, setForm] = useState(initialForm);
  const [loading, setLoading] = useState(editing);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [replaceKey, setReplaceKey] = useState(!editing);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [testResult, setTestResult] = useState(null);
  const [slugTouched, setSlugTouched] = useState(false);

  useEffect(() => {
    if (!editing) return;
    api(`/venues/${id}`).then(({ venue }) => setForm({
      name: venue.name,
      slug: venue.slug,
      apiUrl: venue.apiUrl,
      siteUrl: venue.siteUrl || '',
      adminUrl: venue.adminUrl || '',
      staffUrl: venue.staffUrl || '',
      registryStatus: venue.registryStatus,
      billingNotes: venue.billingNotes || '',
      platformApiKey: '',
    })).catch((requestError) => setError(requestError.message)).finally(() => setLoading(false));
  }, [editing, id]);

  function setField(field, value) {
    setForm((current) => {
      const next = { ...current, [field]: value };
      if (field === 'name' && !slugTouched && !editing) next.slug = slugify(value);
      return next;
    });
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
    setTestResult(null);
  }

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    setError('');
    try {
      const body = editing && !form.platformApiKey
        ? { id: Number(id), apiUrl: form.apiUrl }
        : { apiUrl: form.apiUrl, platformApiKey: form.platformApiKey, ...(editing ? { id: Number(id) } : {}) };
      const result = await api('/venues/test-connection', { method: 'POST', body });
      setTestResult({ ok: true, message: `Connected to ${result.venue || 'venue'} in ${result.latencyMs} ms · ${result.plan} plan` });
    } catch (requestError) {
      setTestResult({ ok: false, message: requestError.message });
    } finally { setTesting(false); }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setFieldErrors({});
    try {
      const body = { ...form };
      if (editing && !replaceKey) delete body.platformApiKey;
      const payload = await api(editing ? `/venues/${id}` : '/venues', { method: editing ? 'PUT' : 'POST', body });
      navigate(`/venues/${payload.venue.id}`);
    } catch (requestError) {
      setError(requestError.message);
      setFieldErrors(Object.fromEntries((requestError.fields || []).map((item) => [item.field, item.message])));
    } finally { setBusy(false); }
  }

  if (loading) return <div className="page"><div className="detail-loading"><span className="spinner" /><p>Loading venue registry…</p></div></div>;

  return (
    <div className="page page--form">
      <Link className="back-link" to={editing ? `/venues/${id}` : '/venues'}><Icon name="arrowLeft" size={17} />{editing ? 'Back to venue' : 'All venues'}</Link>
      <header className="page-header"><div><span className="eyebrow">Venue registry</span><h1>{editing ? `Edit ${form.name}` : 'Add a venue'}</h1><p>{editing ? 'Update registry details or replace the write-only platform key.' : 'Connect an isolated venue deployment to the CentralPass control plane.'}</p></div></header>
      {error && <div className="form-alert form-alert--error" role="alert"><Icon name="alert" size={18} />{error}</div>}
      <form className="venue-form" onSubmit={handleSubmit}>
        <section className="content-card form-section">
          <div className="form-section__intro"><span className="step-number">01</span><div><h2>Venue identity</h2><p>The name and internal slug used throughout Console.</p></div></div>
          <div className="form-grid">
            <Field label="Venue name" error={fieldErrors.name}><input required value={form.name} onChange={(event) => setField('name', event.target.value)} placeholder="Caffe Primo Firle" /></Field>
            <Field label="Registry slug" hint="Lowercase letters, numbers and hyphens." error={fieldErrors.slug}><input required value={form.slug} onChange={(event) => { setSlugTouched(true); setField('slug', event.target.value.toLowerCase()); }} placeholder="primo-firle" /></Field>
            <Field label="Lifecycle status" error={fieldErrors.registryStatus}><select value={form.registryStatus} onChange={(event) => setField('registryStatus', event.target.value)}><option value="active">Active</option><option value="suspended">Suspended</option><option value="offboarded">Offboarded</option></select></Field>
          </div>
        </section>

        <section className="content-card form-section">
          <div className="form-section__intro"><span className="step-number">02</span><div><h2>Venue surfaces</h2><p>Console calls the API server-side. The other links are operator shortcuts only.</p></div></div>
          <div className="form-grid form-grid--two">
            <Field label="Venue API URL" hint="Use the stable api. custom domain, not railway.app." error={fieldErrors.apiUrl}><input type="url" required value={form.apiUrl} onChange={(event) => setField('apiUrl', event.target.value)} placeholder="https://api.theirvenue.com.au" /></Field>
            <Field label="Customer website" optional error={fieldErrors.siteUrl}><input type="url" value={form.siteUrl} onChange={(event) => setField('siteUrl', event.target.value)} placeholder="https://theirvenue.com.au" /></Field>
            <Field label="Owner dashboard" optional error={fieldErrors.adminUrl}><input type="url" value={form.adminUrl} onChange={(event) => setField('adminUrl', event.target.value)} placeholder="https://admin.theirvenue.com.au" /></Field>
            <Field label="Staff dashboard" optional error={fieldErrors.staffUrl}><input type="url" value={form.staffUrl} onChange={(event) => setField('staffUrl', event.target.value)} placeholder="https://staff.theirvenue.com.au" /></Field>
          </div>
        </section>

        <section className="content-card form-section form-section--security">
          <div className="form-section__intro"><span className="step-number"><Icon name="key" size={19} /></span><div><h2>Platform connection</h2><p>This is CentralPass’s own per-venue key. It is encrypted at rest and can never be read back.</p></div></div>
          {editing && !replaceKey ? (
            <div className="key-set-row"><span><Icon name="eyeOff" /><strong>Platform key is set</strong><small>Last replacement is recorded on the venue detail page.</small></span><button className="button button--secondary" type="button" onClick={() => setReplaceKey(true)}>Replace key</button></div>
          ) : (
            <div className="key-input-row">
              <Field label={editing ? 'Replacement platform key' : 'Platform API key'} hint="At least 32 random characters. It will be write-only after save." error={fieldErrors.platformApiKey}><input type="password" autoComplete="new-password" minLength="32" required={!editing || replaceKey} value={form.platformApiKey} onChange={(event) => setField('platformApiKey', event.target.value)} placeholder="Paste the unique PLATFORM_API_KEY" /></Field>
              {editing && <button className="text-button" type="button" onClick={() => { setReplaceKey(false); setField('platformApiKey', ''); }}>Keep current key</button>}
            </div>
          )}
          <div className="connection-test">
            <button className="button button--secondary" type="button" disabled={testing || !form.apiUrl || (!editing && form.platformApiKey.length < 32)} onClick={testConnection}><Icon name="signal" size={17} />{testing ? 'Testing…' : 'Test connection'}</button>
            {testResult && <span className={testResult.ok ? 'test-result test-result--success' : 'test-result test-result--error'}><Icon name={testResult.ok ? 'check' : 'alert'} size={17} />{testResult.message}</span>}
          </div>
        </section>

        <section className="content-card form-section">
          <div className="form-section__intro"><span className="step-number">03</span><div><h2>Commercial context</h2><p>Internal notes only. Do not paste client credentials or customer data here.</p></div></div>
          <Field label="Billing notes" optional hint="For example: plan agreement, trial end or one-off entitlement arrangement." error={fieldErrors.billingNotes}><textarea rows="5" value={form.billingNotes} onChange={(event) => setField('billingNotes', event.target.value)} placeholder="Premium plan from launch. 500 SMS allowance included…" /></Field>
        </section>

        <div className="form-footer"><p><Icon name="shield" size={17} />No Stripe, admin, R2, SMS or JWT credentials belong in this console.</p><div><Link className="button button--secondary" to={editing ? `/venues/${id}` : '/venues'}>Cancel</Link><button className="button button--primary" type="submit" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save venue' : 'Add venue'}</button></div></div>
      </form>
    </div>
  );
}

function Field({ label, hint, optional, error, children }) {
  return <label className={`field${error ? ' field--error' : ''}`}><span>{label}{optional && <small>Optional</small>}</span>{children}{(error || hint) && <em>{error || hint}</em>}</label>;
}

function slugify(value) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

