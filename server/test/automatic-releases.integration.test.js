'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
test(
  'automatic opt-in, publication authentication, queue isolation and opt-out',
  { skip: !process.env.AUTOMATIC_RELEASE_TEST_DATABASE_URL },
  async (t) => {
    const url = new URL(process.env.AUTOMATIC_RELEASE_TEST_DATABASE_URL);
    assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
    assert.match(url.pathname, /^\/centralpass_auto_release_test[a-z0-9_]*$/);
    process.env.DATABASE_URL = url.href;
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    process.env.RELEASE_PUBLISH_TOKEN =
      'publisher-test-token-' + 'x'.repeat(40);
    const { pool, migrate } = require('../src/db');
    const { encryptSecret } = require('../src/crypto');
    t.after(() => pool.end());
    assert.equal(
      (await pool.query("SELECT to_regclass('public.venues') AS found")).rows[0]
        .found,
      null,
    );
    await migrate();
    await migrate();
    const {
      rows: [operator],
    } = await pool.query(
      "INSERT INTO console_users(email,name,password_hash,totp_secret) VALUES('ops@test','Test operator','x','x') RETURNING id",
    );
    const express = require('express'),
      app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      if (req.get('X-Test-Identity'))
        req.session = {
          user: { id: operator.id, name: 'Test operator' },
          csrfToken: 'test-csrf',
        };
      next();
    });
    app.use('/releases', require('../src/routes/releases'));
    app.use('/publish', require('../src/routes/release-publisher').router);
    app.use((e, req, res, next) => res.status(500).json({ error: e.message }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    t.after(() => new Promise((r) => server.close(r)));
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(
      path,
      body,
      { method = 'POST', identity = true, csrf = true, publisher = false } = {},
    ) {
      const response = await fetch(base + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(identity ? { 'X-Test-Identity': 'yes' } : {}),
          ...(csrf ? { 'X-CSRF-Token': 'test-csrf' } : {}),
          ...(publisher
            ? { Authorization: `Bearer ${process.env.RELEASE_PUBLISH_TOKEN}` }
            : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, body: await response.json() };
    }
    const ids = [],
      uid = (n) => `12345678-1234-1234-1234-${String(n).padStart(12, '0')}`;
    for (const [i, name] of [
      'Automatic Venue',
      'Manual Venue',
      'Unconfigured',
    ].entries()) {
      const {
        rows: [v],
      } = await pool.query(
        `INSERT INTO venues(name,slug,api_url,admin_url,staff_url,platform_api_key) VALUES($1,$2,'https://api.test','https://admin.test','https://staff.test',$3) RETURNING *`,
        [name, `venue-${i}`, encryptSecret('test-platform-key')],
      );
      ids.push(v.id);
      assert.equal(v.automatic_updates, false);
      if (i < 2)
        await pool.query(
          `INSERT INTO venue_deployment_targets(venue_id,project_id,environment_id,services,railway_token,auto_deploy_disabled) VALUES($1,$2,$3,$4,$5,true)`,
          [
            v.id,
            uid(i + 1),
            uid(i + 10),
            { backend: uid(100 + i), admin: uid(200 + i), staff: uid(300 + i) },
            encryptSecret('test-project-token'),
          ],
        );
    }
    const setPolicy = (id, enabled, options = {}) =>
      request(
        `/releases/venues/${id}/automatic`,
        { enabled },
        { method: 'PUT', ...options },
      );
    assert.equal(
      (await setPolicy(ids[0], true, { identity: false })).status,
      401,
    );
    assert.equal((await setPolicy(ids[0], true, { csrf: false })).status, 403);
    assert.equal((await setPolicy(ids[2], true)).status, 400);
    // Only releases CI vouched for are deployed without approval.
    const rel = await request(
      '/publish',
      { version: '1', commitSha: 'a'.repeat(40), notes: 'First' },
      { identity: false, publisher: true },
    );
    assert.equal(rel.status, 201);
    const on = await setPolicy(ids[0], true);
    assert.equal(on.status, 200);
    assert.ok(on.body.queuedRolloutId);
    const { queueAutomaticReleases } = require('../src/automatic-releases');
    assert.deepEqual(await queueAutomaticReleases(pool), []);
    const off = await setPolicy(ids[0], false);
    assert.equal(off.status, 200);
    assert.equal(
      (
        await pool.query(
          'SELECT status FROM venue_release_rollouts WHERE id=$1',
          [on.body.queuedRolloutId],
        )
      ).rows[0].status,
      'cancelled',
    );
    const again = await setPolicy(ids[0], true);
    assert.ok(
      again.body.queuedRolloutId,
      'Explicit re-enabling may resume an auto rollout cancelled by opt-out.',
    );
    await pool.query(
      "UPDATE venue_release_rollouts SET status='deploying' WHERE id=$1",
      [again.body.queuedRolloutId],
    );
    await setPolicy(ids[0], false);
    assert.equal(
      (
        await pool.query(
          'SELECT status FROM venue_release_rollouts WHERE id=$1',
          [again.body.queuedRolloutId],
        )
      ).rows[0].status,
      'deploying',
      'Opt-out leaves already-started work alone.',
    );
    await pool.query(
      "UPDATE venue_release_rollouts SET status='succeeded',finished_at=NOW() WHERE id=$1",
      [again.body.queuedRolloutId],
    );
    await setPolicy(ids[0], true);
    const second = { version: '2', commitSha: 'b'.repeat(40), notes: 'Second' };
    assert.equal(
      (await request('/publish', second, { identity: false })).status,
      401,
    );
    assert.equal(
      (await request('/publish', second, { identity: false, publisher: true }))
        .status,
      201,
    );
    assert.equal(
      (await request('/publish', second, { identity: false, publisher: true }))
        .status,
      200,
      'Publisher retry is idempotent.',
    );
    assert.equal(
      (
        await request(
          '/publish',
          { ...second, commitSha: 'c'.repeat(40) },
          { publisher: true },
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT COUNT(*)::int AS n FROM venue_release_rollouts WHERE venue_id=$1 AND status='queued'",
          [ids[0]],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT COUNT(*)::int AS n FROM venue_release_rollouts WHERE venue_id=$1',
          [ids[1]],
        )
      ).rows[0].n,
      0,
      'Manual venue must not receive automatic updates.',
    );
    await pool.query(
      "UPDATE venue_release_rollouts SET status='interrupted' WHERE venue_id=$1 AND status='queued'",
      [ids[0]],
    );
    const third = await request(
      '/publish',
      { version: '3', commitSha: 'd'.repeat(40), notes: 'Third' },
      { identity: false, publisher: true },
    );
    assert.equal(third.status, 201);
    assert.deepEqual(
      await queueAutomaticReleases(pool),
      [],
      'An interrupted venue stays blocked.',
    );
    await pool.query(
      "UPDATE venue_release_rollouts SET status='failed' WHERE venue_id=$1 AND status='interrupted'",
      [ids[0]],
    );
    const raced = await Promise.all([
      queueAutomaticReleases(pool),
      queueAutomaticReleases(pool),
    ]);
    assert.equal(
      raced.flat().length,
      1,
      'Concurrent workers queue a venue only once.',
    );
    await pool.query(
      "UPDATE venue_release_rollouts SET status='succeeded',finished_at=NOW() WHERE venue_id=$1 AND status='queued'",
      [ids[0]],
    );
    const manual = await request('/releases', {
      version: '4',
      commitSha: 'e'.repeat(40),
      notes: 'Registered by hand',
    });
    assert.equal(manual.status, 201);
    assert.equal(manual.body.automaticallyQueued, 0);
    assert.deepEqual(
      await queueAutomaticReleases(pool),
      [],
      'A release registered by hand is never deployed without approval.',
    );
    await setPolicy(ids[0], false);
    assert.deepEqual(await queueAutomaticReleases(pool), []);
  },
);
