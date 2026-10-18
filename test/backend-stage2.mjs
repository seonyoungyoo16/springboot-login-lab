import { request } from "@playwright/test";
import assert from "node:assert/strict";
import { createClient } from "redis";
const run = "backend-expiry-" + Date.now(),
  a = await request.newContext({
    baseURL: "https://localhost:8460",
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { "X-Lab-Run": run },
  }),
  redis = createClient({ url: "redis://127.0.0.1:56379" });
try {
  await redis.connect();
  await a.post("/lab/runs", {
    headers: { "X-Lab-Control": "1" },
    data: { run, policy: "expiry" },
  });
  let csrf = await (await a.get("/api/auth/csrf")).json();
  let r = await a.post("/api/auth/login", {
    headers: { "X-CSRF-TOKEN": csrf.token },
    data: {
      loginId: "demo@lab.test",
      password: "Lab!2026Pass",
      rememberMe: false,
    },
  });
  assert.equal(r.status(), 200);
  const auth = await r.json();
  r = await a.get("/api/protected/report", { headers: { "X-Lab-Node": "B" } });
  assert.equal(r.status(), 200);
  assert.equal(r.headers()["x-app-instance"], "B");
  const sid = await redis.get("loginlab:ref:" + auth.sessionRecordId);
  assert.ok((await redis.ttl("loginlab:sessions:" + sid)) <= 3);
  await new Promise((r) => setTimeout(r, 3400));
  assert.equal((await a.get("/api/protected/report")).status(), 401);
  console.log(
    JSON.stringify({
      stage: "shared-session-expiry",
      passed: 3,
      evidence: "server B + actual Redis TTL + elapsed server time",
    }),
  );
} finally {
  await a.dispose();
  await redis.quit();
}
