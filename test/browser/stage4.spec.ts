import {
  test,
  expect,
  Browser,
  Page,
  APIRequestContext,
} from "@playwright/test";
import { setup, login, lab, browserApi, BASE } from "./helpers";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function second(
  browser: Browser,
  run: string,
  label = "브라우저 B",
  other = false,
) {
  const c = await browser.newContext({ ignoreHTTPSErrors: true });
  const p = await c.newPage();
  await p.goto(BASE + "/?run=" + run);
  await expect(p.getByRole("status")).toContainText("실습 계정으로");
  await p.getByLabel("기기 이름", { exact: true }).fill(label);
  if (other) {
    await p.getByLabel("아이디", { exact: true }).fill("other@lab.test");
    await p.getByLabel("비밀번호", { exact: true }).fill("Lab!2026Pass");
    await p.getByLabel("로그인 유지", { exact: true }).check();
    await p.getByRole("button", { name: "로그인하고 흐름 확인하기" }).click();
    await expect(p.locator(".account")).toBeVisible();
  } else await login(p, true);
  return { context: c, page: p };
}
async function replay(browser: Browser, run: string, cookies: any[]) {
  const c = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    await c.addCookies(cookies);
    const r = await c.request.get(BASE + "/api/protected/report", {
      headers: { "X-Lab-Run": run },
    });
    expect(r.status()).toBe(401);
    const csrf = await (
      await c.request.get(BASE + "/api/auth/csrf", {
        headers: { "X-Lab-Run": run },
      })
    ).json();
    const restore = await c.request.post(BASE + "/api/auth/restore", {
      headers: { "X-Lab-Run": run, "X-CSRF-TOKEN": csrf.token },
      data: {},
    });
    expect(restore.status()).toBe(401);
  } finally {
    await c.close();
  }
}
test("O01 현재 기기 로그아웃은 옛 쿠키를 막고 다른 기기는 유지 @stage4", async ({
  page,
  request,
  browser,
}) => {
  const run = await setup(page, request);
  await page.getByLabel("기기 이름").fill("브라우저 A");
  await login(page, true);
  const b = await second(browser, run);
  try {
    const old = await page.context().cookies();
    await page
      .getByRole("button", { name: "현재 기기 로그아웃", exact: true })
      .click();
    await expect(page.locator(".login-form")).toBeVisible();
    expect((await browserApi(b.page, run, "protected/report")).status).toBe(
      200,
    );
    await replay(browser, run, old);
    const s = await lab(request, "snapshot?run=" + run);
    expect(s.grants.filter((g: any) => g.revoked_at !== null)).toHaveLength(1);
  } finally {
    await b.context.close();
  }
});
test("O02 다른 기기 해제는 재확인 후 대상만 폐기 @stage4", async ({
  page,
  request,
  browser,
}) => {
  const run = await setup(page, request);
  await login(page, true);
  const b = await second(browser, run);
  try {
    const target = (await browserApi(b.page, run, "auth/me")).data.grantId;
    await page.context().clearCookies({ name: "__Host-auth_session" });
    await page.reload();
    await expect(page.locator(".account")).toBeVisible();
    const denied = await browserApi(
      page,
      run,
      "auth/devices/" + target,
      "DELETE",
    );
    expect(denied.status).toBe(403);
    expect(denied.data.code).toBe("REAUTH_REQUIRED");
    const before = (await browserApi(page, run, "auth/me")).data;
    const reauth = await browserApi(page, run, "auth/reauthenticate", "POST", {
      password: "Lab!2026Pass",
    });
    expect(reauth.status).toBe(204);
    const after = (await browserApi(page, run, "auth/me")).data;
    expect(after.sessionRecordId === before.sessionRecordId).toBe(false);
    expect(after.absoluteExpiresAt).toBe(before.absoluteExpiresAt);
    expect(
      (await browserApi(page, run, "auth/devices/" + target, "DELETE")).status,
    ).toBe(204);
    expect((await browserApi(b.page, run, "protected/report")).status).toBe(
      401,
    );
    expect((await browserApi(page, run, "protected/report")).status).toBe(200);
  } finally {
    await b.context.close();
  }
});
test("O03 다른 사용자의 기기 해제는 404와 데이터 불변 @stage4", async ({
  page,
  request,
  browser,
}) => {
  const run = await setup(page, request);
  await login(page, true);
  const b = await second(browser, run, "다른 사용자", true);
  try {
    const target = (await browserApi(b.page, run, "auth/me")).data.grantId;
    expect(
      (await browserApi(page, run, "auth/devices/" + target, "DELETE")).status,
    ).toBe(404);
    expect((await browserApi(b.page, run, "protected/report")).status).toBe(
      200,
    );
    const s = await lab(request, "snapshot?run=" + run);
    expect(s.grants.find((g: any) => g.id === target).revoked_at).toBeNull();
  } finally {
    await b.context.close();
  }
});
test("O04 모든 기기 로그아웃은 버전과 옛 자격정보를 모두 폐기 @stage4", async ({
  page,
  request,
  browser,
}) => {
  const run = await setup(page, request);
  await login(page, true);
  const b = await second(browser, run);
  try {
    const oldA = await page.context().cookies(),
      oldB = await b.context.cookies();
    await page
      .getByRole("button", { name: "모든 기기 로그아웃", exact: true })
      .click();
    await expect(page.locator(".login-form")).toBeVisible();
    expect((await browserApi(b.page, run, "protected/report")).status).toBe(
      401,
    );
    await replay(browser, run, oldA);
    await replay(browser, run, oldB);
    const s = await lab(request, "snapshot?run=" + run);
    expect(
      s.users.find((u: any) => u.login_id === "demo@lab.test").auth_version,
    ).toBe(2);
    expect(s.grants.every((g: any) => g.revoked_at !== null)).toBe(true);
  } finally {
    await b.context.close();
  }
});
test("O05 전체 로그아웃과 경쟁한 복원은 뒤늦게 활성화되지 않음 @stage4", async ({
  page,
  request,
  browser,
}) => {
  const run = await setup(page, request);
  await login(page, true);
  const b = await second(browser, run);
  try {
    await b.context.clearCookies({ name: "__Host-auth_session" });
    await lab(request, "fault", {
      run,
      point: "before-activate",
      mode: "pause",
    });
    const restoring = browserApi(b.page, run, "auth/restore", "POST", {}, "B");
    await expect
      .poll(
        async () => {
          const s = await lab(request, "fault?run=" + run);
          return s.B.some(
            (f: any) => f.point === "before-activate" && f.reached,
          );
        },
        { timeout: 5000 },
      )
      .toBe(true);
    expect(
      (await browserApi(page, run, "auth/logout-all", "POST")).status,
    ).toBe(204);
    await lab(request, "fault", {
      run,
      point: "before-activate",
      mode: "release",
    });
    expect((await restoring).status).toBe(401);
    const s = await lab(request, "snapshot?run=" + run);
    expect(s.sessions.filter((x: any) => x.state === "ACTIVE")).toHaveLength(0);
    expect((await browserApi(b.page, run, "protected/report")).status).toBe(
      401,
    );
  } finally {
    await lab(request, "fault", {
      run,
      point: "before-activate",
      mode: "release",
    });
    await b.context.close();
  }
});
test("O06 DB 폐기 후 로그아웃 응답이 사라져도 옛 쿠키는 거부 @stage4", async ({
  page,
  request,
  browser,
}) => {
  const run = await setup(page, request);
  await login(page, true);
  const old = await page.context().cookies();
  const csrf = (await browserApi(page, run, "auth/csrf")).data.token;
  const lost = await page.evaluate(
    async ({ run, csrf }) => {
      try {
        await fetch("/api/auth/logout", {
          method: "POST",
          headers: {
            "X-Lab-Run": run,
            "X-CSRF-TOKEN": csrf,
            "X-Lab-Drop-Response": "1",
          },
        });
        return false;
      } catch {
        return true;
      }
    },
    { run, csrf },
  );
  expect(lost).toBe(true);
  await replay(browser, run, old);
  expect(
    (await lab(request, "snapshot?run=" + run)).grants[0].revoked_at !== null,
  ).toBe(true);
});
test("O07 같은 브라우저 두 탭의 로그아웃과 서버 차단 @stage4", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  await login(page, true);
  const tab = await page.context().newPage();
  await tab.goto(BASE + "/?run=" + run);
  await expect(tab.locator(".account")).toBeVisible();
  await page
    .getByRole("button", { name: "현재 기기 로그아웃", exact: true })
    .click();
  await expect(tab.locator(".login-form")).toBeVisible();
  expect((await browserApi(tab, run, "protected/report")).status).toBe(401);
  await tab.close();
});
test("O08 유지 인증의 재확인 모달은 실패 때 원래 작업을 실행하지 않음 @stage4", async ({
  page,
  request,
}) => {
  const run = await setup(page, request);
  await login(page, true);
  await page.context().clearCookies({ name: "__Host-auth_session" });
  await page.reload();
  await expect(page.locator(".account")).toBeVisible();
  await page
    .getByRole("button", { name: "모든 기기 로그아웃", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "비밀번호 재확인" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("재확인 비밀번호").fill("wrong");
  await dialog.getByRole("button", { name: "확인하고 계속" }).click();
  await expect(dialog.locator(".confirm-error")).toContainText(
    "비밀번호를 확인",
  );
  const before = await lab(request, "snapshot?run=" + run);
  expect(before.grants.every((g: any) => g.revoked_at === null)).toBe(true);
  await dialog.getByLabel("재확인 비밀번호").fill("Lab!2026Pass");
  await dialog.getByRole("button", { name: "확인하고 계속" }).click();
  await expect(page.locator(".login-form")).toBeVisible();
  await expect(dialog).not.toBeVisible();
  expect(
    (await lab(request, "snapshot?run=" + run)).grants.every(
      (g: any) => g.revoked_at !== null,
    ),
  ).toBe(true);
});

test("O09 세션 만료 뒤 로그아웃도 유지 자격정보를 서버에서 폐기 @stage4", async ({
  page,
  request,
  browser,
}) => {
  const run = await setup(page, request, "expiry");
  await login(page, true);
  const old = await page.context().cookies();
  await wait(3400);
  await page
    .getByRole("button", { name: "현재 기기 로그아웃", exact: true })
    .click();
  await expect(page.locator(".login-form")).toBeVisible();
  const snap = await lab(request, "snapshot?run=" + run);
  expect(snap.grants[0].revoked_at !== null).toBe(true);
  await replay(browser, run, old);
});
