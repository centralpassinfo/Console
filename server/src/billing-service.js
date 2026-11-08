'use strict';
const crypto = require('crypto');
const { pool } = require('./db');
const { recordAudit } = require('./audit');
const { localDate } = require('./timezone');
const {
  describeInvoice,
  publicInvoice,
  publicPayment,
  summarizeVenueBilling,
} = require('./billing');
const { planMonthlyInvoice, reminderDue, money } = require('./billing-calendar');
const { allocateInvoiceNumber } = require('./invoice-numbers');
const { buildInvoiceDocument, renderInvoicePdf } = require('./invoice-document');
const { sendEmail, emailConfigured } = require('./brevo');
const { fail, date, text, invoiceInput, settingsInput, contactInput } = require('./billing-input');

function createBillingService({
  db = pool,
  send = sendEmail,
  render = renderInvoicePdf,
  now = () => new Date(),
  env = process.env,
} = {}) {
  const today = () => localDate(now());
  async function tx(work) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  const audit = (client, venueId, actor, action, detail) =>
    recordAudit({ venueId, actor, action, detail }, client);
  async function settings(client = db) {
    return (await client.query('SELECT * FROM billing_settings WHERE id = 1')).rows[0];
  }
  async function venue(id, client = db) {
    const row = (await client.query('SELECT * FROM venues WHERE id = $1', [id])).rows[0];
    if (!row) fail('Venue not found.', 404);
    return row;
  }
  function contact(row) {
    return Object.fromEntries(
      [
        'billing_name',
        'billing_contact',
        'billing_email',
        'billing_cc',
        'billing_address',
        'billing_service_description',
      ].map((key) => [key, row[key] || '']),
    );
  }
  async function invoice(venueId, invoiceId, client = db, lock = false) {
    const row = (
      await client.query(
        `SELECT * FROM venue_invoices WHERE venue_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`,
        [venueId, invoiceId],
      )
    ).rows[0];
    if (!row) fail('Invoice not found.', 404);
    return row;
  }
  async function idle(row, client) {
    if (
      (
        await client.query(
          "SELECT 1 FROM venue_invoice_emails WHERE invoice_id = $1 AND status = 'sending'",
          [row.id],
        )
      ).rowCount
    )
      fail('An email is in progress. Wait before changing this invoice or its payments.', 409);
  }
  async function entry(row, client = db) {
    const lines = (
      await client.query(
        'SELECT * FROM venue_invoice_lines WHERE invoice_id = $1 ORDER BY position, id',
        [row.id],
      )
    ).rows;
    const payments = (
      await client.query(
        'SELECT * FROM venue_payments WHERE invoice_id = $1 ORDER BY received_on, id',
        [row.id],
      )
    ).rows;
    const emails = (
      await client.query(
        'SELECT id, purpose, reminder_key, to_email, cc_email, subject, status, provider_message_id, error, sent_by, created_at FROM venue_invoice_emails WHERE invoice_id = $1 ORDER BY created_at DESC, id DESC',
        [row.id],
      )
    ).rows;
    const description = describeInvoice(row, payments, today());
    return { invoice: row, lines, payments, emails, description };
  }
  const present = (item) => ({
    ...publicInvoice(item.invoice, item.description),
    footnote: item.invoice.footnote || '',
    origin: item.invoice.origin,
    sentAt: item.invoice.sent_at,
    lines: item.lines.map((row) => ({
      description: row.description,
      detail: row.detail || '',
      amountCents: row.amount_cents,
    })),
    payments: item.payments.map(publicPayment),
    emails: item.emails,
  });
  async function ledger(venueId) {
    const buyer = await venue(venueId),
      config = await settings();
    const rows = (
      await db.query(
        'SELECT * FROM venue_invoices WHERE venue_id = $1 ORDER BY issued_on DESC, id DESC',
        [venueId],
      )
    ).rows;
    const entries = await Promise.all(rows.map((row) => entry(row)));
    return {
      contact: contact(buyer),
      settings: config,
      emailReady: emailConfigured(env),
      summary: summarizeVenueBilling(entries),
      invoices: entries.map(present),
    };
  }
  async function updateSettings(input, actor) {
    const values = settingsInput(input),
      keys = Object.keys(values);
    return tx(async (client) => {
      const current = (await client.query('SELECT * FROM billing_settings WHERE id=1 FOR UPDATE'))
        .rows[0];
      if (
        input.updated_at &&
        new Date(input.updated_at).getTime() !== new Date(current.updated_at).getTime()
      )
        fail('Billing settings changed. Reload before saving.', 409);
      // Explicit opt-in is required; secrets never pass through this route.
      const row = (
        await client.query(
          `UPDATE billing_settings SET ${keys.map((key, i) => `${key} = $${i + 1}`).join(', ')}, updated_by = $${keys.length + 1}, updated_at = NOW() WHERE id = 1 RETURNING *`,
          [...Object.values(values), actor],
        )
      ).rows[0];
      await audit(client, null, actor, 'billing.settings.updated', {
        fields: keys.filter((key) => String(current[key] ?? '') !== String(values[key] ?? '')),
      });
      return row;
    });
  }
  async function updateContact(venueId, input, actor) {
    const values = contactInput(input),
      keys = Object.keys(values);
    return tx(async (client) => {
      await venue(venueId, client);
      const row = (
        await client.query(
          `UPDATE venues SET ${keys.map((key, i) => `${key} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
          [venueId, ...Object.values(values)],
        )
      ).rows[0];
      await audit(client, venueId, actor, 'billing.contact.updated', { fields: keys });
      return contact(row);
    });
  }
  async function saveInvoice(venueId, invoiceId, input, actor, origin = 'manual') {
    return tx(async (client) => {
      // All invoice creation for a venue shares this lock, including monthly runs.
      await client.query('SELECT pg_advisory_xact_lock(70319, $1)', [venueId]);
      const buyer = await venue(venueId, client),
        config = await settings(client);
      const old = invoiceId ? await invoice(venueId, invoiceId, client, true) : null;
      if (old) {
        await idle(old, client);
        if (
          old.status !== 'draft' ||
          (
            await client.query(
              "SELECT 1 FROM venue_invoice_emails WHERE invoice_id=$1 AND status IN ('sent','unknown')",
              [old.id],
            )
          ).rowCount
        )
          fail(
            'Issued invoices cannot be rewritten. Void an incorrect invoice and create a replacement.',
            409,
          );
        if (
          !input.updatedAt ||
          new Date(input.updatedAt).getTime() !== new Date(old.updated_at).getTime()
        )
          fail('This invoice changed. Reload it before editing.', 409);
      }
      const value = invoiceInput(input, config);
      let operation = old?.operation_key || null;
      if (!old && input.requestId) {
        if (!/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId)) fail('Invalid invoice request ID.');
        operation = `invoice:${venueId}:${input.requestId}`;
        const recorded = (
          await client.query('SELECT * FROM venue_invoices WHERE operation_key=$1', [operation])
        ).rows[0];
        if (recorded) return present(await entry(recorded, client));
      }
      if (
        value.contractId &&
        !(
          await client.query('SELECT 1 FROM venue_contracts WHERE id = $1 AND venue_id = $2', [
            value.contractId,
            venueId,
          ])
        ).rowCount
      )
        fail('Choose one of this venue’s contracts.');
      if (
        value.kind === 'monthly' &&
        (
          await client.query(
            "SELECT 1 FROM venue_invoices WHERE venue_id = $1 AND kind = 'monthly' AND status <> 'void' AND id <> $4 AND period_start <= $3 AND period_end >= $2",
            [venueId, value.periodStart, value.periodEnd, invoiceId || 0],
          )
        ).rowCount
      )
        fail('A monthly invoice already covers some or all of that service period.', 409);
      // Reserve the same counter lock for manual numbers as generated numbers.
      // A rolled-back allocation never consumes a number.
      const allocated = await allocateInvoiceNumber(client, {
        prefix: config.invoice_prefix,
        issuedOn: value.issuedOn,
        reserveOnly: !!(value.invoiceNumber || old?.invoice_number),
      });
      const number = value.invoiceNumber || old?.invoice_number || allocated;
      const snapshots = value.status !== 'draft' ? [config, contact(buyer)] : [null, null];
      const columns = [
        'venue_id',
        'contract_id',
        'invoice_number',
        'kind',
        'period_start',
        'period_end',
        'issued_on',
        'due_on',
        'amount_cents',
        'gst_cents',
        'status',
        'notes',
        'footnote',
        'origin',
        'gst_registered',
        'seller_snapshot',
        'buyer_snapshot',
        'created_by',
        'operation_key',
      ];
      const values = [
        venueId,
        value.contractId,
        number,
        value.kind,
        value.periodStart,
        value.periodEnd,
        value.issuedOn,
        value.dueOn,
        value.amountCents,
        value.gstCents,
        value.status,
        value.notes,
        value.footnote,
        old?.origin || origin,
        config.gst_registered,
        ...snapshots,
        old?.created_by || actor,
        operation,
      ];
      let row;
      if (old)
        row = (
          await client.query(
            `UPDATE venue_invoices SET ${columns.map((key, i) => `${key} = $${i + 2}`).join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
            [old.id, ...values],
          )
        ).rows[0];
      else
        row = (
          await client.query(
            `INSERT INTO venue_invoices (${columns.join(', ')}) VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
            values,
          )
        ).rows[0];
      await client.query('DELETE FROM venue_invoice_lines WHERE invoice_id = $1', [row.id]);
      for (const [position, line] of value.lines.entries())
        await client.query(
          'INSERT INTO venue_invoice_lines (invoice_id, position, description, detail, amount_cents) VALUES ($1,$2,$3,$4,$5)',
          [row.id, position, line.description, line.detail, line.amountCents],
        );
      await audit(
        client,
        venueId,
        actor,
        old ? 'billing.invoice.updated' : 'billing.invoice.created',
        { invoiceNumber: number, amountCents: row.amount_cents, origin },
      );
      return present(await entry(row, client));
    });
  }
  async function changeStatus(venueId, invoiceId, status, actor) {
    if (!['sent', 'void', 'written_off'].includes(status))
      fail('Choose issued, void or written off.');
    return tx(async (client) => {
      const row = await invoice(venueId, invoiceId, client, true);
      await idle(row, client);
      if (row.status !== 'draft' && status === 'sent')
        fail('Issued or void invoices cannot be reinstated. Create a replacement invoice.', 409);
      const current = await entry(row, client);
      if (status === 'void' && current.payments.length)
        fail('Remove incorrectly recorded payments before voiding this invoice.', 409);
      if (
        status === 'written_off' &&
        (row.status !== 'sent' || current.description.outstandingCents <= 0)
      )
        fail('Only an issued invoice with an unpaid balance can be written off.', 409);
      const config = await settings(client),
        buyer = await venue(venueId, client);
      const updated = (
        await client.query(
          'UPDATE venue_invoices SET status = $2, seller_snapshot = COALESCE(seller_snapshot,$3::jsonb), buyer_snapshot = COALESCE(buyer_snapshot,$4::jsonb), updated_at = NOW() WHERE id = $1 RETURNING *',
          [invoiceId, status, JSON.stringify(config), JSON.stringify(contact(buyer))],
        )
      ).rows[0];
      await audit(client, venueId, actor, 'billing.invoice.status', {
        invoiceNumber: row.invoice_number,
        status,
      });
      return present(await entry(updated, client));
    });
  }
  async function recordPayment(venueId, invoiceId, input, actor) {
    const received = date(input.receivedOn, 'Received date');
    if (received > today()) fail('A received payment cannot be dated in the future.');
    const amount = require('./contracts').parseMoneyToCents(input.amount, 'Payment');
    if (!amount || !['bank_transfer', 'becs', 'card', 'cash', 'other'].includes(input.method))
      fail('Enter a positive payment and valid payment method.');
    return tx(async (client) => {
      const row = await invoice(venueId, invoiceId, client, true);
      await idle(row, client);
      if (row.status !== 'sent') fail('Issue the invoice before recording payment.', 409);
      if (!/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId || ''))
        fail('A payment needs a unique request ID. Refresh and retry.');
      const operation = `payment:${venueId}:${invoiceId}:${input.requestId}`;
      const recorded = (
        await client.query('SELECT * FROM venue_payments WHERE operation_key=$1', [operation])
      ).rows[0];
      if (recorded)
        return {
          payment: publicPayment(recorded),
          billing: (await entry(row, client)).description,
        };
      const current = await entry(row, client);
      if (amount > current.description.outstandingCents)
        fail('Payment exceeds the outstanding amount. Record unapplied credits separately.', 409);
      const payment = (
        await client.query(
          "INSERT INTO venue_payments (invoice_id,venue_id,received_on,amount_cents,method,source,reference,recorded_by,operation_key) VALUES ($1,$2,$3,$4,$5,'manual',$6,$7,$8) RETURNING *",
          [
            invoiceId,
            venueId,
            received,
            amount,
            input.method,
            text(input.reference, 200),
            actor,
            operation,
          ],
        )
      ).rows[0];
      await audit(client, venueId, actor, 'billing.payment.recorded', {
        invoiceNumber: row.invoice_number,
        amountCents: amount,
        method: input.method,
      });
      return { payment: publicPayment(payment), billing: (await entry(row, client)).description };
    });
  }
  async function removePayment(venueId, paymentId, actor) {
    return tx(async (client) => {
      const payment = (
        await client.query('SELECT * FROM venue_payments WHERE id = $1 AND venue_id = $2', [
          paymentId,
          venueId,
        ])
      ).rows[0];
      if (!payment) fail('Payment not found.', 404);
      const row = await invoice(venueId, payment.invoice_id, client, true);
      await idle(row, client);
      if (payment.source !== 'manual') fail('Provider payments cannot be removed manually.', 409);
      await client.query('DELETE FROM venue_payments WHERE id = $1', [paymentId]);
      await audit(client, venueId, actor, 'billing.payment.removed', {
        invoiceId: row.id,
        amountCents: payment.amount_cents,
      });
      return publicPayment(payment);
    });
  }
  async function document(venueId, invoiceId) {
    const row = await invoice(venueId, invoiceId),
      item = await entry(row),
      buyer = await venue(venueId);
    if (Number(row.gst_cents) > 0 && !row.gst_registered)
      fail(
        'This historical invoice contains GST without a registration snapshot. Review its tax treatment before producing a document.',
        409,
      );
    return buildInvoiceDocument({
      invoice: row,
      lineItems: item.lines,
      payments: item.payments,
      description: item.description,
      settings: {
        ...(row.status !== 'draft' ||
        item.emails.some((email) => ['sent', 'unknown'].includes(email.status))
          ? row.seller_snapshot || (await settings())
          : await settings()),
        gst_registered: row.gst_registered || Number(row.gst_cents) > 0,
      },
      venue: { ...buyer, ...(row.status !== 'draft' ? row.buyer_snapshot || {} : {}) },
    });
  }
  async function deliver(
    venueId,
    invoiceId,
    { purpose = 'invoice', reminderKey = null, resend = false, requestId = null } = {},
    actor = 'billing-worker',
  ) {
    if (!emailConfigured(env))
      fail(
        'Sending is disabled. Configure Brevo and enable BILLING_SEND_ENABLED on the server.',
        409,
      );
    if (!['invoice', 'reminder', 'receipt'].includes(purpose)) fail('Unknown email purpose.');
    if (resend && (!requestId || !/^[a-zA-Z0-9-]{16,80}$/.test(requestId)))
      fail('Resending needs a unique request ID.');
    const operationKey = resend
      ? `resend:${invoiceId}:${purpose}:${requestId}`
      : `${purpose}:${invoiceId}:${reminderKey || 'initial'}`;
    const prepared = await tx(async (client) => {
      const row = await invoice(venueId, invoiceId, client, true);
      if (Number(row.gst_cents) > 0 && !row.gst_registered)
        fail('Review this historical invoice’s GST treatment before sending.', 409);
      const existing = (
        await client.query('SELECT * FROM venue_invoice_emails WHERE operation_key = $1', [
          operationKey,
        ])
      ).rows[0];
      if (existing) return { duplicate: true, email: existing };
      await idle(row, client);
      if (['void', 'written_off'].includes(row.status))
        fail('Void or written-off invoices cannot be emailed.', 409);
      if (row.issued_on > today()) fail('Do not send an invoice before its issue date.', 409);
      const config =
          row.status === 'draft'
            ? await settings(client)
            : row.seller_snapshot || (await settings(client)),
        buyer = await venue(venueId, client);
      if (!buyer.billing_email) fail('Add a billing email for this venue first.', 409);
      const current = await entry(row, client),
        prospective = { ...row, status: 'sent' };
      const description = describeInvoice(prospective, current.payments, today());
      if (purpose === 'receipt' && description.state !== 'paid')
        fail('A paid-in-full receipt requires a fully paid invoice.', 409);
      if (purpose === 'reminder') {
        const due = reminderDue({
          state: description.state,
          dueOn: row.due_on,
          today: today(),
          invoiceEmailed: !!row.sent_at,
          sentKeys: new Set(
            current.emails
              .filter(
                (item) =>
                  item.status === 'sent' || item.status === 'unknown' || item.status === 'sending',
              )
              .map((item) => item.reminder_key),
          ),
        });
        if (!due || due !== reminderKey) fail('No reminder is due for this invoice.', 409);
      }
      const model = buildInvoiceDocument({
        invoice: prospective,
        lineItems: current.lines,
        payments: current.payments,
        description,
        settings: { ...config, gst_registered: row.gst_registered || Number(row.gst_cents) > 0 },
        venue: { ...buyer, ...(row.status !== 'draft' ? row.buyer_snapshot || {} : {}) },
      });
      if (!config.seller_legal_name || model.missing.length)
        fail(
          `Complete invoice details first: ${[!config.seller_legal_name && 'legal business name', ...model.missing].filter(Boolean).join(', ')}.`,
          409,
        );
      const subject = `${purpose === 'receipt' ? 'Payment receipt' : purpose === 'reminder' ? 'Payment reminder' : 'Invoice'} ${row.invoice_number} - ${config.seller_name}`;
      const email = (
        await client.query(
          "INSERT INTO venue_invoice_emails (invoice_id,venue_id,purpose,reminder_key,to_email,cc_email,subject,status,operation_key,document,sent_by,provider_key) VALUES ($1,$2,$3,$4,$5,$6,$7,'sending',$8,$9::jsonb,$10,$11) RETURNING *",
          [
            invoiceId,
            venueId,
            purpose,
            reminderKey,
            buyer.billing_email,
            buyer.billing_cc,
            subject,
            operationKey,
            JSON.stringify(model),
            actor,
            crypto.randomUUID(),
          ],
        )
      ).rows[0];
      await client.query(
        "UPDATE venue_invoices SET seller_snapshot = CASE WHEN status='draft' THEN $2::jsonb ELSE COALESCE(seller_snapshot,$2::jsonb) END, buyer_snapshot = CASE WHEN status='draft' THEN $3::jsonb ELSE COALESCE(buyer_snapshot,$3::jsonb) END WHERE id = $1",
        [invoiceId, JSON.stringify(config), JSON.stringify(contact(buyer))],
      );
      return { email, model, number: row.invoice_number, replyTo: config.email };
    });
    if (prepared.duplicate) return { email: prepared.email, duplicate: true };
    const { email, model } = prepared;
    let result,
      error,
      attempted = false;
    try {
      const pdf = await render(model);
      const body = `${purpose === 'receipt' ? 'Thank you. Payment has been received in full.' : purpose === 'reminder' ? 'A reminder about your outstanding invoice.' : 'Your CentralPass invoice is attached.'}\n\nInvoice: ${prepared.number}\nAmount due: ${money(model.dueCents)}\n${model.details.map((pair) => pair.join(': ')).join('\n')}\n\nPlease use the invoice number as your bank reference.\nQuestions: ${prepared.replyTo}`;
      const escape = (value) =>
        value.replace(
          /[&<>"']/g,
          (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
        );
      attempted = true;
      result = await send(
        {
          to: email.to_email,
          cc: email.cc_email,
          replyTo: prepared.replyTo,
          subject: email.subject,
          text: body,
          html: `<div style="font-family:Arial,sans-serif;white-space:pre-line">${escape(body)}</div>`,
          operationKey: email.provider_key,
          attachments: [
            { name: `${prepared.number.replace(/[^A-Za-z0-9._-]/g, '-')}.pdf`, content: pdf },
          ],
        },
        { env },
      );
    } catch (caught) {
      error = caught;
    }
    // An ambiguous network/provider result is never automatically retried.
    const status = !error ? 'sent' : !attempted || error.definitive ? 'failed' : 'unknown';
    await tx(async (client) => {
      await invoice(venueId, invoiceId, client, true);
      await client.query(
        'UPDATE venue_invoice_emails SET status = $2, provider_message_id = $3, error = $4, updated_at = NOW() WHERE id = $1',
        [
          email.id,
          status,
          result?.messageId || null,
          error
            ? status === 'unknown'
              ? 'Outcome uncertain. Check Brevo activity before resending.'
              : 'Provider rejected the email. Check Brevo configuration before resending.'
            : null,
        ],
      );
      if (status !== 'failed')
        await client.query(
          "UPDATE venue_invoices SET status = CASE WHEN status='draft' THEN 'sent' ELSE status END, sent_at = CASE WHEN $2 = 'sent' AND $3 = 'invoice' THEN COALESCE(sent_at,NOW()) ELSE sent_at END, updated_at = NOW() WHERE id = $1",
          [invoiceId, status, purpose],
        );
      await audit(client, venueId, actor, 'billing.email.' + status, {
        invoiceId,
        purpose,
        emailId: email.id,
        providerMessageId: result?.messageId || null,
      });
    });
    return {
      email: { ...email, status, provider_message_id: result?.messageId || null },
      duplicate: false,
    };
  }
  async function preview(on = today()) {
    date(on);
    const config = await settings();
    const buyers = (await db.query('SELECT * FROM venues ORDER BY name,id')).rows;
    const result = [];
    for (const buyer of buyers) {
      const contracts = (
        await db.query(
          "SELECT * FROM venue_contracts WHERE venue_id = $1 AND status IN ('signed','terminated','expired') AND effective_date <= $2 ORDER BY effective_date DESC,id DESC",
          [buyer.id, on],
        )
      ).rows;
      const latest =
        contracts[0] ||
        (
          await db.query(
            "SELECT * FROM venue_contracts WHERE venue_id=$1 AND status='signed' AND effective_date > $2 ORDER BY effective_date,id LIMIT 1",
            [buyer.id, on],
          )
        ).rows[0] ||
        null;
      const plan = planMonthlyInvoice({
        venue: buyer,
        contract: latest,
        today: on,
        settings: config,
      });
      if (plan.action === 'create') {
        if (!config.automation_start_on || plan.invoice.periodStart < config.automation_start_on)
          Object.assign(plan, {
            action: 'skip',
            reason:
              'Historic invoices need review, or this period predates the automation start date.',
          });
        else if (
          (
            await db.query(
              "SELECT 1 FROM venue_invoices WHERE venue_id = $1 AND kind = 'monthly' AND status <> 'void' AND period_start <= $3 AND period_end >= $2",
              [buyer.id, plan.invoice.periodStart, plan.invoice.periodEnd],
            )
          ).rowCount
        )
          Object.assign(plan, {
            action: 'skip',
            reason: 'Already invoiced for this service period.',
          });
      }
      result.push({ venueId: buyer.id, venueName: buyer.name, ...plan });
    }
    return { date: on, settings: config, emailReady: emailConfigured(env), venues: result };
  }
  async function run({ actor = 'billing-worker', manual = false } = {}) {
    if (db.options?.max < 2) fail('Billing checks require DATABASE_POOL_SIZE of at least 2.', 409);
    const guard = await db.connect();
    let locked = false;
    try {
      locked = (await guard.query('SELECT pg_try_advisory_lock(70319,0) AS locked')).rows[0].locked;
      if (!locked) return { busy: true };
      // Never replay a send interrupted after its provider may have accepted it.
      await guard.query(
        "UPDATE venue_invoice_emails SET status='unknown',error='Worker interrupted. Check Brevo activity before resending.',updated_at=NOW() WHERE status='sending' AND created_at < NOW() - INTERVAL '5 minutes'",
      );
      await guard.query(
        "UPDATE venue_invoices SET status='sent',updated_at=NOW() WHERE status='draft' AND EXISTS (SELECT 1 FROM venue_invoice_emails e WHERE e.invoice_id=venue_invoices.id AND e.status='unknown')",
      );
      const plan = await preview(),
        config = plan.settings;
      const summary = {
        date: plan.date,
        created: [],
        emails: [],
        skipped: plan.venues.filter((item) => item.action === 'skip').length,
        errors: [],
      };
      if (manual || config.auto_generate)
        for (const item of plan.venues.filter((item) => item.action === 'create')) {
          try {
            const draft = item.invoice;
            const row = await saveInvoice(
              item.venueId,
              null,
              {
                ...draft,
                status: 'draft',
                lines: draft.lines.map((line) => ({
                  ...line,
                  amount: (line.amountCents / 100).toFixed(2),
                })),
              },
              actor,
              'automatic',
            );
            summary.created.push(row.id);
          } catch (error) {
            if (error.status !== 409 && error.code !== '23505')
              summary.errors.push({ venueId: item.venueId, error: error.message });
          }
        }
      if (emailConfigured(env) && config.automation_start_on) {
        const candidates = (
          await db.query(
            "SELECT * FROM venue_invoices WHERE issued_on >= $1 AND issued_on <= $2 AND status IN ('draft','sent') ORDER BY id",
            [config.automation_start_on, today()],
          )
        ).rows;
        for (const row of candidates) {
          try {
            const switches = await settings();
            if (
              config.auto_send &&
              switches.auto_send &&
              row.status === 'draft' &&
              row.origin === 'automatic' &&
              summary.created.includes(row.id)
            ) {
              const result = await deliver(row.venue_id, row.id, {}, actor);
              if (!result.duplicate)
                summary.emails.push({ id: result.email.id, status: result.email.status });
            } else if (config.auto_remind && switches.auto_remind && row.status === 'sent') {
              const item = await entry(row);
              const key = reminderDue({
                state: item.description.state,
                dueOn: row.due_on,
                today: today(),
                invoiceEmailed: !!row.sent_at,
                sentKeys: new Set(
                  item.emails
                    .filter((email) => email.status !== 'failed')
                    .map((email) => email.reminder_key),
                ),
              });
              if (key) {
                const result = await deliver(
                  row.venue_id,
                  row.id,
                  { purpose: 'reminder', reminderKey: key },
                  actor,
                );
                if (!result.duplicate)
                  summary.emails.push({ id: result.email.id, status: result.email.status });
              }
            }
          } catch (error) {
            summary.errors.push({ invoiceId: row.id, error: error.message });
          }
        }
      }
      await db.query(
        'UPDATE billing_settings SET last_run_at = NOW(), last_run_summary = $1::jsonb WHERE id=1',
        [JSON.stringify(summary)],
      );
      await recordAudit({ actor, action: 'billing.run', detail: summary }, db);
      return summary;
    } finally {
      let releaseError;
      if (locked)
        try {
          await guard.query('SELECT pg_advisory_unlock(70319,0)');
        } catch (error) {
          releaseError = error;
        }
      guard.release(releaseError);
    }
  }
  async function overview() {
    const rows = (
      await db.query(
        'SELECT i.*,v.name AS venue_name FROM venue_invoices i JOIN venues v ON v.id=i.venue_id ORDER BY issued_on DESC,id DESC LIMIT 200',
      )
    ).rows;
    const entries = await Promise.all(rows.map((row) => entry(row)));
    return {
      settings: await settings(),
      emailReady: emailConfigured(env),
      invoices: entries.map((item) => ({ ...present(item), venueName: item.invoice.venue_name })),
    };
  }
  return {
    settings,
    updateSettings,
    updateContact,
    ledger,
    saveInvoice,
    changeStatus,
    recordPayment,
    removePayment,
    document,
    deliver,
    preview,
    run,
    overview,
  };
}
module.exports = { createBillingService, ...createBillingService() };
