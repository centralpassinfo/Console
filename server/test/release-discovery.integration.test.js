'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
test(
  'discovery persists encrypted connections, imports tested releases once and preserves venue approval policies',
  { skip: !process.env.DISCOVERY_TEST_DATABASE_URL },
  async (t) => {
    const url = new URL(process.env.DISCOVERY_TEST_DATABASE_URL);
    assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
    assert.match(url.pathname, /^\/centralpass_release_test[a-z0-9_]*$/);
    process.env.DATABASE_URL = url.href;
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    delete process.env.RELEASE_GITHUB_TOKEN;
    delete process.env.RELEASE_REPOSITORY_URL;
    const { pool, migrate } = require('../src/db');
    const { encryptSecret, decryptSecret } = require('../src/crypto');
    t.after(() => pool.end());
    assert.equal(
      (await pool.query("SELECT to_regclass('public.venues') AS found")).rows[0]
        .found,
      null,
    );
    await migrate();
    await migrate();
    const originalFetch = global.fetch;
    const uid = (n) => `12345678-1234-1234-1234-${String(n).padStart(12, '0')}`;
    const sha = 'b'.repeat(40),
      githubToken = 'github-test-token-' + 'x'.repeat(32),
      railwayToken = 'railway-test-token-' + 'x'.repeat(32);
    let ci = 'success',
      mutations = 0;
    global.fetch = async (input, options) => {
      const endpoint = String(input);
      const ok = (data) => ({ ok: true, json: async () => data });
      if (endpoint.startsWith('https://api.github.com/')) {
        if (endpoint.includes('/runs?'))
          return ok({
            workflow_runs: [
              {
                id: 123,
                run_number: 12,
                head_sha: sha,
                head_branch: 'main',
                event: 'push',
                path: '.github/workflows/console-releases.yml',
                head_repository: {
                  full_name: 'CentralPass/centralpass-platform',
                },
                status: 'completed',
                conclusion: ci,
              },
            ],
          });
        return ok({ sha, commit: { message: 'Tested platform fix' } });
      }
      if (endpoint === 'https://backboard.railway.com/graphql/v2') {
        assert.equal(options.headers['Project-Access-Token'], railwayToken);
        const { query, variables } = JSON.parse(options.body);
        if (query.includes('projectToken'))
          return ok({
            data: {
              projectToken: {
                projectId: uid(1),
                environmentId: uid(2),
                project: { name: 'Venue project' },
                environment: { name: 'Production' },
              },
            },
          });
        if (query.includes('Discovery'))
          return ok({
            data: {
              environment: {
                serviceInstances: {
                  edges: [
                    ['backend', 3],
                    ['admin-portal', 4],
                    ['staff-dashboard', 5],
                  ].map(([rootDirectory, n]) => ({
                    node: {
                      serviceId: uid(n),
                      serviceName: rootDirectory,
                      rootDirectory,
                      domains: {
                        serviceDomains: [{ domain: `service-${n}.test` }],
                      },
                    },
                  })),
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          });
        if (query.includes('mutation')) {
          mutations++;
          return ok({
            data: { serviceInstanceAutoDeployUpdate: { enabled: false } },
          });
        }
        if (query.includes('Verify'))
          return ok({
            data: {
              serviceInstanceAutoDeployStatus: { enabled: false },
              serviceInstance: {
                rootDirectory: {
                  [uid(3)]: 'backend',
                  [uid(4)]: 'admin-portal',
                  [uid(5)]: 'staff-dashboard',
                }[variables.serviceId],
              },
            },
          });
        throw new Error('Unexpected Railway operation');
      }
      return originalFetch(input, options);
    };
    t.after(() => {
      global.fetch = originalFetch;
    });
    const app = require('express')();
    app.use(require('express').json());
    app.use((req, res, next) => {
      if (req.get('X-Test-Identity'))
        req.session = {
          user: { name: 'Test operator' },
          csrfToken: 'test-csrf',
        };
      next();
    });
    app.use('/releases', require('../src/routes/releases'));
    app.use((error, req, res, next) =>
      res.status(500).json({ error: error.message }),
    );
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(path, body, { identity = true, csrf = true } = {}) {
      const response = await originalFetch(base + '/releases' + path, {
        method: body ? 'POST' : 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(identity ? { 'X-Test-Identity': 'yes' } : {}),
          ...(csrf ? { 'X-CSRF-Token': 'test-csrf' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, body: await response.json() };
    }
    for (const path of [
      '/source',
      '/sync',
      '/targets/1/discover',
      '/targets/1/connect',
    ]) {
      assert.equal((await request(path, {}, { identity: false })).status, 401);
      assert.equal((await request(path, {}, { csrf: false })).status, 403);
    }
    const ids = [];
    for (const name of ['Automatic', 'Manual'])
      ids.push(
        (
          await pool.query(
            "INSERT INTO venues(name,slug,api_url,platform_api_key) VALUES($1,$2,'',$3) RETURNING id",
            [name, name.toLowerCase(), encryptSecret('platform-key')],
          )
        ).rows[0].id,
      );
    const target = {
      railwayToken,
      services: { backend: uid(3), admin: uid(4), staff: '' },
      manageUpdates: true,
      projectId: uid(999),
      environmentId: uid(999),
    };
    const discovered = await request(`/targets/${ids[0]}/discover`, {
      railwayToken,
    });
    assert.equal(discovered.status, 200);
    assert.equal(JSON.stringify(discovered).includes(railwayToken), false);
    const forged = await request(`/targets/${ids[0]}/connect`, {
      ...target,
      services: { ...target.services, staff: uid(999) },
    });
    assert.equal(forged.status, 400);
    assert.equal(mutations, 0);
    assert.equal(
      (await request(`/targets/${ids[0]}/connect`, target)).status,
      200,
    );
    assert.equal(mutations, 2);
    const saved = (
      await pool.query(
        'SELECT * FROM venue_deployment_targets WHERE venue_id=$1',
        [ids[0]],
      )
    ).rows[0];
    assert.equal(saved.project_id, uid(1));
    assert.equal(saved.environment_id, uid(2));
    assert.deepEqual(saved.services, { backend: uid(3), admin: uid(4) });
    assert.equal(decryptSecret(saved.railway_token), railwayToken);
    const venue = (
      await pool.query('SELECT * FROM venues WHERE id=$1', [ids[0]])
    ).rows[0];
    assert.equal(venue.api_url, 'https://service-3.test');
    assert.equal(venue.admin_url, 'https://service-4.test');
    assert.equal(venue.staff_url, null);
    assert.equal(
      (await request(`/targets/${ids[0]}/discover`, {})).status,
      200,
      'Saved token can be reused.',
    );
    assert.equal(
      (await request(`/targets/${ids[1]}/connect`, target)).status,
      409,
    );
    assert.equal(
      mutations,
      2,
      'Duplicate assignment rejected before changing external settings.',
    );
    await pool.query('UPDATE venues SET automatic_updates=true WHERE id=$1', [
      ids[0],
    ]);
    ci = 'failure';
    assert.equal((await request('/source', { githubToken })).status, 200);
    assert.equal(
      (await pool.query('SELECT COUNT(*)::int AS n FROM console_releases'))
        .rows[0].n,
      0,
    );
    const sourceRow = (await pool.query('SELECT * FROM console_release_source'))
      .rows[0];
    assert.notEqual(sourceRow.github_token, githubToken);
    assert.equal(decryptSecret(sourceRow.github_token), githubToken);
    ci = 'success';
    const synced = await request('/sync', {});
    assert.equal(synced.status, 200);
    assert.equal(synced.body.imported, 1);
    assert.equal((await request('/sync', {})).body.imported, 0);
    const jobs = (await pool.query('SELECT * FROM venue_release_rollouts'))
      .rows;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].venue_id, ids[0]);
    assert.equal(jobs[0].approval_mode, 'automatic');
    assert.equal(jobs[0].target_snapshot.services.staff, undefined);
    const listing = await request('');
    const serialized = JSON.stringify(listing.body);
    assert.equal(listing.body.releases.length, 1);
    assert.equal(listing.body.releases[0].source_run_number, 12);
    assert.equal(listing.body.source.connected, true);
    for (const secret of [
      railwayToken,
      githubToken,
      'github_token',
      'railway_token',
      'platform_api_key',
    ])
      assert.equal(serialized.includes(secret), false, secret);
    assert.equal(
      (await request(`/targets/${ids[0]}/connect`, target)).status,
      409,
      'Active rollouts prevent reconnecting.',
    );
    assert.equal(mutations, 2);
  },
);
