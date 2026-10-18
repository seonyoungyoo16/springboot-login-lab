import { request } from "@playwright/test";
import assert from "node:assert/strict";
import pg from "pg";
import crypto from "node:crypto";
const run = "backend-remember-" + Date.now(),
  a = await request.newContext({
    baseURL: "https://localhost:8460",
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { "X-Lab-Run": run },
  }),
  db = new pg.Client({
    host: "127.0.0.1",
    port: 55432,
    user: "loginlab",
    database: "loginlab",
  });
try {
  await db.connect();
  await a.post("/lab/runs", {
    headers: { "X-Lab-Control": "1" },
    data: { run, policy: "normal" },
  });
  let c = await (await a.get("/api/auth/csrf")).json();
  let r = await a.post("/api/auth/login", {
    headers: { "X-CSRF-TOKEN": c.token },
    data: {
      loginId: "demo@lab.test",
      password: "Lab!2026Pass",
      rememberMe: true,
    },
  });
  assert.equal(r.status(), 200);
  const first = await r.json();
  const cookies = (await a.storageState()).cookies,
    old = cookies.find((c) => c.name === "__Host-remember_me");
  const record = (
    await db.query("SELECT c.* FROM remember_credentials c WHERE grant_id=$1", [
      first.grantId,
    ])
  ).rows[0];
  assert.equal(record.current_hash.length, 64);
  assert.equal(
    record.current_hash,
    crypto.createHash("sha256").update(old.value.split(".")[1]).digest("hex"),
  );
  assert.notEqual(record.current_hash, old.value.split(".")[1]);
  c = await (await a.get("/api/auth/csrf")).json();
  const oldSid = (await a.storageState()).cookies.find(
    (c) => c.name === "__Host-auth_session",
  );
  r = await a.post("/api/auth/restore", {
    headers: { "X-CSRF-TOKEN": c.token },
    data: {},
  });
  assert.equal(r.status(), 200);
  const restored = await r.json();
  assert.equal(restored.rememberExpiresAt, first.rememberExpiresAt);
  assert.equal(restored.method, "REMEMBER");
  assert.notEqual(restored.sessionRecordId, first.sessionRecordId);
  r = await a.post("/api/auth/restore", {
    headers: {
      "X-CSRF-TOKEN": c.token,
      Cookie:
        oldSid.name + "=" + oldSid.value + "; " + old.name + "=" + old.value,
    },
    data: {},
  });
  assert.equal(r.status(), 409);
  assert.equal(
    (
      await db.query(
        "SELECT generation FROM remember_credentials WHERE grant_id=$1",
        [first.grantId],
      )
    ).rows[0].generation,
    "1",
  );
  console.log(
    JSON.stringify({
      stage: "remember-rotation",
      passed: 4,
      evidence: "DB hash + fixed expiry + new Redis session + replay conflict",
    }),
  );
} finally {
  await a.dispose();
  await db.end();
}
