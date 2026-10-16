'use strict';
const { recordAudit } = require('./audit');
const { assertEligible } = require('./releases');

// Caller holds the venue row lock. Background reconciliation never replaces
// manual work, retries cancelled/failed releases, or skips an interruption.
// Explicitly re-enabling the policy may resume a cancelled automatic release.
async function queueAutomaticForVenue(
  db,
  venue,
  release,
  { allowCancelled = false } = {},
) {
  if (!release || venue.automatic_updates !== true || venue.status !== 'active')
    return null;
  const {
    rows: [target],
  } = await db.query(
    'SELECT * FROM venue_deployment_targets WHERE venue_id=$1',
    [venue.id],
  );
  const {
    rows: [busy],
  } = await db.query(
    "SELECT id FROM venue_release_rollouts WHERE venue_id=$1 AND status IN ('queued','deploying','verifying','interrupted')",
    [venue.id],
  );
  const {
    rows: [attempted],
  } = await db.query(
    `SELECT id FROM venue_release_rollouts WHERE venue_id=$1 AND release_id=$2
    AND (NOT $3::boolean OR status<>'cancelled' OR approval_mode<>'automatic') LIMIT 1`,
    [venue.id, release.id, allowCancelled],
  );
  if (busy || attempted) return null;
  try {
    assertEligible(venue, target, null);
  } catch {
    return null;
  }
  const {
    rows: [job],
  } = await db.query(
    `INSERT INTO venue_release_rollouts
    (venue_id,release_id,approved_by,approval_mode,target_snapshot,venue_snapshot)
    VALUES ($1,$2,'Automatic update policy','automatic',$3,$4) RETURNING id`,
    [
      venue.id,
      release.id,
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
      venueId: venue.id,
      actor: 'Automatic update policy',
      action: 'release.automatically_queued',
      detail: {
        rolloutId: job.id,
        version: release.version,
        commit: release.commit_sha,
      },
    },
    db,
  );
  return job.id;
}
async function queueAutomaticReleases(pool) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    // Serialize against policy edits and manual approvals. Different workers
    // may handle different venues, without duplicating the same venue's job.
    const { rows: venues } = await db.query(
      "SELECT * FROM venues WHERE automatic_updates AND status='active' ORDER BY id FOR UPDATE SKIP LOCKED",
    );
    const {
      rows: [release],
    } = await db.query(
      'SELECT * FROM console_releases ORDER BY id DESC LIMIT 1',
    );
    const queued = [];
    for (const venue of venues) {
      const id = await queueAutomaticForVenue(db, venue, release);
      if (id) queued.push(id);
    }
    await db.query('COMMIT');
    return queued;
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    db.release();
  }
}
module.exports = { queueAutomaticForVenue, queueAutomaticReleases };
