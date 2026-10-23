import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export function groupOf(pack) {
  return pack === "material" ? "material" : "acme";
}

function accepted(row) {
  return new Set([row.expect?.lead ?? "", ...(row.alternates ?? [])].filter(Boolean));
}

function isNoFit(row) {
  return row.expect?.accept !== "exact" || (row.tags ?? []).includes("no-fit");
}

function shown(result) {
  return Boolean(result && result.tier !== "no-fit" && result.id);
}

function keyOf(result) {
  return `${result?.tier ?? ""}|${shown(result) ? result.id : ""}`;
}

export function majority(rows) {
  const counts = new Map();
  for (const row of rows) {
    const key = keyOf(row.result);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best;
  let votes = 0;
  for (const [key, count] of counts) {
    if (count > votes) {
      best = key;
      votes = count;
    }
  }
  if (!best || votes < 2) return undefined;
  return rows.find((row) => keyOf(row.result) === best);
}

function namesOf(shortlist, packNames) {
  return shortlist.map((id) => packNames[id] ?? id);
}

function rate(hit, of) {
  return of === 0 ? 0 : hit / of;
}

export function scoreRecorded(cases, runs, namesByPack) {
  const byCase = new Map();
  for (const run of runs) {
    const list = byCase.get(run.caseId) ?? [];
    list.push(run);
    byCase.set(run.caseId, list);
  }
  const groups = {
    material: emptyGroup(),
    acme: emptyGroup(),
    total: emptyGroup(),
  };
  let invented = 0;
  let unquoted = 0;
  let thinPlaced = 0;
  const lost = [];
  for (const row of cases) {
    const group = groupOf(row.pack);
    const bucket = [groups[group], groups.total];
    for (const item of bucket) item.asks += 1;
    const recorded = byCase.get(row.id) ?? [];
    const packNames = namesByPack[row.pack] ?? {};
    const indexIds = new Set(Object.keys(packNames));
    for (const run of recorded) {
      const ids = [...(run.shortlist ?? []), ...(run.request?.pick ? [run.request.pick] : [])];
      for (const id of ids) if (id && !indexIds.has(id)) invented += 1;
    }
    const winner = majority(recorded);
    const keys = new Set(recorded.map((run) => keyOf(run.result)));
    const unstable = recorded.length < 3 || keys.size !== 1;
    if (unstable) for (const item of bucket) item.unstable += 1;
    if (!winner) for (const item of bucket) item.split += 1;
    const ok = accepted(row);
    const leadName = winner?.result?.name ?? "";
    const noFit = Boolean(winner) && winner.result.tier === "no-fit" && !winner.result.id;
    const exact = row.expect?.accept === "exact";
    const fit1 = exact ? Boolean(winner) && ok.has(leadName) : noFit;
    const shortlistNames = namesOf((winner?.shortlist ?? []).slice(0, 3), packNames);
    const fit3 = exact ? shortlistNames.some((name) => ok.has(name)) : noFit;
    if (fit1) for (const item of bucket) item.top1 += 1;
    if (fit3) for (const item of bucket) item.top3 += 1;
    if ((row.tags ?? []).includes("meaning-only")) {
      for (const item of bucket) item.avoid += 1;
      if (fit3) for (const item of bucket) item.avoidHit += 1;
    }
    if (isNoFit(row)) {
      for (const item of bucket) item.noFit += 1;
      if (noFit) for (const item of bucket) item.noFitHit += 1;
    }
    if ((row.tags ?? []).includes("confusable") && winner?.result?.tier === "place" && !ok.has(leadName)) {
      for (const item of bucket) item.confusableWrong += 1;
    }
    if (winner && shown(winner.result)) {
      const failed = winner.result.failed ?? [];
      if (!winner.result.reason || failed.includes("quote") || failed.includes("alias-quote")) unquoted += 1;
      if (winner.result.tier === "place" && (winner.result.thin ?? []).some((entry) => entry.id === winner.result.id)) thinPlaced += 1;
    }
    if (!fit1) lost.push(row.id);
  }
  return { groups, invented, unquoted, thinPlaced, lost };
}

function emptyGroup() {
  return { asks: 0, top1: 0, top3: 0, avoid: 0, avoidHit: 0, noFit: 0, noFitHit: 0, confusableWrong: 0, unstable: 0, split: 0 };
}

function pct(hit, of) {
  return `${Math.round(rate(hit, of) * 1000) / 10}%`;
}

function line(label, hit, of, need) {
  const mark = need === undefined ? "" : hit >= need ? " pass" : " fail";
  const bar = need === undefined ? "" : ` need ${need}/${of}`;
  return `${label} ${hit}/${of} ${pct(hit, of)}${bar}${mark}`;
}

export function formatScore(report, cases) {
  const materialAsks = cases.filter((row) => groupOf(row.pack) === "material").length;
  const acmeAsks = cases.length - materialAsks;
  const materialAvoid = cases.filter((row) => groupOf(row.pack) === "material" && (row.tags ?? []).includes("meaning-only")).length;
  const acmeAvoid = cases.filter((row) => groupOf(row.pack) === "acme" && (row.tags ?? []).includes("meaning-only")).length;
  const materialNoFit = cases.filter((row) => groupOf(row.pack) === "material" && isNoFit(row)).length;
  const acmeNoFit = cases.filter((row) => groupOf(row.pack) === "acme" && isNoFit(row)).length;
  const material = report.groups.material;
  const acme = report.groups.acme;
  const total = report.groups.total;
  const lines = [
    `Material ${materialAsks}`,
    line("top-1", material.top1, materialAsks, materialAsks === 60 ? 48 : undefined),
    line("top-3", material.top3, materialAsks, materialAsks === 60 ? 54 : undefined),
    line("name-avoiding top-3", material.avoidHit, materialAvoid, materialAvoid === 32 ? 28 : undefined),
    line("no-fit", material.noFitHit, materialNoFit, materialNoFit === 6 ? 6 : undefined),
    `confusable sure-wrong ${material.confusableWrong}`,
    `unstable ${material.unstable}/${materialAsks} ${pct(material.unstable, materialAsks)}`,
    `split ${material.split}/${materialAsks}`,
    `Acme ${acmeAsks}`,
    line("top-1", acme.top1, acmeAsks, acmeAsks === 51 ? 13 : undefined),
    line("top-3", acme.top3, acmeAsks, acmeAsks === 51 ? 15 : undefined),
    line("name-avoiding top-3", acme.avoidHit, acmeAvoid, undefined),
    line("no-fit", acme.noFitHit, acmeNoFit, acmeNoFit === 11 ? 10 : undefined),
    `confusable sure-wrong ${acme.confusableWrong}`,
    `unstable ${acme.unstable}/${acmeAsks} ${pct(acme.unstable, acmeAsks)}`,
    `split ${acme.split}/${acmeAsks}`,
    `Total ${cases.length}`,
    line("top-1", total.top1, cases.length, undefined),
    line("top-3", total.top3, cases.length, undefined),
    line("name-avoiding top-3", total.avoidHit, total.avoid, undefined),
    line("no-fit", total.noFitHit, total.noFit, undefined),
    `confusable sure-wrong ${total.confusableWrong}`,
    `invented ${report.invented}`,
    `unquoted ${report.unquoted}`,
    `thin placed ${report.thinPlaced}`,
    `unstable ${total.unstable}/${cases.length}`,
  ];
  return lines.join("\n");
}

export function readNames(root = join(repo, "meaning")) {
  const names = {};
  for (const pack of readdirSync(root)) {
    const dir = join(root, pack);
    const map = {};
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!file.endsWith(".md") || file === "index.md") continue;
      const text = readFileSync(join(dir, file), "utf8");
      const title = text.split("\n").find((line) => line.startsWith("# ")) ?? "";
      const name = title.includes(" / ") ? title.slice(title.lastIndexOf(" / ") + 3).trim() : file.slice(0, -3);
      map[file.slice(0, -3)] = name;
    }
    if (Object.keys(map).length) names[pack] = map;
  }
  return names;
}

function readCases(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return Array.isArray(parsed) ? parsed : parsed.cases;
}

function readRuns(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function promptFor(row) {
  return [
    `Library: ${row.pack}`,
    "Read that library's index, shortlist at most 3 component files, then open those files. Stop after two hops.",
    `Ask: ${row.ask}`,
    "Reply with one JSON object and no other text.",
    'Fields: library, ask, shortlist, pick, props, reason, tier.',
    "tier is place, ask, or no-fit.",
    "reason is a verbatim quote from the component's name, description, guidelines, or a prop name or value.",
    "Do not quote an Aliases line. If the file has a Thin line, do not use tier place.",
    "If nothing in the library fits, tier is no-fit and omit pick.",
  ].join("\n");
}

function writeBlindPrompts(casesPath, outDir) {
  const cases = readCases(casesPath);
  mkdirSync(outDir, { recursive: true });
  const groups = { material: [], acme: [] };
  for (const row of cases) {
    const group = groupOf(row.pack);
    groups[group].push(JSON.stringify({ id: row.id, ask: row.ask, library: row.pack }));
  }
  for (const [group, lines] of Object.entries(groups)) {
    writeFileSync(join(outDir, `${group}.jsonl`), lines.length ? `${lines.join("\n")}\n` : "");
  }
  process.stdout.write(`wrote ${cases.length} blind prompts to ${outDir}\n`);
}

function prepare(casesPath, outDir) {
  const cases = readCases(casesPath);
  mkdirSync(outDir, { recursive: true });
  for (const row of cases) writeFileSync(join(outDir, `${row.id}.txt`), `${promptFor(row)}\n`);
  process.stdout.write(`wrote ${cases.length} prompts to ${outDir}\n`);
}

function score(casesPath, runsPath) {
  const cases = readCases(casesPath);
  const runs = readRuns(runsPath);
  const report = scoreRecorded(cases, runs, readNames());
  process.stdout.write(`${formatScore(report, cases)}\n`);
}

const invoked = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href || process.argv[1]?.endsWith("ai-picks-eval.mjs");
if (invoked) {
  const command = process.argv[2];
  if (command === "prompts") writeBlindPrompts(arg("--cases") ?? join(repo, "scoreboard/meaning/frozen.json"), arg("--out") ?? join(repo, "scoreboard/ai-picks/prompts"));
  else if (command === "prepare") prepare(arg("--cases") ?? join(repo, "scoreboard/meaning/frozen.json"), arg("--out") ?? join(repo, "scoreboard/ai-picks/prompts"));
  else if (command === "score") {
    const cases = arg("--cases");
    const runs = arg("--runs");
    if (!cases || !runs) {
      process.stderr.write("Usage: node scripts/ai-picks-eval.mjs score --cases <file> --runs <jsonl>\n");
      process.exit(1);
    }
    score(cases, runs);
  } else {
    process.stderr.write("Usage: node scripts/ai-picks-eval.mjs prompts|prepare|score\n");
    process.exit(1);
  }
}
