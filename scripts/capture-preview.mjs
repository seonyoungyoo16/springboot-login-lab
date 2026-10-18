import { chromium, request } from "@playwright/test";
import fs from "node:fs";
import assert from "node:assert/strict";
const base = "https://localhost:8460",
  run = "preview-" + Date.now(),
  api = await request.newContext({ baseURL: base, ignoreHTTPSErrors: true });
await api.post("/lab/runs", {
  headers: { "X-Lab-Control": "1" },
  data: { run, policy: "normal" },
});
const browser = await chromium.launch();
const errors = [];
let checks = 0;
try {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1050 },
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/?run=" + run);
  await page.getByRole("button", { name: "실습 계정 입력" }).click();
  await page.getByLabel("로그인 유지", { exact: true }).check();
  await page.getByRole("button", { name: "로그인하고 흐름 확인하기" }).click();
  await page.locator(".account").waitFor();
  await page.waitForTimeout(900);
  await page.getByRole("button", { name: "흐름 일시정지" }).click();
  await page
    .locator(".timeline button")
    .filter({ hasText: "ACTIVE 커밋" })
    .click();
  await page.locator(".source summary").click();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  fs.mkdirSync("docs/previews", { recursive: true });
  await page.screenshot({ path: "docs/previews/desktop.png", fullPage: true });
  assert.ok(
    (await page.locator(".redis-sessions").innerText()).includes("TTL"),
  );
  checks++;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.locator(".account").waitFor();
  await page
    .getByRole("button", { name: "보호 API 조회", exact: true })
    .click();
  await page.getByRole("button", { name: "흐름", exact: true }).click();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  assert.equal(await page.locator(".panel.service").isVisible(), false);
  assert.equal(await page.locator(".panel.data").isVisible(), false);
  assert.equal(await page.locator(".panel.flow").isVisible(), true);
  await page.screenshot({
    path: "docs/previews/mobile-flow.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "서비스", exact: true }).click();
  await page.screenshot({
    path: "docs/previews/mobile-service.png",
    fullPage: true,
  });
  assert.equal(await page.locator(".panel.flow").isVisible(), false);
  assert.equal(await page.locator(".panel.data").isVisible(), false);
  await page.getByRole("button", { name: "데이터", exact: true }).click();
  assert.equal(await page.locator(".panel.data").isVisible(), true);
  assert.equal(await page.locator(".panel.service").isVisible(), false);
  assert.equal(await page.locator(".panel.flow").isVisible(), false);
  await page
    .locator(".panel.data")
    .screenshot({ path: "docs/previews/mobile-data.png" });
  checks++;
  assert.equal(errors.length, 0);
  assert.ok((await page.locator(".history-list button").count()) > 0);
  checks++;
  fs.writeFileSync(
    "docs/verification/preview.json",
    JSON.stringify(
      {
        status: "passed",
        completedAt: new Date().toISOString(),
        checks,
        desktop: { width: 1440, overflow: false },
        mobile: { width: 390, overflow: false },
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      status: "passed",
      checks,
      desktopWidth: 1440,
      mobileWidth: 390,
      pageErrors: errors.length,
    }),
  );
  await context.close();
} finally {
  await browser.close();
  await api.dispose();
}
