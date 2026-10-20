import { readFileSync } from "node:fs";

const baselinePath = process.argv[2] ?? "scoreboard/phrase-baseline.json";
const reportPath = process.argv[3];
const goldenPath = process.argv[4];
if (!reportPath) {
  process.stderr.write("Usage: node scripts/check-phrase-floor.mjs <baseline.json> <phrase-report.json> [golden-report.json]\n");
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
let golden;
try {
  baseline = readJson(baselinePath);
  report = readJson(reportPath);
  golden = goldenPath ? readJson(goldenPath) : undefined;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
const totals = report.totals ?? {};
const top1 = totals.top1;
const top3 = totals.top3;
const matchCases = totals.matchCases;
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
  if (typeof baseline.invented === "number" && totals.invented > baseline.invented) {
    failures.push(`invented ${totals.invented} is above ${baseline.invented}`);
  }
  if (typeof baseline.retired === "number" && totals.retiredRecommended > baseline.retired) {
    failures.push(`retired ${totals.retiredRecommended} is above ${baseline.retired}`);
  }
  if (typeof baseline.correctEmpty === "number" && totals.correctEmpty < baseline.correctEmpty) {
    failures.push(`empty-correct ${totals.correctEmpty} is below ${baseline.correctEmpty}`);
  }
  if (typeof baseline.emptyCases === "number" && totals.emptyCases < baseline.emptyCases) {
    failures.push(`empty cases ${totals.emptyCases} is below ${baseline.emptyCases}`);
  }
  if (golden) {
    if (typeof baseline.goldenCases === "number" && golden.cases < baseline.goldenCases) {
      failures.push(`golden cases ${golden.cases} is below ${baseline.goldenCases}`);
    }
    if (typeof baseline.goldenInvent === "number" && golden.inventCount > baseline.goldenInvent) {
      failures.push(`golden invented ${golden.inventCount} is above ${baseline.goldenInvent}`);
    }
    const toolFloors = baseline.goldenTools;
    if (toolFloors && typeof toolFloors === "object") {
      const tools = Array.isArray(golden.tools) ? golden.tools : [];
      for (const [name, floor] of Object.entries(toolFloors)) {
        const wantTop = floor && typeof floor.top1 === "number" ? floor.top1 : undefined;
        const wantScored = floor && typeof floor.scored === "number" ? floor.scored : undefined;
        if (wantTop === undefined || wantScored === undefined) {
          failures.push(`${baselinePath} goldenTools.${name} needs numeric top1 and scored`);
          continue;
        }
        const row = tools.find((tool) => tool && tool.tool === name);
        const top = row && typeof row.top1Count === "number" ? row.top1Count : undefined;
        const scored = row && typeof row.scored === "number" ? row.scored : undefined;
        if (top === undefined || scored === undefined) {
          failures.push(`golden ${name} is missing a pass count`);
          continue;
        }
        if (top < wantTop || scored < wantScored) {
          failures.push(`golden ${name} ${top}/${scored} is below ${wantTop}/${wantScored}`);
        }
      }
    }
  }
}

if (failures.length) {
  process.stderr.write(`Phrase scoreboard dropped below the floor in ${baselinePath}:\n${failures.map((line) => `- ${line}`).join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(
  `Phrase scoreboard holds: top-1 ${top1}/${matchCases}, top-3 ${top3}/${matchCases} (floor ${floor1}/${floorBase} and ${floor3}/${floorBase}).\n`,
);
