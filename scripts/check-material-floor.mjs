import { readFileSync } from "node:fs";

const baselinePath = process.argv[2] ?? "scoreboard/material-baseline.json";
const reportPath = process.argv[3];
if (!reportPath) {
  process.stderr.write("Usage: node scripts/check-material-floor.mjs <baseline.json> <phrase-report.json>\n");
  process.exit(1);
}

function readJson(path) {
  const raw = readFileSync(path, "utf8");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`${path} has no JSON object`);
  return JSON.parse(raw.slice(start, end + 1));
}

let baseline;
let report;
try {
  baseline = readJson(baselinePath);
  report = readJson(reportPath);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

const totals = report.totals ?? {};
const failures = [];

function bad(value) {
  return typeof value !== "number" || !Number.isFinite(value);
}

const top1 = totals.top1;
const top3 = totals.top3;
const matchCases = totals.matchCases;
const correctEmpty = totals.correctEmpty;
const emptyCases = totals.emptyCases;
const invented = totals.invented;

if (bad(baseline.top1) || bad(baseline.top3) || bad(baseline.matchCases) || baseline.matchCases <= 0) {
  failures.push(`${baselinePath} needs numeric top1, top3, and matchCases`);
}
if (bad(top1) || bad(top3) || bad(matchCases) || matchCases <= 0) {
  failures.push("Material phrase report is missing totals.top1, totals.top3, or totals.matchCases");
}
if (!failures.length) {
  if (top1 / matchCases < baseline.top1 / baseline.matchCases) {
    failures.push(`top-1 ${top1}/${matchCases} is below ${baseline.top1}/${baseline.matchCases}`);
  }
  if (top3 / matchCases < baseline.top3 / baseline.matchCases) {
    failures.push(`top-3 ${top3}/${matchCases} is below ${baseline.top3}/${baseline.matchCases}`);
  }
}
if (bad(baseline.emptyCorrect) || bad(baseline.emptyCases)) {
  failures.push(`${baselinePath} needs numeric emptyCorrect and emptyCases`);
} else if (bad(correctEmpty) || bad(emptyCases)) {
  failures.push("Material phrase report is missing empty totals");
} else if (emptyCases < baseline.emptyCases || correctEmpty < baseline.emptyCorrect) {
  failures.push(`empty-correct ${correctEmpty}/${emptyCases} is below ${baseline.emptyCorrect}/${baseline.emptyCases}`);
}
if (invented !== 0) failures.push(`invented ${invented} (must be 0)`);

if (failures.length) {
  process.stderr.write(`Material scoreboard dropped below the floor in ${baselinePath}:\n${failures.map((line) => `- ${line}`).join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(
  `Material scoreboard holds: top-1 ${top1}/${matchCases}, top-3 ${top3}/${matchCases}, empty-correct ${correctEmpty}/${emptyCases}, invented ${invented}.\n`,
);
