import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
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

function runNumber(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 3;
}

export function caseRuns(rows) {
  const seen = new Set();
  for (const row of rows) {
    if (!runNumber(row.run)) return { error: "run", runs: [] };
    if (seen.has(row.run)) return { error: "duplicate", runs: [] };
    seen.add(row.run);
  }
  const runs = [...rows].sort((a, b) => a.run - b.run);
  return { runs };
}

// F1b-R5: runs vote on the answer, not on (component, tier) pairs. Every accepted answer (lead or alternate) is one vote.
function voteOf(result, ok) {
  if (!shown(result)) return "no-fit";
  return ok.has(result.name ?? "") ? "accepted" : `pick|${result.id}`;
}

// The run that stands for the winning answer: its most common (tier, component) pair, ties by key.
function mostCommon(rows) {
  const counts = new Map();
  for (const row of rows) {
    const key = keyOf(row.result);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return rows.find((row) => keyOf(row.result) === best[0]);
}

export function majority(rows, ok = new Set()) {
  const votes = new Map();
  for (const row of rows) {
    const key = voteOf(row.result, ok);
    votes.set(key, [...(votes.get(key) ?? []), row]);
  }
  const best = [...votes.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];
  if (!best || best[1].length < 2) return undefined;
  return mostCommon(best[1]);
}

function winnerOf(runs, ok) {
  if (runs.length === 1) return { winner: runs[0], oneRun: true };
  if (runs.length !== 3) return { winner: undefined, oneRun: false };
  return { winner: majority(runs, ok), oneRun: false };
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

function rejection(result) {
  return Boolean(result) && result.tier === "no-fit" && (result.failed ?? []).length > 0;
}

// What the picker chose in one run. A checker rejection keeps the requested pick, so it is not a pick change (F1b-R6).
function choiceOf(run, packNames) {
  if (rejection(run.result)) {
    const id = typeof run.request?.pick === "string" ? run.request.pick.trim() : "";
    return { id, tier: run.request?.tier ?? "", name: id ? packNames[id] ?? id : "" };
  }
  const id = componentKey(run.result);
  return { id, tier: run.result?.tier ?? "", name: id ? run.result.name ?? "" : "" };
}

function gateHit(choices, ok) {
  if (choices.length > 0 && choices.every((choice) => choice.id && ok.has(choice.name))) return false;
  return new Set(choices.map((choice) => choice.id)).size > 1;
}

// F1b-R3: a flip needs the same component in all 3 runs with both place and ask. A no-fit among them is a gate hit.
function tierFlip(choices) {
  if (choices.length !== 3 || !choices[0].id || choices.some((choice) => choice.id !== choices[0].id)) return false;
  const tiers = new Set(choices.map((choice) => choice.tier));
  return tiers.has("place") && tiers.has("ask");
}

// F1b-R2: main's one weak-lead rule, used the same way on the frozen path and the recommend path.
// The rule is decision D2, the ticket's strict text: "a weak lead fails".
// A weak lead is never a top-1 or top-3 hit, and it is not a no-fit.
export function mainPath(exact, acceptedNames, names, weak) {
  if (weak && names.length > 0) return { top1: false, top3: false, noFit: false };
  const empty = names.length === 0;
  if (!exact) return { top1: empty, top3: empty, noFit: empty };
  return { top1: acceptedNames.includes(names[0] ?? ""), top3: names.slice(0, 3).some((name) => acceptedNames.includes(name)), noFit: empty };
}

// "Main gets right" for lost cases: correct on either path, under the same weak-lead rule.
export function eitherCorrect(exact, acceptedNames, frozenNames, lead, weak, frozenWeak = false) {
  const frozen = mainPath(exact, acceptedNames, frozenNames ?? [], frozenWeak);
  const recommend = mainPath(exact, acceptedNames, lead ? [lead] : [], weak);
  return { top1: frozen.top1 || recommend.top1, top3: frozen.top3 || recommend.top3, noFit: frozen.noFit || recommend.noFit };
}

export function scoreRecorded(cases, runs, namesByPack, indexIds = {}, mainCorrect = undefined) {
  const byCase = new Map();
  for (const run of runs) {
    const list = byCase.get(run.caseId) ?? [];
    list.push(run);
    byCase.set(run.caseId, list);
  }
  const groups = { material: emptyGroup(), acme: emptyGroup(), total: emptyGroup() };
  let duplicates = 0;
  let badRuns = 0;
  let sawOne = false;
  let sawThree = false;
  const thinDescribed = [];
  const rejections = [];
  const incomplete = [];
  const lost = { material: [], acme: [] };
  for (const row of cases) {
    const group = groupOf(row.pack);
    const bucket = [groups[group], groups.total];
    const add = (field, by = 1) => {
      for (const item of bucket) item[field] += by;
    };
    const parsed = caseRuns(byCase.get(row.id) ?? []);
    if (!parsed.error && parsed.runs.length === 2) {
      incomplete.push(row.id);
      continue;
    }
    add("asks");
    if (parsed.error === "duplicate") {
      duplicates += 1;
      continue;
    }
    if (parsed.error) {
      badRuns += 1;
      continue;
    }
    if (parsed.runs.length === 1) sawOne = true;
    else if (parsed.runs.length === 3) sawThree = true;
    const known = indexIds[row.pack] ?? new Set();
    const packNames = namesByPack[row.pack] ?? {};
    for (const run of parsed.runs) {
      const ids = [...(run.request?.shortlist ?? []), ...(typeof run.request?.pick === "string" ? [run.request.pick] : [])];
      for (const id of ids.filter(Boolean)) {
        add("named");
        if (!known.has(id)) add("invented");
      }
      if (run.request?.tier === "place" && (run.result?.thin ?? []).some((entry) => entry.id === run.request.pick)) add("thinPlaced");
      if (rejection(run.result)) rejections.push({ caseId: row.id, run: run.run, failed: run.result.failed });
    }
    if (parsed.runs.some((run) => rejection(run.result))) add("rejected");
    const ok = accepted(row);
    const picked = winnerOf(parsed.runs, ok);
    const winner = picked.winner;
    if (!winner && !picked.oneRun) add("split");
    const choices = parsed.runs.map((run) => choiceOf(run, packNames));
    if (parsed.runs.length > 1 && gateHit(choices, ok)) {
      add("gate");
      add("unstable");
    }
    if (parsed.runs.length > 1 && tierFlip(choices)) add("tierFlips");
    const leadName = winner?.result?.name ?? "";
    const noFit = Boolean(winner) && winner.result.tier === "no-fit" && !winner.result.id;
    const exact = row.expect?.accept === "exact";
    const fit1 = exact ? Boolean(winner) && winner.result.tier !== "no-fit" && ok.has(leadName) : noFit;
    const shortlistNames = namesOf((winner?.request?.shortlist ?? []).slice(0, 3), packNames);
    const fit3 = exact ? Boolean(winner) && winner.result.tier !== "no-fit" && shortlistNames.some((name) => ok.has(name)) : noFit;
    if (fit1) add("top1");
    if (fit3) add("top3");
    if ((row.tags ?? []).includes("meaning-only")) {
      add("avoid");
      if (fit3) add("avoidHit");
    }
    if (isNoFit(row)) {
      add("noFit");
      if (noFit) add("noFitHit");
    }
    if ((row.tags ?? []).includes("confusable") && winner?.result?.tier === "place" && !ok.has(leadName)) add("confusableWrong");
    if (winner && shown(winner.result)) {
      if (winner.result.nameOnly) {
        add("nameOnly");
        // F1b-R4: one line per component, not one per case.
        if (!thinDescribed.includes(winner.result.id)) thinDescribed.push(winner.result.id);
      } else {
        add("libraryShown");
        const failed = winner.result.failed ?? [];
        if (winner.result.reason && !failed.includes("quote") && !failed.includes("alias-quote")) add("libraryQuotes");
        else add("unquoted");
      }
    }
    if (mainCorrect?.[row.id] && !fit1) lost[group].push(row.id);
  }
  const mixed = sawOne && sawThree;
  const total = groups.total;
  return {
    groups,
    invented: total.invented,
    unquoted: total.unquoted,
    thinPlaced: total.thinPlaced,
    nameOnly: total.nameOnly,
    libraryQuotes: total.libraryQuotes,
    libraryShown: total.libraryShown,
    thinDescribed,
    rejections,
    incomplete,
    lost: mainCorrect ? lost : undefined,
    oneRun: sawOne && !sawThree,
    mixed,
    duplicates,
    badRuns,
  };
}

function emptyGroup() {
  return {
    asks: 0, top1: 0, top3: 0, avoid: 0, avoidHit: 0, noFit: 0, noFitHit: 0, confusableWrong: 0, unstable: 0, gate: 0, tierFlips: 0, split: 0,
    rejected: 0, invented: 0, named: 0, thinPlaced: 0, nameOnly: 0, libraryQuotes: 0, libraryShown: 0, unquoted: 0,
  };
}

function pct(hit, of) {
  return `${Math.round(rate(hit, of) * 1000) / 10}%`;
}

function percent(value) {
  return `${Math.round(value * 1000) / 10}%`;
}

function reportCap(label, hit, of, target) {
  if (!of) return `${label} ${hit}/${of}`;
  return `${label} ${hit}/${of} ${pct(hit, of)} at most ${percent(target)}`;
}

function line(label, hit, of) {
  return `${label} ${hit}/${of} ${of ? pct(hit, of) : "n/a"}`;
}

function rateOf(hit, of) {
  return of ? hit / of : undefined;
}

// F1b-R1: the ticket bars (the F1c acceptance table) as rates, so any case count gets marks, the holdout too.
// On the frozen 60: top-1 48/60, top-3 54/60, name-avoiding top-3 28/32, no-fit 6/6, main-correct cases lost 3.
export const TICKET_BARS = { top1: 0.8, top3: 0.9, avoid: 0.85, noFit: 0.9, gate: 0.05, tierFlips: 0.1, lost: 3 / 60, quote: 1, overMainTop1: 0.05 };

// A bar with no cases (N = 0) is n/a, never a pass.
function mark(label, n, N, pass, bar) {
  if (!N) return { label, n, N, rate: null, pass: null, text: `${label} ${n}/${N} n/a` };
  return { label, n, N, rate: n / N, pass, text: `${label} ${n}/${N} ${pct(n, N)} ${bar} ${pass ? "pass" : "fail"}` };
}

// Pass when n >= ceil(rate × N).
function atLeast(label, n, N, target) {
  if (target === undefined) return mark(label, n, N, false, "no main");
  const need = Math.ceil(target * N - 1e-9);
  return mark(label, n, N, n >= need, `target ${percent(target)} (${need}/${N})`);
}

// Pass when n <= floor(rate × N).
function atMost(label, n, N, target) {
  const most = Math.floor(target * N + 1e-9);
  return mark(label, n, N, n <= most, `at most ${percent(target)} (${most}/${N})`);
}

function none(label, n, N) {
  return mark(label, n, N, n === 0, "target 0");
}

function soft(item) {
  return { ...item, soft: true, text: `${item.text} (soft)` };
}

function countsOf(cases, group) {
  const rows = cases.filter((row) => groupOf(row.pack) === group);
  const tagged = (tag) => rows.filter((row) => (row.tags ?? []).includes(tag)).length;
  return { asks: rows.length, avoid: tagged("meaning-only"), confusable: tagged("confusable"), noFit: rows.filter(isNoFit).length };
}

function mainLine(main) {
  if (!main) return "main (none)";
  const path = (name, rates) => `${name} top-1 ${rates.top1}, top-3 ${rates.top3}, no-fit ${rates.noFitHit}`;
  const paths = main.paths ? `; ${path("frozen", main.paths.frozen)}; ${path("recommend", main.paths.recommend)}` : "";
  return `main ${line("top-1", main.top1, main.asks)}, ${line("top-3", main.top3, main.asks)}, ${line("no-fit", main.noFitHit, main.noFit)} (better path per metric${paths})`;
}

function verdict(marks) {
  const hard = marks.filter((item) => !item.soft);
  const failed = hard.filter((item) => item.pass === false).map((item) => item.label);
  if (failed.length) return `verdict fail (${failed.join(", ")})`;
  const open = hard.filter((item) => item.pass === null).map((item) => item.label);
  return open.length ? `verdict incomplete (n/a: ${open.join(", ")})` : "verdict pass";
}

// F1b-R8: every acceptance metric for the group as n/N and %, with pass/fail where the group has a bar.
// Material carries the ticket bars. Acme has no ticket bar, so it keeps its "not below main" marks only.
function groupScore(name, group, counts, main, lost) {
  const quotes = [group.libraryQuotes ?? 0, group.libraryShown ?? 0];
  const reported = [
    line("rejected", group.rejected ?? 0, counts.asks),
    `split ${group.split}/${counts.asks}`,
    `${line("nothing-fits asks", counts.noFit, counts.asks)}${name === "material" ? " target TBD (fresh set at least 8)" : ""}`,
    mainLine(main),
  ];
  if (name !== "material") {
    const [top1, top3, noFit, flips] = [
      atLeast("top-1", group.top1, counts.asks, rateOf(main?.top1, main?.asks)),
      atLeast("top-3", group.top3, counts.asks, rateOf(main?.top3, main?.asks)),
      atLeast("no-fit", group.noFitHit, counts.noFit, rateOf(main?.noFitHit, main?.noFit)),
      atMost("tier flips", group.tierFlips, counts.asks, TICKET_BARS.tierFlips),
    ];
    const lines = [
      top1.text,
      top3.text,
      line("name-avoiding top-3", group.avoidHit, counts.avoid),
      noFit.text,
      line("invented", group.invented ?? 0, group.named ?? 0),
      reportCap("gate", group.gate, counts.asks, TICKET_BARS.gate),
      flips.text,
      line("confusable sure-wrong", group.confusableWrong, counts.confusable),
      ...(lost ? [line("main lost", lost.length, counts.asks)] : []),
      line("library quote", ...quotes),
      ...reported,
    ];
    return { marks: [top1, top3, noFit, flips], lines };
  }
  const mainTop1 = rateOf(main?.top1, main?.asks);
  const marks = [
    atLeast("top-1", group.top1, counts.asks, TICKET_BARS.top1),
    atLeast("top-1 vs main", group.top1, counts.asks, mainTop1 === undefined ? undefined : mainTop1 + TICKET_BARS.overMainTop1),
    atLeast("top-3", group.top3, counts.asks, TICKET_BARS.top3),
    atLeast("top-3 vs main", group.top3, counts.asks, rateOf(main?.top3, main?.asks)),
    atLeast("name-avoiding top-3", group.avoidHit, counts.avoid, TICKET_BARS.avoid),
    atLeast("no-fit", group.noFitHit, counts.noFit, TICKET_BARS.noFit),
    none("invented", group.invented ?? 0, group.named ?? 0),
    atMost("gate", group.gate, counts.asks, TICKET_BARS.gate),
    soft(atMost("tier flips", group.tierFlips, counts.asks, TICKET_BARS.tierFlips)),
    none("confusable sure-wrong", group.confusableWrong, counts.confusable),
    lost ? atMost("main lost", lost.length, counts.asks, TICKET_BARS.lost) : mark("main lost", 0, counts.asks, false, "no main"),
    atLeast("library quote", ...quotes, TICKET_BARS.quote),
  ];
  return { marks, lines: [...marks.map((item) => item.text), ...reported, verdict(marks)] };
}

function scoredCases(report, cases) {
  const incomplete = new Set(report.incomplete ?? []);
  return cases.filter((row) => !incomplete.has(row.id));
}

function groupScores(report, cases, mainRates) {
  return Object.fromEntries(["material", "acme"].map((name) => [
    name,
    groupScore(name, report.groups[name], countsOf(cases, name), mainRates?.[name], report.lost?.[name]),
  ]));
}

// The --json score object: the report's fields unchanged, plus main's rates and
// marks { group: { metric: { n, N, rate, pass } } }. rate and pass are null when N is 0.
export function scoreJson(report, cases, mainRates) {
  const scores = groupScores(report, scoredCases(report, cases), mainRates);
  const marks = Object.fromEntries(Object.entries(scores).map(([name, score]) => [
    name,
    Object.fromEntries(score.marks.map(({ label, n, N, rate, pass }) => [label, { n, N, rate, pass }])),
  ]));
  return { ...report, main: mainRates ?? null, marks };
}

export function formatScore(report, cases, mainRates) {
  const scored = scoredCases(report, cases);
  const scores = groupScores(report, scored, mainRates);
  const total = report.groups.total;
  const asks = scored.length;
  const incomplete = report.incomplete ?? [];
  const rejections = report.rejections ?? [];
  const lines = [
    `Material ${countsOf(scored, "material").asks}`,
    ...scores.material.lines,
    `Acme ${countsOf(scored, "acme").asks}`,
    ...scores.acme.lines,
    `Total ${asks}`,
    line("top-1", total.top1, asks),
    line("top-3", total.top3, asks),
    line("name-avoiding top-3", total.avoidHit, total.avoid),
    line("no-fit", total.noFitHit, total.noFit),
    `confusable sure-wrong ${total.confusableWrong}`,
    `invented ${report.invented}`,
    `unquoted ${report.unquoted}`,
    `thin placed ${report.thinPlaced}`,
    line("rejected", total.rejected ?? 0, asks),
    atMost("gate", total.gate, asks, TICKET_BARS.gate).text,
    atMost("tier flips", total.tierFlips, asks, TICKET_BARS.tierFlips).text,
    report.mixed ? "mixed runs" : report.oneRun ? "one run" : "majority of 3",
    report.duplicates ? `duplicate runs ${report.duplicates}` : "duplicate runs 0",
    report.badRuns ? `bad runs ${report.badRuns}` : "bad runs 0",
    incomplete.length ? `incomplete ${incomplete.length} (2 of 3 runs, left out of every count): ${incomplete.join(", ")}` : "incomplete 0",
    `name-only ${report.nameOnly ?? 0}`,
    `library quote ${report.libraryQuotes ?? 0}/${report.libraryShown ?? 0}`,
    "thin description",
    report.thinDescribed?.length ? report.thinDescribed.map((id) => `${id} name-only`).join("\n") : "(none)",
    "checker rejections",
    rejections.length ? rejections.map((item) => `${item.caseId} run ${item.run} ${item.failed.join(",")}`).join("\n") : "(none)",
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
    "reason is a span of at least 3 words from one sentence, an exact whole line that is not the name, or the name plus one property and one listed value.",
    "Property values are strings, written exactly as listed. A bare name is valid only when the file has no description and no properties.",
    "Do not quote an Aliases line. If the file has a Thin line, do not use tier place.",
    "If nothing in the library fits, tier is no-fit and omit pick.",
  ].join("\n");
}

// The real path: the nearest existing ancestor (or the file itself) through realpath, so a symlink cannot hide the repo.
function realTarget(target) {
  let path = resolve(target);
  const rest = [];
  while (!existsSync(path)) {
    let link = false;
    try {
      link = lstatSync(path).isSymbolicLink();
    } catch {
      link = false;
    }
    if (link) return undefined;
    rest.unshift(basename(path));
    path = dirname(path);
  }
  return join(realpathSync.native(path), ...rest);
}

function insideRepo(target) {
  const real = realTarget(target);
  if (!real) return true;
  const rel = relative(realpathSync.native(repo), real);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function defaultMapPath() {
  const root = process.env["RESOLVE_PRIVATE"] || join(homedir(), ".resolve-private");
  return join(root, "ai-picks-id-map.json");
}

function randomId(used) {
  let id = "";
  do {
    id = randomBytes(8).toString("hex");
  } while (used.has(id));
  used.add(id);
  return id;
}

function writeBlindPrompts(casesPath, outDir, mapPath) {
  if (insideRepo(mapPath)) {
    process.stderr.write("Refusing to write the id map inside the repo.\n");
    process.exit(1);
  }
  const cases = readCases(casesPath);
  mkdirSync(outDir, { recursive: true });
  mkdirSync(dirname(mapPath), { recursive: true });
  const groups = { material: [], acme: [] };
  const map = {};
  const used = new Set();
  for (const row of cases) {
    const id = randomId(used);
    map[id] = row.id;
    groups[groupOf(row.pack)].push({ id, ask: row.ask, library: row.pack, sort: randomBytes(8).toString("hex") });
  }
  for (const [group, rows] of Object.entries(groups)) {
    rows.sort((a, b) => a.sort.localeCompare(b.sort));
    const lines = rows.map((row) => JSON.stringify({ id: row.id, ask: row.ask, library: row.library }));
    writeFileSync(join(outDir, `${group}.jsonl`), lines.length ? `${lines.join("\n")}\n` : "");
  }
  writeFileSync(mapPath, `${JSON.stringify(map, null, 2)}\n`);
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

// A case with 2 of 3 runs is incomplete: scoring leaves it out and lists it. Runs and cases that do not match are listed.
function runShape(cases, runs) {
  const byCase = new Map();
  for (const run of runs) {
    const list = byCase.get(run.caseId) ?? [];
    list.push(run);
    byCase.set(run.caseId, list);
  }
  let sawOne = false;
  let sawThree = false;
  const incomplete = [];
  for (const row of cases) {
    const parsed = caseRuns(byCase.get(row.id) ?? []);
    if (parsed.error) return { shape: parsed.error };
    if (parsed.runs.length === 1) sawOne = true;
    else if (parsed.runs.length === 3) sawThree = true;
    else if (parsed.runs.length === 2) incomplete.push(row.id);
  }
  if (sawOne && sawThree) return { shape: "mixed" };
  const caseIds = new Set(cases.map((row) => row.id));
  const unknown = [...byCase.keys()].filter((id) => !caseIds.has(id));
  const unrun = cases.filter((row) => !byCase.has(row.id)).map((row) => row.id);
  if (unknown.length || unrun.length) return { shape: "cases", unknown, unrun };
  return { shape: "ok", incomplete };
}

async function loadMain(cases) {
  const { createServer } = await import("vite");
  const server = await createServer({
    configFile: join(repo, "vite.config.ts"),
    root: repo,
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    logLevel: "error",
  });
  try {
    const mod = await server.ssrLoadModule("/scripts/ai-picks-main.ts");
    return mod.mainEvidence(cases);
  } finally {
    await server.close();
  }
}

// Main's rates per group. For the bars, main is the better path per metric (F1b-R2); a lost case is one main gets
// right on either path. Both use the one weak-lead rule in mainPath.
export function ratesFrom(cases, evidence) {
  const byId = new Map(evidence.map((row) => [row.id, row]));
  const blank = () => ({ asks: 0, top1: 0, top3: 0, noFit: 0, noFitHit: 0 });
  const paths = { material: { frozen: blank(), recommend: blank() }, acme: { frozen: blank(), recommend: blank() } };
  const correct = {};
  for (const row of cases) {
    const found = byId.get(row.id) ?? { frozenNames: [], frozenWeak: false, lead: "", weak: false };
    const ok = [...accepted(row)];
    const exact = row.expect?.accept === "exact";
    const got = {
      frozen: mainPath(exact, ok, found.frozenNames ?? [], Boolean(found.frozenWeak)),
      recommend: mainPath(exact, ok, found.lead ? [found.lead] : [], Boolean(found.weak)),
    };
    correct[row.id] = got.frozen.top1 || got.recommend.top1;
    for (const [path, bucket] of Object.entries(paths[groupOf(row.pack)])) {
      bucket.asks += 1;
      if (got[path].top1) bucket.top1 += 1;
      if (got[path].top3) bucket.top3 += 1;
      if (isNoFit(row)) {
        bucket.noFit += 1;
        if (got[path].noFit) bucket.noFitHit += 1;
      }
    }
  }
  const better = ({ frozen, recommend }) => ({
    asks: frozen.asks,
    top1: Math.max(frozen.top1, recommend.top1),
    top3: Math.max(frozen.top3, recommend.top3),
    noFit: frozen.noFit,
    noFitHit: Math.max(frozen.noFitHit, recommend.noFitHit),
    paths: { frozen, recommend },
  });
  return { correct, rates: { material: better(paths.material), acme: better(paths.acme) } };
}

async function score(casesPath, runsPath, mapPath, json) {
  const cases = readCases(casesPath);
  const mapped = applyMap(readRuns(runsPath), JSON.parse(readFileSync(mapPath, "utf8")));
  const shape = runShape(cases, mapped);
  if (shape.shape === "mixed") {
    process.stderr.write("Mixed 1-run and 3-run data is an error.\n");
    process.exit(1);
  }
  if (shape.shape === "duplicate") {
    process.stderr.write("Duplicate run numbers are an error.\n");
    process.exit(1);
  }
  if (shape.shape === "cases") {
    const list = (label, ids) => (ids.length ? `${label} (${ids.length}): ${ids.join(", ")}\n` : "");
    process.stderr.write(`The runs and the cases file do not cover the same cases.\n${list("Runs for cases not in the cases file", shape.unknown)}${list("Cases with no runs", shape.unrun)}`);
    process.exit(3);
  }
  if (shape.shape !== "ok") {
    process.stderr.write("Run numbers have to be integers 1, 2, and 3.\n");
    process.exit(1);
  }
  const runs = revalidate(mapped);
  const incomplete = new Set(shape.incomplete);
  const scored = cases.filter((row) => !incomplete.has(row.id));
  const main = ratesFrom(scored, await loadMain(scored));
  const report = scoreRecorded(cases, runs, readNames(), readIndexIds(), main.correct);
  if (json) process.stdout.write(`${JSON.stringify(scoreJson(report, cases, main.rates), null, 2)}\n`);
  else process.stdout.write(`${formatScore(report, cases, main.rates)}\n`);
  if (report.mixed || report.badRuns) process.exit(1);
}

function validate(rawPath, outPath) {
  const runs = revalidate(readRuns(rawPath));
  writeFileSync(outPath, `${runs.map((run) => JSON.stringify(run)).join("\n")}\n`);
  process.stdout.write(`wrote ${runs.length} records to ${outPath}\n`);
}

function requireMapPath() {
  const path = arg("--id-map");
  if (!path) {
    process.stderr.write("Pass --id-map with a file outside this repo.\n");
    process.exit(1);
  }
  if (insideRepo(path)) {
    process.stderr.write("Refusing to write the id map inside the repo.\n");
    process.exit(1);
  }
  return path;
}

const invoked = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href || process.argv[1]?.endsWith("ai-picks-eval.mjs");
if (invoked) {
  const command = process.argv[2];
  if (command === "prompts") {
    const out = arg("--out");
    if (!out) {
      process.stderr.write("Usage: node scripts/ai-picks-eval.mjs prompts --out <dir> --id-map <file outside this repo>. Prompts are not committed.\n");
      process.exit(1);
    }
    writeBlindPrompts(arg("--cases") ?? join(repo, "scoreboard/meaning/frozen.json"), out, arg("--id-map") ?? defaultMapPath());
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
    const mapPath = requireMapPath();
    if (!cases || !runs) {
      process.stderr.write("Usage: node scripts/ai-picks-eval.mjs score --cases <file> --runs <jsonl> --id-map <file> [--json]\n");
      process.exit(1);
    }
    if (!existsSync(runs)) {
      process.stderr.write(`No run file at ${runs}.\n`);
      process.exit(2);
    }
    if (!existsSync(mapPath)) {
      process.stderr.write("No id map at that path.\n");
      process.exit(1);
    }
    await score(cases, runs, mapPath, process.argv.includes("--json"));
  } else {
    process.stderr.write("Usage: node scripts/ai-picks-eval.mjs prompts|prepare|validate|score\n");
    process.exit(1);
  }
}
