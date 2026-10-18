import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createClient } from "redis";
const exec = promisify(execFile),
  pause = (ms) => new Promise((r) => setTimeout(r, ms));
export async function restartRedis(root, mode) {
  if (mode === "docker") {
    await exec("docker", ["compose", "restart", "redis"], {
      cwd: root,
      windowsHide: true,
      timeout: 25000,
    });
  } else {
    const runtime = path.join(root, ".runtime"),
      bin = path.join(runtime, "redis/Redis-7.4.3-Windows-x64-cygwin");
    await exec(
      path.join(bin, "redis-cli.exe"),
      ["-h", "127.0.0.1", "-p", "56379", "SHUTDOWN", "SAVE"],
      { windowsHide: true, timeout: 8000 },
    );
    await pause(250);
    const data = path.join(runtime, "redis-data"),
      unix =
        "/cygdrive/" +
        data[0].toLowerCase() +
        data.slice(2).replaceAll("\\", "/");
    const out = fs.openSync(path.join(runtime, "redis-restart.log"), "a");
    const p = spawn(
      path.join(bin, "redis-server.exe"),
      [
        "--bind",
        "127.0.0.1",
        "--port",
        "56379",
        "--dir",
        unix,
        "--appendonly",
        "yes",
        "--loglevel",
        "warning",
      ],
      { cwd: bin, windowsHide: true, stdio: ["ignore", out, out] },
    );
    fs.closeSync(out);
    p.on("error", () => {});
    fs.writeFileSync(path.join(runtime, "redis.pid"), String(p.pid));
  }
  for (let i = 0; i < 40; i++) {
    const c = createClient({
      url: "redis://127.0.0.1:56379",
      socket: { connectTimeout: 500, reconnectStrategy: false },
    });
    c.on("error", () => {});
    try {
      await c.connect();
      const version = (await c.info("server")).match(
        /redis_version:([^\r\n]+)/,
      )?.[1];
      await c.quit();
      return { restarted: true, version };
    } catch {
      if (c.isOpen) c.destroy();
      await pause(200);
    }
  }
  throw Error("Redis restart did not become ready");
}
