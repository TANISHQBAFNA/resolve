import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Source files only. Generated output is allowlisted by name. */
const LIMIT = 1000;
const ROOT = "src";
const ALLOW = [
  /\.generated\.ts$/,
  /\.gen\.ts$/,
  /\.d\.ts$/,
];

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (name === "node_modules" || name === "dist" || name === "dist-server") continue;
      walk(path, out);
      continue;
    }
    if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
    if (ALLOW.some((pattern) => pattern.test(path))) continue;
    out.push(path);
  }
}

const files = [];
walk(ROOT, files);
const over = [];
for (const path of files) {
  const lines = readFileSync(path, "utf8").split("\n").length;
  const count = readFileSync(path, "utf8").endsWith("\n") ? lines - 1 : lines;
  if (count > LIMIT) over.push(`${count} ${path}`);
}

if (over.length) {
  process.stderr.write(`Source files over ${LIMIT} lines (generated files are allowlisted):\n${over.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(`${files.length} source files, none over ${LIMIT} lines.\n`);
