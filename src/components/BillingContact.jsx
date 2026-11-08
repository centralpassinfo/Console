import { useEffect, useState } from 'react';
import { api } from '../api.js';
export default function BillingContact({ venueId, contact, onSaved }) {
  const [form, setForm] = useState(contact),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => setForm(contact), [contact]);
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/venues/${venueId}/billing/contact`, { method: 'PUT', body: form });
      await onSaved();
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="billing-contact">
      <summary>Billing contact · {contact.billing_email || 'Not set'}</summary>
      <form onSubmit={save}>
        {error && (
          <p role="alert" className="form-alert form-alert--error">
            {error}
          </p>
        )}
        <div className="contract-form__grid">
          {Object.entries({
            billing_name: 'Legal / billing name',
            billing_contact: 'Contact person',
            billing_email: 'Email',
            billing_cc: 'CC emails',
            billing_address: 'Billing address',
            billing_service_description: 'Monthly service description',
          }).map(([key, label]) => (
            <label className="field" key={key}>
              <span>{label}</span>
              {key === 'billing_address' ? (
                <textarea
                  rows="3"
                  maxLength="1000"
                  value={form[key] || ''}
                  onChange={(event) => setForm({ ...form, [key]: event.target.value })}
                />
              ) : (
                <input
                  type={key === 'billing_email' ? 'email' : 'text'}
                  maxLength={key === 'billing_cc' ? 500 : 300}
                  value={form[key] || ''}
                  onChange={(event) => setForm({ ...form, [key]: event.target.value })}
                />
              )}
            </label>
          ))}
        </div>
        <button className="button button--secondary" disabled={busy}>
          {busy ? 'Saving…' : 'Save billing contact'}
        </button>
      </form>
    </details>
  );
}
