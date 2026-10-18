import { request } from "@playwright/test";
import assert from "node:assert/strict";
import pg from "pg";
import { createClient } from "redis";
const run = "backend-fault-" + Date.now(),
  api = await request.newContext({
    baseURL: "https://localhost:8460",
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { "X-Lab-Run": run },
  }),
  db = new pg.Client({
    host: "127.0.0.1",
    port: 55432,
    user: "loginlab",
    database: "loginlab",
  }),
  redis = createClient({ url: "redis://127.0.0.1:56379" });
let passed = 0;
async function control(path, body) {
  const r = await api.post("/lab/" + path, {
    headers: { "X-Lab-Control": "1" },
    data: body,
  });
  assert.equal(r.status(), 200);
  return r.json();
}
async function healthy() {
  for (let i = 0; i < 30; i++) {
    const r = await api.get("/api/protected/report");
    if (r.status() === 200) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw Error("Recovery did not restore authentication");
}
try {
  await db.connect();
  await redis.connect();
  await control("runs", { run, policy: "normal" });
  let c = await (await api.get("/api/auth/csrf")).json();
  let r = await api.post("/api/auth/login", {
    headers: { "X-CSRF-TOKEN": c.token },
    data: {
      loginId: "demo@lab.test",
      password: "Lab!2026Pass",
      rememberMe: true,
    },
  });
  assert.equal(r.status(), 200);
  const auth = await r.json();
  const old = await api.storageState();
  await control("network", { target: "redis", down: true });
  assert.equal((await api.get("/api/protected/report")).status(), 503);
  assert.equal(await redis.ping(), "PONG");
  passed++;
  const after = await api.storageState();
  assert.equal(
    after.cookies.find((c) => c.name === "__Host-auth_session").value,
    old.cookies.find((c) => c.name === "__Host-auth_session").value,
  );
  passed++;
  await control("network", { target: "redis", down: false });
  await healthy();
  await control("network", { target: "db", down: true });
  assert.equal((await api.get("/api/protected/report")).status(), 503);
  assert.equal((await db.query("SELECT 1 AS ok")).rows[0].ok, 1);
  passed++;
  await control("network", { target: "db", down: false });
  await healthy();
  passed++;
  await control("fault", { run, point: "after-revoke-commit", mode: "fail" });
  c = await (await api.get("/api/auth/csrf")).json();
  r = await api.post("/api/auth/logout", {
    headers: { "X-CSRF-TOKEN": c.token },
  });
  assert.equal(r.status(), 204);
  assert.notEqual(
    (
      await db.query("SELECT revoked_at FROM device_auth_grants WHERE id=$1", [
        auth.grantId,
      ])
    ).rows[0].revoked_at,
    null,
  );
  const sid = await redis.get("loginlab:ref:" + auth.sessionRecordId);
  assert.equal(await redis.exists("loginlab:sessions:" + sid), 1);
  passed++;
  const oldContext = await request.newContext({
    baseURL: "https://localhost:8460",
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { "X-Lab-Run": run },
    storageState: old,
  });
  try {
    assert.equal((await oldContext.get("/api/protected/report")).status(), 401);
    passed++;
  } finally {
    await oldContext.dispose();
  }
  console.log(
    JSON.stringify({
      stage: "dependency-failure-recovery",
      passed,
      evidence:
        "real TCP path failures + direct DB/Redis availability + committed revocation",
    }),
  );
} finally {
  try {
    await control("network", { target: "redis", down: false });
    await control("network", { target: "db", down: false });
  } catch {}
  await api.dispose();
  await db.end();
  await redis.quit();
}
