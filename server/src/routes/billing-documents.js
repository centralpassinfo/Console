'use strict';
const express = require('express');
const { requireAuth, requireCsrf, actorFrom } = require('../auth');
const billing = require('../billing-service');
const { renderInvoicePdf } = require('../invoice-document');
const { fail } = require('../billing-input');
const router = express.Router();
router.use(requireAuth);
router.param('venueId', (req, res, next, value) => {
  if (!/^[1-9]\d{0,8}$/.test(value)) return res.status(400).json({ error: 'Invalid venue.' });
  req.params.venueId = Number(value);
  next();
});
const handle = (work) => async (req, res, next) => {
  try {
    await work(req, res);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    if (error.code === '23505')
      return res
        .status(409)
        .json({ error: 'That invoice number, period or payment is already recorded.' });
    if (error.code === '23514' || /two decimal|too large/.test(error.message))
      return res.status(400).json({ error: 'Review the invoice dates and amounts.' });
    next(error);
  }
};
function id(req, key) {
  const value = req.params[key];
  if (!/^[1-9]\d{0,8}$/.test(String(value))) fail('Invalid record ID.');
  return Number(value);
}
router.get(
  '/:venueId/billing',
  handle(async (req, res) => res.json(await billing.ledger(req.params.venueId))),
);
router.put(
  '/:venueId/billing/contact',
  requireCsrf,
  handle(async (req, res) =>
    res.json({
      contact: await billing.updateContact(req.params.venueId, req.body, actorFrom(req)),
    }),
  ),
);
router.post(
  '/:venueId/billing/invoices',
  requireCsrf,
  handle(async (req, res) =>
    res
      .status(201)
      .json({
        invoice: await billing.saveInvoice(req.params.venueId, null, req.body, actorFrom(req)),
      }),
  ),
);
router.put(
  '/:venueId/billing/invoices/:invoiceId',
  requireCsrf,
  handle(async (req, res) =>
    res.json({
      invoice: await billing.saveInvoice(
        req.params.venueId,
        id(req, 'invoiceId'),
        req.body,
        actorFrom(req),
      ),
    }),
  ),
);
router.post(
  '/:venueId/billing/invoices/:invoiceId/status',
  requireCsrf,
  handle(async (req, res) =>
    res.json({
      invoice: await billing.changeStatus(
        req.params.venueId,
        id(req, 'invoiceId'),
        req.body.status,
        actorFrom(req),
      ),
    }),
  ),
);
router.post(
  '/:venueId/billing/invoices/:invoiceId/payments',
  requireCsrf,
  handle(async (req, res) =>
    res
      .status(201)
      .json(
        await billing.recordPayment(
          req.params.venueId,
          id(req, 'invoiceId'),
          req.body,
          actorFrom(req),
        ),
      ),
  ),
);
router.delete(
  '/:venueId/billing/payments/:paymentId',
  requireCsrf,
  handle(async (req, res) =>
    res.json({
      removed: await billing.removePayment(
        req.params.venueId,
        id(req, 'paymentId'),
        actorFrom(req),
      ),
    }),
  ),
);
router.get(
  '/:venueId/billing/invoices/:invoiceId/pdf',
  handle(async (req, res) => {
    const model = await billing.document(req.params.venueId, id(req, 'invoiceId'));
    const pdf = await renderInvoicePdf(model);
    const filename = String(model.details[0][1]).replace(/[^A-Za-z0-9._-]/g, '-');
    res
      .type('application/pdf')
      .set('Content-Disposition', `attachment; filename="${filename}.pdf"`)
      .send(pdf);
  }),
);
router.get(
  '/:venueId/billing/invoices/:invoiceId/preview',
  handle(async (req, res) =>
    res.json({ document: await billing.document(req.params.venueId, id(req, 'invoiceId')) }),
  ),
);
router.post(
  '/:venueId/billing/invoices/:invoiceId/send',
  requireCsrf,
  handle(async (req, res) => {
    if (req.body.resend !== undefined && typeof req.body.resend !== 'boolean')
      fail('Resend must be on or off.');
    if (req.body.purpose && !['invoice', 'receipt'].includes(req.body.purpose))
      fail('Choose invoice or receipt. Reminders are managed by the run.');
    res.json(
      await billing.deliver(
        req.params.venueId,
        id(req, 'invoiceId'),
        {
          purpose: req.body.purpose || 'invoice',
          resend: req.body.resend === true,
          requestId: req.body.requestId,
        },
        actorFrom(req),
      ),
    );
  }),
);
module.exports = router;
module.exports.handleRoute = handle;
