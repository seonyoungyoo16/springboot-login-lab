import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
const design = fs.readFileSync("docs/DESIGN.md", "utf8"),
  expected = [...design.matchAll(/^\| ([A-Z]\d{2}) \|/gm)].map((m) => m[1]);
const summary = JSON.parse(
  fs.readFileSync("test-results/summary.json", "utf8"),
);
assert.equal(summary.status, "passed");
const ids = summary.tests.map((t) => t.id);
assert.equal(new Set(ids).size, ids.length);
for (const id of expected)
  assert.ok(
    summary.tests.some((t) => t.id === id && t.status === "passed"),
    "Missing passing scenario " + id,
  );
const graph = JSON.parse(fs.readFileSync("public/flow-source.json", "utf8"));
for (const [tag, e] of Object.entries(graph)) {
  const text = fs.readFileSync(e.file, "utf8");
  assert.equal(
    crypto.createHash("sha256").update(text).digest("hex"),
    e.sha256,
    "Source mismatch " + tag,
  );
  assert.ok(
    text
      .split(/\r?\n/)
      .slice(0, e.line)
      .some((l) => l.includes("flow:" + tag)),
  );
}
const files = [];
function walk(dir) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p);
    else files.push(p.replaceAll("\\", "/"));
  }
}
walk("backend/src");
walk("frontend");
walk("scripts");
files.push("backend/pom.xml", "package.json", "package-lock.json");
const inputs = files
  .sort()
  .map((file) => ({
    file,
    sha256: crypto
      .createHash("sha256")
      .update(fs.readFileSync(file))
      .digest("hex"),
  }));
const sourceSha256 = crypto
  .createHash("sha256")
  .update(JSON.stringify(inputs))
  .digest("hex");
const report = {
  status: "passed",
  completedAt: new Date().toISOString(),
  designScenarios: expected.length,
  passingDesignScenarios: expected.filter((id) => ids.includes(id)).length,
  additionalScenarios: ids.filter((id) => !expected.includes(id)),
  browserScenarios: ids.length,
  sourceAnchors: Object.keys(graph).length,
  sourceSha256,
  inputs,
};
fs.mkdirSync("docs/verification", { recursive: true });
fs.writeFileSync(
  "docs/verification/coverage.json",
  JSON.stringify(report, null, 2),
);
fs.copyFileSync(
  "test-results/summary.json",
  "docs/verification/browser-full.json",
);
console.log(
  JSON.stringify({
    status: report.status,
    designScenarios: report.designScenarios,
    passingDesignScenarios: report.passingDesignScenarios,
    additionalScenarios: report.additionalScenarios,
    sourceAnchors: report.sourceAnchors,
  }),
);
