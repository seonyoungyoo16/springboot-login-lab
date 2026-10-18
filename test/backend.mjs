import { request } from "@playwright/test";
import assert from "node:assert/strict";
import pg from "pg";
import { createClient } from "redis";
const run = "backend-" + Date.now(),
  api = await request.newContext({
    baseURL: "https://localhost:8460",
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { "X-Lab-Run": run },
  }),
  db = new pg.Client({
    host: "127.0.0.1",
    port: 55432,
    user: "loginlab",
    password: "loginlab_dev",
    database: "loginlab",
  }),
  redis = createClient({ url: "redis://127.0.0.1:56379" });
let cases = 0;
try {
  await db.connect();
  await redis.connect();
  let r = await api.post("/lab/runs", {
    headers: { "X-Lab-Control": "1" },
    data: { run, policy: "normal" },
  });
  assert.equal(r.status(), 200);
  let csrf = await (await api.get("/api/auth/csrf")).json();
  r = await api.post("/api/auth/login", {
    headers: { "X-CSRF-TOKEN": csrf.token },
    data: { loginId: "demo@lab.test", password: "wrong", rememberMe: false },
  });
  assert.equal(r.status(), 401);
  assert.equal(
    (
      await db.query(
        "SELECT count(*) FROM auth_sessions s JOIN device_auth_grants g ON g.id=s.grant_id JOIN users u ON u.id=g.user_id WHERE u.run_id=$1",
        [run],
      )
    ).rows[0].count,
    "0",
  );
  cases++;
  r = await api.post("/api/auth/login", {
    headers: { "X-CSRF-TOKEN": csrf.token },
    data: {
      loginId: "demo@lab.test",
      password: "Lab!2026Pass",
      rememberMe: false,
      deviceName: "백엔드 검증",
    },
  });
  assert.equal(r.status(), 200);
  const auth = await r.json();
  assert.equal(auth.method, "PASSWORD");
  const row = (
    await db.query("SELECT state FROM auth_sessions WHERE id=$1", [
      auth.sessionRecordId,
    ])
  ).rows[0];
  assert.equal(row.state, "ACTIVE");
  const sid = await redis.get("loginlab:ref:" + auth.sessionRecordId);
  assert.ok(sid);
  assert.ok(await redis.exists("loginlab:sessions:" + sid));
  cases++;
  csrf = await (await api.get("/api/auth/csrf")).json();
  r = await api.patch("/api/protected/preferences", {
    headers: { "X-CSRF-TOKEN": csrf.token },
    data: { notifications: false },
  });
  assert.equal(r.status(), 200);
  assert.equal(
    (
      await db.query(
        "SELECT notifications,version FROM user_preferences p JOIN users u ON u.id=p.user_id WHERE u.run_id=$1 AND u.login_id=$2",
        [run, "demo@lab.test"],
      )
    ).rows[0].notifications,
    false,
  );
  cases++;
  console.log(
    JSON.stringify({
      stage: "general-login",
      passed: cases,
      evidence: "actual HTTPS + PostgreSQL + Redis",
    }),
  );
} finally {
  await api.dispose();
  await db.end();
  await redis.quit();
}
