# CentralPass Console

Internal operations and entitlement control for CentralPass venue deployments.

The console is intentionally a **remote control, not a vault**. It stores only
CentralPass's own per-venue `PLATFORM_API_KEY`, encrypted with AES-256-GCM. It
does not store or display client Stripe keys, venue admin passwords, JWT
secrets, R2 credentials, SMS credentials, customer records, orders or menus.

## What is included

- Mandatory email/password plus TOTP authenticator sign-in; no public signup.
- PostgreSQL-backed venue registry and session storage.
- Parallel venue checks with an independent five-second timeout per venue.
- Fleet summary for availability, plan, orders today and customer count.
- Loud `unconfigured` plan warning.
- Write-only, encrypted platform keys that are never returned to the browser.
- Venue detail with customer/admin/staff shortcuts.
- Plan-aware feature controls, locked core features and dependency handling.
- Named confirmation before every entitlement change.
- Local cross-venue audit plus the venue's own entitlement audit.
- Per-venue contract records with encrypted PDF storage, commercial terms,
  renewal dates and missing/expiring agreement warnings.
- Responsive desktop/mobile UI aligned to the CentralPass marketing brand.

## Venue contracts

Each venue detail page can store one or more agreement PDFs with the contract
status, effective and expiry dates, signed date, setup/monthly fees, renewal
terms and internal notes. PDFs are limited to 10 MB, validated as PDF files and
encrypted with AES-256-GCM before being stored in Console's PostgreSQL database.
The original file cannot be overwritten or deleted through Console; upload a
new agreement and update the old status so the legal history remains intact.

Uploads, metadata changes and downloads are written to `console_audit`.
Contract summaries also feed the venue list and the **Needs attention** count:
missing, expiring-within-60-days and expired agreements are surfaced.

Because the same `ENCRYPTION_KEY` protects platform keys and contract files:

- Keep a recoverable copy of `ENCRYPTION_KEY` in the CentralPass password
  manager. Losing it makes existing encrypted records unrecoverable.
- Enable scheduled backups for Console's PostgreSQL service and test a restore.
- Store executed PDFs here, but have the services agreement itself drafted or
  reviewed by an Australian commercial lawyer.

## Local setup on Windows

Requirements: Node 20.19+ and PostgreSQL.

```powershell
Set-Location C:\Users\agarw\claude_projects\centralpass\console
Copy-Item .env.example .env
npm.cmd install
```

Create a dedicated database. Do not point Console at a venue database.

Generate two different random secrets:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Put one in `ENCRYPTION_KEY` and the other in `SESSION_SECRET` in `.env`, then set
`DATABASE_URL`. Run the migration:

```powershell
npm.cmd run db:migrate
```

Create the first operator account. The command prints a TOTP secret and
authenticator URI once; add it to 1Password, Bitwarden, Google Authenticator or
another TOTP app before removing `ADMIN_PASSWORD` from `.env`.

```powershell
$env:ADMIN_EMAIL='you@centralpass.au'
$env:ADMIN_NAME='Your name'
$env:ADMIN_PASSWORD='use-a-long-unique-password'
npm.cmd run admin:create
Remove-Item Env:ADMIN_PASSWORD
```

Start the API and Vite development server:

```powershell
npm.cmd run dev
```

Open `http://localhost:5173`.

## Production deployment on Railway

Deploy this `console` folder as a separate private repository and a separate
Railway project. It must not be deployed with any venue platform.

1. Create a Railway project with a Postgres service and a Node service connected
   to this repository.
2. Set the service's root directory to the repository root (or `console` if this
   remains inside a larger repository).
3. Use build command `npm ci && npm run build` and start command `npm start`.
4. Set health check path `/api/console/health`.
5. Add these service variables:

   - `DATABASE_URL=${{Postgres.DATABASE_URL}}`
   - `NODE_ENV=production`
   - `APP_ORIGIN=https://console.centralpass.au` (or the exact domain chosen)
   - `ENCRYPTION_KEY=<64 hex characters>`
   - `SESSION_SECRET=<a different 64 hex characters>`

6. Attach a private-looking subdomain such as `console.centralpass.au`. Do not
   link it from the public marketing site. Add access control at Cloudflare if
   desired, but keep Console's own password plus TOTP requirement in place.
7. Run `npm run admin:create` once with the Railway variables injected, then
   remove the temporary `ADMIN_PASSWORD` variable.
8. Verify `https://console.centralpass.au/api/console/health`, sign in, and add
   the first venue through the UI.

The app applies its idempotent SQL migration during startup. A production build
serves the React app and the `/api/console/*` routes from the same origin.

## Connect a venue

The customer website does **not** connect to CentralPass Console. Its own venue
backend is the hub. Console connects server-to-server to that backend.

See [Connecting venues and websites](docs/CONNECTING_VENUES.md) for the exact
per-client setup.

## Verification

```powershell
npm.cmd run check
npm.cmd audit
```

`npm run check` runs the encryption/TOTP tests and a production Vite build.
