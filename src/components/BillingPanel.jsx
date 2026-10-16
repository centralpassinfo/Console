import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { formatCurrencyCents, formatDate, humanise } from '../format.js';
import { addDays, localDate, monthBounds } from '../timezone.mjs';
import Icon from './Icon.jsx';
import Modal from './Modal.jsx';

export const INVOICE_STATE_LABELS = {
  draft: 'Draft',
  due: 'Due',
  part_paid: 'Part paid',
  overdue: 'Overdue',
  paid: 'Paid',
  void: 'Void',
  written_off: 'Written off',
};

const KIND_LABELS = { monthly: 'Monthly service', setup: 'Setup fee', usage: 'Usage (SMS and extras)', other: 'Other' };
const METHOD_LABELS = { bank_transfer: 'Bank transfer', becs: 'BECS direct debit', card: 'Card', cash: 'Cash', other: 'Other' };
const STATUS_LABELS = { draft: 'Draft, not sent', sent: 'Sent to the venue', void: 'Void (issued in error)', written_off: 'Written off' };

function dollars(cents) {
  return cents === null || cents === undefined ? '' : (Number(cents) / 100).toFixed(2);
}

/** Australian GST is one tenth of the GST-exclusive amount. */
function gstFor(amount) {
  const cents = Math.round(Number(amount || 0) * 100);
  return Number.isFinite(cents) && cents > 0 ? dollars(Math.round(cents / 10)) : '';
}

/** The fee agreed in the venue's current signed contract, if there is one. */
function contractedFee(contracts, kind) {
  const signed = contracts.find((contract) => ['active', 'expiring'].includes(contract.state));
  if (!signed) return { contractId: '', amount: '' };
  const cents = kind === 'setup' ? signed.setupFeeCents : kind === 'monthly' ? signed.monthlyFeeCents : null;
  return { contractId: String(signed.id), amount: dollars(cents) };
}

function newInvoiceForm(contracts) {
  const today = localDate();
  const { start, end } = monthBounds(today);
  const fee = contractedFee(contracts, 'monthly');
  return {
    invoiceNumber: '',
    kind: 'monthly',
    status: 'sent',
    issuedOn: today,
    dueOn: addDays(today, 14),
    periodStart: start,
    periodEnd: end,
    amount: fee.amount,
    gst: gstFor(fee.amount),
    contractId: fee.contractId,
    notes: '',
    gstTouched: false,
  };
}

export function BillingBadge({ state = 'none' }) {
  const label = state === 'good_standing' ? 'Good standing' : state === 'none' ? 'No invoices' : INVOICE_STATE_LABELS[state] || humanise(state);
  return <span className={`billing-badge billing-badge--${state}`}>{label}</span>;
}

export default function BillingPanel({ venueId, contracts = [] }) {
  const [ledger, setLedger] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [payment, setPayment] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setLedger(await api(`/venues/${venueId}/billing`));
      setError('');
    } catch (requestError) { setError(requestError.message); }
  }, [venueId]);

  useEffect(() => { load(); }, [load]);

  const summary = ledger?.summary;
  const invoices = ledger?.invoices || [];
  const usableContracts = useMemo(() => contracts.filter((contract) => contract.status !== 'draft'), [contracts]);

  function setField(field, value) {
    setForm((current) => {
      const next = { ...current, [field]: value };
      if (field === 'gst') next.gstTouched = true;
      if (field === 'amount' && !current.gstTouched) next.gst = gstFor(value);
      if (field === 'kind' && !editingId) {
        const fee = contractedFee(usableContracts, value);
        if (fee.amount) { next.amount = fee.amount; if (!current.gstTouched) next.gst = gstFor(fee.amount); }
        if (value !== 'monthly') { next.periodStart = ''; next.periodEnd = ''; }
        else if (!next.periodStart) Object.assign(next, (({ start, end }) => ({ periodStart: start, periodEnd: end }))(monthBounds(next.issuedOn || localDate())));
      }
      if (field === 'issuedOn' && value && current.dueOn && current.dueOn < value) next.dueOn = addDays(value, 14);
      return next;
    });
  }

  function startAdd() {
    setEditingId(null);
    setPayment(null);
    setNotice('');
    setError('');
    setForm(newInvoiceForm(usableContracts));
  }

  function startEdit(invoice) {
    setEditingId(invoice.id);
    setPayment(null);
    setNotice('');
    setError('');
    setForm({
      invoiceNumber: invoice.invoiceNumber,
      kind: invoice.kind,
      status: invoice.status,
      issuedOn: invoice.issuedOn,
      dueOn: invoice.dueOn,
      periodStart: invoice.periodStart || '',
      periodEnd: invoice.periodEnd || '',
      amount: dollars(invoice.amountCents),
      gst: dollars(invoice.gstCents),
      contractId: invoice.contractId ? String(invoice.contractId) : '',
      notes: invoice.notes || '',
      gstTouched: true,
    });
  }

  async function saveInvoice(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { gstTouched, ...fields } = form;
      const body = { ...fields, contractId: fields.contractId ? Number(fields.contractId) : null, gst: fields.gst || '0' };
      await api(editingId ? `/venues/${venueId}/billing/invoices/${editingId}` : `/venues/${venueId}/billing/invoices`, { method: editingId ? 'PUT' : 'POST', body });
      setNotice(editingId ? `Invoice ${form.invoiceNumber} updated.` : `Invoice ${form.invoiceNumber} recorded.`);
      setForm(null);
      setEditingId(null);
      await load();
    } catch (requestError) {
      setError(requestError.fields?.[0]?.message || requestError.message);
    } finally { setBusy(false); }
  }

  function startPayment(invoice) {
    setForm(null);
    setNotice('');
    setError('');
    setPayment({ invoice, receivedOn: localDate(), amount: dollars(invoice.billing?.outstandingCents), method: 'bank_transfer', reference: '' });
  }

  async function savePayment(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { invoice, ...body } = payment;
      const result = await api(`/venues/${venueId}/billing/invoices/${invoice.id}/payments`, { method: 'POST', body });
      setNotice(`Payment recorded against ${invoice.invoiceNumber}. It is now ${INVOICE_STATE_LABELS[result.billing.state]?.toLowerCase() || result.billing.state}.`);
      setPayment(null);
      await load();
    } catch (requestError) {
      setError(requestError.fields?.[0]?.message || requestError.message);
    } finally { setBusy(false); }
  }

  async function removePayment() {
    setBusy(true);
    try {
      await api(`/venues/${venueId}/billing/payments/${removing.payment.id}`, { method: 'DELETE' });
      setNotice(`Payment removed from ${removing.invoice.invoiceNumber}.`);
      setRemoving(null);
      await load();
    } catch (requestError) {
      setRemoving((current) => ({ ...current, error: requestError.message }));
    } finally { setBusy(false); }
  }

  return (
    <section className="content-card billing-panel">
      <div className="content-card__header contract-panel__header">
        <div><span className="eyebrow">Commercial record</span><h2>Invoices and payments</h2><p>What CentralPass billed this venue and what it paid. Paid and overdue are worked out from payments and today’s date.</p></div>
        <div className="contract-panel__actions">{summary && <BillingBadge state={summary.state} />}{!form && <button className="button button--primary" type="button" onClick={startAdd}><Icon name="plus" size={16} />New invoice</button>}</div>
      </div>

      {summary && summary.invoiceCount > 0 && (
        <div className="billing-summary">
          <div><span>Outstanding</span><strong>{formatCurrencyCents(summary.outstandingCents)}</strong></div>
          <div><span>Overdue</span><strong className={summary.overdueCents ? 'is-danger' : ''}>{formatCurrencyCents(summary.overdueCents)}</strong>{summary.overdueCount > 0 && <small>{summary.overdueCount} invoice{summary.overdueCount === 1 ? '' : 's'}, oldest {summary.oldestOverdueDays} day{summary.oldestOverdueDays === 1 ? '' : 's'} late</small>}</div>
          <div><span>Next due</span><strong>{summary.nextDueOn ? formatDate(summary.nextDueOn) : 'Nothing due'}</strong></div>
          <div><span>Paid on time</span><strong>{summary.onTimeRate == null ? 'No history' : `${Math.round(summary.onTimeRate * 100)}%`}</strong>{summary.settledCount > 0 && <small>of {summary.settledCount} settled</small>}</div>
        </div>
      )}

      {summary?.state === 'overdue' && <div className="contract-alert contract-alert--danger"><Icon name="alert" /><div><strong>{formatCurrencyCents(summary.overdueCents)} is overdue.</strong><p>Follow up with the venue, or record the payment if it has already arrived.</p></div></div>}
      {notice && <div className="form-alert form-alert--success contract-notice" role="status"><Icon name="check" size={18} />{notice}<button type="button" onClick={() => setNotice('')} aria-label="Dismiss"><Icon name="x" size={16} /></button></div>}
      {error && !form && !payment && <div className="form-alert form-alert--error contract-notice" role="alert"><Icon name="alert" size={18} />{error}</div>}

      {form && (
        <form className="contract-form" onSubmit={saveInvoice}>
          <div className="contract-form__heading"><div><h3>{editingId ? `Update invoice ${form.invoiceNumber}` : 'Record an invoice'}</h3><p>Enter the amount before GST. GST is filled in at 10% until you change it.</p></div><button className="icon-button" type="button" onClick={() => setForm(null)} aria-label="Close invoice form"><Icon name="x" /></button></div>
          {error && <div className="form-alert form-alert--error" role="alert"><Icon name="alert" size={18} />{error}</div>}
          <div className="contract-form__grid">
            <label className="field"><span>Invoice number</span><input required maxLength="40" value={form.invoiceNumber} onChange={(event) => setField('invoiceNumber', event.target.value)} placeholder="CP-0001" /></label>
            <label className="field"><span>Type</span><select value={form.kind} onChange={(event) => setField('kind', event.target.value)}>{Object.entries(KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="field"><span>Status</span><select value={form.status} onChange={(event) => setField('status', event.target.value)}>{Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="field"><span>Contract</span><select value={form.contractId} onChange={(event) => setField('contractId', event.target.value)}><option value="">Not linked</option>{usableContracts.map((contract) => <option key={contract.id} value={contract.id}>{contract.title}</option>)}</select></label>
            <label className="field"><span>Issued</span><input type="date" required value={form.issuedOn} onChange={(event) => setField('issuedOn', event.target.value)} /></label>
            <label className="field"><span>Due</span><input type="date" required min={form.issuedOn || undefined} value={form.dueOn} onChange={(event) => setField('dueOn', event.target.value)} /></label>
            <label className="field"><span>Period start{form.kind !== 'monthly' && <small>Optional</small>}</span><input type="date" required={form.kind === 'monthly'} value={form.periodStart} onChange={(event) => setField('periodStart', event.target.value)} /></label>
            <label className="field"><span>Period end{form.kind !== 'monthly' && <small>Optional</small>}</span><input type="date" required={form.kind === 'monthly'} min={form.periodStart || undefined} value={form.periodEnd} onChange={(event) => setField('periodEnd', event.target.value)} /></label>
            <label className="field"><span>Amount before GST (AUD)</span><input type="number" required min="0" step="0.01" value={form.amount} onChange={(event) => setField('amount', event.target.value)} placeholder="250.00" /></label>
            <label className="field"><span>GST (AUD)</span><input type="number" min="0" step="0.01" value={form.gst} onChange={(event) => setField('gst', event.target.value)} placeholder="25.00" /></label>
            <div className="field billing-total"><span>Total</span><strong>{formatCurrencyCents(Math.round((Number(form.amount || 0) + Number(form.gst || 0)) * 100))}</strong></div>
            <label className="field contract-notes"><span>Notes</span><textarea rows="2" maxLength="3000" value={form.notes} onChange={(event) => setField('notes', event.target.value)} placeholder="For example: 1,200 SMS above the bundled allowance" /></label>
          </div>
          <div className="contract-form__footer"><p><Icon name="info" size={16} />Paid and overdue follow from the payments you record.</p><div><button className="button button--secondary" type="button" onClick={() => setForm(null)} disabled={busy}>Cancel</button><button className="button button--primary" type="submit" disabled={busy}>{busy ? 'Saving…' : editingId ? 'Save invoice' : 'Record invoice'}</button></div></div>
        </form>
      )}

      {payment && (
        <form className="contract-form" onSubmit={savePayment}>
          <div className="contract-form__heading"><div><h3>Record a payment · {payment.invoice.invoiceNumber}</h3><p>{formatCurrencyCents(payment.invoice.billing?.outstandingCents)} outstanding of {formatCurrencyCents(payment.invoice.billing?.totalCents)}.</p></div><button className="icon-button" type="button" onClick={() => setPayment(null)} aria-label="Close payment form"><Icon name="x" /></button></div>
          {error && <div className="form-alert form-alert--error" role="alert"><Icon name="alert" size={18} />{error}</div>}
          <div className="contract-form__grid">
            <label className="field"><span>Received</span><input type="date" required value={payment.receivedOn} onChange={(event) => setPayment({ ...payment, receivedOn: event.target.value })} /></label>
            <label className="field"><span>Amount (AUD)</span><input type="number" required min="0.01" step="0.01" value={payment.amount} onChange={(event) => setPayment({ ...payment, amount: event.target.value })} /></label>
            <label className="field"><span>Method</span><select value={payment.method} onChange={(event) => setPayment({ ...payment, method: event.target.value })}>{Object.entries(METHOD_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="field"><span>Reference<small>Optional</small></span><input maxLength="200" value={payment.reference} onChange={(event) => setPayment({ ...payment, reference: event.target.value })} placeholder="Bank reference" /></label>
          </div>
          <div className="contract-form__footer"><p><Icon name="info" size={16} />A payment recorded here can be removed if it was entered by mistake.</p><div><button className="button button--secondary" type="button" onClick={() => setPayment(null)} disabled={busy}>Cancel</button><button className="button button--primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Record payment'}</button></div></div>
        </form>
      )}

      <div className="contract-list">
        {!ledger ? (error ? null : <div className="loading-block">Loading invoices…</div>) : invoices.length ? invoices.map((invoice) => (
          <article className="billing-invoice" key={invoice.id}>
            <div className="billing-invoice__main">
              <div className="contract-record__title"><div><h3>{invoice.invoiceNumber}</h3><span>{KIND_LABELS[invoice.kind] || invoice.kind}{invoice.periodStart ? ` · ${formatDate(invoice.periodStart)} to ${formatDate(invoice.periodEnd)}` : ''}</span></div><BillingBadge state={invoice.billing?.state || invoice.status} /></div>
              <dl>
                <div><dt>Issued</dt><dd>{formatDate(invoice.issuedOn)}</dd></div>
                <div><dt>Due</dt><dd>{formatDate(invoice.dueOn)}{invoice.billing?.state === 'overdue' ? ` · ${invoice.billing.daysLate} day${invoice.billing.daysLate === 1 ? '' : 's'} late` : ''}</dd></div>
                <div><dt>Total</dt><dd>{formatCurrencyCents(invoice.billing?.totalCents)} <small>incl. {formatCurrencyCents(invoice.gstCents)} GST</small></dd></div>
                <div><dt>Outstanding</dt><dd>{formatCurrencyCents(invoice.billing?.outstandingCents)}</dd></div>
              </dl>
              {invoice.notes && <p>{invoice.notes}</p>}
              {invoice.payments.length > 0 && (
                <ul className="billing-payments">
                  {invoice.payments.map((item) => (
                    <li key={item.id}>
                      <span><strong>{formatCurrencyCents(item.amountCents)}</strong> {METHOD_LABELS[item.method] || item.method} · {formatDate(item.receivedOn)}{item.reference ? ` · ${item.reference}` : ''}</span>
                      {item.source === 'manual' && <button className="text-button" type="button" onClick={() => setRemoving({ invoice, payment: item })}>Remove</button>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="contract-record__actions">
              {['due', 'part_paid', 'overdue'].includes(invoice.billing?.state) && <button className="button button--primary" type="button" onClick={() => startPayment(invoice)}><Icon name="check" size={15} />Record payment</button>}
              <button className="button button--secondary" type="button" onClick={() => startEdit(invoice)}><Icon name="edit" size={15} />Edit</button>
            </div>
          </article>
        )) : !form && <div className="empty-inline contract-empty">No invoices recorded yet. Record each invoice CentralPass sends this venue so overdue amounts show up on the Overview.</div>}
      </div>

      {removing && (
        <Modal title={`Remove payment from ${removing.invoice.invoiceNumber}`} confirmLabel="Remove payment" tone="danger" busy={busy} onClose={() => setRemoving(null)} onConfirm={removePayment}>
          <p>Remove the {formatCurrencyCents(removing.payment.amountCents)} payment received {formatDate(removing.payment.receivedOn)}? The invoice goes back to owing that amount. The removal is recorded in Activity.</p>
          {removing.error && <div className="form-alert form-alert--error"><Icon name="alert" size={18} />{removing.error}</div>}
        </Modal>
      )}
    </section>
  );
}
