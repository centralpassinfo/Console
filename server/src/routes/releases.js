'use strict';
const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireCsrf, actorFrom } = require('../auth');
const { encryptSecret, decryptSecret } = require('../crypto');
const { discoverRailway, configureRailway } = require('../railway-discovery');
const {
  publicSource,
  connectSource,
  syncSource,
} = require('../release-source');
const { recordAudit } = require('../audit');
const {
  latestTestedRelease,
  queueAutomaticForVenue,
  queueAutomaticReleases,
} = require('../automatic-releases');
const {
  cleanRelease,
  cleanTarget,
  cleanApproval,
  assertEligible,
} = require('../releases');
const router = express.Router();
router.use(requireAuth);
function handle(error, res, next) {
  if (
    error.code === '23505' &&
    error.constraint ===
      'venue_deployment_targets_project_id_environment_id_key'
  ) {
    return res.status(409).json({
      error:
        'That Railway project and environment are already assigned to another venue.',
    });
  }
  if (error.status)
    return res
      .status(error.status)
      .json({
        error: error.message,
        ...(error.operation ? { operation: error.operation } : {}),
        ...(error.code ? { code: error.code } : {}),
      });
  if (error.code === '23505')
    return res.status(409).json({
      error:
        'That release version already exists, or a selected venue already has an update running. Refresh and try again.',
    });
  next(error);
}
// Never return encrypted credentials or job snapshots to the browser.
router.get('/', async (req, res, next) => {
  try {
    const [
      { rows: releases },
      { rows: venues },
      { rows: rollouts },
      {
        rows: [worker],
      },
    ] = await Promise.all([
      pool.query('SELECT * FROM console_releases ORDER BY id DESC LIMIT 200'),
      pool.query(`SELECT v.id,v.name,v.slug,v.status,v.admin_url,v.staff_url,v.automatic_updates,
        t.project_id,t.environment_id,t.services,t.employee_url,t.auto_deploy_disabled,
        t.venue_id IS NOT NULL AS configured,
        (SELECT r.version FROM venue_release_rollouts x JOIN console_releases r ON r.id=x.release_id
          WHERE x.venue_id=v.id AND x.status='succeeded' ORDER BY x.finished_at DESC LIMIT 1) AS last_verified_version,
        (SELECT json_build_object('version',r.version,'commit_sha',r.commit_sha,'source_run_number',r.source_run_number,'finished_at',x.finished_at)
          FROM venue_release_rollouts x JOIN console_releases r ON r.id=x.release_id
          WHERE x.venue_id=v.id AND x.status='succeeded' ORDER BY x.finished_at DESC LIMIT 1) AS last_verified
        FROM venues v LEFT JOIN venue_deployment_targets t ON t.venue_id=v.id ORDER BY v.name`),
      pool.query(`SELECT x.id,x.venue_id,x.release_id,x.status,x.approval_mode,x.approved_by,x.approved_at,x.scheduled_at,
        x.started_at,x.finished_at,x.heartbeat_at,x.progress,x.error,v.name AS venue_name,r.version,r.commit_sha,r.source_run_number
        FROM venue_release_rollouts x JOIN venues v ON v.id=x.venue_id JOIN console_releases r ON r.id=x.release_id
        WHERE x.status IN ('queued','deploying','verifying','interrupted') OR x.id IN
          (SELECT id FROM venue_release_rollouts ORDER BY id DESC LIMIT 200) ORDER BY x.id DESC`),
      pool.query(
        'SELECT MAX(heartbeat_at) AS last_seen FROM console_release_workers',
      ),
    ]);
    res.json({
      releases,
      venues,
      rollouts,
      worker: { lastSeen: worker?.last_seen || null },
      source: await publicSource(),
    });
  } catch (e) {
    next(e);
  }
});
router.post('/source', requireCsrf, async (req, res, next) => {
  try {
    await connectSource(req.body.githubToken, actorFrom(req));
    const result = await syncSource();
    await queueAutomaticReleases(pool);
    res.json({ ...result, source: await publicSource() });
  } catch (error) {
    handle(error, res, next);
  }
});
router.post('/sync', requireCsrf, async (req, res, next) => {
  try {
    const result = await syncSource();
    await queueAutomaticReleases(pool);
    res.json({ ...result, source: await publicSource() });
  } catch (error) {
    handle(error, res, next);
  }
});
async function discoveryToken(venueId, body, db = pool) {
  const {
    rows: [venue],
  } = await db.query('SELECT * FROM venues WHERE id=$1', [venueId]);
  if (!venue)
    throw Object.assign(new Error('Venue not found.'), { status: 404 });
  const {
    rows: [existing],
  } = await db.query(
    'SELECT * FROM venue_deployment_targets WHERE venue_id=$1',
    [venueId],
  );
  const token =
    body.railwayToken ||
    (existing ? decryptSecret(existing.railway_token) : null);
  return { venue, token, existing };
}
router.post(
  '/targets/:venueId/discover',
  requireCsrf,
  async (req, res, next) => {
    try {
      if (!/^\d+$/.test(req.params.venueId))
        return res.status(400).json({ error: 'Invalid venue.' });
      const { venue, token } = await discoveryToken(
        req.params.venueId,
        req.body,
      );
      const discovered = await discoverRailway(token, venue);
      await recordAudit({
        venueId: venue.id,
        actor: actorFrom(req),
        action: 'release.target.discovered',
        detail: {
          projectId: discovered.projectId,
          environmentId: discovered.environmentId,
        },
      });
      res.json({ discovered });
    } catch (error) {
      handle(error, res, next);
    }
  },
);
router.post(
  '/targets/:venueId/connect',
  requireCsrf,
  async (req, res, next) => {
    let db,
      settingsStarted = false;
    try {
      if (!/^\d+$/.test(req.params.venueId) || req.body.manageUpdates !== true)
        return res.status(400).json({
          error:
            'Confirm that Console should manage these production services.',
        });
      db = await pool.connect();
      await db.query('BEGIN');
      await db.query('SELECT id FROM venues WHERE id=$1 FOR UPDATE', [
        req.params.venueId,
      ]);
      const { venue, token, existing } = await discoveryToken(
        req.params.venueId,
        req.body,
        db,
      );
      const {
        rows: [busy],
      } = await db.query(
        "SELECT id FROM venue_release_rollouts WHERE venue_id=$1 AND status IN ('queued','deploying','verifying','interrupted')",
        [venue.id],
      );
      if (busy)
        throw Object.assign(
          new Error(
            'Wait for or cancel the current update before reconnecting this venue.',
          ),
          { status: 409 },
        );
      const discovered = await discoverRailway(token, venue);
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `railway-target:${discovered.projectId}:${discovered.environmentId}`,
      ]);
      const {
        rows: [assigned],
      } = await db.query(
        'SELECT venue_id FROM venue_deployment_targets WHERE project_id=$1 AND environment_id=$2 AND venue_id<>$3',
        [discovered.projectId, discovered.environmentId, venue.id],
      );
      if (assigned)
        throw Object.assign(
          new Error(
            'That Railway project and environment are already assigned to another venue.',
          ),
          { status: 409 },
        );
      // Rediscover on save: never trust browser-supplied project/environment IDs.
      const services = Object.fromEntries(
        Object.entries(req.body.services || {}).filter(([, id]) => Boolean(id)),
      );
      const target = cleanTarget({
        projectId: discovered.projectId,
        environmentId: discovered.environmentId,
        services,
        autoDeployDisabled: true,
      });
      for (const id of Object.values(services))
        if (!discovered.services.some((service) => service.id === id))
          throw Object.assign(
            new Error(
              'A selected service is no longer available in this environment.',
            ),
            { status: 400 },
          );
      const urlFor = (role) =>
        discovered.services.find((service) => service.id === services[role])
          ?.urls[0] || null;
      const urls = {
        api_url: venue.api_url || urlFor('backend'),
        admin_url: venue.admin_url || urlFor('admin'),
        staff_url: venue.staff_url || urlFor('staff'),
      };
      const employeeUrl = services.employee
        ? req.body.employeeUrl || existing?.employee_url || urlFor('employee')
        : null;
      if (
        !urls.api_url ||
        !urls.admin_url ||
        (services.staff && !urls.staff_url) ||
        (services.employee && !employeeUrl)
      )
        throw Object.assign(
          new Error(
            'Add a public domain to each selected portal in Railway so Console can verify deployments.',
          ),
          { status: 400 },
        );
      if (employeeUrl) {
        try {
          const url = new URL(employeeUrl);
          if (url.protocol !== 'https:' || url.username || url.password)
            throw new Error();
        } catch {
          throw Object.assign(
            new Error('Enter a valid HTTPS employee portal URL.'),
            { status: 400 },
          );
        }
      }
      // A failure rolls back the saved connection; repeat safely if Railway only
      // applied some of the settings. Every external mutation stays scoped here.
      // The workspace token can manage every project in the workspace, so it
      // is used for this request only and never stored.
      const setupToken = req.body.setupToken || null;
      if (!setupToken)
        throw Object.assign(
          new Error(
            'Paste a Railway workspace token so Console can change service settings. It is used for this connection only and not stored; this venue’s project token is still used for deployment.',
          ),
          { status: 400, code: 'RAILWAY_SETUP_REQUIRED' },
        );
      if (
        typeof setupToken !== 'string' ||
        setupToken.length < 20 ||
        setupToken.length > 512 ||
        /\s/.test(setupToken)
      )
        throw Object.assign(
          new Error('Enter a valid Railway workspace token for setup.'),
          { status: 400 },
        );
      settingsStarted = true;
      await configureRailway(setupToken, discovered, services);
      await db.query(
        `INSERT INTO venue_deployment_targets(venue_id,project_id,environment_id,services,railway_token,auto_deploy_disabled,employee_url)
      VALUES($1,$2,$3,$4,$5,true,$6) ON CONFLICT(venue_id) DO UPDATE SET project_id=$2,environment_id=$3,services=$4,railway_token=$5,
      auto_deploy_disabled=true,employee_url=$6,updated_at=NOW()`,
        [
          venue.id,
          target.projectId,
          target.environmentId,
          target.services,
          encryptSecret(token),
          employeeUrl,
        ],
      );
      await db.query(
        'UPDATE venues SET api_url=$2,admin_url=$3,staff_url=$4,updated_at=NOW() WHERE id=$1',
        [venue.id, urls.api_url, urls.admin_url, urls.staff_url],
      );
      await recordAudit(
        {
          venueId: venue.id,
          actor: actorFrom(req),
          action: 'release.target.connected',
          detail: {
            projectId: target.projectId,
            environmentId: target.environmentId,
            services: target.services,
            railwaySettingsVerified: true,
          },
        },
        db,
      );
      await db.query('COMMIT');
      res.json({
        ok: true,
        projectName: discovered.projectName,
        environmentName: discovered.environmentName,
      });
    } catch (error) {
      if (db) await db.query('ROLLBACK');
      if (settingsStarted) {
        console.warn('Railway connection settings failed', {
          venueId: Number(req.params.venueId),
          code: error.code || 'SETUP_FAILED',
          operation: error.operation || 'VerifySettings',
        });
        await recordAudit({
          venueId: Number(req.params.venueId),
          actor: actorFrom(req),
          action: 'release.target.connection_failed',
          detail: {
            code: error.code || 'SETUP_FAILED',
            operation: error.operation || 'VerifySettings',
            settingsMayHaveChanged: error.operation !== 'SetupAccess',
          },
        }).catch(() => {});
        if (error.operation !== 'SetupAccess')
          error.message +=
            ' Some Railway settings may already be applied; reconnect to verify and finish setup.';
      }
      handle(error, res, next);
    } finally {
      db?.release();
    }
  },
);
router.post('/', requireCsrf, async (req, res, next) => {
  let db;
  try {
    const r = cleanRelease(req.body);
    db = await pool.connect();
    await db.query('BEGIN');
    const {
      rows: [release],
    } = await db.query(
      `INSERT INTO console_releases
      (version,commit_sha,notes,tablet_bundle,created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [r.version, r.commitSha, r.notes, r.tabletBundle, actorFrom(req)],
    );
    await recordAudit(
      {
        actor: actorFrom(req),
        action: 'release.created',
        detail: {
          releaseId: release.id,
          version: r.version,
          commit: r.commitSha,
        },
      },
      db,
    );
    await db.query('COMMIT');
    db.release();
    db = null;
    const automaticallyQueued = await queueAutomaticReleases(pool);
    res
      .status(201)
      .json({ release, automaticallyQueued: automaticallyQueued.length });
  } catch (e) {
    if (db) await db.query('ROLLBACK');
    handle(e, res, next);
  } finally {
    db?.release();
  }
});
router.put('/targets/:venueId', requireCsrf, async (req, res, next) => {
  let db;
  try {
    const target = cleanTarget(req.body);
    const employeeUrl = req.body.employeeUrl || null;
    if (employeeUrl && !/^https:\/\/[^\s]+$/.test(employeeUrl))
      throw Object.assign(new Error('Employee URL must use HTTPS.'), {
        status: 400,
      });
    if (target.services.employee && !employeeUrl)
      throw Object.assign(new Error('Enter the employee portal URL.'), {
        status: 400,
      });
    if (!/^\d+$/.test(req.params.venueId))
      return res.status(400).json({ error: 'Invalid venue.' });
    db = await pool.connect();
    await db.query('BEGIN');
    const {
      rows: [venue],
    } = await db.query('SELECT id FROM venues WHERE id=$1 FOR UPDATE', [
      req.params.venueId,
    ]);
    if (!venue)
      throw Object.assign(new Error('Venue not found.'), { status: 404 });
    const {
      rows: [busy],
    } = await db.query(
      "SELECT id FROM venue_release_rollouts WHERE venue_id=$1 AND status IN ('queued','deploying','verifying','interrupted')",
      [venue.id],
    );
    if (busy)
      throw Object.assign(
        new Error(
          'Wait for or cancel the current update before changing deployment setup.',
        ),
        { status: 409 },
      );
    const {
      rows: [existing],
    } = await db.query(
      'SELECT railway_token FROM venue_deployment_targets WHERE venue_id=$1',
      [venue.id],
    );
    const token = req.body.railwayToken
      ? encryptSecret(req.body.railwayToken)
      : existing?.railway_token;
    if (!token)
      throw Object.assign(new Error('A Railway project token is required.'), {
        status: 400,
      });
    await db.query(
      `INSERT INTO venue_deployment_targets
      (venue_id,project_id,environment_id,services,railway_token,auto_deploy_disabled,employee_url)
      VALUES ($1,$2,$3,$4,$5,true,$6) ON CONFLICT (venue_id) DO UPDATE SET project_id=$2,
      environment_id=$3,services=$4,railway_token=$5,auto_deploy_disabled=true,employee_url=$6,updated_at=NOW()`,
      [
        venue.id,
        target.projectId,
        target.environmentId,
        target.services,
        token,
        employeeUrl,
      ],
    );
    await recordAudit(
      {
        venueId: venue.id,
        actor: actorFrom(req),
        action: 'release.target.updated',
        detail: { ...target, tokenReplaced: Boolean(req.body.railwayToken) },
      },
      db,
    );
    await db.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    if (db) await db.query('ROLLBACK');
    handle(e, res, next);
  } finally {
    db?.release();
  }
});
router.put('/venues/:id/automatic', requireCsrf, async (req, res, next) => {
  let db;
  try {
    if (!/^\d+$/.test(req.params.id) || typeof req.body.enabled !== 'boolean')
      return res
        .status(400)
        .json({ error: 'Choose a venue and a boolean update policy.' });
    db = await pool.connect();
    await db.query('BEGIN');
    const {
      rows: [venue],
    } = await db.query('SELECT * FROM venues WHERE id=$1 FOR UPDATE', [
      req.params.id,
    ]);
    if (!venue)
      throw Object.assign(new Error('Venue not found.'), { status: 404 });
    if (req.body.enabled) {
      const {
        rows: [target],
      } = await db.query(
        'SELECT * FROM venue_deployment_targets WHERE venue_id=$1',
        [venue.id],
      );
      assertEligible(venue, target, null);
    }
    await db.query(
      'UPDATE venues SET automatic_updates=$2,updated_at=NOW() WHERE id=$1',
      [venue.id, req.body.enabled],
    );
    const wasAutomatic = venue.automatic_updates;
    venue.automatic_updates = req.body.enabled;
    let queued = null;
    if (req.body.enabled) {
      const latest = await latestTestedRelease(db);
      queued = await queueAutomaticForVenue(db, venue, latest, {
        allowCancelled: !wasAutomatic,
      });
    } else {
      const { rows: cancelled } = await db.query(
        "UPDATE venue_release_rollouts SET status='cancelled',finished_at=NOW() WHERE venue_id=$1 AND approval_mode='automatic' AND status='queued' RETURNING id",
        [venue.id],
      );
      for (const job of cancelled)
        await recordAudit(
          {
            venueId: venue.id,
            actor: actorFrom(req),
            action: 'release.cancelled',
            detail: { rolloutId: job.id, reason: 'automatic updates disabled' },
          },
          db,
        );
    }
    await recordAudit(
      {
        venueId: venue.id,
        actor: actorFrom(req),
        action: 'release.automatic_policy.updated',
        detail: { enabled: req.body.enabled, queuedRolloutId: queued },
      },
      db,
    );
    await db.query('COMMIT');
    res.json({ automaticUpdates: req.body.enabled, queuedRolloutId: queued });
  } catch (e) {
    if (db) await db.query('ROLLBACK');
    handle(e, res, next);
  } finally {
    db?.release();
  }
});
router.post('/approve', requireCsrf, async (req, res, next) => {
  let db;
  try {
    const approval = cleanApproval(req.body);
    db = await pool.connect();
    await db.query('BEGIN');
    const {
      rows: [release],
    } = await db.query('SELECT * FROM console_releases WHERE id=$1', [
      approval.releaseId,
    ]);
    if (!release)
      throw Object.assign(new Error('Release not found.'), { status: 404 });
    const created = [];
    for (const id of approval.venueIds) {
      const {
        rows: [venue],
      } = await db.query('SELECT * FROM venues WHERE id=$1 FOR UPDATE', [id]);
      if (!venue)
        throw Object.assign(new Error('A selected venue no longer exists.'), {
          status: 404,
        });
      const {
        rows: [target],
      } = await db.query(
        'SELECT * FROM venue_deployment_targets WHERE venue_id=$1',
        [id],
      );
      const {
        rows: [active],
      } = await db.query(
        "SELECT id FROM venue_release_rollouts WHERE venue_id=$1 AND status IN ('queued','deploying','verifying','interrupted')",
        [id],
      );
      assertEligible(venue, target, active);
      const {
        rows: [row],
      } = await db.query(
        `INSERT INTO venue_release_rollouts
        (venue_id,release_id,approved_by,scheduled_at,target_snapshot,venue_snapshot)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [
          id,
          release.id,
          actorFrom(req),
          approval.scheduledAt,
          target,
          {
            api_url: venue.api_url,
            admin_url: venue.admin_url,
            staff_url: venue.staff_url,
            platform_api_key: venue.platform_api_key,
          },
        ],
      );
      await recordAudit(
        {
          venueId: id,
          actor: actorFrom(req),
          action: 'release.approved',
          detail: {
            rolloutId: row.id,
            version: release.version,
            commit: release.commit_sha,
            scheduledAt: approval.scheduledAt,
          },
        },
        db,
      );
      created.push(row.id);
    }
    await db.query('COMMIT');
    res.status(201).json({ rolloutIds: created });
  } catch (e) {
    if (db) await db.query('ROLLBACK');
    handle(e, res, next);
  } finally {
    db?.release();
  }
});
router.post('/:id/cancel', requireCsrf, async (req, res, next) => {
  let db;
  try {
    if (!/^\d+$/.test(req.params.id))
      return res.status(400).json({ error: 'Invalid update.' });
    db = await pool.connect();
    await db.query('BEGIN');
    const {
      rows: [row],
    } = await db.query(
      "UPDATE venue_release_rollouts SET status='cancelled',finished_at=NOW() WHERE id=$1 AND status='queued' RETURNING venue_id",
      [req.params.id],
    );
    if (!row)
      throw Object.assign(
        new Error(
          'Only a queued update can be cancelled. A deployment in progress must finish or be reconciled.',
        ),
        { status: 409 },
      );
    await recordAudit(
      {
        venueId: row.venue_id,
        actor: actorFrom(req),
        action: 'release.cancelled',
        detail: { rolloutId: Number(req.params.id) },
      },
      db,
    );
    await db.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    if (db) await db.query('ROLLBACK');
    handle(e, res, next);
  } finally {
    db?.release();
  }
});
router.post('/:id/resolve', requireCsrf, async (req, res, next) => {
  let db;
  try {
    if (!/^\d+$/.test(req.params.id) || req.body.acknowledged !== true)
      return res
        .status(400)
        .json({ error: 'Confirm that previous deployments have stopped.' });
    db = await pool.connect();
    await db.query('BEGIN');
    const {
      rows: [row],
    } = await db.query(
      "UPDATE venue_release_rollouts SET status='failed',finished_at=NOW(),error='Interrupted deployment closed by operator after checking Railway.' WHERE id=$1 AND status='interrupted' RETURNING venue_id",
      [req.params.id],
    );
    if (!row)
      throw Object.assign(new Error('This update is not interrupted.'), {
        status: 409,
      });
    await recordAudit(
      {
        venueId: row.venue_id,
        actor: actorFrom(req),
        action: 'release.interruption.resolved',
        detail: { rolloutId: Number(req.params.id) },
      },
      db,
    );
    await db.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    if (db) await db.query('ROLLBACK');
    handle(e, res, next);
  } finally {
    db?.release();
  }
});
module.exports = router;
