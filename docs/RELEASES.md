# Control Platform updates per venue

Console now has **Releases**, with individual selection, search, select-all for
eligible visible venues, and bulk approval. Selection survives search changes;
the confirmation lists every selected venue, including those outside the filter.
A bulk approval is atomic in Console: either every selected venue is queued or
none are. Deployment is independent per venue and sequential within a venue.

Backend and owner dashboard services are required. Staff and employee portals
are optional: choose **Not used** for either absent portal. Console configures,
deploys and verifies only selected services, and requires portal URLs only for
those services. Reconnecting a venue preserves its saved optional selections.

## Automatic updates for selected venues

Every venue starts with **Automatic updates off**. The switch on each venue row
changes only that venue. Turning it on queues the latest available release when
the venue is ready, then new published releases deploy without a separate
approval. Turning it off cancels queued automatic work and restores manual
approval; already-started deployments finish. The confirmation names the venue
and explains this behavior. Switch changes and automatic deployments are audited.

Automatic work uses the same worker, pinned commit, health/version verification,
and tablet checksum approval as manual work. It waits behind manual/scheduled
updates and interrupted jobs. An update which was cancelled or failed is not
retried in a loop. Explicitly turning the policy off and back on can resume an
automatic update cancelled by opting out. Other failures need review and a new
manual approval. Newer published releases supersede deferred older releases.

### Normal release process

1. Commit **and push** the Platform code to GitHub `main` (or merge a PR into
   `main`). A local commit alone is not visible to Console.
2. The Platform `Validate and publish Console release` workflow runs backend
   tests and builds the admin, staff and employee portals.
3. Console discovers the successful build for the **current** main commit.
   The release name, pinned commit, commit-message notes and CI link are filled
   automatically. Failed, pending, fork and superseded builds are not imported.
4. Venues with Automatic updates on queue the release. For other venues, select
   one or several, then approve now or schedule it.
5. The worker deploys and verifies each component. **Succeeded** means the
   deployment and served version were verified; pushing code is not proof it
   is live.

On **Releases → Platform releases**, connect GitHub once using a fine-grained
token for the Platform repository with **Contents: read** and **Actions: read**.
It is encrypted in Console's database and shared by the API and worker, never
returned to the browser. This is one connection for all venues, not one per
venue. An organisation may require approval of the token. The worker polls
about every minute between rollouts; **Check for releases** checks immediately.
The default repository is `CentralPass/centralpass-platform`; an operator can
override `RELEASE_REPOSITORY_URL` before the first connection. The form cannot
redirect fetching to an arbitrary repository. `RELEASE_GITHUB_TOKEN` is an
optional environment fallback, with the same read permissions.

### Optional CI push publication

Platform includes `.github/workflows/console-releases.yml`. Pushes to `main`
run backend tests and build all three portals. Only after these pass does CI
publish the exact tested commit to Console if the optional settings below are
configured. Discovery above also works when this publication step is skipped.
Concurrency cancellation and a
current-main check prevent an older CI run from publishing over a newer commit.
Publication is idempotent. Automatic venues queue it; manual venues await approval.

Set `RELEASE_PUBLISH_TOKEN` on the Console API to a separate random secret of at
least 32 characters. On the Platform GitHub repository set the Actions variable
`CENTRALPASS_CONSOLE_URL` to the Console HTTPS origin and the Actions secret
`CONSOLE_RELEASE_PUBLISH_TOKEN` to the same secret. This credential only permits
release publication, not venue settings or other Console actions. With these
unset the workflow validates code and explicitly skips publication. A passing
Git push alone does not prove that CI, publication or a venue deployment ran.

Railway's independent GitHub automatic deployments must remain **disabled for
all venues**, including automatic ones: Console owns the policy and worker queue.

## One-time activation

These source changes do not change any live deployment settings. Complete this
setup before claiming that production updates require Console approval:

1. Commit and push the Platform changes in this implementation, including
   `070_console_release_approvals.sql` and `src/lib/releaseApproval.js`.
   Never register an uncommitted working tree as a release. Only a complete,
   reviewed, tested 40-character commit from the configured repository is used.
2. Use **Releases → Configure → Connect Railway** for each venue. Paste its
   production-environment project token, click **Find services**, review the
   discovered project/environment and service names, then **Connect venue**.
   Console sets the selected services' component root folders and disables
   their Railway GitHub automatic deployments, then reads both settings back
   before saving. IDs and public portal addresses are discovered automatically;
   existing venue URLs are preserved. Ambiguous service matches require a
   dropdown choice. Database/image services are excluded. Manual ID setup is
   still available under Advanced. One venue token is still needed per isolated
   Railway project, once. It is encrypted and can be reused when reconnecting.
   Stop any already queued deployments and disable independent CI/deploy
   scripts too. Changing settings does not cancel an existing deployment.
   Keep credentials restricted
   to operators and the release worker. A person with Railway deployment access
   can still deliberately bypass Console; this is a deployment workflow gate.
   Staging can continue updating automatically.
3. Automatic setup sets each selected service's Root Directory to its matching component:
   `backend`, `admin-portal`, `staff-dashboard`, or `employee-portal`.
   Existing per-venue variables, `VITE_API_URL`, build/start commands, CORS,
   payment configuration and domains remain on those services. Configure
   Railway health checks and ensure Vite's public directory is copied normally.
   The worker uploads the complete monorepo so shared source remains available.
4. Deploy this Console build. Its normal startup migration creates release
   tables in **Console's own database**, not a venue database.
5. Add a separate worker service using `Dockerfile.release-worker`. Set
   `DATABASE_URL`, `DATABASE_SSL` if needed, `ENCRYPTION_KEY` to the Console
   values. The worker uses the shared GitHub connection saved in Console.
   `RELEASE_REPOSITORY_URL` and `RELEASE_GITHUB_TOKEN` are optional environment
   fallbacks; do not include credentials in repository URLs. The worker does
   not need the Console session secret or a public port.
   Use a 30-second shutdown grace period or longer. Keep workers running;
   scheduled work is durable in Postgres but starts only when a worker is online.
6. Connect GitHub once under **Platform releases** and check for releases. No
   version or SHA entry is needed for normal web releases. Configure venue
   connections from step 2 after Console is deployed. If setup is interrupted,
   some Railway settings may already have changed; reconnect to verify and
   complete the connection. Failed connection attempts are audited.
7. Discover the first release including these Platform changes. Approve a test
   venue first, confirm all portals and real workflows, then approve others.
   Use backward-compatible database migrations: the backend updates first and
   existing browser sessions can continue using the previous frontend code.

On Windows a worker can run with `npm.cmd run releases:worker`; set
`RAILWAY_CLI_PATH` to the installed native `railway.exe` (see `.env.example`).
Git, tar, Node and Railway CLI 5.1.0 must be installed. The Docker worker includes
these dependencies. Run the normal Console migration before starting the worker.

## Release and approval

Normal web releases appear from successful GitHub builds. **Advanced → Register
release manually** remains available for deliberate manual releases and installed
tablet bundles; it requires a unique version, full commit SHA and release notes.
Manual registration also queues opted-in automatic venues immediately, so use
a tested commit. These records cannot be edited through the API. Code is fetched from the worker's
configured repository and the fetched commit is checked for exact equality.
Changing `main` later cannot change an approved commit. The worker stamps a
release manifest into each exported component before upload. Dependencies and
build environments must remain controlled; this is a pinned source release,
not a claim of bit-for-bit reproducible build artifacts.

Select one or multiple venues, optionally schedule a Sydney date/time (stored in
UTC, within 90 days), review the exact venue list and approve. The form and
history explicitly use Sydney time regardless of the server/browser timezone;
skipped or repeated daylight-saving times are rejected. Manual approval never
selects every venue by default. Automatic approval only applies to venues
explicitly opted in. Suspended/offboarded/unconfigured venues,
and venues with an update in flight, cannot be approved. Duplicate concurrent
requests cannot create multiple active rollouts for the same venue.

The worker uploads backend first, verifies its authenticated status and release
protocol, then updates admin, staff and optional employee portals. Verification
waits for the specific Railway deployment ID to succeed, then checks the public
manifest **and** the stamped HTML. All services are rechecked
at the end. A successful upload alone is not success. Progress and approval
identity are recorded per venue. The list shows the last *verified* release;
it is historical evidence, not continuous monitoring of manual Railway changes.
Open browser sessions receive frontend updates on their next reload; the worker
does not force a reload during service. Customer storefronts and native APKs are
separate products and are not deployed by this worker.

Queued work may be cancelled. A failed/expired worker or unverified upload is
marked **interrupted** and blocks another release. Stop the previous worker and
any queued/building Railway deployments, inspect actual versions and then use
**Resolve**. No automatic retry or database rollback occurs. A new approval can
then redeploy a compatible release. Incompatible database changes require a
specific recovery plan; approving old code does not undo migrations.

## Installed tablet bundles

Migration 070 preserves each currently active bundle as the initial approved
bundle. Fresh uploads are inactive; venue-admin activation and rollback now
return an explicit Console approval error. The device update and download
endpoints only serve the active bundle recorded in the approval table.

To include a tablet update, upload the inactive ZIP through each venue's existing
admin bundle API first (`activate=false`). Create the Console release with the
tablet app ID, channel, bundle version and exact ZIP SHA-256 checksum. Every
selected venue must have those bytes staged. Once the web rollout is verified,
the worker calls the platform-key-only approval endpoint, which checks the
running release commit and exact uploaded bundle, activates it transactionally
and records the approval. If no tablet bundle is specified, the existing tablet
bundle remains approved. Installation happens on the tablet's normal update
cycle; Console records publication approval, not proof of device installation.

## Verification

`npm run check` runs unit tests and the production Console build. Optional real
PostgreSQL tests accept only fresh local databases named
`centralpass_release_test...` through `RELEASE_TEST_DATABASE_URL`. Platform's
tablet integration tests use `TABLET_RELEASE_TEST_DATABASE_URL` and fresh local
`centralpass_tablet_test...` databases. No production credentials are needed.
Discovery integration tests use `DISCOVERY_TEST_DATABASE_URL` with a fresh local
`centralpass_release_test...` database; external provider responses are simulated.

Provider behavior follows Railway's [CLI deployment documentation](https://docs.railway.com/cli/deploying),
[automatic deployment controls](https://docs.railway.com/deployments/github-autodeploys),
and [project-token authentication](https://docs.railway.com/guides/lock-down-production-project).
Connection discovery uses Railway's [service API](https://docs.railway.com/integrations/api/manage-services)
and the [CLI 5.1.0 GraphQL schema](https://github.com/railwayapp/cli/blob/v5.1.0/src/gql/schema.json).
The CLI is pinned to 5.1.0; its detached upload returns a deployment ID, which the
worker checks using the provider API before checking the running application.
