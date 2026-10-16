'use strict';
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { cleanRelease } = require('../releases');
const { recordAudit } = require('../audit');
const { queueAutomaticReleases } = require('../automatic-releases');
const router = express.Router();
function requirePublisher(req, res, next) {
  const expected = process.env.RELEASE_PUBLISH_TOKEN;
  if (!expected || expected.length < 32)
    return res
      .status(503)
      .json({ error: 'Release publishing is not configured.' });
  const presented = req.get('Authorization') || '';
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(`Bearer ${expected}`).digest();
  if (!crypto.timingSafeEqual(a, b))
    return res.status(401).json({ error: 'Invalid release publisher token.' });
  next();
}
router.post(
  '/',
  rateLimit({
    windowMs: 60000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
  }),
  requirePublisher,
  async (req, res, next) => {
    let db;
    try {
      const release = cleanRelease(req.body);
      db = await pool.connect();
      await db.query('BEGIN');
      const {
        rows: [created],
      } = await db.query(
        `INSERT INTO console_releases(version,commit_sha,notes,tablet_bundle,created_by)
      VALUES($1,$2,$3,$4,'Platform CI') ON CONFLICT(version) DO NOTHING RETURNING *`,
        [
          release.version,
          release.commitSha,
          release.notes,
          release.tabletBundle,
        ],
      );
      const saved =
        created ||
        (
          await db.query('SELECT * FROM console_releases WHERE version=$1', [
            release.version,
          ])
        ).rows[0];
      if (
        saved.commit_sha !== release.commitSha ||
        !isDeepStrictEqual(saved.tablet_bundle, release.tabletBundle)
      )
        throw Object.assign(
          new Error(
            'That release version already points to different source or tablet bytes.',
          ),
          { status: 409 },
        );
      if (created)
        await recordAudit(
          {
            actor: 'Platform CI',
            action: 'release.published',
            detail: {
              releaseId: saved.id,
              version: saved.version,
              commit: saved.commit_sha,
            },
          },
          db,
        );
      await db.query('COMMIT');
      db.release();
      db = null;
      const queued = await queueAutomaticReleases(pool);
      res.status(created ? 201 : 200).json({
        releaseId: saved.id,
        version: saved.version,
        automaticallyQueued: queued.length,
      });
    } catch (e) {
      if (db) await db.query('ROLLBACK');
      if (e.status) return res.status(e.status).json({ error: e.message });
      next(e);
    } finally {
      db?.release();
    }
  },
);
module.exports = { router, requirePublisher };
