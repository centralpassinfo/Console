'use strict';

const express = require('express');
const { body, param, query } = require('express-validator');
const { pool } = require('../db');
const { encryptSecret, decryptSecret } = require('../crypto');
const { validateRequest, isHttpUrl } = require('../validation');
const { requireAuth, requireCsrf, actorFrom } = require('../auth');
const { recordAudit, completeAudit } = require('../audit');
const { summarizeContracts } = require('../contracts');
const { listVenueContracts, contractSummaries } = require('../contract-store');
const {
  VenueApiError,
  venueRequest,
  snapshotVenue,
  getVenueDetail,
  updateVenueFeatures,
  baseUrl,
} = require('../venue-client');

const router = express.Router();
const VENUE_STATUSES = ['active', 'suspended', 'offboarded'];

router.use(requireAuth);

function publicVenue(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    apiUrl: row.api_url,
    siteUrl: row.site_url,
    adminUrl: row.admin_url,
    staffUrl: row.staff_url,
    registryStatus: row.status,
    billingNotes: row.billing_notes,
    platformKeySet: Boolean(row.platform_api_key),
    keyRotatedAt: row.key_rotated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function findVenue(id) {
  const { rows: [venue] } = await pool.query(`SELECT * FROM venues WHERE id = $1`, [id]);
  return venue;
}

function urlField(field, required = false) {
  let validator = body(field).trim();
  if (!required) validator = validator.optional({ values: 'falsy' });
  return validator.custom(isHttpUrl).withMessage('Enter a complete http:// or https:// URL.');
}

const venueFields = [
  body('name').isString().trim().isLength({ min: 2, max: 120 }).withMessage('Name must be between 2 and 120 characters.'),
  body('slug').isString().trim().matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).isLength({ min: 2, max: 80 }).withMessage('Use lowercase letters, numbers and hyphens.'),
  urlField('apiUrl', true),
  urlField('siteUrl'),
  urlField('adminUrl'),
  urlField('staffUrl'),
  body('registryStatus').optional().isIn(VENUE_STATUSES).withMessage('Choose a valid venue status.'),
  body('billingNotes').optional({ nullable: true }).isString().trim().isLength({ max: 3000 }).withMessage('Billing notes are too long.'),
];

router.get(
  '/',
  [query('live').optional().isBoolean().withMessage('live must be true or false.')],
  validateRequest,
  async (req, res, next) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM venues ORDER BY name ASC`);
      const summaries = await contractSummaries(rows.map((venue) => venue.id));
      const shouldFetchLive = req.query.live !== 'false';
      const venues = await Promise.all(rows.map(async (venue) => {
        const safe = { ...publicVenue(venue), contractSummary: summaries.get(venue.id) || summarizeContracts([]) };
        if (!shouldFetchLive) return safe;
        try {
          const live = await snapshotVenue(venue, decryptSecret(venue.platform_api_key));
          return { ...safe, live };
        } catch (error) {
          return {
            ...safe,
            live: {
              state: 'unreachable',
              checkedAt: new Date().toISOString(),
              platform: null,
              error: error.message || 'Could not check this venue.',
            },
          };
        }
      }));
      return res.json({ venues, checkedAt: new Date().toISOString() });
    } catch (error) { return next(error); }
  }
);

router.get(
  '/:id',
  [param('id').isInt({ min: 1 }).toInt()],
  validateRequest,
  async (req, res, next) => {
    try {
      const venue = await findVenue(req.params.id);
      if (!venue) return res.status(404).json({ error: 'Venue not found.' });
      const contracts = await listVenueContracts(venue.id);
      let live = null;
      try {
        live = await getVenueDetail(venue, decryptSecret(venue.platform_api_key));
      } catch (error) {
        live = { error: error.message || 'Could not reach the venue.', errorCode: error.code || null };
      }
      return res.json({ venue: { ...publicVenue(venue), contractSummary: summarizeContracts(contracts) }, contracts, live });
    } catch (error) { return next(error); }
  }
);

router.post(
  '/',
  requireCsrf,
  [...venueFields, body('platformApiKey').isString().isLength({ min: 32, max: 512 }).withMessage('Platform key must be at least 32 characters.')],
  validateRequest,
  async (req, res, next) => {
    try {
      const actor = actorFrom(req);
      const { rows: [venue] } = await pool.query(
        `INSERT INTO venues
          (name, slug, api_url, site_url, admin_url, staff_url, platform_api_key, status, billing_notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [
          req.body.name,
          req.body.slug,
          baseUrl(req.body.apiUrl),
          req.body.siteUrl ? baseUrl(req.body.siteUrl) : null,
          req.body.adminUrl ? baseUrl(req.body.adminUrl) : null,
          req.body.staffUrl ? baseUrl(req.body.staffUrl) : null,
          encryptSecret(req.body.platformApiKey),
          req.body.registryStatus || 'active',
          req.body.billingNotes || null,
        ]
      );
      await recordAudit({ venueId: venue.id, actor, action: 'venue.created', detail: { name: venue.name, slug: venue.slug, apiUrl: venue.api_url } });
      return res.status(201).json({ venue: publicVenue(venue) });
    } catch (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'That venue slug is already in use.' });
      return next(error);
    }
  }
);

router.put(
  '/:id',
  requireCsrf,
  [
    param('id').isInt({ min: 1 }).toInt(),
    ...venueFields,
    body('platformApiKey').optional({ values: 'falsy' }).isString().isLength({ min: 32, max: 512 }).withMessage('Replacement key must be at least 32 characters.'),
  ],
  validateRequest,
  async (req, res, next) => {
    try {
      const existing = await findVenue(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Venue not found.' });
      const replacingKey = Boolean(req.body.platformApiKey);
      const { rows: [venue] } = await pool.query(
        `UPDATE venues SET
          name = $2, slug = $3, api_url = $4, site_url = $5, admin_url = $6,
          staff_url = $7, status = $8, billing_notes = $9,
          platform_api_key = CASE WHEN $10::text IS NULL THEN platform_api_key ELSE $10 END,
          key_rotated_at = CASE WHEN $10::text IS NULL THEN key_rotated_at ELSE NOW() END,
          updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          req.params.id,
          req.body.name,
          req.body.slug,
          baseUrl(req.body.apiUrl),
          req.body.siteUrl ? baseUrl(req.body.siteUrl) : null,
          req.body.adminUrl ? baseUrl(req.body.adminUrl) : null,
          req.body.staffUrl ? baseUrl(req.body.staffUrl) : null,
          req.body.registryStatus || 'active',
          req.body.billingNotes || null,
          replacingKey ? encryptSecret(req.body.platformApiKey) : null,
        ]
      );
      await recordAudit({
        venueId: venue.id,
        actor: actorFrom(req),
        action: 'venue.updated',
        detail: { name: venue.name, registryStatus: venue.status, platformKeyReplaced: replacingKey },
      });
      return res.json({ venue: publicVenue(venue) });
    } catch (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'That venue slug is already in use.' });
      return next(error);
    }
  }
);

router.post(
  '/test-connection',
  requireCsrf,
  [
    body('id').optional().isInt({ min: 1 }).toInt(),
    body('apiUrl').optional().custom(isHttpUrl).withMessage('Enter a complete API URL.'),
    body('platformApiKey').optional().isString().isLength({ min: 32, max: 512 }).withMessage('Platform key must be at least 32 characters.'),
    body().custom((value) => {
      if (value.id || (value.apiUrl && value.platformApiKey)) return true;
      throw new Error('Choose a saved venue or supply both the API URL and platform key.');
    }),
  ],
  validateRequest,
  async (req, res, next) => {
    try {
      let apiUrl = req.body.apiUrl;
      let platformApiKey = req.body.platformApiKey;
      if (req.body.id) {
        const venue = await findVenue(req.body.id);
        if (!venue) return res.status(404).json({ error: 'Venue not found.' });
        apiUrl = apiUrl || venue.api_url;
        platformApiKey = platformApiKey || decryptSecret(venue.platform_api_key);
      }
      const result = await venueRequest({ apiUrl, platformApiKey, path: '/api/platform/status' });
      return res.json({ ok: true, latencyMs: result.latencyMs, venue: result.data.venue, plan: result.data.plan });
    } catch (error) {
      if (error instanceof VenueApiError) {
        return res.status(error.status && error.status < 500 ? 400 : 502).json({ error: error.message, code: error.code || null });
      }
      return next(error);
    }
  }
);

router.put(
  '/:id/features',
  requireCsrf,
  [
    param('id').isInt({ min: 1 }).toInt(),
    body('overrides').isObject().custom((overrides) => {
      const entries = Object.entries(overrides);
      const allowed = ['order_emails', 'order_sms', 'customers', 'discounts', 'analytics', 'offers', 'campaigns', 'bookings', 'timeclock'];
      if (!entries.length) throw new Error('Supply at least one feature override.');
      for (const [key, value] of entries) {
        if (!allowed.includes(key)) throw new Error(`${key} is not a billable feature.`);
        if (value !== null && typeof value !== 'boolean') throw new Error(`${key} must be true, false or null.`);
      }
      return true;
    }),
  ],
  validateRequest,
  async (req, res, next) => {
    let auditId = null;
    try {
      const venue = await findVenue(req.params.id);
      if (!venue) return res.status(404).json({ error: 'Venue not found.' });
      const actor = actorFrom(req);
      auditId = await recordAudit({
        venueId: venue.id,
        actor,
        action: 'venue.features.update',
        detail: { overrides: req.body.overrides, outcome: 'requested' },
      });
      const features = await updateVenueFeatures(venue, decryptSecret(venue.platform_api_key), req.body.overrides, actor);
      await completeAudit(auditId, { outcome: 'succeeded', plan: features.plan });
      return res.json({ features });
    } catch (error) {
      if (auditId) await completeAudit(auditId, { outcome: 'failed', error: error.message }).catch(() => {});
      if (error instanceof VenueApiError) {
        return res.status(error.status && error.status < 500 ? 400 : 502).json({ error: error.message, code: error.code || null });
      }
      return next(error);
    }
  }
);

module.exports = router;
