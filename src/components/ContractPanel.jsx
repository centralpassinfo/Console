import { useMemo, useState } from 'react';
import { api, apiForm, downloadFile } from '../api.js';
import { formatCurrencyCents, formatDate, formatDateTime, formatFileSize } from '../format.js';
import Icon from './Icon.jsx';

const EMPTY_FORM = {
  title: 'Services agreement',
  status: 'signed',
  effectiveDate: '',
  expiryDate: '',
  signedAt: '',
  setupFee: '',
  monthlyFee: '',
  autoRenews: false,
  noticePeriodDays: '',
  notes: '',
};

const STATE_LABELS = {
  active: 'Active',
  expiring: 'Expiring soon',
  expired: 'Expired',
  signed: 'Signed',
  sent: 'Sent for signature',
  draft: 'Draft',
  terminated: 'Terminated',
  missing: 'No contract',
};

function dollars(cents) {
  return cents === null || cents === undefined ? '' : (Number(cents) / 100).toFixed(2);
}

function deriveSummary(contracts) {
  if (!contracts.length) return { state: 'missing', nextExpiry: null };
  const priority = ['expiring', 'active', 'sent', 'draft', 'expired', 'terminated'];
  const state = priority.find((value) => contracts.some((contract) => contract.state === value)) || 'missing';
  const expiries = contracts.filter((contract) => ['active', 'expiring'].includes(contract.state) && contract.expiryDate).map((contract) => contract.expiryDate).sort();
  return { state, nextExpiry: expiries[0] || null };
}

export default function ContractPanel({ venueId, initialContracts = [] }) {
  const [contracts, setContracts] = useState(initialContracts);
  const [form, setForm] = useState(EMPTY_FORM);
  const [file, setFile] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [downloadingId, setDownloadingId] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const summary = useMemo(() => deriveSummary(contracts), [contracts]);

  function setField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function startAdd() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFile(null);
    setError('');
    setNotice('');
    setShowForm(true);
  }

  function startEdit(contract) {
    setEditingId(contract.id);
    setForm({
      title: contract.title,
      status: contract.status,
      effectiveDate: contract.effectiveDate || '',
      expiryDate: contract.expiryDate || '',
      signedAt: contract.signedAt || '',
      setupFee: dollars(contract.setupFeeCents),
      monthlyFee: dollars(contract.monthlyFeeCents),
      autoRenews: Boolean(contract.autoRenews),
      noticePeriodDays: contract.noticePeriodDays ?? '',
      notes: contract.notes || '',
    });
    setFile(null);
    setError('');
    setNotice('');
    setShowForm(true);
  }

  function payload() {
    return {
      ...form,
      setupFee: form.setupFee || null,
      monthlyFee: form.monthlyFee || null,
      noticePeriodDays: form.noticePeriodDays === '' ? null : Number(form.noticePeriodDays),
    };
  }

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      let result;
      if (editingId) {
        result = await api(`/venues/${venueId}/contracts/${editingId}`, { method: 'PUT', body: payload() });
        setContracts((current) => current.map((contract) => contract.id === editingId ? result.contract : contract));
      } else {
        if (!file) throw new Error('Choose the contract PDF to store.');
        const data = new FormData();
        Object.entries(payload()).forEach(([key, value]) => data.append(key, value == null ? '' : String(value)));
        data.append('contractFile', file);
        result = await apiForm(`/venues/${venueId}/contracts`, data);
        setContracts((current) => [result.contract, ...current]);
      }
      setShowForm(false);
      setEditingId(null);
      setFile(null);
      setNotice(editingId ? 'Contract details updated.' : 'Contract securely stored.');
    } catch (requestError) {
      setError(requestError.message);
    } finally { setBusy(false); }
  }

  async function download(contract) {
    setDownloadingId(contract.id);
    setError('');
    try { await downloadFile(`/venues/${venueId}/contracts/${contract.id}/download`, contract.fileName); }
    catch (requestError) { setError(requestError.message); }
    finally { setDownloadingId(null); }
  }

  return (
    <section className="content-card contract-panel">
      <div className="content-card__header contract-panel__header">
        <div><span className="eyebrow">Commercial record</span><h2>Venue contracts</h2><p>Signed PDFs are encrypted in Console and every upload, edit and download is audited.</p></div>
        <div className="contract-panel__actions"><ContractBadge state={summary.state} />{!showForm && <button className="button button--primary" type="button" onClick={startAdd}><Icon name="plus" size={16} />Add contract</button>}</div>
      </div>

      {summary.state === 'missing' && <div className="contract-alert contract-alert--warning"><Icon name="alert" /><div><strong>No venue agreement is stored.</strong><p>Upload the executed services agreement before work or ongoing service continues.</p></div></div>}
      {summary.state === 'expiring' && <div className="contract-alert contract-alert--warning"><Icon name="clock" /><div><strong>Renewal action is due.</strong><p>The current agreement expires {formatDate(summary.nextExpiry)}.</p></div></div>}
      {summary.state === 'expired' && <div className="contract-alert contract-alert--danger"><Icon name="alert" /><div><strong>The stored agreement has expired.</strong><p>Record the renewal or update its status before relying on the old terms.</p></div></div>}
      {notice && <div className="form-alert form-alert--success contract-notice" role="status"><Icon name="check" size={18} />{notice}<button type="button" onClick={() => setNotice('')} aria-label="Dismiss"><Icon name="x" size={16} /></button></div>}
      {error && !showForm && <div className="form-alert form-alert--error contract-notice" role="alert"><Icon name="alert" size={18} />{error}</div>}

      {showForm && (
        <form className="contract-form" onSubmit={save}>
          <div className="contract-form__heading"><div><h3>{editingId ? 'Update contract details' : 'Store a contract'}</h3><p>{editingId ? 'The original PDF remains unchanged.' : 'Upload the final PDF or the current draft. Maximum size 10 MB.'}</p></div><button className="icon-button" type="button" onClick={() => setShowForm(false)} aria-label="Close contract form"><Icon name="x" /></button></div>
          {error && <div className="form-alert form-alert--error" role="alert"><Icon name="alert" size={18} />{error}</div>}
          <div className="contract-form__grid">
            <label className="field"><span>Contract title</span><input required minLength="2" maxLength="160" value={form.title} onChange={(event) => setField('title', event.target.value)} /></label>
            <label className="field"><span>Status</span><select value={form.status} onChange={(event) => setField('status', event.target.value)}><option value="draft">Draft</option><option value="sent">Sent for signature</option><option value="signed">Signed</option><option value="expired">Expired</option><option value="terminated">Terminated</option></select></label>
            <label className="field"><span>Effective date</span><input type="date" value={form.effectiveDate} onChange={(event) => setField('effectiveDate', event.target.value)} /></label>
            <label className="field"><span>Expiry date</span><input type="date" min={form.effectiveDate || undefined} value={form.expiryDate} onChange={(event) => setField('expiryDate', event.target.value)} /></label>
            <label className="field"><span>Signed date</span><input type="date" value={form.signedAt} onChange={(event) => setField('signedAt', event.target.value)} /></label>
            <label className="field"><span>Notice period (days)</span><input type="number" min="0" max="730" value={form.noticePeriodDays} onChange={(event) => setField('noticePeriodDays', event.target.value)} placeholder="30" /></label>
            <label className="field"><span>Setup fee (AUD)</span><input type="number" min="0" step="0.01" value={form.setupFee} onChange={(event) => setField('setupFee', event.target.value)} placeholder="3500.00" /></label>
            <label className="field"><span>Monthly fee (AUD)</span><input type="number" min="0" step="0.01" value={form.monthlyFee} onChange={(event) => setField('monthlyFee', event.target.value)} placeholder="250.00" /></label>
            <label className="contract-checkbox"><input type="checkbox" checked={form.autoRenews} onChange={(event) => setField('autoRenews', event.target.checked)} /><span><strong>Auto-renewing agreement</strong><small>Use the notice period above for the renewal reminder.</small></span></label>
            {!editingId && <label className="field contract-file"><span>Contract PDF</span><input type="file" accept="application/pdf,.pdf" required onChange={(event) => setFile(event.target.files?.[0] || null)} /><small>{file ? `${file.name} · ${formatFileSize(file.size)}` : 'PDF only · maximum 10 MB'}</small></label>}
            <label className="field contract-notes"><span>Internal notes</span><textarea rows="3" maxLength="4000" value={form.notes} onChange={(event) => setField('notes', event.target.value)} placeholder="Scope variation, pricing arrangement or renewal context…" /></label>
          </div>
          <div className="contract-form__footer"><p><Icon name="shield" size={16} />The PDF is encrypted at rest and is never public.</p><div><button className="button button--secondary" type="button" onClick={() => setShowForm(false)} disabled={busy}>Cancel</button><button className="button button--primary" type="submit" disabled={busy}>{busy ? 'Saving…' : editingId ? 'Save details' : 'Store contract'}</button></div></div>
        </form>
      )}

      <div className="contract-list">
        {contracts.length ? contracts.map((contract) => (
          <article className="contract-record" key={contract.id}>
            <div className="contract-record__icon"><Icon name="file" /></div>
            <div className="contract-record__body">
              <div className="contract-record__title"><div><h3>{contract.title}</h3><span>{contract.fileName} · {formatFileSize(contract.fileSizeBytes)}</span></div><ContractBadge state={contract.state} /></div>
              <dl>
                <div><dt>Term</dt><dd>{contract.effectiveDate ? formatDate(contract.effectiveDate) : 'Not recorded'} → {contract.expiryDate ? formatDate(contract.expiryDate) : 'No end date'}</dd></div>
                <div><dt>Commercials</dt><dd>{formatCurrencyCents(contract.setupFeeCents)} setup · {formatCurrencyCents(contract.monthlyFeeCents)} / month</dd></div>
                <div><dt>Renewal</dt><dd>{contract.autoRenews ? `Automatic${contract.noticePeriodDays != null ? ` · ${contract.noticePeriodDays} days notice` : ''}` : 'Not automatic'}</dd></div>
                <div><dt>Stored</dt><dd>{contract.createdBy} · {formatDateTime(contract.createdAt)}</dd></div>
              </dl>
              {contract.notes && <p>{contract.notes}</p>}
            </div>
            <div className="contract-record__actions"><button className="button button--secondary" type="button" onClick={() => startEdit(contract)}><Icon name="edit" size={15} />Edit details</button><button className="button button--secondary" type="button" onClick={() => download(contract)} disabled={downloadingId === contract.id}><Icon name="download" size={15} />{downloadingId === contract.id ? 'Preparing…' : 'Download PDF'}</button></div>
          </article>
        )) : !showForm && <div className="empty-inline contract-empty">No contract records yet. Signed agreements should be stored here, not in personal inboxes or local folders.</div>}
      </div>
      {contracts.length > 0 && <div className="contract-retention"><Icon name="info" size={15} />Contract PDFs cannot be overwritten or deleted from Console. Update the status or upload a new agreement to preserve the legal history.</div>}
    </section>
  );
}

export function ContractBadge({ state = 'missing' }) {
  return <span className={`contract-badge contract-badge--${state}`}>{STATE_LABELS[state] || state}</span>;
}
