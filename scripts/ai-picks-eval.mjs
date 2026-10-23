import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
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

export function caseRuns(rows) {
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.run)) return { error: "duplicate", runs: [] };
    seen.add(row.run);
  }
  const runs = [...rows].sort((a, b) => Number(a.run) - Number(b.run) || String(a.run).localeCompare(String(b.run)));
  return { runs };
}

export function majority(rows) {
  const counts = new Map();
  for (const row of rows) {
    const key = keyOf(row.result);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const best = ranked[0];
  if (!best || best[1] < 2) return undefined;
  return rows.find((row) => keyOf(row.result) === best[0]);
}

function winnerOf(runs) {
  if (runs.length === 1) return { winner: runs[0], oneRun: true };
  if (runs.length !== 3) return { winner: undefined, oneRun: false };
  return { winner: majority(runs), oneRun: false };
}

function namesOf(shortlist, packNames) {
  return shortlist.map((id) => packNames[id] ?? id);
}

function rate(hit, of) {
  return of === 0 ? 0 : hit / of;
}

function componentKey(result) {
  if (!result || result.tier === "no-fit" || !result.id) return "";
  return result.id;
}

function gateHit(runs, ok) {
  const picked = runs.map((run) => (shown(run.result) ? run.result.name ?? "" : ""));
  if (picked.length > 0 && picked.every((name) => name && ok.has(name))) return false;
  const ids = new Set(runs.map((run) => componentKey(run.result)));
  if (ids.size > 1) return true;
  const noFit = runs.some((run) => run.result?.tier === "no-fit");
  const placed = runs.some((run) => shown(run.result));
  return noFit && placed;
}

function tierFlip(runs) {
  return new Set(runs.map((run) => run.result?.tier ?? "")).size > 1;
}

export function scoreRecorded(cases, runs, namesByPack, indexIds = {}, mainCorrect = undefined) {
  const byCase = new Map();
  for (const run of runs) {
    const list = byCase.get(run.caseId) ?? [];
    list.push(run);
    byCase.set(run.caseId, list);
  }
  const groups = { material: emptyGroup(), acme: emptyGroup(), total: emptyGroup() };
  let invented = 0;
  let unquoted = 0;
  let thinPlaced = 0;
  let oneRun = false;
  let duplicates = 0;
  const lost = { material: [], acme: [] };
  for (const row of cases) {
    const group = groupOf(row.pack);
    const bucket = [groups[group], groups.total];
    for (const item of bucket) item.asks += 1;
    const parsed = caseRuns(byCase.get(row.id) ?? []);
    if (parsed.error) {
      duplicates += 1;
      continue;
    }
    const known = indexIds[row.pack] ?? new Set();
    for (const run of parsed.runs) {
      const ids = [...(run.request?.shortlist ?? []), ...(typeof run.request?.pick === "string" ? [run.request.pick] : [])];
      for (const id of ids) if (id && !known.has(id)) invented += 1;
      if (run.request?.tier === "place" && (run.result?.thin ?? []).some((entry) => entry.id === run.request.pick)) thinPlaced += 1;
    }
    const picked = winnerOf(parsed.runs);
    if (picked.oneRun) oneRun = true;
    const winner = picked.winner;
    if (!winner && !picked.oneRun) for (const item of bucket) item.split += 1;
    if (parsed.runs.length > 1 && gateHit(parsed.runs, accepted(row))) for (const item of bucket) { item.gate += 1; item.unstable += 1; }
    if (parsed.runs.length > 1 && tierFlip(parsed.runs)) for (const item of bucket) item.tierFlips += 1;
    const ok = accepted(row);
    const leadName = winner?.result?.name ?? "";
    const noFit = Boolean(winner) && winner.result.tier === "no-fit" && !winner.result.id;
    const exact = row.expect?.accept === "exact";
    const fit1 = exact ? Boolean(winner) && winner.result.tier !== "no-fit" && ok.has(leadName) : noFit;
    const shortlistNames = namesOf((winner?.request?.shortlist ?? []).slice(0, 3), namesByPack[row.pack] ?? {});
    const fit3 = exact ? Boolean(winner) && winner.result.tier !== "no-fit" && shortlistNames.some((name) => ok.has(name)) : noFit;
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
    }
    if (mainCorrect?.[row.id] && !fit1) lost[group].push(row.id);
  }
  return { groups, invented, unquoted, thinPlaced, lost: mainCorrect ? lost : undefined, oneRun, duplicates };
}

function emptyGroup() {
  return { asks: 0, top1: 0, top3: 0, avoid: 0, avoidHit: 0, noFit: 0, noFitHit: 0, confusableWrong: 0, unstable: 0, gate: 0, tierFlips: 0, split: 0 };
}

function pct(hit, of) {
  return `${Math.round(rate(hit, of) * 1000) / 10}%`;
}

function cap(label, hit, of, target) {
  if (!of) return `${label} ${hit}/${of}`;
  const mark = hit / of <= target + 1e-12 ? " pass" : " fail";
  return `${label} ${hit}/${of} ${pct(hit, of)} at most ${Math.round(target * 1000) / 10}%${mark}`;
}

function line(label, hit, of, target) {
  if (!of || target === undefined) return `${label} ${hit}/${of} ${pct(hit, of)}`;
  const mark = hit / of >= target ? " pass" : " fail";
  return `${label} ${hit}/${of} ${pct(hit, of)} target ${Math.round(target * 1000) / 10}%${mark}`;
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
    line("top-1", material.top1, materialAsks, 0.8),
    line("top-3", material.top3, materialAsks, 0.9),
    line("name-avoiding top-3", material.avoidHit, materialAvoid, 0.85),
    line("no-fit", material.noFitHit, materialNoFit, 0.9),
    `confusable sure-wrong ${material.confusableWrong}`,
    cap("gate", material.gate, materialAsks, 0.05),
    cap("tier flips", material.tierFlips, materialAsks, 0.1),
    `split ${material.split}/${materialAsks}`,
    `Acme ${acmeAsks}`,
    line("top-1", acme.top1, acmeAsks, 13 / 51),
    line("top-3", acme.top3, acmeAsks, 15 / 51),
    line("name-avoiding top-3", acme.avoidHit, acmeAvoid, undefined),
    line("no-fit", acme.noFitHit, acmeNoFit, 0.9),
    `confusable sure-wrong ${acme.confusableWrong}`,
    cap("gate", acme.gate, acmeAsks, 0.05),
    cap("tier flips", acme.tierFlips, acmeAsks, 0.1),
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
    cap("gate", total.gate, cases.length, 0.05),
    cap("tier flips", total.tierFlips, cases.length, 0.1),
    report.oneRun ? "one run" : "majority of 3",
    report.duplicates ? `duplicate runs ${report.duplicates}` : "duplicate runs 0",
  ];
  if (report.lost) {
    lines.push("main lost material");
    lines.push(report.lost.material.length ? report.lost.material.join("\n") : "(none)");
    lines.push("main lost acme");
    lines.push(report.lost.acme.length ? report.lost.acme.join("\n") : "(none)");
  }
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

function opaqueId(realId) {
  return createHash("sha256").update(`resolve-ai-picks:${realId}`).digest("hex").slice(0, 16);
}

function writeBlindPrompts(casesPath, outDir) {
  const cases = readCases(casesPath);
  mkdirSync(outDir, { recursive: true });
  const groups = { material: [], acme: [] };
  const map = {};
  for (const row of cases) {
    const id = opaqueId(row.id);
    map[id] = row.id;
    groups[groupOf(row.pack)].push({ id, ask: row.ask, library: row.pack, sort: createHash("sha256").update(`shuffle:${row.id}`).digest("hex") });
  }
  for (const [group, rows] of Object.entries(groups)) {
    rows.sort((a, b) => a.sort.localeCompare(b.sort));
    const lines = rows.map((row) => JSON.stringify({ id: row.id, ask: row.ask, library: row.library }));
    writeFileSync(join(outDir, `${group}.jsonl`), lines.length ? `${lines.join("\n")}\n` : "");
  }
  writeFileSync(join(dirname(outDir), "id-map.json"), `${JSON.stringify(map, null, 2)}\n`);
  process.stdout.write(`wrote ${cases.length} blind prompts to ${outDir}\n`);
}

function readIndexIds(root = join(repo, "meaning")) {
  const ids = {};
  if (!existsSync(root)) return ids;
  for (const pack of readdirSync(root)) {
    const index = join(root, pack, "index.md");
    if (!existsSync(index)) continue;
    const found = new Set();
    for (const match of readFileSync(index, "utf8").matchAll(/^- \[([^\]]+)\]\([^)]+\.md\)/gm)) found.add(match[1]);
    ids[pack] = found;
  }
  return ids;
}

function validateRequest(request) {
  const dir = mkdtempSync(join(tmpdir(), "ai-pick-"));
  const file = join(dir, "request.json");
  writeFileSync(file, JSON.stringify(request));
  const cli = join(repo, "dist-server/cli.mjs");
  const result = spawnSync(process.execPath, [cli, "pick", file], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, RESOLVE_AI_PICKS: "1" },
  });
  rmSync(dir, { recursive: true, force: true });
  const line = (result.stdout ?? "").trim().split("\n").filter(Boolean).at(-1) ?? "";
  try {
    return JSON.parse(line);
  } catch {
    return { tier: "no-fit", failed: ["tier"], thin: [] };
  }
}

function revalidate(runs) {
  return runs.map((run) => ({ ...run, result: validateRequest(run.request) }));
}

function applyMap(runs, map) {
  return runs.map((run) => (map[run.caseId] ? { ...run, caseId: map[run.caseId] } : run));
}

function prepare(casesPath, outDir) {
  const cases = readCases(casesPath);
  mkdirSync(outDir, { recursive: true });
  for (const row of cases) writeFileSync(join(outDir, `${row.id}.txt`), `${promptFor(row)}\n`);
  process.stdout.write(`wrote ${cases.length} prompts to ${outDir}\n`);
}

function readMain(path) {
  if (!path) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const rows = Array.isArray(parsed) ? parsed : parsed.cases;
  return Object.fromEntries(rows.filter((row) => row.correct).map((row) => [row.id, true]));
}

function score(casesPath, runsPath, mapPath, mainPath) {
  const cases = readCases(casesPath);
  const map = existsSync(mapPath) ? JSON.parse(readFileSync(mapPath, "utf8")) : {};
  const runs = revalidate(applyMap(readRuns(runsPath), map));
  const report = scoreRecorded(cases, runs, readNames(), readIndexIds(), readMain(mainPath));
  process.stdout.write(`${formatScore(report, cases)}\n`);
}

function validate(rawPath, outPath) {
  const runs = revalidate(readRuns(rawPath));
  writeFileSync(outPath, `${runs.map((run) => JSON.stringify(run)).join("\n")}\n`);
  process.stdout.write(`wrote ${runs.length} records to ${outPath}\n`);
}

const invoked = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href || process.argv[1]?.endsWith("ai-picks-eval.mjs");
if (invoked) {
  const command = process.argv[2];
  if (command === "prompts") {
    const out = arg("--out");
    const dest = out ?? join(repo, "scoreboard/ai-picks/prompts");
    if (!out && existsSync(join(dest, "material.jsonl"))) {
      process.stderr.write("Committed prompts already exist. Pass --out to write another set.\n");
      process.exit(1);
    }
    writeBlindPrompts(arg("--cases") ?? join(repo, "scoreboard/meaning/frozen.json"), dest);
  } else if (command === "prepare") prepare(arg("--cases") ?? join(repo, "scoreboard/meaning/frozen.json"), arg("--out") ?? join(repo, "scoreboard/ai-picks/prepared"));
  else if (command === "validate") {
    const raw = arg("--raw");
    const out = arg("--out");
    if (!raw || !out) {
      process.stderr.write("Usage: node scripts/ai-picks-eval.mjs validate --raw <jsonl> --out <jsonl>\n");
      process.exit(1);
    }
    validate(raw, out);
  } else if (command === "score") {
    const cases = arg("--cases");
    const runs = arg("--runs");
    if (!cases || !runs) {
      process.stderr.write("Usage: node scripts/ai-picks-eval.mjs score --cases <file> --runs <jsonl> [--map <id-map.json>] [--main <main.json>]\n");
      process.exit(1);
    }
    score(cases, runs, arg("--map") ?? join(repo, "scoreboard/ai-picks/id-map.json"), arg("--main"));
  } else {
    process.stderr.write("Usage: node scripts/ai-picks-eval.mjs prompts|prepare|validate|score\n");
    process.exit(1);
  }
}
