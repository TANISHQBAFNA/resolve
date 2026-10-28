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
  // 2 of 3 is partial agreement: the two runs vote, same as a full set of 3. Do not drop the case.
  if (runs.length === 2 || runs.length === 3) return { winner: majority(runs, ok), oneRun: false };
  return { winner: undefined, oneRun: false };
}

function namesOf(shortlist, packNames) {
  return shortlist.map((id) => packNames[id] ?? id);
}

function idList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim());
}

// Top-3 scores the shortlist users see: result.shortlist from the engine.
// A record saved before that field existed still counts the shown pick, and nothing the model listed beside it.
function scoredShortlist(result) {
  if (!result) return [];
  if (Array.isArray(result.shortlist)) return idList(result.shortlist).slice(0, 3);
  return typeof result.id === "string" && result.id ? [result.id] : [];
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

// F1b-R2: the same weak-lead rule on the frozen path, the recommend path, and the AI path.
// Old rule: a weak lead still counts. New rule (decision D2): a weak lead fails.
// Under the new rule a weak lead is never a top-1 or top-3 hit, and it is not a no-fit.
// Tier `ask` is a weak lead on every path. Main's paths pass that in as `weak`.
export function mainPath(exact, acceptedNames, names, weak, rule = "new") {
  if (rule !== "old" && weak && names.length > 0) return { top1: false, top3: false, noFit: false };
  const empty = names.length === 0;
  if (!exact) return { top1: empty, top3: empty, noFit: empty };
  return { top1: acceptedNames.includes(names[0] ?? ""), top3: names.slice(0, 3).some((name) => acceptedNames.includes(name)), noFit: empty };
}

// "Main gets right" for lost cases: correct on either path. Default is the new rule.
export function eitherCorrect(exact, acceptedNames, frozenNames, lead, weak, frozenWeak = false, rule = "new") {
  const frozen = mainPath(exact, acceptedNames, frozenNames ?? [], frozenWeak, rule);
  const recommend = mainPath(exact, acceptedNames, lead ? [lead] : [], weak, rule);
  return { top1: frozen.top1 || recommend.top1, top3: frozen.top3 || recommend.top3, noFit: frozen.noFit || recommend.noFit };
}

// A flat id→boolean map applies to both rules. { old, new } keeps each rule's main-correct set.
function correctMaps(mainCorrect) {
  if (!mainCorrect) return undefined;
  const values = Object.values(mainCorrect);
  if (values.length > 0 && values.every((value) => value && typeof value === "object")) {
    return { old: mainCorrect.old ?? {}, new: mainCorrect.new ?? {} };
  }
  return { old: mainCorrect, new: mainCorrect };
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
  const twoOfThree = [];
  const modelShortlist = [];
  const lost = { material: [], acme: [] };
  const lostNew = { material: [], acme: [] };
  const maps = correctMaps(mainCorrect);
  let sawTwo = false;
  for (const row of cases) {
    const group = groupOf(row.pack);
    const bucket = [groups[group], groups.total];
    const add = (field, by = 1) => {
      for (const item of bucket) item[field] += by;
    };
    const parsed = caseRuns(byCase.get(row.id) ?? []);
    if (!parsed.error && parsed.runs.length === 2) {
      sawTwo = true;
      twoOfThree.push(row.id);
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
      const offered = idList(run.request?.shortlist).slice(0, 3);
      if (offered.length) modelShortlist.push({ caseId: row.id, run: run.run, shortlist: offered });
      const ids = [...offered, ...(typeof run.request?.pick === "string" ? [run.request.pick] : [])];
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
    const weakAnswer = Boolean(winner) && winner.result.tier === "ask";
    const shortlistNames = namesOf(scoredShortlist(winner?.result), packNames);
    const nameHit = Boolean(winner) && winner.result.tier !== "no-fit" && ok.has(leadName);
    const top3Hit = Boolean(winner) && winner.result.tier !== "no-fit" && shortlistNames.some((name) => ok.has(name));
    // Old rule: tier ask still counts. New rule: tier ask is a weak lead and fails.
    const oldHits = { top1: exact ? nameHit : noFit, top3: exact ? top3Hit : noFit, noFit };
    const newHits = weakAnswer && shown(winner?.result) ? { top1: false, top3: false, noFit: false } : oldHits;
    if (oldHits.top1) add("top1");
    if (newHits.top1) add("top1New");
    if (oldHits.top3) add("top3");
    if (newHits.top3) add("top3New");
    if ((row.tags ?? []).includes("meaning-only")) {
      add("avoid");
      if (oldHits.top3) add("avoidHit");
      if (newHits.top3) add("avoidHitNew");
    }
    if (isNoFit(row)) {
      add("noFit");
      if (oldHits.noFit) add("noFitHit");
      if (newHits.noFit) add("noFitHitNew");
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
    if (maps?.old[row.id] && !oldHits.top1) lost[group].push(row.id);
    if (maps?.new[row.id] && !newHits.top1) lostNew[group].push(row.id);
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
    twoOfThree,
    modelShortlist,
    partial: sawTwo,
    threeRun: sawThree,
    lost: mainCorrect ? lost : undefined,
    lostNew: mainCorrect ? lostNew : undefined,
    oneRun: sawOne && !sawThree,
    mixed,
    duplicates,
    badRuns,
  };
}

function emptyGroup() {
  return {
    asks: 0, top1: 0, top3: 0, top1New: 0, top3New: 0, avoid: 0, avoidHit: 0, avoidHitNew: 0, noFit: 0, noFitHit: 0, noFitHitNew: 0, confusableWrong: 0, unstable: 0, gate: 0, tierFlips: 0, split: 0,
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

// F1b-R1: the ticket bars as rates, so any case count gets marks, the holdout too.
// Absolute bars on the frozen 60: top-1 48/60, top-3 54/60, name-avoiding top-3 28/32, no-fit 6/6, main-correct cases lost 3.
// Vs-main bars are fixed. They are not computed from a fresh main score.
// Floors against main's better single path. top-1 floor is 21/60 under both rules.
// top-3 floor is 27/60 under the old rule and 21/60 under the new rule.
export const TICKET_BARS = {
  top1: 0.8, top3: 0.9, avoid: 0.85, noFit: 0.9, gate: 0.05, tierFlips: 0.1, lost: 3 / 60, quote: 1,
  top1Old: 21 / 60, top1New: 21 / 60, top3Old: 27 / 60, top3New: 21 / 60,
};

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

function pathReport(rates) {
  const which = rates.path ? ` ${rates.path}` : "";
  const detail = rates.paths
    ? `; frozen top-1 ${rates.paths.frozen.top1}, top-3 ${rates.paths.frozen.top3}, no-fit ${rates.paths.frozen.noFitHit}; recommend top-1 ${rates.paths.recommend.top1}, top-3 ${rates.paths.recommend.top3}, no-fit ${rates.paths.recommend.noFitHit}`
    : "";
  return `${line("top-1", rates.top1, rates.asks)}, ${line("top-3", rates.top3, rates.asks)}, ${line("no-fit", rates.noFitHit, rates.noFit)} (better single path${which}${detail})`;
}

function mainLine(main) {
  if (!main) return "main (none)";
  if (main.rules) return `main old ${pathReport(main.rules.old)}; new ${pathReport(main.rules.new)}`;
  return `main ${pathReport(main)}`;
}

function counted(group, rule) {
  if (rule === "new") {
    return {
      top1: group.top1New ?? group.top1,
      top3: group.top3New ?? group.top3,
      avoidHit: group.avoidHitNew ?? group.avoidHit,
      noFitHit: group.noFitHitNew ?? group.noFitHit,
    };
  }
  return { top1: group.top1, top3: group.top3, avoidHit: group.avoidHit, noFitHit: group.noFitHit };
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
      ...(lostList(lost) ? [line("main lost", lostList(lost).length, counts.asks)] : []),
      line("library quote", ...quotes),
      ...reported,
    ];
    return { marks: [top1, top3, noFit, flips], lines };
  }
  const quotesHit = [group.libraryQuotes ?? 0, group.libraryShown ?? 0];
  const ruleMarks = (rule, prefix) => {
    const hits = counted(group, rule);
    const lostN = !lost ? undefined : (rule === "new" ? lost.new.length : lost.old.length);
    const top1Bar = rule === "new" ? TICKET_BARS.top1New : TICKET_BARS.top1Old;
    const top3Bar = rule === "new" ? TICKET_BARS.top3New : TICKET_BARS.top3Old;
    return [
      atLeast(`${prefix} top-1`, hits.top1, counts.asks, TICKET_BARS.top1),
      atLeast(`${prefix} top-1 vs main`, hits.top1, counts.asks, top1Bar),
      atLeast(`${prefix} top-3`, hits.top3, counts.asks, TICKET_BARS.top3),
      atLeast(`${prefix} top-3 vs main`, hits.top3, counts.asks, top3Bar),
      atLeast(`${prefix} name-avoiding top-3`, hits.avoidHit, counts.avoid, TICKET_BARS.avoid),
      atLeast(`${prefix} no-fit`, hits.noFitHit, counts.noFit, TICKET_BARS.noFit),
      none(`${prefix} invented`, group.invented ?? 0, group.named ?? 0),
      atMost(`${prefix} gate`, group.gate, counts.asks, TICKET_BARS.gate),
      soft(atMost(`${prefix} tier flips`, group.tierFlips, counts.asks, TICKET_BARS.tierFlips)),
      none(`${prefix} confusable sure-wrong`, group.confusableWrong, counts.confusable),
      lostN === undefined ? mark(`${prefix} main lost`, 0, counts.asks, false, "no main") : atMost(`${prefix} main lost`, lostN, counts.asks, TICKET_BARS.lost),
      atLeast(`${prefix} library quote`, quotesHit[0], quotesHit[1], TICKET_BARS.quote),
    ];
  };
  const oldMarks = ruleMarks("old", "old");
  const newMarks = ruleMarks("new", "new");
  const marks = oldMarks.flatMap((item, index) => [item, newMarks[index]]);
  return { marks, lines: [...marks.map((item) => item.text), ...reported, verdict(marks)] };
}

function scoredCases(report, cases) {
  const incomplete = new Set(report.incomplete ?? []);
  return cases.filter((row) => !incomplete.has(row.id));
}

function lostList(lost) {
  if (!lost) return undefined;
  return Array.isArray(lost) ? lost : lost.old;
}

function lostByRule(report, name) {
  if (!report.lost && !report.lostNew) return undefined;
  return {
    old: report.lost?.[name] ?? [],
    new: report.lostNew?.[name] ?? report.lost?.[name] ?? [],
  };
}

function groupScores(report, cases, mainRates) {
  return Object.fromEntries(["material", "acme"].map((name) => [
    name,
    groupScore(name, report.groups[name], countsOf(cases, name), mainRates?.[name], lostByRule(report, name)),
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

function listedIds(incomplete, twoOfThree) {
  const seen = new Set();
  const ids = [];
  for (const id of [...incomplete, ...twoOfThree]) {
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function listedLine(label, ids) {
  return ids.length ? `${label} ${ids.length}: ${ids.join(", ")}` : `${label} 0`;
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
    line("top-1 new", total.top1New ?? total.top1, asks),
    line("top-3", total.top3, asks),
    line("top-3 new", total.top3New ?? total.top3, asks),
    line("name-avoiding top-3", total.avoidHit, total.avoid),
    line("name-avoiding top-3 new", total.avoidHitNew ?? total.avoidHit, total.avoid),
    line("no-fit", total.noFitHit, total.noFit),
    line("no-fit new", total.noFitHitNew ?? total.noFitHit, total.noFit),
    `confusable sure-wrong ${total.confusableWrong}`,
    `invented ${report.invented}`,
    `unquoted ${report.unquoted}`,
    `thin placed ${report.thinPlaced}`,
    line("rejected", total.rejected ?? 0, asks),
    atMost("gate", total.gate, asks, TICKET_BARS.gate).text,
    atMost("tier flips", total.tierFlips, asks, TICKET_BARS.tierFlips).text,
    report.mixed ? "mixed runs" : report.partial && !report.threeRun ? "partial agreement (2 of 3)" : report.oneRun ? "one run" : "majority of 3",
    report.duplicates ? `duplicate runs ${report.duplicates}` : "duplicate runs 0",
    report.badRuns ? `bad runs ${report.badRuns}` : "bad runs 0",
    ...(incomplete.length ? [`incomplete ${incomplete.length} (2 of 3 runs, left out of every count): ${incomplete.join(", ")}`] : []),
    listedLine("incomplete or 2-of-3", listedIds(incomplete, report.twoOfThree ?? [])),
    `name-only ${report.nameOnly ?? 0}`,
    `library quote ${report.libraryQuotes ?? 0}/${report.libraryShown ?? 0}`,
    "thin description",
    report.thinDescribed?.length ? report.thinDescribed.map((id) => `${id} name-only`).join("\n") : "(none)",
    "checker rejections",
    rejections.length ? rejections.map((item) => `${item.caseId} run ${item.run} ${item.failed.join(",")}`).join("\n") : "(none)",
    "model shortlist (not scored)",
    report.modelShortlist?.length ? report.modelShortlist.map((item) => `${item.caseId} run ${item.run} ${item.shortlist.join(", ")}`).join("\n") : "(none)",
  ];
  if (report.lost) {
    const fresh = report.lostNew ?? report.lost;
    lines.push("main lost material");
    lines.push(report.lost.material.length ? report.lost.material.join("\n") : "(none)");
    lines.push("main lost material new");
    lines.push(fresh.material.length ? fresh.material.join("\n") : "(none)");
    lines.push("main lost acme");
    lines.push(report.lost.acme.length ? report.lost.acme.join("\n") : "(none)");
    lines.push("main lost acme new");
    lines.push(fresh.acme.length ? fresh.acme.join("\n") : "(none)");
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

// A case with 2 of 3 runs is scored (partial agreement). Runs and cases that do not match are listed.
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

// Main's rates per group, under both weak-lead rules. The reported baseline is the better single
// path (higher top-1, then top-3, then no-fit; frozen on a tie), not the better number from each path.
// A lost case is one main gets right on either path under that rule. `correct` is the new rule.
export function ratesFrom(cases, evidence) {
  const byId = new Map(evidence.map((row) => [row.id, row]));
  const blank = () => ({ asks: 0, top1: 0, top3: 0, noFit: 0, noFitHit: 0 });
  const paths = {
    old: { material: { frozen: blank(), recommend: blank() }, acme: { frozen: blank(), recommend: blank() } },
    new: { material: { frozen: blank(), recommend: blank() }, acme: { frozen: blank(), recommend: blank() } },
  };
  const correctByRule = { old: {}, new: {} };
  for (const row of cases) {
    const found = byId.get(row.id) ?? { frozenNames: [], frozenWeak: false, lead: "", weak: false };
    const ok = [...accepted(row)];
    const exact = row.expect?.accept === "exact";
    for (const rule of ["old", "new"]) {
      const got = {
        frozen: mainPath(exact, ok, found.frozenNames ?? [], Boolean(found.frozenWeak), rule),
        recommend: mainPath(exact, ok, found.lead ? [found.lead] : [], Boolean(found.weak), rule),
      };
      correctByRule[rule][row.id] = got.frozen.top1 || got.recommend.top1;
      for (const [path, bucket] of Object.entries(paths[rule][groupOf(row.pack)])) {
        bucket.asks += 1;
        if (got[path].top1) bucket.top1 += 1;
        if (got[path].top3) bucket.top3 += 1;
        if (isNoFit(row)) {
          bucket.noFit += 1;
          if (got[path].noFit) bucket.noFitHit += 1;
        }
      }
    }
  }
  const better = (pair) => {
    const rank = (path) => path.top1 * 1000000 + path.top3 * 1000 + path.noFitHit;
    const name = rank(pair.recommend) > rank(pair.frozen) ? "recommend" : "frozen";
    const chosen = pair[name];
    return { asks: chosen.asks, top1: chosen.top1, top3: chosen.top3, noFit: chosen.noFit, noFitHit: chosen.noFitHit, path: name, paths: pair };
  };
  const packRates = (pack) => {
    const next = better(paths.new[pack]);
    return { ...next, rules: { old: better(paths.old[pack]), new: next } };
  };
  return { correct: correctByRule.new, correctByRule, rates: { material: packRates("material"), acme: packRates("acme") } };
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
  const report = scoreRecorded(cases, runs, readNames(), readIndexIds(), main.correctByRule);
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
