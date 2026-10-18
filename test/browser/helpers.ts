import { expect, Page, APIRequestContext } from "@playwright/test";
export const BASE = "https://localhost:8460";
export const CONTROL = { "X-Lab-Control": "1" };
export async function lab(
  request: APIRequestContext,
  path: string,
  body?: any,
) {
  const r = body
    ? await request.post("/lab/" + path, { headers: CONTROL, data: body })
    : await request.get("/lab/" + path, { headers: CONTROL });
  expect(r.ok()).toBeTruthy();
  return r.json();
}
export async function setup(
  page: Page,
  request: APIRequestContext,
  policy = "normal",
) {
  const run = "t-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  await lab(request, "runs", { run, policy });
  await page.goto("/?run=" + run);
  await expect(page.getByRole("status")).toContainText("실습 계정으로");
  return run;
}
export async function login(page: Page, remember = false) {
  await page.getByLabel("아이디", { exact: true }).fill("demo@lab.test");
  await page.getByLabel("비밀번호", { exact: true }).fill("Lab!2026Pass");
  if (remember) await page.getByLabel("로그인 유지", { exact: true }).check();
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/auth/login") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "로그인하고 흐름 확인하기" }).click();
  const r = await response;
  expect(r.status()).toBe(200);
  await expect(page.locator(".account")).toBeVisible();
  return r;
}
export async function browserApi(
  page: Page,
  run: string,
  path: string,
  method = "GET",
  body?: any,
  node = "A",
  csrf = true,
) {
  return page.evaluate(
    async ({ run, path, method, body, node, csrf }) => {
      let token = "";
      if (csrf && method !== "GET") {
        const c = await fetch("/api/auth/csrf", {
          headers: { "X-Lab-Run": run, "X-Lab-Node": node },
        });
        const j = await c.json();
        token = j.token;
      }
      const r = await fetch("/api/" + path, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Lab-Run": run,
          "X-Lab-Node": node,
          ...(token ? { "X-CSRF-TOKEN": token } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return {
        status: r.status,
        data: r.status === 204 ? null : await r.json(),
        instance: r.headers.get("x-app-instance"),
      };
    },
    { run, path, method, body, node, csrf },
  );
}
