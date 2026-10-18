import { spawnSync } from "node:child_process";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
const stages = [];
for (const file of [
  "backend.mjs",
  "backend-stage2.mjs",
  "backend-stage3.mjs",
  "backend-stage4.mjs",
  "backend-stage5.mjs",
]) {
  const r = spawnSync(process.execPath, [path.resolve("test", file)], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.status !== 0) {
    process.stderr.write(r.stderr);
    process.stdout.write(r.stdout);
    process.exit(r.status || 1);
  }
  const result = JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1));
  stages.push(result);
  console.log(result.stage + ": " + result.passed + " passed");
}
fs.mkdirSync("docs/verification", { recursive: true });
const out = {
  status: "passed",
  completedAt: new Date().toISOString(),
  passed: stages.reduce((s, r) => s + r.passed, 0),
  stages,
};
fs.writeFileSync(
  "docs/verification/backend.json",
  JSON.stringify(out, null, 2),
);
console.log(JSON.stringify({ status: out.status, passed: out.passed }));
