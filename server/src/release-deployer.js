"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { concurrencyLimit, runLimited } = require("./release-concurrency");
const exec = promisify(execFile);
const FOLDERS = {
  backend: "backend",
  admin: "admin-portal",
  staff: "staff-dashboard",
  employee: "employee-portal",
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Do not hand the Console database, encryption/session secrets or other venues'
// credentials to a deployment subprocess. The CLI needs only its project token.
function cliEnvironment(token) {
  const env = {};
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return {
    ...env,
    ...(token ? { RAILWAY_TOKEN: token } : {}),
    CI: "true",
    NO_COLOR: "1",
  };
}
async function run(file, args, options = {}) {
  try {
    return await exec(file, args, {
      timeout: 180000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
      ...options,
    });
  } catch {
    throw new Error(
      `${path.basename(file)} could not complete ${args[0]}. Check worker access and Railway deployment logs.`,
    );
  }
}
async function prepareSource(
  release,
  {
    repository = process.env.RELEASE_REPOSITORY_URL,
    githubToken = process.env.RELEASE_GITHUB_TOKEN,
    execCommand = run,
  } = {},
) {
  if (
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(
      repository || "",
    )
  )
    throw new Error(
      "Configure RELEASE_REPOSITORY_URL as the trusted GitHub Platform repository HTTPS URL.",
    );
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "centralpass-release-"),
  );
  try {
    const git = path.join(directory, "repository");
    const gitEnv = cliEnvironment();
    gitEnv.GIT_TERMINAL_PROMPT = "0";
    if (githubToken) {
      gitEnv.GIT_CONFIG_COUNT = "1";
      gitEnv.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
      gitEnv.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${githubToken}`).toString("base64")}`;
    }
    await execCommand("git", ["init", git], { env: gitEnv });
    await execCommand(
      "git",
      ["-C", git, "fetch", "--depth=1", repository, release.commit_sha],
      { env: gitEnv },
    );
    const { stdout } = await execCommand(
      "git",
      ["-C", git, "rev-parse", "FETCH_HEAD"],
      { env: gitEnv },
    );
    if (stdout.trim() !== release.commit_sha)
      throw new Error("Fetched source does not match the approved commit.");
    const archive = path.join(directory, "source.tar");
    await execCommand(
      "git",
      [
        "-C",
        git,
        "archive",
        "--format=tar",
        `--output=${archive}`,
        release.commit_sha,
      ],
      { env: gitEnv },
    );
    const source = path.join(directory, "source");
    await fs.mkdir(source);
    await execCommand("tar", ["-xf", archive, "-C", source], {
      env: cliEnvironment(),
    });
    const manifest = JSON.stringify({
      version: release.version,
      commit: release.commit_sha,
    });
    // Require approval support in the release. An older commit must not silently
    // replace a backend with a version that bypasses tablet approval checks.
    await fs.access(path.join(source, "backend/src/lib/releaseApproval.js"));
    await fs.writeFile(path.join(source, "backend/release.json"), manifest);
    for (const folder of [
      "admin-portal",
      "staff-dashboard",
      "employee-portal",
    ]) {
      await fs.mkdir(path.join(source, folder, "public"), { recursive: true });
      await fs.writeFile(
        path.join(source, folder, "public/release.json"),
        manifest,
      );
      const index = path.join(source, folder, "index.html");
      const html = await fs.readFile(index, "utf8");
      if (!html.includes("</head>"))
        throw new Error(`Cannot stamp ${folder} release.`);
      await fs.writeFile(
        index,
        html.replace(
          "</head>",
          `<meta name="centralpass-release" content="${release.commit_sha}"></head>`,
        ),
      );
    }
    return { directory, source };
  } catch (e) {
    await fs.rm(directory, { recursive: true, force: true });
    throw e;
  }
}
async function fetchChecked(url, options = {}, fetcher = fetch) {
  const response = await fetcher(url, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(10000),
    headers: { "Cache-Control": "no-cache", ...options.headers },
  });
  if (!response.ok)
    throw new Error("Service has not returned a healthy response.");
  return response;
}
async function verifyComponent(component, url, release, key, fetcher = fetch) {
  const base = url.replace(/\/+$/, "");
  if (component === "backend") {
    const response = await fetchChecked(
      `${base}/api/platform/status`,
      { headers: { "X-Platform-Key": key } },
      fetcher,
    );
    const payload = await response.json();
    if (
      payload.status !== "ok" ||
      payload.release?.commit !== release.commit_sha ||
      payload.release?.version !== release.version ||
      payload.release?.approvalProtocol !== 1
    )
      throw new Error("Backend has not reached the approved release.");
  } else {
    const response = await fetchChecked(
      `${base}/release.json?check=${Date.now()}`,
      {},
      fetcher,
    );
    const payload = await response.json();
    const html = await (
      await fetchChecked(`${base}/?release_check=${Date.now()}`, {}, fetcher)
    ).text();
    if (
      payload.commit !== release.commit_sha ||
      payload.version !== release.version ||
      !html.includes(
        `name="centralpass-release" content="${release.commit_sha}"`,
      )
    )
      throw new Error(
        `${component} portal has not reached the approved release.`,
      );
  }
}
async function waitForComponent(
  component,
  url,
  release,
  key,
  {
    fetcher = fetch,
    timeoutMs = Number(process.env.RELEASE_VERIFY_TIMEOUT_MS || 900000),
    sleep = delay,
  } = {},
) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      await verifyComponent(component, url, release, key, fetcher);
      return;
    } catch {}
    await sleep(5000);
  }
  throw new Error(
    `${component} did not reach the approved version before the timeout. Inspect Railway before retrying.`,
  );
}
function deploymentIdFromOutput(stdout) {
  for (const line of String(stdout).trim().split(/\r?\n/)) {
    try {
      const item = JSON.parse(line);
      if (/^[0-9a-f-]{36}$/i.test(item.deploymentId || ""))
        return item.deploymentId;
    } catch {}
  }
  throw new Error(
    "Railway accepted no identifiable deployment. Inspect Railway before retrying.",
  );
}
async function waitForDeployment(
  id,
  token,
  assertRunning,
  {
    fetcher = fetch,
    sleep = delay,
    timeoutMs = Number(process.env.RELEASE_VERIFY_TIMEOUT_MS || 900000),
  } = {},
) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await assertRunning();
    const response = await fetchChecked(
      "https://backboard.railway.com/graphql/v2",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Project-Access-Token": token,
        },
        body: JSON.stringify({
          query:
            "query Deployment($id: String!) { deployment(id: $id) { id status } }",
          variables: { id },
        }),
      },
      fetcher,
    );
    const payload = await response.json();
    if (payload.errors?.length || payload.data?.deployment?.id !== id)
      throw new Error(
        "Could not verify the Railway deployment. Inspect Railway before retrying.",
      );
    const status = payload.data.deployment.status;
    // SLEEPING is a healthy deployment of a service with app sleeping on; the
    // version checks that follow wake it.
    if (status === "SUCCESS" || status === "SLEEPING") return;
    if (status === "NEEDS_APPROVAL")
      throw new Error(
        `Railway is holding deployment ${id} for approval in Railway. Approve or remove it there, then resolve this update.`,
      );
    if (["FAILED", "CRASHED", "REMOVED", "SKIPPED"].includes(status))
      throw new Error(
        `Railway deployment ${id} ended with ${status}. Inspect Railway before retrying.`,
      );
    await sleep(5000);
  }
  throw new Error(
    `Railway deployment ${id} did not finish before the timeout. Inspect Railway before retrying.`,
  );
}
async function deployRelease(
  {
    release,
    target,
    venue,
    token,
    platformKey,
    repository,
    githubToken,
    onProgress,
    assertRunning,
  },
  deps = {},
) {
  const prepare = deps.prepareSource || prepareSource;
  const command = deps.execCommand || run;
  const verify = deps.waitForComponent || waitForComponent;
  const waitDeployment = deps.waitForDeployment || waitForDeployment;
  const portalConcurrency = concurrencyLimit(
    deps.portalConcurrency ?? process.env.RELEASE_PORTAL_CONCURRENCY,
    3,
    3,
  );
  const cli =
    process.env.RAILWAY_CLI_PATH ||
    (process.platform === "win32" ? null : "railway");
  if (!cli)
    throw new Error(
      "Set RAILWAY_CLI_PATH to the Railway executable on Windows.",
    );
  const prepared = await prepare(release, { repository, githubToken });
  try {
    const urls = {
      backend: venue.api_url,
      admin: venue.admin_url,
      staff: venue.staff_url,
      employee: target.employee_url,
    };
    async function deployComponent(component) {
      await assertRunning();
      await onProgress(component, "uploading");
      // Upload the full monorepo so shared/ sync scripts see the same approved
      // source. Each Railway service must have its component root configured.
      const result = await command(
        cli,
        [
          "up",
          prepared.source,
          "--path-as-root",
          "--project",
          target.project_id,
          "--environment",
          target.environment_id,
          "--service",
          target.services[component],
          "--detach",
          "--json",
          "--message",
          `Console ${release.version} ${release.commit_sha}`,
        ],
        { cwd: prepared.source, env: cliEnvironment(token) },
      );
      const deploymentId = deploymentIdFromOutput(result.stdout);
      await onProgress(`${component}_deployment`, deploymentId);
      await onProgress(component, "building");
      await waitDeployment(deploymentId, token, assertRunning);
      await onProgress(component, "verifying");
      await verify(component, urls[component], release, platformKey);
      await onProgress(component, "verified");
    }
    // The new backend must be healthy and speak the approval protocol before
    // any frontend changes. Frontends are independent once that gate passes.
    await deployComponent("backend");
    const portals = Object.keys(FOLDERS).filter(
      (component) => component !== "backend" && target.services[component],
    );
    await runLimited(
      portals.map((component) => () => deployComponent(component)),
      portalConcurrency,
    );
    await assertRunning();
    // Recheck every service after the sequence; success is not just an upload.
    for (const component of Object.keys(target.services))
      await verify(component, urls[component], release, platformKey);
    if (release.tablet_bundle) {
      await onProgress("tablet", "approving");
      await fetchChecked(
        `${venue.api_url.replace(/\/+$/, "")}/api/platform/releases/tablet`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "X-Platform-Key": platformKey,
          },
          body: JSON.stringify({
            bundle: release.tablet_bundle,
            releaseCommit: release.commit_sha,
          }),
        },
        deps.fetcher || fetch,
      );
      await onProgress("tablet", "approved");
    }
  } finally {
    await fs.rm(prepared.directory, { recursive: true, force: true });
  }
}
module.exports = {
  cliEnvironment,
  prepareSource,
  verifyComponent,
  waitForComponent,
  waitForDeployment,
  deploymentIdFromOutput,
  deployRelease,
};
