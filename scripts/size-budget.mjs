// Counts source lines per area and fails when an area is over its budget (package.json "resolveSizeBudget").
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const areas = {
  code: { dirs: ["src/server/code"], label: "code engine + pick (src/server/code)" },
  server: { dirs: ["src/server"], skip: ["src/server/code"], label: "rest of server (src/server)" },
  core: { dirs: ["src/core"], label: "Figma core (src/core)" },
};
const budget = JSON.parse(readFileSync("package.json", "utf8")).resolveSizeBudget ?? {};

const FILE_CAP = 1000;
const long = [];

function lines(dir, skip = []) {
  let n = 0;
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (skip.includes(path)) continue;
    if (item.isDirectory()) n += lines(path, skip);
    else if (/\.(ts|tsx|mts)$/.test(item.name) && !/\.(test|spec)\./.test(item.name)) {
      const text = readFileSync(path, "utf8");
      n += text.split("\n").length;
      if (text.split("\n").length - 1 > FILE_CAP) long.push(`${path} (${text.split("\n").length - 1})`);
    }
  }
  return n;
}

const counts = Object.fromEntries(Object.entries(areas).map(([key, a]) => [key, a.dirs.reduce((sum, d) => sum + lines(d, a.skip), 0)]));
const total = Object.values(counts).reduce((a, b) => a + b, 0);
let failed = false;
for (const [key, a] of Object.entries(areas)) {
  const limit = budget[key];
  const over = limit !== undefined && counts[key] > limit;
  failed ||= over;
  console.log(`${key.padEnd(7)} ${String(counts[key]).padStart(6)} lines  ${((counts[key] / total) * 100).toFixed(1).padStart(5)}%  budget ${limit ?? "none"}  ${over ? "OVER" : "ok"}  ${a.label}`);
}
console.log(`total   ${String(total).padStart(6)} lines`);
for (const file of long) console.error(`${file} is over ${FILE_CAP} lines. Split it.`);
failed ||= long.length > 0;
if (failed) {
  console.error("Over the size budget. Trim the code or raise resolveSizeBudget in package.json on purpose.");
  process.exit(1);
}
