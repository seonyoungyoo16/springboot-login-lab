import { chromium } from "@playwright/test";
import fs from "node:fs";
import assert from "node:assert/strict";
const browser = await chromium.launch();
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 1000 },
});
try {
  const page = await context.newPage();
  await page.goto("https://localhost:8460");
  const button = page.getByRole("button", { name: "브라우저 전체 검증 실행" });
  await button.waitFor();
  await page.waitForTimeout(700);
  const accepted = page.waitForResponse((r) => r.url().endsWith("/lab/test"));
  await button.click();
  assert.equal((await accepted).status(), 202);
  console.log("UI test runner accepted: 202");
  await context.close();
  let previous = 0;
  for (let i = 0; i < 180; i++) {
    let summary;
    try {
      summary = JSON.parse(
        fs.readFileSync("test-results/summary.json", "utf8"),
      );
    } catch {
      await new Promise((r) => setTimeout(r, 300));
      continue;
    }
    if (summary.tests.length !== previous) {
      previous = summary.tests.length;
      console.log("Completed browser scenarios: " + previous);
    }
    if (summary.status !== "running") {
      assert.equal(summary.status, "passed");
      console.log(
        JSON.stringify({
          status: summary.status,
          scenarios: summary.tests.length,
          trigger: "actual browser test button",
        }),
      );
      fs.mkdirSync("docs/verification", { recursive: true });
      fs.writeFileSync(
        "docs/verification/test-runner.json",
        JSON.stringify(
          {
            status: "passed",
            httpStatus: 202,
            trigger: "actual browser button",
            completedScenarios: summary.tests.length,
            completedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      process.exitCode = 0;
      break;
    }
    if (i === 179) throw Error("Browser suite timeout");
    await new Promise((r) => setTimeout(r, 1000));
  }
} finally {
  await browser.close();
}
