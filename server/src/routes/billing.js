'use strict';

const express = require('express');
const { body, param } = require('express-validator');
const { pool } = require('../db');
const { validateRequest } = require('../validation');
const { requireAuth, requireCsrf, actorFrom } = require('../auth');
const { recordAudit } = require('../audit');
const { parseMoneyToCents } = require('../contracts');
const {
  INVOICE_KINDS,
  INVOICE_STATUSES,
  PAYMENT_METHODS,
  describeInvoice,
  summarizeVenueBilling,
  publicInvoice,
  publicPayment,
} = require('../billing');

const router = express.Router();

router.use(requireAuth);

async function findVenue(id) {
  const { rows: [venue] } = await pool.query(`SELECT id, name FROM venues WHERE id = $1`, [id]);
  return venue;
}

async function findInvoice(venueId, invoiceId) {
  const { rows: [invoice] } = await pool.query(
    `SELECT * FROM venue_invoices WHERE id = $1 AND venue_id = $2`,
    [invoiceId, venueId]
  );
  return invoice;
}

/** Every invoice for a venue, each with its payments and derived state. */
async function loadLedger(venueId) {
  const { rows: invoices } = await pool.query(
    `SELECT * FROM venue_invoices WHERE venue_id = $1 ORDER BY issued_on DESC, id DESC`,
    [venueId]
  );
  const { rows: payments } = await pool.query(
    `SELECT * FROM venue_payments WHERE venue_id = $1 ORDER BY received_on ASC, id ASC`,
    [venueId]
  );

  const byInvoice = new Map();
  for (const payment of payments) {
    if (!byInvoice.has(payment.invoice_id)) byInvoice.set(payment.invoice_id, []);
    byInvoice.get(payment.invoice_id).push(payment);
  }

  return invoices.map((invoice) => {
    const invoicePayments = byInvoice.get(invoice.id) || [];
    return { invoice, payments: invoicePayments, description: describeInvoice(invoice, invoicePayments) };
  });
}

/** Money arrives as "150.00" from the form and is stored as exact cents. */
function moneyField(field, { required = true, label } = {}) {
  let validator = body(field);
  if (!required) validator = validator.optional({ values: 'falsy' });
  return validator.custom((value) => {
    parseMoneyToCents(value, label || field);
    return true;
  });
}

const invoiceFields = [
  body('invoiceNumber').isString().trim().isLength({ min: 1, max: 40 })
    .withMessage('Invoice number is required and must be 40 characters or fewer.'),
  body('kind').isIn(INVOICE_KINDS).withMessage('Choose a valid invoice type.'),
  body('issuedOn').isISO8601().withMessage('Issue date must be a valid date.'),
  body('dueOn').isISO8601().withMessage('Due date must be a valid date.'),
  body('dueOn').custom((value, { req }) => {
    if (req.body.issuedOn && String(value).slice(0, 10) < String(req.body.issuedOn).slice(0, 10)) {
      throw new Error('Due date cannot be before the issue date.');
    }
    return true;
  }),
  moneyField('amount', { label: 'Amount' }),
  moneyField('gst', { required: false, label: 'GST' }),
  body('periodStart').optional({ values: 'falsy' }).isISO8601().withMessage('Period start must be a valid date.'),
  body('periodEnd').optional({ values: 'falsy' }).isISO8601().withMessage('Period end must be a valid date.'),
  body('kind').custom((value, { req }) => {
    if (value === 'monthly' && !(req.body.periodStart && req.body.periodEnd)) {
      throw new Error('A monthly invoice needs a period start and end.');
    }
    return true;
  }),
  body('status').optional().isIn(INVOICE_STATUSES).withMessage('Choose a valid invoice status.'),
  body('contractId').optional({ values: 'falsy' }).isInt({ min: 1 }).toInt(),
  body('notes').optional({ nullable: true }).isString().trim().isLength({ max: 3000 })
    .withMessage('Notes are too long.'),
];

// ── Ledger ───────────────────────────────────────────────────────────────────

router.get(
  '/:venueId/billing',
  [param('venueId').isInt({ min: 1 }).toInt()],
  validateRequest,
  async (req, res, next) => {
    try {
      const venue = await findVenue(req.params.venueId);
      if (!venue) return res.status(404).json({ error: 'Venue not found.' });
      const entries = await loadLedger(venue.id);
      return res.json({
        summary: summarizeVenueBilling(entries),
        invoices: entries.map(({ invoice, payments, description }) => ({
          ...publicInvoice(invoice, description),
          payments: payments.map(publicPayment),
        })),
      });
    } catch (error) { return next(error); }
  }
);

// ── Invoices ─────────────────────────────────────────────────────────────────

router.post(
  '/:venueId/billing/invoices',
  requireCsrf,
  [param('venueId').isInt({ min: 1 }).toInt(), ...invoiceFields],
  validateRequest,
  async (req, res, next) => {
    try {
      const venue = await findVenue(req.params.venueId);
      if (!venue) return res.status(404).json({ error: 'Venue not found.' });

      const { rows: [invoice] } = await pool.query(
        `INSERT INTO venue_invoices
          (venue_id, contract_id, invoice_number, kind, period_start, period_end,
           issued_on, due_on, amount_cents, gst_cents, status, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [
          venue.id,
          req.body.contractId || null,
          req.body.invoiceNumber.trim(),
          req.body.kind,
          req.body.periodStart || null,
          req.body.periodEnd || null,
          req.body.issuedOn,
          req.body.dueOn,
          parseMoneyToCents(req.body.amount, 'Amount'),
          parseMoneyToCents(req.body.gst, 'GST') || 0,
          req.body.status || 'draft',
          req.body.notes || null,
          actorFrom(req),
        ]
      );

      await recordAudit({
        venueId: venue.id,
        actor: actorFrom(req),
        action: 'billing.invoice.created',
        detail: {
          invoiceNumber: invoice.invoice_number,
          kind: invoice.kind,
          amountCents: invoice.amount_cents,
          gstCents: invoice.gst_cents,
          dueOn: invoice.due_on,
        },
      });

      return res.status(201).json({ invoice: publicInvoice(invoice, describeInvoice(invoice, [])) });
    } catch (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'That invoice number, period or Stripe invoice is already recorded.' });
      }
      if (error.code === '23514') return res.status(400).json({ error: 'Those invoice values are not a valid combination.' });
      if (/two decimal|too large/.test(error.message || '')) return res.status(400).json({ error: error.message });
      return next(error);
    }
  }
);

router.put(
  '/:venueId/billing/invoices/:invoiceId',
  requireCsrf,
  [
    param('venueId').isInt({ min: 1 }).toInt(),
    param('invoiceId').isInt({ min: 1 }).toInt(),
    ...invoiceFields,
  ],
  validateRequest,
  async (req, res, next) => {
    try {
      const existing = await findInvoice(req.params.venueId, req.params.invoiceId);
      if (!existing) return res.status(404).json({ error: 'Invoice not found.' });

      const { rows: [invoice] } = await pool.query(
        `UPDATE venue_invoices SET
           contract_id = $3, invoice_number = $4, kind = $5, period_start = $6,
           period_end = $7, issued_on = $8, due_on = $9, amount_cents = $10,
           gst_cents = $11, status = $12, notes = $13, updated_at = NOW()
         WHERE id = $1 AND venue_id = $2
         RETURNING *`,
        [
          req.params.invoiceId,
          req.params.venueId,
          req.body.contractId || null,
          req.body.invoiceNumber.trim(),
          req.body.kind,
          req.body.periodStart || null,
          req.body.periodEnd || null,
          req.body.issuedOn,
          req.body.dueOn,
          parseMoneyToCents(req.body.amount, 'Amount'),
          parseMoneyToCents(req.body.gst, 'GST') || 0,
          req.body.status || existing.status,
          req.body.notes || null,
        ]
      );

      await recordAudit({
        venueId: invoice.venue_id,
        actor: actorFrom(req),
        action: 'billing.invoice.updated',
        detail: { invoiceNumber: invoice.invoice_number, status: invoice.status, amountCents: invoice.amount_cents },
      });

      const { rows: payments } = await pool.query(
        `SELECT * FROM venue_payments WHERE invoice_id = $1 ORDER BY received_on ASC, id ASC`,
        [invoice.id]
      );
      return res.json({ invoice: publicInvoice(invoice, describeInvoice(invoice, payments)) });
    } catch (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'That invoice number, period or Stripe invoice is already recorded.' });
      }
      if (error.code === '23514') return res.status(400).json({ error: 'Those invoice values are not a valid combination.' });
      if (/two decimal|too large/.test(error.message || '')) return res.status(400).json({ error: error.message });
      return next(error);
    }
  }
);

// ── Payments ─────────────────────────────────────────────────────────────────

router.post(
  '/:venueId/billing/invoices/:invoiceId/payments',
  requireCsrf,
  [
    param('venueId').isInt({ min: 1 }).toInt(),
    param('invoiceId').isInt({ min: 1 }).toInt(),
    body('receivedOn').isISO8601().withMessage('Received date must be a valid date.'),
    moneyField('amount', { label: 'Amount' }),
    body('method').isIn(PAYMENT_METHODS).withMessage('Choose a valid payment method.'),
    body('reference').optional({ nullable: true }).isString().trim().isLength({ max: 200 })
      .withMessage('Reference is too long.'),
  ],
  validateRequest,
  async (req, res, next) => {
    try {
      const invoice = await findInvoice(req.params.venueId, req.params.invoiceId);
      if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });
      if (invoice.status === 'void') {
        return res.status(409).json({ error: 'That invoice is void. Reinstate it before recording a payment.' });
      }

      const amountCents = parseMoneyToCents(req.body.amount, 'Amount');
      const { rows: [payment] } = await pool.query(
        `INSERT INTO venue_payments
          (invoice_id, venue_id, received_on, amount_cents, method, source, reference, recorded_by)
         VALUES ($1,$2,$3,$4,$5,'manual',$6,$7)
         RETURNING *`,
        [
          invoice.id,
          invoice.venue_id,
          req.body.receivedOn,
          amountCents,
          req.body.method,
          req.body.reference || null,
          actorFrom(req),
        ]
      );

      const { rows: payments } = await pool.query(
        `SELECT * FROM venue_payments WHERE invoice_id = $1 ORDER BY received_on ASC, id ASC`,
        [invoice.id]
      );
      const description = describeInvoice(invoice, payments);

      await recordAudit({
        venueId: invoice.venue_id,
        actor: actorFrom(req),
        action: 'billing.payment.recorded',
        detail: {
          invoiceNumber: invoice.invoice_number,
          amountCents,
          method: payment.method,
          receivedOn: payment.received_on,
          resultingState: description.state,
          daysLate: description.daysLate,
        },
      });

      return res.status(201).json({ payment: publicPayment(payment), billing: description });
    } catch (error) {
      if (/two decimal|too large/.test(error.message || '')) return res.status(400).json({ error: error.message });
      return next(error);
    }
  }
);

router.delete(
  '/:venueId/billing/payments/:paymentId',
  requireCsrf,
  [param('venueId').isInt({ min: 1 }).toInt(), param('paymentId').isInt({ min: 1 }).toInt()],
  validateRequest,
  async (req, res, next) => {
    try {
      const { rows: [payment] } = await pool.query(
        `DELETE FROM venue_payments WHERE id = $1 AND venue_id = $2 RETURNING *`,
        [req.params.paymentId, req.params.venueId]
      );
      if (!payment) return res.status(404).json({ error: 'Payment not found.' });

      await recordAudit({
        venueId: payment.venue_id,
        actor: actorFrom(req),
        action: 'billing.payment.removed',
        detail: { invoiceId: payment.invoice_id, amountCents: payment.amount_cents, receivedOn: payment.received_on },
      });

      return res.json({ removed: publicPayment(payment) });
    } catch (error) { return next(error); }
  }
);

module.exports = router;
