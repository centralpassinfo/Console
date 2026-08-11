# Connecting venues and client websites

## The important architecture rule

Do not connect a customer website, owner dashboard or staff dashboard directly
to CentralPass Console.

```text
Customer website  ─┐
Owner dashboard   ─┼──> that venue's API ──> that venue's Postgres / Stripe
Staff dashboard   ─┘          ↑
                               │ server-to-server, X-Platform-Key
CentralPass Console browser ──> CentralPass Console API
                               │
                               └──────────────> that venue's /api/platform/*
```

This keeps `PLATFORM_API_KEY` out of every browser. It also preserves the
per-venue isolation CentralPass relies on: a problem at one venue does not expose
another venue's payments, staff access or customer data.

## One-time setup for each venue backend

1. Confirm the platform backend contains these existing routes:

   - `GET /health`
   - `GET /api/platform/status`
   - `GET /api/platform/features`
   - `PUT /api/platform/features`
   - `DELETE /api/platform/features/:key`
   - `GET /api/platform/audit`

2. Generate a new key that is unique to this venue:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

3. In that venue's Railway **backend service**, set:

   ```text
   PLATFORM_API_KEY=<the new unique key>
   PLAN=starter
   ```

   Use `starter`, `pro` or `premium`. Always set `PLAN` explicitly; a missing or
   misspelled value becomes `unconfigured` and grants every feature.

4. Give the backend a stable API domain, for example:

   ```text
   https://api.theirvenue.com.au
   ```

   Prefer the venue's `api.` subdomain over a hard-coded `railway.app` URL so the
   host can change later without rebuilding every frontend.

5. Redeploy the backend and verify:

   ```powershell
   Invoke-RestMethod 'https://api.theirvenue.com.au/health'
   Invoke-RestMethod `
     -Uri 'https://api.theirvenue.com.au/api/platform/status' `
     -Headers @{ 'X-Platform-Key' = '<the new unique key>' }
   ```

   The second response should include `status`, `venue`, `plan`, `registry`,
   `overrides`, `features`, `counts` and `ts`.

6. Sign in to CentralPass Console, choose **Add venue**, and enter:

   - Venue name and internal slug.
   - `https://api.theirvenue.com.au` as the API URL.
   - Customer, owner and staff URLs for shortcuts.
   - The new `PLATFORM_API_KEY` once.
   - Internal plan or billing notes if useful.

7. Use **Test connection** before saving. After saving, the key is shown only as
   `•••• set`; neither the API nor the browser can read it back.

## Point each built website at its venue backend

For each Vite customer/admin/staff website, set its deployment variable:

```text
VITE_API_URL=https://api.theirvenue.com.au
```

The frontend should build requests from that value, for example:

```js
const API_URL = import.meta.env.VITE_API_URL;
const response = await fetch(`${API_URL}/api/menu`);
```

Because `VITE_*` variables are compiled into a Vite build, rebuild and redeploy
the frontend after changing `VITE_API_URL`.

Add all actual frontend origins to the venue backend's `CORS_ORIGIN`, without
removing any origins it still needs. A typical value is:

```text
https://theirvenue.com.au,https://admin.theirvenue.com.au,https://staff.theirvenue.com.au
```

Never put any of these in a frontend variable or source file:

- `PLATFORM_API_KEY`
- `STRIPE_SECRET_KEY` or `STRIPE_WEBHOOK_SECRET`
- `JWT_SECRET`
- R2 or SMS credentials
- Venue admin passwords

They are server secrets. `VITE_*` values are public to anyone who downloads the
website JavaScript.

## How feature changes reach websites

The console writes an entitlement override to the venue backend. The venue
backend immediately applies that result when it gates its own routes.

- Customer websites keep calling their normal public venue endpoints.
- Owner and staff dashboards can call their existing authenticated
  `GET /api/features` endpoint after login to hide modules they cannot use.
- The backend remains the enforcement point. Hiding a button in React is only a
  user-experience improvement; it is not the security boundary.

If a public customer page needs to hide an optional feature such as Bookings,
expose only a safe public boolean from that venue's public settings endpoint.
Do not make `/api/platform/*` public and do not ship a platform key to solve it.

## Key rotation

1. Generate a new key.
2. Replace `PLATFORM_API_KEY` in the venue's Railway backend and redeploy.
3. Immediately open **Edit venue → Replace key** in Console and paste the same
   new value.
4. Test the connection and save.

There is an expected short disconnected window between steps 2 and 3. Rotate
one venue at a time and avoid its busiest service period.

