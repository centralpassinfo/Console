'use strict';
const { randomUUID } = require('node:crypto');
const { pool } = require('../src/db');
const { decryptSecret, resolveKey } = require('../src/crypto');
const { recordAudit } = require('../src/audit');
const { deployRelease } = require('../src/release-deployer');
const { queueAutomaticReleases } = require('../src/automatic-releases');
const workerId = randomUUID();
let stopping = false;
process.on('SIGTERM', () => {
  stopping = true;
});
process.on('SIGINT', () => {
  stopping = true;
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function claim() {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const {
      rows: [job],
    } =
      await db.query(`SELECT x.* FROM venue_release_rollouts x JOIN venues v ON v.id=x.venue_id
      WHERE x.status='queued' AND x.scheduled_at<=NOW() AND v.status='active'
        AND (x.approval_mode='manual' OR v.automatic_updates)
      ORDER BY x.scheduled_at,x.id FOR UPDATE OF x SKIP LOCKED LIMIT 1`);
    if (job)
      await db.query(
        "UPDATE venue_release_rollouts SET status='deploying',started_at=NOW(),heartbeat_at=NOW() WHERE id=$1",
        [job.id],
      );
    await db.query('COMMIT');
    return job;
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    db.release();
  }
}
async function processJob(job) {
  let heartbeatBusy = false;
  const heartbeat = setInterval(async () => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    try {
      await pool.query(
        "UPDATE venue_release_rollouts SET heartbeat_at=NOW() WHERE id=$1 AND status IN ('deploying','verifying')",
        [job.id],
      );
    } catch {
      /* Fencing check below stops further uploads if the lease expired. */
    } finally {
      heartbeatBusy = false;
    }
  }, 10000);
  try {
    const {
      rows: [release],
    } = await pool.query('SELECT * FROM console_releases WHERE id=$1', [
      job.release_id,
    ]);
    const assertRunning = async () => {
      const {
        rows: [current],
      } = await pool.query(
        `SELECT x.status,v.status AS venue_status FROM venue_release_rollouts x
        JOIN venues v ON v.id=x.venue_id WHERE x.id=$1`,
        [job.id],
      );
      if (
        !['deploying', 'verifying'].includes(current?.status) ||
        current.venue_status !== 'active'
      )
        throw new Error(
          'Update stopped: the job or venue is no longer active.',
        );
    };
    await assertRunning();
    const target = job.target_snapshot,
      venue = job.venue_snapshot;
    await deployRelease({
      release,
      target,
      venue,
      token: decryptSecret(target.railway_token),
      platformKey: decryptSecret(venue.platform_api_key),
      assertRunning,
      onProgress: async (component, state) => {
        await assertRunning();
        await pool.query(
          `UPDATE venue_release_rollouts SET status=$2,progress=progress||$3::jsonb WHERE id=$1 AND status IN ('deploying','verifying')`,
          [
            job.id,
            state === 'verifying' ? 'verifying' : 'deploying',
            JSON.stringify({ [component]: state }),
          ],
        );
      },
    });
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const { rowCount } = await db.query(
        "UPDATE venue_release_rollouts SET status='succeeded',finished_at=NOW() WHERE id=$1 AND status IN ('deploying','verifying')",
        [job.id],
      );
      if (rowCount)
        await recordAudit(
          {
            venueId: job.venue_id,
            actor: 'release worker',
            action: 'release.succeeded',
            detail: {
              rolloutId: job.id,
              version: release.version,
              commit: release.commit_sha,
            },
          },
          db,
        );
      await db.query('COMMIT');
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    } finally {
      db.release();
    }
  } catch (e) {
    // An accepted upload may still be building. Block another rollout until an
    // operator stops/reconciles it; never automatically retry or roll back DBs.
    await pool.query(
      "UPDATE venue_release_rollouts SET status='interrupted',error=$2,finished_at=NOW() WHERE id=$1 AND status IN ('deploying','verifying')",
      [job.id, e.message],
    );
    await recordAudit({
      venueId: job.venue_id,
      actor: 'release worker',
      action: 'release.interrupted',
      detail: { rolloutId: job.id, error: e.message },
    });
  } finally {
    clearInterval(heartbeat);
  }
}
async function main() {
  resolveKey();
  if (!process.env.RELEASE_REPOSITORY_URL)
    throw new Error('RELEASE_REPOSITORY_URL is required.');
  const beat = async () => {
    await pool.query(
      'INSERT INTO console_release_workers(id) VALUES ($1) ON CONFLICT(id) DO UPDATE SET heartbeat_at=NOW()',
      [workerId],
    );
    await pool.query(`WITH expired AS (
      UPDATE venue_release_rollouts SET status='interrupted',error='Worker heartbeat lost. Inspect Railway and stop pending deployments before resolving.',finished_at=NOW()
      WHERE status IN ('deploying','verifying') AND heartbeat_at<NOW()-INTERVAL '2 minutes'
      RETURNING id,venue_id
    ) INSERT INTO console_audit(venue_id,actor,action,detail)
      SELECT venue_id,'release worker','release.interrupted',jsonb_build_object('rolloutId',id,'reason','heartbeat lost') FROM expired`);
  };
  await beat();
  const timer = setInterval(() => beat().catch(() => {}), 10000);
  try {
    while (!stopping) {
      await queueAutomaticReleases(pool);
      const job = await claim();
      if (job) await processJob(job);
      else await sleep(3000);
    }
  } finally {
    clearInterval(timer);
    await pool.query('DELETE FROM console_release_workers WHERE id=$1', [
      workerId,
    ]);
    await pool.end();
  }
}
if (require.main === module)
  main().catch((e) => {
    console.error('Release worker stopped:', e.message);
    process.exit(1);
  });
module.exports = { claim, processJob };
