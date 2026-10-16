'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { testedCommit, repositoryParts } = require('../src/release-source');
const {
  discoverRailway,
  configureRailway,
  proposeServices,
} = require('../src/railway-discovery');
const sha = 'a'.repeat(40);
const source = {
  repository: 'https://github.com/CentralPass/centralpass-platform.git',
  token: 'secret-github-token',
};
const uid = (n) => `12345678-1234-1234-1234-${String(n).padStart(12, '0')}`;
const ok = (data) => ({ ok: true, json: async () => data });
const run = {
  id: 123,
  run_number: 7,
  run_attempt: 1,
  path: '.github/workflows/console-releases.yml',
  head_sha: sha,
  head_branch: 'main',
  event: 'push',
  head_repository: { full_name: 'CentralPass/centralpass-platform' },
  status: 'completed',
  conclusion: 'success',
  html_url: 'https://untrusted.example',
};
function github(runs, latest = sha) {
  let commits = 0;
  return async (url, options) => {
    assert.ok(
      url.startsWith(
        'https://api.github.com/repos/CentralPass/centralpass-platform/',
      ),
    );
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer secret-github-token');
    return ok(
      url.includes('/runs?')
        ? { workflow_runs: runs }
        : {
            sha: ++commits === 1 ? sha : latest,
            commit: { message: 'Fix bookings' },
          },
    );
  };
}
test('only the exact current-main successful trusted workflow is discoverable', async () => {
  assert.deepEqual(repositoryParts(source.repository), {
    owner: 'CentralPass',
    repo: 'centralpass-platform',
  });
  assert.throws(() => repositoryParts('https://token@github.com/org/repo.git'));
  const result = await testedCommit(source, github([run]));
  assert.equal(result.commit.sha, sha);
  assert.equal(
    result.run.html_url,
    'https://github.com/CentralPass/centralpass-platform/actions/runs/123',
  );
  for (const override of [
    { head_sha: 'b'.repeat(40) },
    { head_branch: 'other' },
    { event: 'pull_request' },
    { path: '.github/workflows/other.yml' },
    { head_repository: { full_name: 'fork/repo' } },
    { status: 'in_progress' },
    { conclusion: 'failure' },
    { conclusion: 'cancelled' },
  ]) {
    assert.equal(
      (await testedCommit(source, github([{ ...run, ...override }]))).run,
      null,
      JSON.stringify(override),
    );
  }
  assert.equal(
    (await testedCommit(source, github([run], 'b'.repeat(40)))).run,
    null,
    'A superseded main commit is not imported.',
  );
  assert.equal(
    (
      await testedCommit(
        source,
        github([run, { ...run, run_number: 8, conclusion: 'failure' }]),
      )
    ).run,
    null,
    'Later failures override older successful runs.',
  );
});
test('provider failures do not expose response bodies or credentials', async () => {
  await assert.rejects(
    testedCommit(source, async () => ({
      ok: false,
      status: 401,
      json: async () => ({ token: source.token }),
    })),
    (error) =>
      !error.message.includes(source.token) && /access/.test(error.message),
  );
  await assert.rejects(
    discoverRailway('sensitive-project-token', {}, async () => {
      throw new Error('sensitive-project-token');
    }),
    (error) => !error.message.includes('sensitive-project-token'),
  );
});
test('Railway discovery uses token scope, pagination and avoids guessing ambiguous matches', async () => {
  const service = (n, name, rootDirectory, image) => ({
    serviceId: uid(n),
    serviceName: name,
    rootDirectory,
    source: { image },
    domains: { customDomains: [{ domain: `service-${n}.test` }] },
  });
  let calls = 0;
  const found = await discoverRailway(
    'project-token-for-testing',
    {},
    async (url, options) => {
      assert.equal(url, 'https://backboard.railway.com/graphql/v2');
      assert.equal(
        options.headers['Project-Access-Token'],
        'project-token-for-testing',
      );
      const body = JSON.parse(options.body);
      calls++;
      if (calls === 1)
        return ok({
          data: {
            projectToken: {
              projectId: uid(1),
              environmentId: uid(2),
              project: { name: 'Venue' },
              environment: { name: 'Production' },
            },
          },
        });
      assert.equal(body.variables.projectId, uid(1));
      assert.equal(body.variables.environmentId, uid(2));
      if (calls === 2)
        return ok({
          data: {
            environment: {
              serviceInstances: {
                edges: [
                  service(3, 'backend', 'backend'),
                  service(4, 'admin-portal', 'admin-portal'),
                ].map((node) => ({ node })),
                pageInfo: { hasNextPage: true, endCursor: 'next' },
              },
            },
          },
        });
      assert.equal(body.variables.after, 'next');
      return ok({
        data: {
          environment: {
            serviceInstances: {
              edges: [
                service(5, 'staff-dashboard', 'staff-dashboard'),
                service(6, 'database', 'backend', 'postgres:17'),
              ].map((node) => ({ node })),
              pageInfo: { hasNextPage: false },
            },
          },
        },
      });
    },
  );
  assert.equal(found.services.length, 3);
  assert.equal(found.suggested.backend, uid(3));
  assert.equal(found.suggested.admin, uid(4));
  assert.equal(found.suggested.staff, uid(5));
  const ambiguous = [1, 2].map((id) => ({
    id,
    name: 'backend',
    rootDirectory: 'backend',
    urls: [],
  }));
  assert.equal(proposeServices(ambiguous).backend, '');
  assert.equal(
    proposeServices(
      ambiguous.map((s, i) => ({ ...s, urls: [`https://api-${i}.test`] })),
      { api_url: 'https://api-1.test/api' },
    ).backend,
    2,
  );
});
test('Railway setup mutates only selected application services and verifies control', async () => {
  const selected = { backend: uid(3), admin: uid(4), staff: uid(5) };
  const discovery = {
    projectId: uid(1),
    environmentId: uid(2),
    services: Object.entries(selected).map(([role, id]) => ({
      id,
      name: role,
      rootDirectory: '',
    })),
  };
  const calls = [];
  const provider = async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer token');
    assert.equal(
      options.headers['Project-Access-Token'],
      undefined,
      'Setup must not authenticate as an environment-scoped project token.',
    );
    const { query, variables } = JSON.parse(options.body);
    calls.push({ query, variables });
    if (query.includes('SetupAccess'))
      return ok({ data: { project: { id: discovery.projectId } } });
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
    return ok({
      data: {
        serviceInstanceAutoDeployUpdate: { enabled: false },
        serviceInstanceUpdate: true,
      },
    });
  };
  await configureRailway('token', discovery, selected, provider);
  assert.equal(calls.length, 10);
  for (const c of calls) {
    const v = c.variables.input || c.variables;
    if (!c.query.includes('SetupAccess'))
      assert.ok(
        Object.values(selected).includes(v.serviceId || c.variables.serviceId),
      );
    if (c.query.includes('TakeControl')) {
      assert.equal(v.enabled, false);
      assert.equal(v.environmentId, uid(2));
    }
  }
  calls.length = 0;
  await configureRailway(
    'token',
    discovery,
    {
      backend: selected.backend,
      admin: selected.admin,
      staff: '',
      employee: '',
    },
    provider,
  );
  assert.equal(
    calls.length,
    7,
    'Only the two required services are configured when staff is omitted.',
  );
  assert.equal(JSON.stringify(calls).includes(selected.staff), false);
  calls.length = 0;
  await assert.rejects(
    configureRailway(
      'token',
      discovery,
      { ...selected, employee: uid(999) },
      provider,
    ),
    /does not belong/,
  );
  assert.equal(
    calls.length,
    0,
    'Validate every selection before the first mutation.',
  );
  await assert.rejects(
    configureRailway(
      'token',
      discovery,
      { ...selected, admin: selected.backend },
      provider,
    ),
    /different service/,
  );
  await assert.rejects(
    configureRailway('token', discovery, selected, async (url, options) =>
      JSON.parse(options.body).query.includes('SetupAccess')
        ? ok({ data: { project: { id: discovery.projectId } } })
        : ok({
            data: {
              serviceInstanceAutoDeployStatus: { enabled: true },
              serviceInstance: { rootDirectory: 'backend' },
            },
          }),
    ),
    /not confirmed/,
  );
});

test('Railway permission errors are actionable, sanitized and do not become proxy-replaced 502 responses', async () => {
  const { railwayQuery } = require('../src/railway-discovery');
  await assert.rejects(
    railwayQuery(
      'private-setup-token',
      'query SetupAccess { project { id } }',
      {},
      async () =>
        ok({
          errors: [
            {
              message: 'Not authorized private-setup-token',
              extensions: { code: 'FORBIDDEN' },
            },
          ],
        }),
      'setup',
    ),
    (error) =>
      error.status === 403 &&
      error.operation === 'SetupAccess' &&
      error.code === 'RAILWAY_ACCESS_DENIED' &&
      /workspace token/.test(error.message) &&
      !error.message.includes('private-setup-token'),
  );
  await assert.rejects(
    railwayQuery(
      'secret',
      'mutation TakeControl { field }',
      {},
      async () =>
        ok({ errors: [{ message: 'Internal provider detail secret' }] }),
      'setup',
    ),
    (error) =>
      error.status === 424 &&
      error.operation === 'TakeControl' &&
      !error.message.includes('secret'),
  );
});
