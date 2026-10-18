import { request } from "@playwright/test";
import assert from "node:assert/strict";
import pg from "pg";
const run = "backend-revoke-" + Date.now(),
  headers = { "X-Lab-Run": run },
  a = await request.newContext({
    baseURL: "https://localhost:8460",
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: headers,
  }),
  b = await request.newContext({
    baseURL: "https://localhost:8460",
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: headers,
  }),
  db = new pg.Client({
    host: "127.0.0.1",
    port: 55432,
    user: "loginlab",
    database: "loginlab",
  });
async function login(c) {
  const csrf = await (await c.get("/api/auth/csrf")).json();
  const r = await c.post("/api/auth/login", {
    headers: { "X-CSRF-TOKEN": csrf.token },
    data: {
      loginId: "demo@lab.test",
      password: "Lab!2026Pass",
      rememberMe: true,
    },
  });
  assert.equal(r.status(), 200);
  return r.json();
}
try {
  await db.connect();
  await a.post("/lab/runs", {
    headers: { "X-Lab-Control": "1" },
    data: { run, policy: "normal" },
  });
  const first = await login(a);
  await login(b);
  let csrf = await (await a.get("/api/auth/csrf")).json();
  let r = await a.post("/api/auth/logout-all", {
    headers: { "X-CSRF-TOKEN": csrf.token },
  });
  assert.equal(r.status(), 204);
  assert.equal((await b.get("/api/protected/report")).status(), 401);
  assert.equal(
    (
      await db.query(
        "SELECT auth_version FROM users WHERE run_id=$1 AND login_id=$2",
        [run, "demo@lab.test"],
      )
    ).rows[0].auth_version,
    "2",
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*) FROM auth_sessions s JOIN device_auth_grants g ON g.id=s.grant_id JOIN users u ON u.id=g.user_id WHERE u.run_id=$1 AND s.state='ACTIVE'",
        [run],
      )
    ).rows[0].count,
    "0",
  );
  assert.ok(
    Number(
      (
        await db.query(
          "SELECT count(*) FROM auth_audit_events WHERE run_id=$1 AND event=$2",
          [run, "LOGOUT_ALL"],
        )
      ).rows[0].count,
    ) > 0,
  );
  console.log(
    JSON.stringify({
      stage: "device-revocation",
      passed: 4,
      evidence:
        "cross-client denial + DB version + revoked sessions + committed audit",
    }),
  );
} finally {
  await a.dispose();
  await b.dispose();
  await db.end();
}
