import { test, expect, chromium, Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { setup, login, lab, browserApi, BASE } from "./helpers";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function forget(page: Page) {
  await page.context().clearCookies({ name: "__Host-auth_session" });
}
async function restore(page: Page, run: string, node = "A") {
  return browserApi(page, run, "auth/restore", "POST", {}, node);
}
test("L03 로그인 유지 선택은 영속 자격정보를 저장 @stage3", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  await login(page, true);
  const s = await lab(request, "snapshot?run=" + run);
  expect(s.remember).toHaveLength(1);
  expect(s.grants[0].mode).toBe("REMEMBER");
  const c = (await page.context().cookies()).find(
    (c) => c.name === "__Host-remember_me",
  );
  expect(!!c && c.expires > Date.now() / 1000).toBeTruthy();
});
test("E04 실제 유휴 만료 후 화면에서 유지 복원 @stage3", async ({
  page,
  request,
}) => {
  const run = await setup(page, request, "expiry");
  await login(page, true);
  const first = await browserApi(page, run, "auth/me");
  await wait(3400);
  await page.reload();
  await expect(page.locator(".account")).toBeVisible();
  await expect(page.getByRole("status")).toContainText("로그인 유지로");
  const a = await browserApi(page, run, "auth/me");
  expect(a.data.method).toBe("REMEMBER");
  expect(a.data.sessionRecordId === first.data.sessionRecordId).toBe(false);
});
test("E05 유지 종료 직전 복원해도 원래 종료를 넘지 못함 @stage3", async ({
  page,
  request,
}) => {
  const run = await setup(page, request, "expiry");
  await login(page, true);
  const original = (await browserApi(page, run, "auth/me")).data;
  const remembered = (await page.context().cookies()).find(
    (c) => c.name === "__Host-remember_me",
  )!;
  await wait(14500);
  await forget(page);
  const r = await restore(page, run);
  expect(r.status).toBe(200);
  expect(
    Date.parse(r.data.absoluteExpiresAt) <=
      Date.parse(original.rememberExpiresAt),
  ).toBeTruthy();
  await wait(3900);
  expect((await browserApi(page, run, "protected/report")).status).toBe(401);
  await page
    .context()
    .addCookies([
      { ...remembered, expires: Math.floor(Date.now() / 1000) + 60 },
    ]);
  const expired = await restore(page, run);
  expect(expired.status).toBe(401);
  expect(expired.data.code).toBe("REMEMBER_EXPIRED");
});
test("E06 실제 브라우저 종료와 같은 프로필 재실행 @stage3", async ({
  request,
}) => {
  const run = "restart-" + Date.now();
  await lab(request, "runs", { run, policy: "normal" });
  const profiles = path.resolve(".runtime/browser-profiles");
  fs.mkdirSync(profiles, { recursive: true });
  const dir = fs.mkdtempSync(path.join(profiles, "restart-"));
  let context;
  try {
    context = await chromium.launchPersistentContext(dir, {
      headless: true,
      ignoreHTTPSErrors: true,
    });
    let page = await context.newPage();
    await page.goto(BASE + "/?run=" + run);
    await expect(page.getByRole("status")).toContainText("실습 계정으로");
    await login(page, true);
    await context.close();
    context = undefined;
    context = await chromium.launchPersistentContext(dir, {
      headless: true,
      ignoreHTTPSErrors: true,
    });
    page = await context.newPage();
    await page.goto(BASE + "/?run=" + run);
    await expect(page.locator(".account")).toBeVisible();
    expect((await browserApi(page, run, "auth/me")).data.loginId).toBe(
      "demo@lab.test",
    );
  } finally {
    if (context) await context.close();
    if (!path.resolve(dir).startsWith(profiles + path.sep))
      throw Error("Profile cleanup target invalid");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("E07 세션 쿠키만 없으면 복원하고 유지 쿠키도 없으면 로그인 요구 @stage3", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  await login(page, true);
  await forget(page);
  await page.reload();
  await expect(page.locator(".account")).toBeVisible();
  expect((await browserApi(page, run, "auth/me")).data.method).toBe("REMEMBER");
  await page.context().clearCookies();
  await page.reload();
  await expect(page.locator(".login-form")).toBeVisible();
});
test("R01 복원 때 새 세션과 새 토큰 세대 발급 @stage3", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  await login(page, true);
  const before = (await page.context().cookies()).find(
    (c) => c.name === "__Host-remember_me",
  )!;
  await forget(page);
  const r = await restore(page, run);
  expect(r.status).toBe(200);
  const after = (await page.context().cookies()).find(
    (c) => c.name === "__Host-remember_me",
  )!;
  expect(before.value === after.value).toBe(false);
  expect(
    (await lab(request, "snapshot?run=" + run)).remember[0].generation,
  ).toBe(1);
});
test("R02 직전 토큰 경쟁 요청은 409이며 성공 쿠키를 지우지 않음 @stage3", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  await login(page, true);
  const old = (await page.context().cookies()).find(
    (c) => c.name === "__Host-remember_me",
  )!;
  await forget(page);
  expect((await restore(page, run)).status).toBe(200);
  const fresh = (await page.context().cookies()).find(
    (c) => c.name === "__Host-remember_me",
  )!;
  const c = await browserApi(page, run, "auth/csrf");
  const sid = (await page.context().cookies()).find(
    (c) => c.name === "__Host-auth_session",
  )!;
  const r = await page
    .context()
    .request.post(BASE + "/api/auth/restore", {
      headers: {
        "X-Lab-Run": run,
        "X-CSRF-TOKEN": c.data.token,
        Cookie: sid.name + "=" + sid.value + "; " + old.name + "=" + old.value,
      },
      data: {},
    });
  expect(r.status()).toBe(409);
  expect(r.headers()["set-cookie"] === undefined).toBe(true);
  const current = (await page.context().cookies()).find(
    (c) => c.name === "__Host-remember_me",
  )!;
  expect(current.value === fresh.value).toBe(true);
  expect(
    (await lab(request, "snapshot?run=" + run)).remember[0].generation,
  ).toBe(1);
});
test("R03 구분 시간이 지난 이전 토큰은 거부 @stage3", async ({
  page,
  request,
}) => {
  const run = await setup(page, request, "expiry");
  await login(page, true);
  const old = (await page.context().cookies()).find(
    (c) => c.name === "__Host-remember_me",
  )!;
  await forget(page);
  expect((await restore(page, run)).status).toBe(200);
  await page.context().addCookies([old]);
  await wait(2200);
  const r = await restore(page, run);
  expect(r.status).toBe(401);
  expect(r.data.code).toBe("REMEMBER_STALE");
  expect(
    (await lab(request, "snapshot?run=" + run)).remember[0].generation,
  ).toBe(1);
});
test("R04 두 탭이 A와 B에서 같은 토큰을 동시에 복원 @stage3", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  await login(page, true);
  await forget(page);
  const c = await browserApi(page, run, "auth/csrf");
  const results = await page.evaluate(
    async ({ run, token }) =>
      Promise.all(
        ["A", "B"].map(async (node) => {
          const r = await fetch("/api/auth/restore", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Lab-Run": run,
              "X-Lab-Node": node,
              "X-CSRF-TOKEN": token,
            },
            body: "{}",
          });
          return { status: r.status, hasCookie: r.headers.has("set-cookie") };
        }),
      ),
    { run, token: c.data.token },
  );
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(
    (await lab(request, "snapshot?run=" + run)).remember[0].generation,
  ).toBe(1);
  expect((await browserApi(page, run, "protected/report")).status).toBe(200);
});
test("R05 토큰 교체 후 응답 유실은 이전 토큰으로 되돌리지 않음 @stage3", async ({
  page,
  request,
}) => {
  const run = await setup(page, request, "expiry");
  await login(page, true);
  await forget(page);
  const c = await browserApi(page, run, "auth/csrf");
  const result = await page.evaluate(
    async ({ run, token }) => {
      try {
        await fetch("/api/auth/restore", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Lab-Run": run,
            "X-CSRF-TOKEN": token,
            "X-Lab-Drop-Response": "1",
          },
          body: "{}",
        });
        return false;
      } catch {
        return true;
      }
    },
    { run, token: c.data.token },
  );
  expect(result).toBe(true);
  expect(
    (await lab(request, "snapshot?run=" + run)).remember[0].generation,
  ).toBe(1);
  await wait(2200);
  const r = await restore(page, run);
  expect(r.status).toBe(401);
  expect(r.data.code).toBe("REMEMBER_STALE");
  await page.reload();
  await expect(page.locator(".login-form")).toBeVisible();
});
test("R06 반복 복원은 최초 유지 만료를 연장하지 않음 @stage3", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  await login(page, true);
  const first = (await browserApi(page, run, "auth/me")).data.rememberExpiresAt;
  for (let i = 0; i < 3; i++) {
    await forget(page);
    const r = await restore(page, run);
    expect(r.status).toBe(200);
    expect(r.data.rememberExpiresAt).toBe(first);
  }
  expect(
    (await lab(request, "snapshot?run=" + run)).remember[0].generation,
  ).toBe(3);
});
