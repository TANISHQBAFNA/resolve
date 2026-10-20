import { readFileSync } from "node:fs";

const baselinePath = process.argv[2] ?? "scoreboard/phrase-baseline.json";
const reportPath = process.argv[3];
if (!reportPath) {
  process.stderr.write("Usage: node scripts/check-phrase-floor.mjs <baseline.json> <phrase-report.json>\n");
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
const top1 = report.totals?.top1;
const top3 = report.totals?.top3;
const matchCases = report.totals?.matchCases;
const floor1 = baseline.top1;
const floor3 = baseline.top3;
const floorBase = baseline.matchCases;

function badNumber(value) {
  return typeof value !== "number" || !Number.isFinite(value);
}

const failures = [];
if (badNumber(floor1) || badNumber(floor3) || badNumber(floorBase) || floorBase <= 0) {
  failures.push(`${baselinePath} needs numeric top1, top3, and matchCases`);
}
if (badNumber(top1) || badNumber(top3) || badNumber(matchCases) || matchCases <= 0) {
  failures.push("phrase report is missing totals.top1, totals.top3, or totals.matchCases");
}
if (!failures.length) {
  const top1Rate = top1 / matchCases;
  const top3Rate = top3 / matchCases;
  const floor1Rate = floor1 / floorBase;
  const floor3Rate = floor3 / floorBase;
  if (top1Rate < floor1Rate) {
    failures.push(`top-1 ${top1}/${matchCases} is below ${floor1}/${floorBase}`);
  }
  if (top3Rate < floor3Rate) {
    failures.push(`top-3 ${top3}/${matchCases} is below ${floor3}/${floorBase}`);
  }
}

if (failures.length) {
  process.stderr.write(`Phrase scoreboard dropped below the floor in ${baselinePath}:\n${failures.map((line) => `- ${line}`).join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(
  `Phrase scoreboard holds: top-1 ${top1}/${matchCases}, top-3 ${top3}/${matchCases} (floor ${floor1}/${floorBase} and ${floor3}/${floorBase}).\n`,
);
