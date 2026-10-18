import { test, expect } from "@playwright/test";
import { setup, login, lab, browserApi } from "./helpers";
test("L01 잘못된 비밀번호와 없는 아이디는 같은 오류 @stage1", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  const a = await browserApi(page, run, "auth/login", "POST", {
      loginId: "demo@lab.test",
      password: "wrong",
      rememberMe: false,
    }),
    b = await browserApi(page, run, "auth/login", "POST", {
      loginId: "missing@lab.test",
      password: "wrong",
      rememberMe: false,
    });
  expect(a.status).toBe(401);
  expect(b.status).toBe(401);
  expect(a.data.code).toBe(b.data.code);
  const s = await lab(request, "snapshot?run=" + run);
  expect(s.sessions).toHaveLength(0);
  expect(s.grants).toHaveLength(0);
});
test("L02 일반 로그인과 실제 보호 설정 저장 @stage1", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  await login(page);
  await page
    .getByRole("button", { name: "보호 API 조회", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "실제 보호 API 조회 성공",
  );
  await page.getByRole("button", { name: "알림 끄기 · 실제 DB 저장" }).click();
  await expect(page.getByRole("status")).toContainText("DB 설정 저장 완료");
  const s = await lab(request, "snapshot?run=" + run);
  expect(s.sessions.filter((s: any) => s.state === "ACTIVE")).toHaveLength(1);
  expect(s.remember).toHaveLength(0);
  expect(s.redisSessions[0].exists).toBeTruthy();
  expect(
    s.preferences.find((p: any) => p.login_id === "demo@lab.test")
      .notifications,
  ).toBe(false);
  expect(
    s.preferences.find((p: any) => p.login_id === "demo@lab.test").version,
  ).toBe(2);
  await expect(
    page
      .locator(".timeline")
      .getByText("보호된 설정 변경과 version 증가 커밋", { exact: true }),
  ).toBeVisible();
});
test("L04 로그인 전 세션 식별자는 인증으로 재사용되지 않음 @stage1", async ({
  page,
  request,
  browser,
}) => {
  const run = await setup(page, request);
  const old = (await page.context().cookies()).find(
    (c) => c.name === "__Host-auth_session",
  );
  expect(!!old).toBeTruthy();
  await login(page);
  const fresh = (await page.context().cookies()).find(
    (c) => c.name === "__Host-auth_session",
  );
  expect(old!.value === fresh!.value).toBe(false);
  const attacker = await browser.newContext({ ignoreHTTPSErrors: true });
  await attacker.addCookies([old!]);
  const r = await attacker.request.get(
    "https://localhost:8460/api/protected/report",
    { headers: { "X-Lab-Run": run } },
  );
  expect(r.status()).toBe(401);
  await attacker.close();
});
test("S01 CSRF 누락은 로그인 실행 전에 거부 @stage1", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  const r = await browserApi(
    page,
    run,
    "auth/login",
    "POST",
    { loginId: "demo@lab.test", password: "Lab!2026Pass" },
    "A",
    false,
  );
  expect(r.status).toBe(403);
  expect(r.data.code).toBe("CSRF_INVALID");
  const s = await lab(request, "snapshot?run=" + run);
  expect(s.sessions).toHaveLength(0);
});
test("S04 익명 사용자의 보호 설정 변경은 저장되지 않음 @stage1", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  const r = await browserApi(page, run, "protected/preferences", "PATCH", {
    notifications: false,
  });
  expect(r.status).toBe(401);
  const s = await lab(request, "snapshot?run=" + run);
  expect(
    s.preferences.every(
      (p: any) => p.notifications === true && p.version === 1,
    ),
  ).toBeTruthy();
});
