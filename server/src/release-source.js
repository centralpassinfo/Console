'use strict';
const { pool } = require('./db');
const { encryptSecret, decryptSecret } = require('./crypto');
const { recordAudit } = require('./audit');
const DEFAULT_REPOSITORY =
  'https://github.com/CentralPass/centralpass-platform.git';
const WORKFLOW = 'console-releases.yml';
function repositoryParts(url) {
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
      url || '',
    );
  if (!match)
    throw Object.assign(
      new Error('Configure the trusted Platform GitHub repository HTTPS URL.'),
      { status: 400 },
    );
  return { owner: match[1], repo: match[2] };
}
async function sourceConfig(db = pool) {
  const {
    rows: [row],
  } = await db.query('SELECT * FROM console_release_source WHERE id=1');
  return {
    repository:
      row?.repository_url ||
      process.env.RELEASE_REPOSITORY_URL ||
      DEFAULT_REPOSITORY,
    token: row?.github_token
      ? decryptSecret(row.github_token)
      : process.env.RELEASE_GITHUB_TOKEN || '',
    row,
  };
}
async function publicSource(db = pool) {
  const source = await sourceConfig(db);
  const parts = repositoryParts(source.repository);
  return {
    repository: `${parts.owner}/${parts.repo}`,
    connected: Boolean(source.token),
    lastChecked: source.row?.last_sync_at || null,
    error: source.row?.last_sync_error || null,
    message: source.row?.last_sync_message || null,
  };
}
async function githubGet(path, token, fetcher = fetch) {
  let response;
  try {
    response = await fetcher(`https://api.github.com${path}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  } catch {
    throw Object.assign(
      new Error(
        'GitHub could not be reached. Try checking for releases again.',
      ),
      { status: 502 },
    );
  }
  if (!response.ok)
    throw Object.assign(
      new Error(
        response.status === 401 ||
          response.status === 403 ||
          response.status === 404
          ? 'GitHub access could not be verified. Use a token with Contents and Actions read access to the Platform repository.'
          : 'GitHub could not return release information.',
      ),
      { status: 502 },
    );
  try {
    return await response.json();
  } catch {
    throw Object.assign(
      new Error('GitHub returned unreadable release information.'),
      { status: 502 },
    );
  }
}
async function testedCommit(source, fetcher = fetch) {
  const { owner, repo } = repositoryParts(source.repository),
    base = `/repos/${owner}/${repo}`;
  const commit = await githubGet(`${base}/commits/main`, source.token, fetcher);
  if (!/^[a-f0-9]{40}$/.test(commit.sha || ''))
    throw new Error('GitHub returned an invalid Platform commit.');
  const result = await githubGet(
    `${base}/actions/workflows/${WORKFLOW}/runs?branch=main&head_sha=${commit.sha}&per_page=20`,
    source.token,
    fetcher,
  );
  const runs = (result.workflow_runs || []).filter(
    (run) =>
      run.head_sha === commit.sha &&
      run.head_branch === 'main' &&
      ['push', 'workflow_dispatch'].includes(run.event) &&
      run.path?.split('@')[0] === `.github/workflows/${WORKFLOW}` &&
      run.head_repository?.full_name?.toLowerCase() ===
        `${owner}/${repo}`.toLowerCase(),
  );
  // A later failed/running rerun invalidates an earlier successful attempt.
  const run = runs.sort(
    (a, b) =>
      Number(b.run_number) - Number(a.run_number) ||
      Number(b.run_attempt) - Number(a.run_attempt),
  )[0];
  if (!run || run.status !== 'completed' || run.conclusion !== 'success')
    return {
      commit,
      run: null,
      message:
        run?.conclusion === 'failure'
          ? 'The latest Platform build failed. It cannot be released.'
          : 'Waiting for the latest main commit to pass tests and builds.',
    };
  if (
    !Number.isSafeInteger(run.id) ||
    run.id < 1 ||
    !Number.isSafeInteger(run.run_number) ||
    run.run_number < 1
  )
    throw new Error('GitHub returned invalid build information.');
  run.html_url = `https://github.com/${owner}/${repo}/actions/runs/${run.id}`;
  const latest = await githubGet(`${base}/commits/main`, source.token, fetcher);
  if (latest.sha !== commit.sha)
    return {
      commit,
      run: null,
      message:
        'A newer Platform commit is being checked. Check again after CI finishes.',
    };
  return {
    commit,
    run,
    message: 'The latest tested Platform release is available.',
  };
}
async function connectSource(
  token,
  actor,
  { db = pool, fetcher = fetch } = {},
) {
  if (
    typeof token !== 'string' ||
    token.length < 20 ||
    token.length > 512 ||
    /\s/.test(token)
  )
    throw Object.assign(
      new Error('Paste a GitHub token with Contents and Actions read access.'),
      { status: 400 },
    );
  const existing = await sourceConfig(db);
  await testedCommit({ ...existing, token }, fetcher);
  await db.query(
    `INSERT INTO console_release_source(id,repository_url,github_token) VALUES(1,$1,$2)
    ON CONFLICT(id) DO UPDATE SET github_token=$2,last_sync_error=NULL,updated_at=NOW()`,
    [existing.repository, encryptSecret(token)],
  );
  await recordAudit(
    {
      actor,
      action: 'release.source.connected',
      detail: { repository: existing.repository },
    },
    db,
  );
}
async function syncSource({ dbPool = pool, fetcher = fetch } = {}) {
  const db = await dbPool.connect();
  let locked = false,
    inTransaction = false,
    source;
  try {
    locked = (
      await db.query(
        "SELECT pg_try_advisory_lock(hashtext('console_release_source_sync')) AS locked",
      )
    ).rows[0].locked;
    if (!locked)
      return { message: 'Release discovery is already running.', imported: 0 };
    source = await sourceConfig(db);
    if (!source.token)
      return {
        message:
          'Connect GitHub once to discover tested releases automatically.',
        imported: 0,
      };
    const tested = await testedCommit(source, fetcher);
    let imported = 0;
    await db.query('BEGIN');
    inTransaction = true;
    if (tested.run) {
      const version = `commit-${tested.commit.sha}`;
      const notes = String(
        tested.commit.commit?.message ||
          tested.run.display_title ||
          'Platform update',
      ).slice(0, 12000);
      const {
        rows: [created],
      } = await db.query(
        `INSERT INTO console_releases(version,commit_sha,notes,created_by,source_run_id,source_run_number,source_run_url)
        VALUES($1,$2,$3,'GitHub CI',$4,$5,$6) ON CONFLICT(version) DO NOTHING RETURNING id`,
        [
          version,
          tested.commit.sha,
          notes,
          tested.run.id,
          tested.run.run_number,
          tested.run.html_url,
        ],
      );
      const {
        rows: [saved],
      } = await db.query(
        'SELECT id,commit_sha FROM console_releases WHERE version=$1',
        [version],
      );
      if (saved.commit_sha !== tested.commit.sha)
        throw new Error(
          'This release name is already assigned to different source.',
        );
      await db.query(
        'UPDATE console_releases SET source_run_id=$2,source_run_number=$3,source_run_url=$4 WHERE id=$1',
        [saved.id, tested.run.id, tested.run.run_number, tested.run.html_url],
      );
      if (created) {
        imported = 1;
        await recordAudit(
          {
            actor: 'GitHub release discovery',
            action: 'release.discovered',
            detail: {
              releaseId: created.id,
              commit: tested.commit.sha,
              runId: tested.run.id,
            },
          },
          db,
        );
      }
    }
    await db.query(
      `INSERT INTO console_release_source(id,repository_url,last_sync_at,last_sync_message) VALUES(1,$1,NOW(),$2)
      ON CONFLICT(id) DO UPDATE SET last_sync_at=NOW(),last_sync_message=$2,last_sync_error=NULL`,
      [source.repository, tested.message],
    );
    await db.query('COMMIT');
    inTransaction = false;
    return { message: tested.message, imported };
  } catch (error) {
    if (inTransaction) await db.query('ROLLBACK');
    if (locked && source)
      await db.query(
        `INSERT INTO console_release_source(id,repository_url,last_sync_at,last_sync_error) VALUES(1,$1,NOW(),$2)
      ON CONFLICT(id) DO UPDATE SET last_sync_at=NOW(),last_sync_error=$2`,
        [source.repository, error.message],
      );
    throw error;
  } finally {
    if (locked)
      await db
        .query(
          "SELECT pg_advisory_unlock(hashtext('console_release_source_sync'))",
        )
        .catch(() => {});
    db.release();
  }
}
module.exports = {
  DEFAULT_REPOSITORY,
  repositoryParts,
  sourceConfig,
  publicSource,
  githubGet,
  testedCommit,
  connectSource,
  syncSource,
};
