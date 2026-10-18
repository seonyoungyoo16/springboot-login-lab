import { test, expect } from "@playwright/test";
import { setup, login, lab, browserApi } from "./helpers";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
test("L05 서버 A 로그인 세션을 B가 공유 @stage2", async ({ page, request }) => {
  const run = await setup(page, request);
  await login(page);
  const before = await lab(request, "snapshot?run=" + run);
  await page.getByLabel("요청 처리 서버").selectOption("B");
  const response = page.waitForResponse((r) =>
    r.url().endsWith("/api/protected/report"),
  );
  await page
    .getByRole("button", { name: "보호 API 조회", exact: true })
    .click();
  const r = await response;
  expect(r.status()).toBe(200);
  expect(r.headers()["x-app-instance"]).toBe("B");
  await expect(page.getByRole("status")).toContainText("서버 B");
  const after = await lab(request, "snapshot?run=" + run);
  expect(after.sessions[0].id).toBe(before.sessions[0].id);
  expect(after.sessions).toHaveLength(1);
});
test("E01 관찰 화면을 열어도 실제 유휴 만료 @stage2", async ({
  page,
  request,
}) => {
  const run = await setup(page, request, "expiry");
  await login(page);
  const before = await lab(request, "snapshot?run=" + run);
  for (let i = 0; i < 4; i++) {
    await wait(850);
    await page.getByRole("button", { name: "관찰 새로고침" }).click();
  }
  const after = await lab(request, "snapshot?run=" + run);
  expect(after.redisSessions[0].exists).toBe(false);
  const r = await browserApi(page, run, "protected/report");
  expect(r.status).toBe(401);
  expect(before.policy.idle).toBe(3);
});
test("E02 정상 보호 요청은 유휴 만료만 연장 @stage2", async ({
  page,
  request,
}) => {
  const run = await setup(page, request, "expiry");
  await login(page);
  const a = await browserApi(page, run, "auth/me");
  await wait(1600);
  const b = await browserApi(page, run, "auth/me");
  expect(b.status).toBe(200);
  expect(
    Date.parse(b.data.idleExpiresAt) > Date.parse(a.data.idleExpiresAt),
  ).toBeTruthy();
  expect(b.data.absoluteExpiresAt).toBe(a.data.absoluteExpiresAt);
  const snap = await lab(request, "snapshot?run=" + run);
  expect(snap.policy.absolute).toBe(9);
});
test("E03 계속 활동해도 서버 절대 수명은 만료 @stage2", async ({
  page,
  request,
}) => {
  const run = await setup(page, request, "expiry");
  await login(page);
  for (let i = 0; i < 4; i++) {
    await wait(1900);
    const r = await browserApi(page, run, "protected/report");
    expect(r.status).toBe(200);
  }
  await wait(1700);
  const r = await browserApi(page, run, "protected/report");
  expect(r.status).toBe(401);
  const s = await lab(request, "snapshot?run=" + run);
  expect(s.policy.absolute).toBe(9);
});
test("S03 분리된 브라우저는 인증 쿠키와 사용자를 공유하지 않음 @stage2", async ({
  page,
  request,
  browser,
}) => {
  const run = await setup(page, request);
  await login(page);
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const other = await context.newPage();
  await other.goto("/?run=" + run);
  await expect(other.getByRole("status")).toContainText("실습 계정으로");
  const result = await browserApi(other, run, "auth/login", "POST", {
    loginId: "other@lab.test",
    password: "Lab!2026Pass",
    rememberMe: false,
  });
  expect(result.status).toBe(200);
  const a = await browserApi(page, run, "auth/me"),
    b = await browserApi(other, run, "auth/me");
  expect(a.data.loginId).toBe("demo@lab.test");
  expect(b.data.loginId).toBe("other@lab.test");
  expect(a.data.grantId === b.data.grantId).toBe(false);
  await context.close();
});
