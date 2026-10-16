'use strict';

const express = require('express');
const { body, param } = require('express-validator');
const { pool } = require('../db');
const { decryptSecret } = require('../crypto');
const { validateRequest } = require('../validation');
const { requireAuth, requireCsrf, actorFrom } = require('../auth');
const { recordAudit } = require('../audit');
const { VenueApiError, venueRequest } = require('../venue-client');

// Tablet app updates, approved one venue at a time without redeploying it.
// The venue only serves a bundle Console approved against the backend release
// it is running, so a tablet cannot drift ahead of its backend.
const router = express.Router();
router.use(requireAuth);

async function findVenue(id) {
  const { rows: [venue] } = await pool.query('SELECT * FROM venues WHERE id = $1', [id]);
  return venue;
}

async function listBundles(venue) {
  const { data } = await venueRequest({
    apiUrl: venue.api_url,
    platformApiKey: decryptSecret(venue.platform_api_key),
    path: '/api/platform/releases/tablet',
  });
  return { release: data?.release || null, bundles: Array.isArray(data?.bundles) ? data.bundles : [] };
}

function publicBundle(row) {
  return {
    id: row.id,
    appId: row.app_id,
    channel: row.channel,
    version: row.version,
    checksum: row.checksum,
    sizeBytes: row.size_bytes,
    minVersionCode: row.min_version_code,
    notes: row.notes,
    uploadedAt: row.created_at,
    live: Boolean(row.live),
    approvedAt: row.approved_at,
  };
}

function venueError(error, res, next) {
  if (error instanceof VenueApiError) {
    return res.status(error.status && error.status < 500 ? 400 : 502).json({ error: error.message, code: error.code || null });
  }
  return next(error);
}

router.get(
  '/:venueId/tablet',
  [param('venueId').isInt({ min: 1 }).toInt()],
  validateRequest,
  async (req, res, next) => {
    try {
      const venue = await findVenue(req.params.venueId);
      if (!venue) return res.status(404).json({ error: 'Venue not found.' });
      try {
        const { release, bundles } = await listBundles(venue);
        return res.json({ available: true, release, bundles: bundles.map(publicBundle) });
      } catch (error) {
        // A venue on a Platform release from before this list existed answers 404.
        if (error instanceof VenueApiError && error.status === 404) {
          return res.json({ available: false, reason: 'This venue runs an older Platform release. Deploy a current release to manage its tablet app here.' });
        }
        throw error;
      }
    } catch (error) { return venueError(error, res, next); }
  }
);

router.post(
  '/:venueId/tablet/approve',
  requireCsrf,
  [
    param('venueId').isInt({ min: 1 }).toInt(),
    body('bundleId').isInt({ min: 1 }).toInt().withMessage('Choose an uploaded bundle.'),
    body('checksum').matches(/^[a-f0-9]{64}$/).withMessage('The bundle checksum is missing.'),
  ],
  validateRequest,
  async (req, res, next) => {
    try {
      const venue = await findVenue(req.params.venueId);
      if (!venue) return res.status(404).json({ error: 'Venue not found.' });
      if (venue.status !== 'active') return res.status(409).json({ error: `${venue.name} is ${venue.status}. Reactivate it before approving a tablet update.` });
      const { rows: [busy] } = await pool.query(
        "SELECT id FROM venue_release_rollouts WHERE venue_id = $1 AND status IN ('queued','deploying','verifying','interrupted')",
        [venue.id]
      );
      if (busy) return res.status(409).json({ error: 'This venue has a platform update queued or running. Approve the tablet update after it finishes.' });

      // Re-read the venue's own list: approve exactly the bytes shown, against
      // the backend release running right now.
      const { release, bundles } = await listBundles(venue);
      const bundle = bundles.find((row) => row.id === req.body.bundleId && row.checksum === req.body.checksum);
      const current = bundles.find((row) => row.live && row.app_id === bundle?.app_id && row.channel === bundle?.channel);
      if (!bundle) return res.status(409).json({ error: 'That bundle is no longer uploaded at this venue. Refresh and try again.' });
      if (!release?.commit) {
        return res.status(409).json({ error: 'This venue is not running a release deployed by Console yet. Deploy a release first, then approve the tablet update.' });
      }
      const { data } = await venueRequest({
        apiUrl: venue.api_url,
        platformApiKey: decryptSecret(venue.platform_api_key),
        path: '/api/platform/releases/tablet',
        method: 'PUT',
        body: {
          releaseCommit: release.commit,
          bundle: { appId: bundle.app_id, channel: bundle.channel, version: bundle.version, checksum: bundle.checksum },
        },
      });
      await recordAudit({
        venueId: venue.id,
        actor: actorFrom(req),
        action: 'tablet.approved',
        detail: {
          appId: bundle.app_id,
          channel: bundle.channel,
          version: bundle.version,
          checksum: bundle.checksum,
          releaseCommit: release.commit,
          rollback: Boolean(current && new Date(bundle.created_at) < new Date(current.created_at)),
        },
      });
      return res.json({ approved: true, version: data?.version || bundle.version });
    } catch (error) { return venueError(error, res, next); }
  }
);

module.exports = router;
