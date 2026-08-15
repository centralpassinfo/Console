'use strict';

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { body, param } = require('express-validator');
const { pool } = require('../db');
const { encryptBuffer, decryptBuffer } = require('../crypto');
const { requireAuth, requireCsrf, actorFrom } = require('../auth');
const { validateRequest } = require('../validation');
const { recordAudit } = require('../audit');
const { CONTRACT_STATUSES, parseMoneyToCents, publicContract, summarizeContracts } = require('../contracts');
const { METADATA_COLUMNS, listVenueContracts } = require('../contract-store');

const router = express.Router();
const MAX_CONTRACT_BYTES = 10 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { files: 1, fileSize: MAX_CONTRACT_BYTES } });

router.use(requireAuth);

function receiveContract(req, res, next) {
  upload.single('contractFile')(req, res, (error) => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Contract PDFs must be 10 MB or smaller.' });
    return res.status(400).json({ error: 'The contract file could not be uploaded.' });
  });
}

async function findVenue(id) {
  const { rows: [venue] } = await pool.query('SELECT id, name FROM venues WHERE id = $1', [id]);
  return venue;
}

function optionalDate(field, label) {
  return body(field).optional({ values: 'falsy' }).isISO8601({ strict: true }).withMessage(`${label} must be a valid date.`);
}

function optionalMoney(field, label) {
  return body(field).optional({ values: 'falsy' }).custom((value) => {
    parseMoneyToCents(value, label);
    return true;
  });
}

const metadataFields = [
  body('title').isString().trim().isLength({ min: 2, max: 160 }).withMessage('Contract title must be between 2 and 160 characters.'),
  body('status').isIn(CONTRACT_STATUSES).withMessage('Choose a valid contract status.'),
  optionalDate('effectiveDate', 'Effective date'),
  optionalDate('expiryDate', 'Expiry date'),
  optionalDate('signedAt', 'Signed date'),
  optionalMoney('setupFee', 'Setup fee'),
  optionalMoney('monthlyFee', 'Monthly fee'),
  body('autoRenews').optional().custom((value) => [true, false, 'true', 'false'].includes(value)).withMessage('Auto-renew must be true or false.'),
  body('noticePeriodDays').optional({ values: 'falsy' }).isInt({ min: 0, max: 730 }).toInt().withMessage('Notice period must be between 0 and 730 days.'),
  body('notes').optional({ nullable: true }).isString().trim().isLength({ max: 4000 }).withMessage('Contract notes are too long.'),
  body().custom((value) => {
    if (value.effectiveDate && value.expiryDate && value.expiryDate < value.effectiveDate) {
      throw new Error('Expiry date cannot be before the effective date.');
    }
    return true;
  }),
];

function metadataValues(body) {
  return {
    title: body.title.trim(),
    status: body.status,
    effectiveDate: body.effectiveDate || null,
    expiryDate: body.expiryDate || null,
    signedAt: body.signedAt || null,
    setupFeeCents: parseMoneyToCents(body.setupFee, 'Setup fee'),
    monthlyFeeCents: parseMoneyToCents(body.monthlyFee, 'Monthly fee'),
    autoRenews: body.autoRenews === true || body.autoRenews === 'true',
    noticePeriodDays: body.noticePeriodDays === '' || body.noticePeriodDays == null ? null : Number(body.noticePeriodDays),
    notes: body.notes?.trim() || null,
  };
}

function safeFileName(value) {
  const cleaned = path.basename(String(value || 'contract.pdf'))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 176) || 'contract';
  return cleaned.toLowerCase().endsWith('.pdf') ? cleaned : `${cleaned}.pdf`;
}

function isPdf(file) {
  return file?.buffer?.subarray(0, 5).toString('ascii') === '%PDF-';
}

router.get(
  '/:venueId/contracts',
  [param('venueId').isInt({ min: 1 }).toInt()],
  validateRequest,
  async (req, res, next) => {
    let client = null;
    try {
      const venue = await findVenue(req.params.venueId);
      if (!venue) return res.status(404).json({ error: 'Venue not found.' });
      const contracts = await listVenueContracts(venue.id);
      return res.json({ contracts, summary: summarizeContracts(contracts) });
    } catch (error) { return next(error); }
  }
);

router.post(
  '/:venueId/contracts',
  requireCsrf,
  receiveContract,
  [
    param('venueId').isInt({ min: 1 }).toInt(),
    ...metadataFields,
    body().custom((value, { req }) => {
      if (!req.file) throw new Error('Choose a signed or draft contract PDF.');
      if (!isPdf(req.file)) throw new Error('Only valid PDF contract files are accepted.');
      return true;
    }),
  ],
  validateRequest,
  async (req, res, next) => {
    try {
      const venue = await findVenue(req.params.venueId);
      if (!venue) return res.status(404).json({ error: 'Venue not found.' });
      const values = metadataValues(req.body);
      const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
      const actor = actorFrom(req);
      client = await pool.connect();
      await client.query('BEGIN');
      const { rows: [contract] } = await client.query(
        `INSERT INTO venue_contracts
          (venue_id, title, status, effective_date, expiry_date, signed_at,
           setup_fee_cents, monthly_fee_cents, auto_renews, notice_period_days, notes,
           original_filename, media_type, file_size_bytes, encrypted_file, file_sha256, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'application/pdf',$13,$14,$15,$16)
         RETURNING ${METADATA_COLUMNS}`,
        [
          venue.id, values.title, values.status, values.effectiveDate, values.expiryDate, values.signedAt,
          values.setupFeeCents, values.monthlyFeeCents, values.autoRenews, values.noticePeriodDays, values.notes,
          safeFileName(req.file.originalname), req.file.size, encryptBuffer(req.file.buffer), hash, actor,
        ]
      );
      await recordAudit({
        venueId: venue.id,
        actor,
        action: 'contract.uploaded',
        detail: { contractId: contract.id, title: contract.title, status: contract.status, fileName: contract.original_filename, fileSizeBytes: contract.file_size_bytes },
      }, client);
      await client.query('COMMIT');
      return res.status(201).json({ contract: publicContract(contract) });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally { client?.release(); }
  }
);

router.put(
  '/:venueId/contracts/:contractId',
  requireCsrf,
  [
    param('venueId').isInt({ min: 1 }).toInt(),
    param('contractId').isInt({ min: 1 }).toInt(),
    ...metadataFields,
  ],
  validateRequest,
  async (req, res, next) => {
    let client = null;
    try {
      const values = metadataValues(req.body);
      client = await pool.connect();
      await client.query('BEGIN');
      const { rows: [contract] } = await client.query(
        `UPDATE venue_contracts SET
           title = $3, status = $4, effective_date = $5, expiry_date = $6, signed_at = $7,
           setup_fee_cents = $8, monthly_fee_cents = $9, auto_renews = $10,
           notice_period_days = $11, notes = $12, updated_at = NOW()
         WHERE id = $1 AND venue_id = $2
         RETURNING ${METADATA_COLUMNS}`,
        [
          req.params.contractId, req.params.venueId, values.title, values.status, values.effectiveDate,
          values.expiryDate, values.signedAt, values.setupFeeCents, values.monthlyFeeCents,
          values.autoRenews, values.noticePeriodDays, values.notes,
        ]
      );
      if (!contract) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Contract not found.' });
      }
      await recordAudit({
        venueId: Number(req.params.venueId),
        actor: actorFrom(req),
        action: 'contract.updated',
        detail: { contractId: contract.id, title: contract.title, status: contract.status, expiryDate: contract.expiry_date },
      }, client);
      await client.query('COMMIT');
      return res.json({ contract: publicContract(contract) });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally { client?.release(); }
  }
);

router.get(
  '/:venueId/contracts/:contractId/download',
  [
    param('venueId').isInt({ min: 1 }).toInt(),
    param('contractId').isInt({ min: 1 }).toInt(),
  ],
  validateRequest,
  async (req, res, next) => {
    try {
      const { rows: [contract] } = await pool.query(
        `SELECT id, venue_id, title, original_filename, file_size_bytes, encrypted_file
           FROM venue_contracts
          WHERE id = $1 AND venue_id = $2`,
        [req.params.contractId, req.params.venueId]
      );
      if (!contract) return res.status(404).json({ error: 'Contract not found.' });
      const file = decryptBuffer(contract.encrypted_file);
      await recordAudit({
        venueId: contract.venue_id,
        actor: actorFrom(req),
        action: 'contract.downloaded',
        detail: { contractId: contract.id, title: contract.title, fileName: contract.original_filename },
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', file.length);
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(contract.original_filename)}`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.send(file);
    } catch (error) { return next(error); }
  }
);

module.exports = router;
