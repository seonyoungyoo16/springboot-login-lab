import { restartRedis } from "./infra.mjs";
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  runtime = path.join(root, ".runtime");
const gatewayStarted = new Date().toISOString();
const drops = new Map();
const key = crypto.randomBytes(32).toString("hex");
const ports = { A: 8461, B: 8462 };
const children = {};
const sockets = { redis: new Set(), db: new Set() };
const network = { redis: false, db: false };
const servers = [];
fs.mkdirSync(runtime, { recursive: true });
function tcp(kind, listen, target) {
  const server = net.createServer((client) => {
    if (network[kind]) {
      client.destroy();
      return;
    }
    const remote = net.connect(target, "127.0.0.1");
    sockets[kind].add(client);
    sockets[kind].add(remote);
    client.pipe(remote);
    remote.pipe(client);
    const close = () => {
      client.destroy();
      remote.destroy();
      sockets[kind].delete(client);
      sockets[kind].delete(remote);
    };
    client.on("error", close);
    remote.on("error", close);
    client.on("close", close);
    remote.on("close", close);
  });
  server.listen(listen, "127.0.0.1");
  servers.push(server);
}
for (const port of [8460, 8461, 8462, 56380, 55433]) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", () =>
      reject(
        new Error(
          "Port " + port + " is already in use; stop the current lab first.",
        ),
      ),
    );
    probe.listen(port, "127.0.0.1", () => probe.close(resolve));
  });
}
tcp("redis", 56380, 56379);
tcp("db", 55433, 55432);
function startApp(node) {
  if (children[node] && !children[node].killed) return;
  const out = fs.openSync(path.join(runtime, "app-" + node + ".log"), "a");
  const jar = path.join(runtime, "app-" + node + ".jar");
  fs.copyFileSync(
    path.join(root, "backend/target/login-session-lab-1.0.0.jar"),
    jar,
  );
  const proc = spawn(process.env.JAVA_BIN || "java", ["-jar", jar], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      APP_PORT: String(ports[node]),
      APP_INSTANCE: node,
      LAB_ENABLED: "true",
      LAB_KEY: key,
    },
  });
  children[node] = proc;
  proc.on("exit", () => {
    if (children[node] === proc) delete children[node];
  });
}
startApp("A");
startApp("B");
async function stopApp(node) {
  const p = children[node];
  if (!p) return;
  await Promise.race([
    new Promise((resolve) => {
      p.once("exit", resolve);
      p.kill();
    }),
    pause(3000),
  ]);
}
// flow:Gateway.response_lost
function loseResponse(up, res) {
  up.resume();
  up.on("end", () => {
    drops.set(up.headers["x-request-id"], new Date().toISOString());
    res.destroy();
  });
}
function call(node, url, method = "GET", body) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port: ports[node],
        path: url,
        method,
        headers: { "X-Lab-Key": key, "Content-Type": "application/json" },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode,
              body: JSON.parse(Buffer.concat(chunks).toString() || "null"),
            });
          } catch {
            reject(new Error("Invalid backend response"));
          }
        });
      },
    );
    request.on("error", reject);
    request.setTimeout(7000, () =>
      request.destroy(new Error("Backend timeout")),
    );
    if (body) request.write(JSON.stringify(body));
    request.end();
  });
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 90; i++) {
  try {
    const [a, b] = await Promise.all([
      call("A", "/health"),
      call("B", "/health"),
    ]);
    if (a.status === 200 && b.status === 200) break;
  } catch {}
  if (i === 89)
    throw new Error("Apps did not start; inspect .runtime/app-A.log");
  await pause(500);
}
await call("A", "/internal/lab/runs", "POST", {
  run: "studio",
  policy: "normal",
});
function send(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 131072) {
        req.destroy();
        reject(new Error("Body too large"));
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
let testing = null;
const server = https.createServer(
  {
    key: fs.readFileSync(path.join(runtime, "dev-key.pem")),
    cert: fs.readFileSync(path.join(runtime, "dev-cert.pem")),
  },
  async (req, res) => {
    try {
      const u = new URL(req.url, "https://localhost:8460");
      if (u.pathname.startsWith("/lab/")) {
        const origin = req.headers.origin;
        if (
          (origin &&
            origin !== "https://localhost:8460" &&
            origin !== "https://127.0.0.1:8460") ||
          req.headers["x-lab-control"] !== "1"
        ) {
          send(res, 403, { code: "LAB_ORIGIN_REQUIRED" });
          return;
        }
        const run = u.searchParams.get("run") || "studio";
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(run)) {
          send(res, 400, { code: "INVALID_RUN" });
          return;
        }
        const body = ["POST", "PUT", "PATCH"].includes(req.method)
          ? JSON.parse((await readBody(req)).toString() || "{}")
          : {};
        if (u.pathname === "/lab/runs" && req.method === "POST") {
          const r = await call("A", "/internal/lab/runs", "POST", body);
          send(res, r.status, r.body);
          return;
        }
        if (u.pathname === "/lab/fault") {
          if (req.method === "POST") {
            const results = await Promise.all(
              ["A", "B"].map((n) =>
                call(n, "/internal/lab/fault", "POST", body),
              ),
            );
            send(res, results.every((r) => r.status === 200) ? 200 : 400, {
              configured: true,
            });
          } else {
            const results = await Promise.all(
              ["A", "B"].map((n) =>
                call(n, "/internal/lab/fault?run=" + encodeURIComponent(run)),
              ),
            );
            send(res, 200, { A: results[0].body, B: results[1].body });
          }
          return;
        }
        if (
          ["/lab/clear-sessions", "/lab/user-state"].includes(u.pathname) &&
          req.method === "POST"
        ) {
          const r = await call("A", "/internal" + u.pathname, "POST", body);
          send(res, r.status, r.body);
          return;
        }
        if (u.pathname === "/lab/snapshot") {
          const r = await call(
            "A",
            "/internal/lab/snapshot?run=" + encodeURIComponent(run),
          );
          send(res, r.status, r.body);
          return;
        }
        if (u.pathname === "/lab/traces") {
          const data = await Promise.allSettled(
            ["A", "B"].map((n) =>
              call(n, "/internal/lab/traces?run=" + encodeURIComponent(run)),
            ),
          );
          send(
            res,
            200,
            data
              .flatMap((r) =>
                r.status === "fulfilled" && Array.isArray(r.value.body)
                  ? r.value.body
                  : [],
              )
              .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
              .slice(0, 100)
              .map((t) =>
                drops.has(t.id)
                  ? {
                      ...t,
                      clientOutcome: "RESPONSE_LOST",
                      steps: [
                        ...t.steps,
                        {
                          node: "Browser",
                          action: "response_lost",
                          message:
                            "실제 응답 경로에서 브라우저 수신 전 연결 유실",
                          source: "Gateway.response_lost",
                          at: drops.get(t.id),
                        },
                      ],
                    }
                  : t,
              ),
          );
          return;
        }
        if (u.pathname === "/lab/system") {
          send(res, 200, {
            network,
            apps: Object.keys(children),
            infra: process.env.LOGINLAB_INFRA || "portable",
            database: "PostgreSQL 17",
            redis: "Redis 7.4",
          });
          return;
        }
        if (u.pathname === "/lab/redis-restart" && req.method === "POST") {
          network.redis = false;
          const result = await restartRedis(
            root,
            process.env.LOGINLAB_INFRA || "portable",
          );
          let cleared;
          for (let i = 0; i < 30; i++) {
            try {
              const r = await call(
                "A",
                "/internal/lab/clear-sessions",
                "POST",
                { run: body.run || run },
              );
              if (r.status === 200) {
                cleared = r.body;
                break;
              }
            } catch {}
            await pause(200);
          }
          if (!cleared) throw Error("Redis reconnection pending");
          send(res, 200, { ...result, ...cleared });
          return;
        }
        if (u.pathname === "/lab/network" && req.method === "POST") {
          if (!["redis", "db"].includes(body.target)) {
            send(res, 400, { code: "INVALID_TARGET" });
            return;
          }
          network[body.target] = !!body.down;
          for (const s of sockets[body.target]) s.destroy();
          send(res, 200, { network });
          return;
        }
        if (u.pathname === "/lab/node" && req.method === "POST") {
          if (!["A", "B"].includes(body.node)) {
            send(res, 400, {});
            return;
          }
          if (body.action === "stop") await stopApp(body.node);
          else if (body.action === "start") startApp(body.node);
          else if (body.action === "restart") {
            await stopApp(body.node);
            startApp(body.node);
          } else {
            send(res, 400, {});
            return;
          }
          send(res, 200, { node: body.node, action: body.action });
          return;
        }
        if (u.pathname === "/lab/results") {
          const file = path.join(root, "test-results/summary.json");
          send(
            res,
            200,
            fs.existsSync(file)
              ? JSON.parse(fs.readFileSync(file, "utf8"))
              : { status: testing ? "running" : "not-run", tests: [] },
          );
          return;
        }
        if (u.pathname === "/lab/test" && req.method === "POST") {
          if (testing) {
            send(res, 409, { code: "TEST_RUNNING" });
            return;
          }
          const args = [
            path.join(root, "node_modules/@playwright/test/cli.js"),
            "test",
          ];
          if (body.stage === "stage1") args.push("--grep", "@stage1");
          fs.mkdirSync(path.join(root, "test-results"), { recursive: true });
          fs.writeFileSync(
            path.join(root, "test-results/summary.json"),
            JSON.stringify({ status: "running", tests: [] }),
          );
          const testLog = fs.openSync(
            path.join(runtime, "browser-tests.log"),
            "a",
          );
          testing = spawn(process.execPath, args, {
            cwd: root,
            windowsHide: true,
            stdio: ["ignore", testLog, testLog],
          });
          fs.closeSync(testLog);
          testing.on("exit", (code) => {
            testing = null;
            const summaryPath = path.join(root, "test-results/summary.json");
            const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
            if (code !== 0 && summary.status === "running") {
              fs.writeFileSync(
                summaryPath,
                JSON.stringify({
                  ...summary,
                  status: "failed",
                  message:
                    "테스트 실행을 완료하지 못했습니다. .runtime/browser-tests.log를 확인하세요.",
                }),
              );
            }
          });
          send(res, 202, { status: "running" });
          return;
        }
        send(res, 404, { code: "NOT_FOUND" });
        return;
      }
      if (u.pathname.startsWith("/api/")) {
        const drop = req.headers["x-lab-drop-response"] === "1";
        const node = req.headers["x-lab-node"] === "B" ? "B" : "A";
        const headers = {
          ...req.headers,
          host: "127.0.0.1:" + ports[node],
          "x-forwarded-proto": "https",
        };
        delete headers["x-lab-key"];
        delete headers.connection;
        headers["x-lab-run"] = /^[A-Za-z0-9_-]{1,80}$/.test(
          String(headers["x-lab-run"] || ""),
        )
          ? headers["x-lab-run"]
          : "studio";
        const proxy = http.request(
          {
            hostname: "127.0.0.1",
            port: ports[node],
            path: u.pathname + u.search,
            method: req.method,
            headers,
          },
          (up) => {
            if (drop) {
              loseResponse(up, res);
              return;
            }
            res.writeHead(up.statusCode, up.headers);
            up.pipe(res);
          },
        );
        proxy.on("error", () => {
          if (!res.headersSent)
            send(res, 503, {
              code: "APP_UNAVAILABLE",
              message: "애플리케이션 서버에 연결할 수 없습니다.",
            });
          else res.destroy();
        });
        proxy.setTimeout(12000, () => proxy.destroy());
        req.pipe(proxy);
        return;
      }
      const raw = decodeURIComponent(u.pathname);
      let file = path.resolve(root, "dist", "." + raw);
      const dist = path.join(root, "dist");
      if (!file.startsWith(dist + path.sep) && file !== dist) {
        send(res, 404, {});
        return;
      }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory())
        file = path.join(dist, "index.html");
      const types = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
      };
      res.writeHead(200, {
        "Content-Type": types[path.extname(file)] || "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "same-origin",
      });
      fs.createReadStream(file).pipe(res);
    } catch {
      if (!res.headersSent)
        send(res, 503, {
          code: "LAB_UNAVAILABLE",
          message: "관찰 또는 제어 결과를 확인할 수 없습니다.",
        });
      else res.destroy();
    }
  },
);
server.listen(8460, "127.0.0.1", () => {
  fs.writeFileSync(
    path.join(runtime, "processes.json"),
    JSON.stringify({
      root,
      startedAt: gatewayStarted,
      gateway: process.pid,
      apps: Object.fromEntries(
        Object.entries(children).map(([n, p]) => [n, p.pid]),
      ),
    }),
  );
  console.log("Login Session Lab: https://localhost:8460");
});
servers.push(server);
process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());
function shutdown() {
  for (const p of Object.values(children)) p.kill();
  for (const list of Object.values(sockets)) for (const s of list) s.destroy();
  for (const s of servers) s.close();
  process.exit(0);
}
