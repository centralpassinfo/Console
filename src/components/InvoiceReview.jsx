import { useEffect, useState } from 'react';
import { api, downloadFile } from '../api.js';
import { formatCurrencyCents, formatDate } from '../format.js';
import Modal from './Modal.jsx';

export default function InvoiceReview({
  venueId,
  invoice,
  contact,
  emailReady,
  onClose,
  onChanged,
}) {
  const [model, setModel] = useState(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [purpose, setPurpose] = useState(invoice.billing?.state === 'paid' ? 'receipt' : 'invoice');
  const [ack, setAck] = useState(false);
  const [requestId] = useState(() => crypto.randomUUID());
  const previous = (invoice.emails || []).some((email) => email.purpose === purpose);
  useEffect(() => {
    let active = true;
    api(`/venues/${venueId}/billing/invoices/${invoice.id}/preview`)
      .then((result) => {
        if (active) setModel(result.document);
      })
      .catch((caught) => {
        if (active) setError(caught.message);
      });
    return () => {
      active = false;
    };
  }, [venueId, invoice.id]);
  async function send() {
    if (
      !emailReady ||
      !contact?.billing_email ||
      (previous && !ack) ||
      !model ||
      ['void', 'written_off'].includes(invoice.status)
    ) {
      setError(
        'Check the billing contact, sender configuration and previous attempts before sending.',
      );
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await api(`/venues/${venueId}/billing/invoices/${invoice.id}/send`, {
        method: 'POST',
        body: { purpose, resend: previous, requestId },
      });
      const status = result.email.status;
      await onChanged(
        status === 'sent'
          ? 'Accepted by Brevo. This does not confirm delivery to the inbox.'
          : status === 'sending'
            ? 'An email is already in progress.'
            : status === 'failed'
              ? 'Brevo rejected the email. Check sender configuration.'
              : 'Outcome uncertain. Check Brevo activity before sending another copy.',
      );
      onClose();
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      className="modal--invoice"
      title={invoice.invoiceNumber}
      busy={busy}
      confirmDisabled={
        !emailReady ||
        !contact?.billing_email ||
        !model ||
        (previous && !ack) ||
        ['void', 'written_off'].includes(invoice.status)
      }
      onClose={onClose}
      onConfirm={send}
      confirmLabel={
        previous
          ? 'Send another copy'
          : purpose === 'receipt'
            ? 'Send paid receipt'
            : 'Send invoice'
      }
    >
      <div className="billing-review">
        {error && (
          <p className="form-alert form-alert--error" role="alert">
            {error}
          </p>
        )}
        {!emailReady && (
          <p className="form-alert">
            Email sending is disabled on the server. You can still preview and download invoices.
          </p>
        )}
        {model ? (
          <>
            <div className="billing-review__heading">
              <strong>
                {model.title} · {model.badge.label}
              </strong>
              <button
                type="button"
                className="button button--secondary"
                onClick={() =>
                  downloadFile(
                    `/venues/${venueId}/billing/invoices/${invoice.id}/pdf`,
                    invoice.invoiceNumber + '.pdf',
                  ).catch((caught) => setError(caught.message))
                }
              >
                Download PDF
              </button>
            </div>
            <div className="billing-review__parties">
              <div>
                <small>From</small>
                {model.from.map((line, index) => (
                  <div key={index}>{line}</div>
                ))}
              </div>
              <div>
                <small>Bill to</small>
                {model.billTo.map((line, index) => (
                  <div key={index}>{line}</div>
                ))}
              </div>
            </div>
            <dl>
              {model.details.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            {model.items.map((line, index) => (
              <div className="billing-review__line" key={index}>
                <span>
                  {line.description}
                  <small>{line.detail}</small>
                </span>
                <strong>{formatCurrencyCents(line.amountCents)}</strong>
              </div>
            ))}
            <div className="billing-review__line">
              <strong>Amount due</strong>
              <strong>{formatCurrencyCents(model.dueCents)}</strong>
            </div>
            <p>
              {model.gstRegistered
                ? `Includes ${formatCurrencyCents(model.gstCents)} GST`
                : 'No GST has been charged'}
            </p>
            {model.pay && (
              <>
                <strong>How to pay</strong>
                <dl>
                  {model.pay.rows.map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              </>
            )}
            {model.footnote && <p>{model.footnote}</p>}
            {model.missing.length > 0 && (
              <p className="form-alert">Complete before sending: {model.missing.join(', ')}.</p>
            )}
            <label className="field">
              <span>Email type</span>
              <select
                value={purpose}
                onChange={(event) => {
                  setPurpose(event.target.value);
                  setAck(false);
                }}
              >
                <option value="invoice">Invoice</option>
                {invoice.billing?.state === 'paid' && (
                  <option value="receipt">Paid-in-full receipt</option>
                )}
              </select>
            </label>
            <p>
              To: <strong>{contact?.billing_email || 'No billing email set'}</strong>
              {contact?.billing_cc && <> · CC: {contact.billing_cc}</>}
            </p>
            {previous && (
              <label className="billing-check">
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(event) => setAck(event.target.checked)}
                />
                I checked the previous attempts below and want to send another copy.
              </label>
            )}
          </>
        ) : (
          <p>Loading invoice preview…</p>
        )}
        <details
          open={(invoice.emails || []).some((email) =>
            ['failed', 'unknown'].includes(email.status),
          )}
        >
          <summary>Email history ({invoice.emails?.length || 0})</summary>
          {!(invoice.emails || []).length && (
            <p>No email attempts. “Issued” may mean it was sent outside Console.</p>
          )}
          {(invoice.emails || []).map((email) => (
            <article className="billing-email" key={email.id}>
              <strong>
                {email.purpose} ·{' '}
                {
                  {
                    sent: 'Accepted by Brevo',
                    unknown: 'Uncertain — check Brevo',
                    failed: 'Rejected',
                    sending: 'Sending',
                  }[email.status]
                }
              </strong>
              <span>
                {formatDate(email.created_at)} · {email.to_email}
                {email.cc_email ? ` · CC ${email.cc_email}` : ''}
              </span>
              {email.error && <p>{email.error}</p>}
            </article>
          ))}
        </details>
      </div>
    </Modal>
  );
}
