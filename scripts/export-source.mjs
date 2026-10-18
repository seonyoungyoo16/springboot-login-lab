import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const dir = path.resolve("backend/src/main/java/dev/portfolio/loginlab");
const result = {};
for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".java"))) {
  const text = fs.readFileSync(path.join(dir, name), "utf8"),
    lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/flow:([\w.]+)/);
    if (m)
      result[m[1]] = {
        file: "backend/src/main/java/dev/portfolio/loginlab/" + name,
        line: i + 2,
        sha256: crypto.createHash("sha256").update(text).digest("hex"),
        snippet: lines.slice(i + 1, i + 33).join("\n"),
      };
  }
}
{
  const file = "scripts/gateway.mjs",
    text = fs.readFileSync(file, "utf8"),
    lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/flow:([\w.]+)/);
    if (m)
      result[m[1]] = {
        file,
        line: i + 2,
        sha256: crypto.createHash("sha256").update(text).digest("hex"),
        snippet: lines.slice(i + 1, i + 33).join("\n"),
      };
  }
}
fs.mkdirSync("public", { recursive: true });
fs.writeFileSync("public/flow-source.json", JSON.stringify(result, null, 2));
console.log(Object.keys(result).length + " verified source anchors");
