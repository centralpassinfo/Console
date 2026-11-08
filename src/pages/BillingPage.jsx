import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { formatCurrencyCents, formatDate, formatDateTime } from '../format.js';
import { BillingBadge } from '../components/BillingPanel.jsx';
import '../billing.css';

const labels = {
  seller_name: 'Business name',
  seller_legal_name: 'Legal partnership name',
  abn: 'ABN',
  address: 'Business address',
  email: 'Reply email',
  bank_account_name: 'Account name',
  bank_bsb: 'BSB',
  bank_account_number: 'Account number',
  invoice_prefix: 'Invoice prefix',
  payment_terms_days: 'Payment terms (days)',
};
export default function BillingPage() {
  const [tab, setTab] = useState('invoices'),
    [data, setData] = useState(null),
    [form, setForm] = useState(null),
    [preview, setPreview] = useState(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [search, setSearch] = useState('');
  const load = useCallback(async () => {
    try {
      const result = await api('/billing');
      setData(result);
      setForm(result.settings);
      setError('');
    } catch (caught) {
      setError(caught.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/billing/settings', { method: 'PUT', body: form });
      setNotice('Billing settings saved. Existing issued invoices keep their original details.');
      await load();
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  }
  async function plan() {
    setBusy(true);
    setError('');
    try {
      setPreview(await api('/billing/run-preview'));
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  }
  async function run() {
    setBusy(true);
    setError('');
    try {
      const result = await api('/billing/run', { method: 'POST' });
      setNotice(
        result.busy
          ? 'Another billing run is already in progress.'
          : `${result.created.length} drafts created; ${result.emails.length} email attempts; ${result.errors.length} issues.`,
      );
      await load();
      setPreview(await api('/billing/run-preview'));
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  }
  const invoices = (data?.invoices || []).filter((invoice) =>
    `${invoice.invoiceNumber} ${invoice.venueName} ${invoice.billing.state}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <div className="page billing-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">CentralPass accounts</span>
          <h1>Billing</h1>
          <p>Invoices, monthly drafts and payment follow-up.</p>
        </div>
      </header>
      <nav className="billing-tabs" aria-label="Billing sections">
        {['invoices', 'monthly run', 'settings'].map((value) => (
          <button
            type="button"
            key={value}
            aria-pressed={tab === value}
            onClick={() => setTab(value)}
          >
            {value[0].toUpperCase() + value.slice(1)}
          </button>
        ))}
      </nav>
      {error && (
        <p className="form-alert form-alert--error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="form-alert form-alert--success" role="status">
          {notice}
        </p>
      )}
      {!data && !error && <p>Loading billing…</p>}
      {data && !data.emailReady && (
        <p className="billing-muted">
          Sending is disabled on the server. Drafting and PDF downloads remain available.
        </p>
      )}
      {tab === 'invoices' && data && (
        <section className="content-card">
          <div className="content-card__header">
            <h2>Recent invoices</h2>
            <p>The latest 200. Open a venue for its full ledger, PDF, payments and sending.</p>
            <input
              type="search"
              className="billing-search"
              aria-label="Find invoice"
              placeholder="Venue, invoice or status"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div className="billing-overview-list">
            {invoices.map((invoice) => (
              <Link key={invoice.id} to={`/venues/${invoice.venueId}?tab=billing`}>
                <span>
                  <strong>{invoice.invoiceNumber}</strong>
                  <small>
                    {invoice.venueName} · Due {formatDate(invoice.dueOn)}
                  </small>
                </span>
                <BillingBadge state={invoice.billing.state} />
                <strong>{formatCurrencyCents(invoice.billing.totalCents)}</strong>
              </Link>
            ))}
            {!invoices.length && (
              <p>No invoices match. Create or record an invoice in a venue’s Billing tab.</p>
            )}
          </div>
        </section>
      )}
      {tab === 'monthly run' && data && (
        <section className="content-card">
          <div className="content-card__header">
            <h2>Monthly run</h2>
            <p>
              Contract-anniversary periods, billed in advance. Checks hourly while Console is
              running.
            </p>
            <p>
              Drafts: {data.settings.auto_generate ? 'automatic' : 'manual only'} · Automatic
              sending: {data.settings.auto_send ? 'on' : 'off'} · Reminders:{' '}
              {data.settings.auto_remind ? 'on' : 'off'}
            </p>
            <p>
              Last check:{' '}
              {data.settings.last_run_at
                ? formatDateTime(data.settings.last_run_at)
                : 'Not run yet'}
            </p>
            <div className="billing-inline-actions">
              <button
                type="button"
                className="button button--secondary"
                disabled={busy}
                onClick={plan}
              >
                Preview run
              </button>
              <button
                type="button"
                className="button button--primary"
                disabled={busy || !preview || !data.settings.automation_start_on}
                onClick={run}
              >
                {busy ? 'Working…' : 'Run billing check'}
              </button>
            </div>
            {!data.settings.automation_start_on && (
              <p>
                First record historic invoices, then set the automation start date in Settings. No
                historical periods are automatically back-billed.
              </p>
            )}
            {(data.settings.auto_send || data.settings.auto_remind) && (
              <p className="form-alert">
                This check can send emails because automatic sending or reminders are enabled.
              </p>
            )}
          </div>
          {data.settings.last_run_summary?.errors?.length > 0 && (
            <div className="form-alert form-alert--error">
              {data.settings.last_run_summary.errors.map((item, index) => (
                <p key={index}>{item.error}</p>
              ))}
            </div>
          )}
          {preview && (
            <div className="billing-run-list">
              {preview.venues.map((item) => (
                <div key={item.venueId}>
                  <strong>{item.venueName}</strong>
                  <span>
                    {item.action === 'create'
                      ? `${formatDate(item.invoice.periodStart)} – ${formatDate(item.invoice.periodEnd)} · ${formatCurrencyCents(item.invoice.amountCents + item.invoice.gstCents)}`
                      : item.reason}
                  </span>
                  <span>{item.action === 'create' ? 'Create draft' : 'Skip'}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
      {tab === 'settings' && form && (
        <form className="content-card billing-settings" onSubmit={save}>
          <div className="content-card__header">
            <h2>Invoice settings</h2>
            <p>
              These details appear on new invoices. API keys belong in the Console service
              environment, never this form.
            </p>
          </div>
          <fieldset disabled={busy}>
            <div className="contract-form__grid">
              {Object.entries(labels).map(([key, label]) => (
                <label className="field" key={key}>
                  <span>{label}</span>
                  {key === 'address' ? (
                    <textarea
                      rows="3"
                      maxLength="1000"
                      value={form[key] || ''}
                      onChange={(event) => setForm({ ...form, [key]: event.target.value })}
                    />
                  ) : (
                    <input
                      required={[
                        'seller_name',
                        'email',
                        'invoice_prefix',
                        'payment_terms_days',
                      ].includes(key)}
                      type={
                        key === 'email' ? 'email' : key === 'payment_terms_days' ? 'number' : 'text'
                      }
                      min={key === 'payment_terms_days' ? 0 : undefined}
                      max={key === 'payment_terms_days' ? 90 : undefined}
                      maxLength="160"
                      value={form[key] ?? ''}
                      onChange={(event) => setForm({ ...form, [key]: event.target.value })}
                    />
                  )}
                </label>
              ))}
            </div>
            <label className="billing-check">
              <input
                type="checkbox"
                checked={form.gst_registered}
                onChange={(event) => setForm({ ...form, gst_registered: event.target.checked })}
              />
              Registered for GST (only enable after registration)
            </label>
            <p className="billing-muted">
              Off: “Invoice”, “No GST has been charged”. On: GST is added to new invoice amounts.
            </p>
            <h3>Automation</h3>
            <label className="field">
              <span>Start date after reviewing historic invoices</span>
              <input
                type="date"
                value={form.automation_start_on || ''}
                onChange={(event) =>
                  setForm({ ...form, automation_start_on: event.target.value || null })
                }
              />
            </label>
            <p className="billing-muted">
              Record CP-2026-001 to 003 first, including 003’s 4 Nov–3 Dec service period. Periods
              starting before this date are manual only.
            </p>
            {Object.entries({
              auto_generate: 'Create monthly drafts automatically',
              auto_send: 'Email automatically generated drafts',
              auto_remind: 'Email payment reminders automatically',
            }).map(([key, label]) => (
              <label className="billing-check" key={key}>
                <input
                  type="checkbox"
                  checked={form[key]}
                  onChange={(event) => setForm({ ...form, [key]: event.target.checked })}
                />
                {label}
              </label>
            ))}
            <p className="billing-muted">
              Reminders: 2 days before due, then 1, 7 and 14 days overdue. Only the latest due stage
              is sent, after the invoice was emailed through Console. Receipts are sent manually
              after payment.
            </p>
            <button className="button button--primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save billing settings'}
            </button>
          </fieldset>
        </form>
      )}
    </div>
  );
}
