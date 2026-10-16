"use strict";
// Only run against a fresh, explicitly named local test database.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
test(
  "release migrations, bulk transactions, races and HTTP authorization",
  { skip: !process.env.RELEASE_TEST_DATABASE_URL },
  async (t) => {
    const url = new URL(process.env.RELEASE_TEST_DATABASE_URL);
    assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
    assert.match(url.pathname, /^\/centralpass_release_test[a-z0-9_]*$/);
    process.env.DATABASE_URL = url.href;
    process.env.ENCRYPTION_KEY = "a".repeat(64);
    const { pool, migrate } = require("../src/db");
    const { encryptSecret } = require("../src/crypto");
    t.after(() => pool.end());
    assert.equal(
      (await pool.query("SELECT to_regclass('public.venues') AS found")).rows[0]
        .found,
      null,
      "Use an empty test database.",
    );
    await migrate();
    await migrate(); // Startup migrations are idempotent.
    // requireAuth checks a real, active operator behind every session.
    await pool.query(
      "INSERT INTO console_users(id,email,name,password_hash,totp_secret) VALUES(1,'ops@test','Test operator','x','x')",
    );
    const express = require("express");
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      if (req.get("X-Test-Identity"))
        req.session = {
          user: { id: 1, name: "Test operator" },
          csrfToken: "test-csrf",
        };
      next();
    });
    app.use("/releases", require("../src/routes/releases"));
    app.use((e, req, res, next) => res.status(500).json({ error: e.message }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    t.after(() => new Promise((r) => server.close(r)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (route, body, extra = {}) => {
      const res = await fetch(base + route, {
        method: body ? "POST" : "GET",
        headers: {
          "Content-Type": "application/json",
          "X-Test-Identity": "yes",
          "X-CSRF-Token": "test-csrf",
          ...extra,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json() };
    };
    assert.equal((await fetch(base + "/releases")).status, 401);
    assert.equal(
      (
        await request(
          "/releases",
          { version: "1", commitSha: "a".repeat(40), notes: "Notes" },
          { "X-CSRF-Token": "" },
        )
      ).status,
      403,
    );
    const rel = await request("/releases", {
      version: "1.9.0",
      commitSha: "a".repeat(40),
      notes: "Tested booking fixes",
    });
    assert.equal(rel.status, 201);
    const releaseId = rel.body.release.id;
    assert.equal(
      (
        await request("/releases", {
          version: "1.9.0",
          commitSha: "b".repeat(40),
          notes: "Other",
        })
      ).status,
      409,
    );
    const ids = [];
    for (const name of ["Primo Firle", "Beach Road", "Offline Venue"]) {
      const {
        rows: [v],
      } = await pool.query(
        `INSERT INTO venues(name,slug,api_url,admin_url,staff_url,platform_api_key)
      VALUES($1,$2,'https://api.test','https://admin.test','https://staff.test',$3) RETURNING id`,
        [
          name,
          name.toLowerCase().replaceAll(" ", "-"),
          encryptSecret("platform-key-" + "x".repeat(32)),
        ],
      );
      ids.push(v.id);
    }
    const uid = (n) => `12345678-1234-1234-1234-${String(n).padStart(12, "0")}`;
    for (const id of ids.slice(0, 2)) {
      const res = await fetch(base + `/releases/targets/${id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Test-Identity": "yes",
          "X-CSRF-Token": "test-csrf",
        },
        body: JSON.stringify({
          projectId: uid(id),
          environmentId: uid(50 + id),
          services: {
            backend: uid(100 + id),
            admin: uid(200 + id),
            ...(id === ids[0] ? { staff: uid(300 + id) } : {}),
          },
          railwayToken: "sensitive-project-token-value",
          autoDeployDisabled: true,
        }),
      });
      assert.equal(res.status, 200, await res.text());
    }
    await pool.query("UPDATE venues SET staff_url=NULL WHERE id=$1", [ids[1]]);
    const bad = await request("/releases/approve", {
      releaseId,
      venueIds: [ids[0], ids[2]],
    });
    assert.equal(bad.status, 400);
    assert.equal(
      (
        await pool.query(
          "SELECT COUNT(*)::int AS n FROM venue_release_rollouts",
        )
      ).rows[0].n,
      0,
      "Invalid bulk approval must roll back earlier selected venues.",
    );
    const good = await request("/releases/approve", {
      releaseId,
      venueIds: ids.slice(0, 2),
    });
    assert.equal(good.status, 201);
    assert.equal(good.body.rolloutIds.length, 2);
    const list = await request("/releases");
    const text = JSON.stringify(list.body);
    assert.equal(text.includes("railway_token"), false);
    assert.equal(text.includes("target_snapshot"), false);
    assert.equal(text.includes("sensitive-project-token"), false);
    assert.equal(text.includes("platform_api_key"), false);
    const cancelled = good.body.rolloutIds[0];
    assert.equal(
      (await request(`/releases/${cancelled}/cancel`, {})).status,
      200,
    );
    const races = await Promise.all(
      [1, 2].map(() =>
        request("/releases/approve", { releaseId, venueIds: [ids[0]] }),
      ),
    );
    assert.deepEqual(races.map((r) => r.status).sort(), [201, 400]);
    const { claim } = require("../scripts/release-worker");
    const claims = await Promise.all([claim(), claim(), claim()]);
    assert.equal(claims.filter(Boolean).length, 2);
    assert.equal(new Set(claims.filter(Boolean).map((j) => j.id)).size, 2);
    for (const j of claims.filter(Boolean))
      assert.equal((await request(`/releases/${j.id}/cancel`, {})).status, 409);
    await pool.query(
      "UPDATE venue_release_rollouts SET status='interrupted' WHERE status='deploying'",
    );
    assert.equal(
      (await request("/releases/approve", { releaseId, venueIds: [ids[0]] }))
        .status,
      400,
    );
    const job = claims.find((j) => j?.venue_id === ids[0]);
    assert.equal(
      (await request(`/releases/${job.id}/resolve`, { acknowledged: true }))
        .status,
      200,
    );
    assert.equal(
      (
        await request("/releases/approve", {
          releaseId,
          venueIds: [ids[0]],
          scheduledAt: new Date(Date.now() + 3600000).toISOString(),
        })
      ).status,
      201,
    );
    assert.equal(
      await claim(),
      undefined,
      "Future schedules must remain queued.",
    );
  },
);
