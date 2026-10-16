'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {
  cleanRelease,
  cleanTarget,
  cleanApproval,
  assertEligible,
} = require('../src/releases');
const {
  verifyComponent,
  deployRelease,
  cliEnvironment,
  waitForDeployment,
  deploymentIdFromOutput,
} = require('../src/release-deployer');
const sha = 'a'.repeat(40),
  uuid = '12345678-1234-1234-1234-123456789012';
const release = { version: '1.9.0', commit_sha: sha };
test('schedules use Sydney time independently of the host timezone', async () => {
  const { releaseScheduleUtc, formatReleaseTime } =
    await import('../../src/releaseTime.mjs');
  assert.equal(
    releaseScheduleUtc('2026-10-17T18:00'),
    '2026-10-17T07:00:00.000Z',
  );
  assert.match(formatReleaseTime('2026-10-17T07:00:00Z'), /6:00 pm/);
  assert.throws(
    () => releaseScheduleUtc('2026-10-04T02:30'),
    /daylight-saving/,
  );
  assert.throws(
    () => releaseScheduleUtc('2027-04-04T02:30'),
    /daylight-saving/,
  );
});
const response = (data) => ({
  ok: true,
  json: async () => data,
  text: async () => data,
});
test('releases pin full commits and optional tablet checksums', () => {
  assert.throws(
    () => cleanRelease({ version: '1', commitSha: 'main', notes: 'Test' }),
    /40-character/,
  );
  assert.throws(
    () =>
      cleanRelease({
        version: '1',
        commitSha: sha,
        notes: 'Test',
        tabletBundle: { version: 'latest' },
      }),
    /checksum/,
  );
  assert.equal(
    cleanRelease({ version: '1.9.0', commitSha: sha, notes: ' Tested ' }).notes,
    'Tested',
  );
});
test('bulk approval validates every ID, deduplicates no inputs and bounds schedules', () => {
  assert.throws(
    () => cleanApproval({ releaseId: 1, venueIds: [1, 1] }),
    /different venues/,
  );
  assert.throws(
    () => cleanApproval({ releaseId: 1, venueIds: [1, '2'] }),
    /different venues/,
  );
  assert.throws(
    () =>
      cleanApproval({ releaseId: 1, venueIds: [1], scheduledAt: 'invalid' }),
    /90 days/,
  );
  assert.deepEqual(
    cleanApproval({ releaseId: 1, venueIds: [3, 1] }).venueIds,
    [1, 3],
  );
});
test('setup requires separate services and disabled automatic deployment', () => {
  const target = {
    projectId: uuid,
    environmentId: uuid,
    services: { backend: uuid, admin: uuid, staff: uuid },
  };
  assert.throws(() => cleanTarget(target), /automatic deployments/);
  assert.throws(
    () => cleanTarget({ ...target, autoDeployDisabled: true }),
    /different Railway service/,
  );
});
test('staff and employee services are optional but selected portals need valid IDs and URLs', () => {
  const admin = '12345678-1234-1234-1234-123456789013';
  const target = {
    projectId: uuid,
    environmentId: uuid,
    autoDeployDisabled: true,
    services: { backend: uuid, admin, staff: '', employee: '' },
  };
  const saved = cleanTarget(target);
  assert.deepEqual(saved.services, { backend: uuid, admin });
  const venue = {
    name: 'No staff portal',
    status: 'active',
    api_url: 'https://api.test',
    admin_url: 'https://admin.test',
    staff_url: null,
  };
  assert.doesNotThrow(() => assertEligible(venue, saved, null));
  assert.throws(
    () =>
      cleanTarget({
        ...target,
        services: { ...target.services, staff: 'invalid' },
      }),
    /staff service ID/,
  );
  assert.throws(
    () =>
      cleanTarget({ ...target, services: { ...target.services, admin: '' } }),
    /admin service ID/,
  );
  assert.throws(
    () =>
      assertEligible(
        venue,
        { ...saved, services: { ...saved.services, staff: uuid } },
        null,
      ),
    /URLs/,
  );
  assert.throws(
    () =>
      assertEligible(
        venue,
        { ...saved, services: { ...saved.services, employee: uuid } },
        null,
      ),
    /URLs/,
  );
});
test('suspended venues, missing setup and in-flight jobs cannot be approved', () => {
  const v = {
    name: 'Primo',
    status: 'active',
    api_url: 'https://api.test',
    admin_url: 'https://admin.test',
    staff_url: 'https://staff.test',
  };
  assert.throws(
    () => assertEligible({ ...v, status: 'offboarded' }, null, null),
    /offboarded/,
  );
  assert.throws(() => assertEligible(v, null, null), /setup/);
  assert.throws(
    () => assertEligible(v, { services: {} }, { id: 1 }),
    /already/,
  );
  assert.doesNotThrow(() => assertEligible(v, { services: {} }, null));
});
test('verification rejects healthy services running the wrong version', async () => {
  await assert.rejects(
    verifyComponent('backend', 'https://test', release, 'key', async () =>
      response({
        status: 'ok',
        release: { commit: 'b'.repeat(40), version: '1.9.0' },
      }),
    ),
    /approved release/,
  );
  await assert.rejects(
    verifyComponent('staff', 'https://test', release, 'key', async (url) =>
      response(
        url.includes('release.json')
          ? { commit: sha, version: '1.9.0' }
          : '<html>Old portal</html>',
      ),
    ),
    /approved release/,
  );
  await verifyComponent('staff', 'https://test', release, 'key', async (url) =>
    response(
      url.includes('release.json')
        ? { commit: sha, version: '1.9.0' }
        : `<meta name="centralpass-release" content="${sha}">`,
    ),
  );
});
test('deployment subprocess receives only its project token, not Console secrets', () => {
  process.env.SESSION_SECRET = 'test-sensitive-session';
  process.env.DATABASE_URL = 'test-sensitive-db';
  const env = cliEnvironment('project-token');
  assert.equal(env.RAILWAY_TOKEN, 'project-token');
  assert.equal(env.SESSION_SECRET, undefined);
  assert.equal(env.DATABASE_URL, undefined);
  delete process.env.SESSION_SECRET;
  delete process.env.DATABASE_URL;
});
test('deployment uploads the pinned source and waits for each component before the next', async () => {
  const old = process.env.RAILWAY_CLI_PATH;
  process.env.RAILWAY_CLI_PATH = 'railway';
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'release-order-test-'),
  );
  const events = [];
  try {
    await deployRelease(
      {
        release,
        target: {
          project_id: uuid,
          environment_id: uuid,
          services: {
            backend: 'backend-id',
            admin: 'admin-id',
            staff: 'staff-id',
          },
        },
        venue: {
          api_url: 'https://api',
          admin_url: 'https://admin',
          staff_url: 'https://staff',
        },
        token: 'token',
        platformKey: 'key',
        repository: 'https://github.com/CentralPass/centralpass-platform.git',
        githubToken: 'shared-read-only-github-token',
        onProgress: async () => {},
        assertRunning: async () => {},
      },
      {
        prepareSource: async (pinnedRelease, options) => {
          assert.equal(pinnedRelease.commit_sha, sha);
          assert.equal(
            options.repository,
            'https://github.com/CentralPass/centralpass-platform.git',
          );
          assert.equal(options.githubToken, 'shared-read-only-github-token');
          return { directory, source: directory };
        },
        execCommand: async (file, args, opts) => {
          events.push(`upload:${args[args.indexOf('--service') + 1]}`);
          assert.ok(args.includes('--path-as-root'));
          assert.equal(opts.env.RAILWAY_TOKEN, 'token');
          assert.equal(
            JSON.stringify(opts.env).includes('shared-read-only-github-token'),
            false,
          );
          return { stdout: JSON.stringify({ deploymentId: uuid }) };
        },
        waitForDeployment: async () => {},
        waitForComponent: async (component) =>
          events.push(`verify:${component}`),
      },
    );
    assert.deepEqual(events.slice(0, 6), [
      'upload:backend-id',
      'verify:backend',
      'upload:admin-id',
      'verify:admin',
      'upload:staff-id',
      'verify:staff',
    ]);
  } finally {
    if (old) process.env.RAILWAY_CLI_PATH = old;
    else delete process.env.RAILWAY_CLI_PATH;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
test('deployment skips an absent staff portal while verifying configured employee portals', async () => {
  const prior = process.env.RAILWAY_CLI_PATH;
  process.env.RAILWAY_CLI_PATH = 'railway';
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'release-optional-staff-test-'),
  );
  const uploaded = [],
    verified = [];
  try {
    await deployRelease(
      {
        release,
        target: {
          project_id: uuid,
          environment_id: uuid,
          services: {
            backend: 'backend-id',
            admin: 'admin-id',
            employee: 'employee-id',
          },
          employee_url: 'https://employee.test',
        },
        venue: {
          api_url: 'https://api.test',
          admin_url: 'https://admin.test',
          staff_url: null,
        },
        token: 'token',
        platformKey: 'key',
        onProgress: async () => {},
        assertRunning: async () => {},
      },
      {
        prepareSource: async () => ({ directory, source: directory }),
        execCommand: async (file, args) => {
          uploaded.push(args[args.indexOf('--service') + 1]);
          return { stdout: JSON.stringify({ deploymentId: uuid }) };
        },
        waitForDeployment: async () => {},
        waitForComponent: async (component, url) => {
          assert.ok(url);
          verified.push(component);
        },
      },
    );
    assert.deepEqual(uploaded, ['backend-id', 'admin-id', 'employee-id']);
    assert.deepEqual(verified, [
      'backend',
      'admin',
      'employee',
      'backend',
      'admin',
      'employee',
    ]);
  } finally {
    if (prior) process.env.RAILWAY_CLI_PATH = prior;
    else delete process.env.RAILWAY_CLI_PATH;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
test('upload acceptance is not deployment success, including same-version redeploys', async () => {
  assert.equal(
    deploymentIdFromOutput(JSON.stringify({ deploymentId: uuid })),
    uuid,
  );
  assert.throws(
    () => deploymentIdFromOutput('{"status":"accepted"}'),
    /identifiable deployment/,
  );
  await assert.rejects(
    waitForDeployment(uuid, 'token', async () => {}, {
      fetcher: async () =>
        response({ data: { deployment: { id: uuid, status: 'FAILED' } } }),
    }),
    /FAILED/,
  );
  let checks = 0;
  await waitForDeployment(uuid, 'token', async () => {}, {
    sleep: async () => {},
    fetcher: async () =>
      response({
        data: {
          deployment: {
            id: uuid,
            status: ++checks === 1 ? 'BUILDING' : 'SUCCESS',
          },
        },
      }),
  });
  assert.equal(checks, 2);
});
test('a failed backend deployment stops the venue before either frontend upload', async () => {
  const prior = process.env.RAILWAY_CLI_PATH;
  process.env.RAILWAY_CLI_PATH = 'railway';
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'release-failure-test-'),
  );
  const uploaded = [];
  try {
    await assert.rejects(
      deployRelease(
        {
          release,
          target: {
            project_id: uuid,
            environment_id: uuid,
            services: {
              backend: 'backend-id',
              admin: 'admin-id',
              staff: 'staff-id',
            },
          },
          venue: {
            api_url: 'https://api',
            admin_url: 'https://admin',
            staff_url: 'https://staff',
          },
          token: 'token',
          platformKey: 'key',
          onProgress: async () => {},
          assertRunning: async () => {},
        },
        {
          prepareSource: async () => ({ directory, source: directory }),
          execCommand: async (file, args) => {
            uploaded.push(args[args.indexOf('--service') + 1]);
            return { stdout: JSON.stringify({ deploymentId: uuid }) };
          },
          waitForDeployment: async () => {
            throw new Error('FAILED');
          },
          waitForComponent: async () => {
            throw new Error('Should not verify an unsuccessful deployment');
          },
        },
      ),
      /FAILED/,
    );
    assert.deepEqual(uploaded, ['backend-id']);
    await assert.rejects(fs.access(directory));
  } finally {
    if (prior) process.env.RAILWAY_CLI_PATH = prior;
    else delete process.env.RAILWAY_CLI_PATH;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
