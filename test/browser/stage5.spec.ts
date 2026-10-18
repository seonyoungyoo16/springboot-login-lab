import { test, expect } from "@playwright/test";
import { createClient } from "redis";
import { setup, login, lab, browserApi, BASE } from "./helpers";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function ready(request: any) {
  await expect
    .poll(
      async () => {
        try {
          const r = await request.get("/lab/snapshot?run=studio", {
            headers: { "X-Lab-Control": "1" },
          });
          if (!r.ok()) return false;
          const s = await r.json();
          return s.db === "available" && s.redis === "available";
        } catch {
          return false;
        }
      },
      { timeout: 15000 },
    )
    .toBe(true);
}
test.afterEach(async ({ request }) => {
  const s = await lab(request, "system");
  for (const kind of ["redis", "db"])
    if (s.network[kind])
      await lab(request, "network", { target: kind, down: false });
  if (!s.apps.includes("A"))
    await lab(request, "node", { node: "A", action: "start" });
  await ready(request);
});
test("F01 Redis 연결 장애는 로그인 성공으로 처리되지 않음 @stage5", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  const before = (await page.context().cookies()).find(
    (c) => c.name === "__Host-auth_session",
  )!;
  await lab(request, "network", { target: "redis", down: true });
  const r = await browserApi(page, run, "auth/login", "POST", {
    loginId: "demo@lab.test",
    password: "Lab!2026Pass",
    rememberMe: true,
  });
  expect(r.status).toBe(503);
  const after = (await page.context().cookies()).find(
    (c) => c.name === "__Host-auth_session",
  )!;
  expect(after.value === before.value).toBe(true);
  const s = await lab(request, "snapshot?run=" + run);
  expect(s.sessions).toHaveLength(0);
  expect(s.redis).toBe("unavailable");
});
test("F02 기존 세션의 Redis 장애는 503이며 복구 후 재검사 @stage5", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  await login(page, true);
  const old = (await page.context().cookies()).find(
    (c) => c.name === "__Host-auth_session",
  )!;
  await lab(request, "network", { target: "redis", down: true });
  await page
    .getByRole("button", { name: "보호 API 조회", exact: true })
    .click();
  await expect(page.locator(".status")).toHaveText("확인 불가");
  expect((await browserApi(page, run, "protected/report")).status).toBe(503);
  const after = (await page.context().cookies()).find(
    (c) => c.name === "__Host-auth_session",
  )!;
  expect(old.value === after.value).toBe(true);
  await lab(request, "network", { target: "redis", down: false });
  await ready(request);
  expect((await browserApi(page, run, "protected/report")).status).toBe(200);
});
test("F03 실제 Redis 재시작과 세션 소실 뒤 일반과 유지 로그인 구분 @stage5", async ({
  page,
  request,
  browser,
}) => {
  const run = await setup(page, request);
  await login(page, false);
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const b = await ctx.newPage();
    await b.goto(BASE + "/?run=" + run);
    await expect(b.getByRole("status")).toContainText("실습 계정으로");
    await login(b, true);
    const old = (await browserApi(b, run, "auth/me")).data.sessionRecordId;
    const restarted = await lab(request, "redis-restart", { run });
    expect(restarted.restarted).toBe(true);
    expect(restarted.version).toMatch(/^7\.4\./);
    expect((await browserApi(page, run, "protected/report")).status).toBe(401);
    const r = await browserApi(b, run, "auth/restore", "POST");
    expect(r.status).toBe(200);
    expect(r.data.sessionRecordId === old).toBe(false);
    expect(r.data.method).toBe("REMEMBER");
  } finally {
    await ctx.close();
  }
});
test("F04 DB 연결 장애에서도 Redis만으로 인증하지 않음 @stage5", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  await login(page, true);
  await lab(request, "network", { target: "db", down: true });
  const r = await browserApi(page, run, "protected/report");
  expect(r.status).toBe(503);
  const s = await lab(request, "snapshot?run=" + run);
  expect(s.db).toBe("unavailable");
  expect(s.sessions === undefined).toBe(true);
  expect(s.redisSessions === undefined).toBe(true);
  await lab(request, "network", { target: "db", down: false });
  await ready(request);
  expect((await browserApi(page, run, "protected/report")).status).toBe(200);
});
test("F05 DB 폐기 후 Redis 정리 실패와 옛 데이터 복구에도 거부 @stage5", async ({
  page,
  request,
  browser,
}) => {
  const run = await setup(page, request);
  await login(page, true);
  const old = await page.context().cookies();
  const auth = (await browserApi(page, run, "auth/me")).data;
  const redis = createClient({ url: "redis://127.0.0.1:56379" });
  await redis.connect();
  let key = "",
    backup = "";
  try {
    const sid = await redis.get("loginlab:ref:" + auth.sessionRecordId);
    key = "loginlab:sessions:" + sid;
    backup = key + ":test-backup";
    await redis.sendCommand(["COPY", key, backup, "REPLACE"]);
    await lab(request, "fault", {
      run,
      point: "after-revoke-commit",
      mode: "fail",
    });
    const r = await browserApi(page, run, "auth/logout", "POST");
    expect(r.status).toBe(204);
    const s = await lab(request, "snapshot?run=" + run);
    expect(s.grants[0].revoked_at !== null).toBe(true);
    expect(s.cleanup.some((j: any) => j.state === "PENDING")).toBe(true);
    await redis.del(key);
    expect(await redis.sendCommand(["COPY", backup, key, "REPLACE"])).toBe(1);
    const attack = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      await attack.addCookies(old);
      const r = await attack.request.get(BASE + "/api/protected/report", {
        headers: { "X-Lab-Run": run },
      });
      expect(r.status()).toBe(401);
    } finally {
      await attack.close();
    }
  } finally {
    if (backup) await redis.del(backup);
    await redis.quit();
  }
});
test("F06 Redis에 남은 PREPARING 세션은 인증이 아님 @stage5", async ({
  page,
  request,
  browser,
}) => {
  const run = await setup(page, request);
  await lab(request, "fault", { run, point: "after-redis-save", mode: "fail" });
  const result = await browserApi(page, run, "auth/login", "POST", {
    loginId: "demo@lab.test",
    password: "Lab!2026Pass",
    rememberMe: false,
  });
  expect(result.status).toBe(503);
  const snap = await lab(request, "snapshot?run=" + run);
  expect(snap.sessions).toHaveLength(1);
  expect(snap.sessions[0].state).toBe("PREPARING");
  expect(snap.redisSessions[0].exists).toBe(true);
  const redis = createClient({ url: "redis://127.0.0.1:56379" });
  await redis.connect();
  try {
    const sid = await redis.get("loginlab:ref:" + snap.sessions[0].id);
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const template = (await page.context().cookies()).find(
        (c) => c.name === "__Host-auth_session",
      )!;
      await context.addCookies([{ ...template, value: sid! }]);
      const r = await context.request.get(BASE + "/api/protected/report", {
        headers: { "X-Lab-Run": run },
      });
      expect(r.status()).toBe(401);
    } finally {
      await context.close();
    }
  } finally {
    await redis.quit();
  }
});
test("F07 앱 A를 실제 종료해도 B의 세션은 유지 @stage5", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  await login(page);
  await lab(request, "node", { node: "A", action: "stop" });
  try {
    const r = await browserApi(
      page,
      run,
      "protected/report",
      "GET",
      undefined,
      "B",
    );
    expect(r.status).toBe(200);
    expect(r.instance).toBe("B");
  } finally {
    await lab(request, "node", { node: "A", action: "start" });
    await ready(request);
  }
  expect((await browserApi(page, run, "protected/report")).status).toBe(200);
});
test("F08 사용자 비활성화와 인증 버전 변경은 기존 인증을 거부 @stage5", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  await login(page, true);
  await lab(request, "user-state", { run, action: "disable" });
  expect((await browserApi(page, run, "protected/report")).status).toBe(401);
  expect((await browserApi(page, run, "auth/restore", "POST")).status).toBe(
    401,
  );
  const next = "version-" + Date.now();
  await lab(request, "runs", { run: next, policy: "normal" });
  await page.context().clearCookies();
  await page.goto(BASE + "/?run=" + next);
  await expect(page.getByRole("status")).toContainText("실습 계정으로");
  await login(page, true);
  await lab(request, "user-state", { run: next, action: "version" });
  expect((await browserApi(page, next, "protected/report")).status).toBe(401);
  expect((await browserApi(page, next, "auth/restore", "POST")).status).toBe(
    401,
  );
});
test("F09 실패 제한의 만료와 동시 요청 원자성 @stage5", async ({
  page,
  request,
}) => {
  const run = await setup(page, request, "expiry");
  for (let i = 0; i < 5; i++)
    expect(
      (
        await browserApi(page, run, "auth/login", "POST", {
          loginId: "demo@lab.test",
          password: "wrong",
        })
      ).status,
    ).toBe(401);
  const blocked = await browserApi(page, run, "auth/login", "POST", {
    loginId: "demo@lab.test",
    password: "Lab!2026Pass",
  });
  expect(blocked.status).toBe(429);
  await wait(5200);
  expect(
    (
      await browserApi(page, run, "auth/login", "POST", {
        loginId: "demo@lab.test",
        password: "Lab!2026Pass",
      })
    ).status,
  ).toBe(200);
  const next = "parallel-" + Date.now();
  await lab(request, "runs", { run: next, policy: "normal" });
  await page.context().clearCookies();
  await page.goto(BASE + "/?run=" + next);
  await expect(page.getByRole("status")).toContainText("실습 계정으로");
  const csrf = (await browserApi(page, next, "auth/csrf")).data.token;
  const statuses = await page.evaluate(
    async ({ run, csrf }) =>
      Promise.all(
        Array.from({ length: 10 }, async () => {
          const r = await fetch("/api/auth/login", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Lab-Run": run,
              "X-CSRF-TOKEN": csrf,
            },
            body: JSON.stringify({
              loginId: "demo@lab.test",
              password: "wrong",
            }),
          });
          return r.status;
        }),
      ),
    { run: next, csrf },
  );
  expect(statuses.filter((x) => x === 401)).toHaveLength(5);
  expect(statuses.filter((x) => x === 429)).toHaveLength(5);
});
test("S02 인증 쿠키 속성과 JS 접근 및 캐시 정책 @stage5", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  const response = await login(page, true);
  const cookies = await page.context().cookies();
  for (const name of ["__Host-auth_session", "__Host-remember_me"]) {
    const c = cookies.find((c) => c.name === name)!;
    expect(c.httpOnly).toBe(true);
    expect(c.secure).toBe(true);
    expect(c.sameSite).toBe("Lax");
    expect(c.path).toBe("/");
    expect(c.domain).toBe("localhost");
  }
  expect(
    await page.evaluate(
      () =>
        document.cookie.includes("__Host-auth_session") ||
        document.cookie.includes("__Host-remember_me"),
    ),
  ).toBe(false);
  expect(
    (await response.allHeaders())["set-cookie"]
      .toLowerCase()
      .includes("domain="),
  ).toBe(false);
  expect(response.headers()["cache-control"]).toContain("no-store");
  const src = await request.get("/flow-source.json");
  expect(src.ok()).toBe(true);
  const graph = await src.json();
  expect(!!graph["AuthService.restore"]).toBe(true);
});
test("S05 로그아웃 후 뒤로가기와 새로고침도 보호 접근 불가 @stage5", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  await login(page, true);
  await page.goto(BASE + "/?run=" + run + "&view=second");
  await expect(page.locator(".account")).toBeVisible();
  await page
    .getByRole("button", { name: "현재 기기 로그아웃", exact: true })
    .click();
  await expect(page.locator(".login-form")).toBeVisible();
  await page.goBack();
  await expect(page.locator(".login-form")).toBeVisible();
  await page.reload();
  await expect(page.locator(".login-form")).toBeVisible();
  expect((await browserApi(page, run, "protected/report")).status).toBe(401);
});
