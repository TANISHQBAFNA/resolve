import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// F1b synthetic scores. Every case, ask and run here is made up inside the test; nothing comes from a blind set.

interface Case {
  id: string;
  pack: string;
  ask: string;
  expect: { lead?: string; accept: string };
  alternates?: string[];
  tags?: string[];
}

interface Run {
  caseId: string;
  run: number;
  request: { tier: string; pick?: string; shortlist: string[] };
  result: { tier: string; id?: string; name?: string; reason?: string; nameOnly?: boolean; failed: string[]; thin: Array<{ id: string; missing: string[]; nameOnly?: boolean }> };
}

type Group = Record<string, number>;
interface Report {
  groups: Record<"material" | "acme" | "total", Group>;
  rejections: Array<{ caseId: string; run: number; failed: string[] }>;
  incomplete: string[];
  thinDescribed: string[];
  lost?: Record<string, string[]>;
  [field: string]: unknown;
}
interface MainRates {
  [group: string]: { asks: number; top1: number; top3: number; noFit: number; noFitHit: number };
}
interface Mark {
  n: number;
  N: number;
  rate: number | null;
  pass: boolean | null;
}
interface Evidence {
  id: string;
  frozenNames: string[];
  frozenWeak: boolean;
  lead: string;
  weak: boolean;
}
interface Scorer {
  scoreRecorded(cases: Case[], runs: Run[], names: Record<string, Record<string, string>>, indexIds?: Record<string, Set<string>>, mainCorrect?: Record<string, boolean>): Report;
  formatScore(report: Report, cases: Case[], mainRates?: MainRates): string;
  scoreJson(report: Report, cases: Case[], mainRates?: MainRates): Report & { main: MainRates | null; marks: Record<string, Record<string, Mark>> };
  ratesFrom(cases: Case[], evidence: Evidence[]): { correct: Record<string, boolean>; rates: Record<string, MainRates[string] & { paths: Record<string, Group> }> };
  mainPath(exact: boolean, accepted: string[], names: string[], weak: boolean): { top1: boolean; top3: boolean; noFit: boolean };
  eitherCorrect(exact: boolean, accepted: string[], frozenNames: string[], lead: string, weak: boolean, frozenWeak?: boolean): { top1: boolean; top3: boolean; noFit: boolean };
}

const scorerUrl: string = new URL("../scripts/ai-picks-eval.mjs", import.meta.url).href;
let scorer: Scorer;
beforeAll(async () => {
  scorer = (await import(/* @vite-ignore */ scorerUrl)) as Scorer;
});

const names = { material: { tooltip: "Tooltip", badge: "Badge", chip: "Chip", slider: "Slider" }, acme: { switch: "Switch" } };
const indexIds = { material: new Set(Object.keys(names.material)), acme: new Set(Object.keys(names.acme)) };
const reason = "A long library sentence.";

function shownRun(caseId: string, run: number, id: string, tier = "place", extra: Partial<Run["result"]> = {}): Run {
  const name = (names.material as Record<string, string>)[id] ?? id;
  return { caseId, run, request: { tier, pick: id, shortlist: [id] }, result: { tier, id, name, reason, failed: [], thin: [], ...extra } };
}

function noFitRun(caseId: string, run: number): Run {
  return { caseId, run, request: { tier: "no-fit", shortlist: [] }, result: { tier: "no-fit", failed: [], thin: [] } };
}

function rejectedRun(caseId: string, run: number, id: string): Run {
  return { caseId, run, request: { tier: "place", pick: id, shortlist: [id] }, result: { tier: "no-fit", failed: ["quote"], thin: [] } };
}

// 60 Material asks shaped like the frozen set: 54 exact (Tooltip, alternate Badge), 6 nothing-fits, 32 name-avoiding,
// 14 confusable.
function materialSet(): Case[] {
  return Array.from({ length: 60 }, (_, index) => {
    const noFit = index >= 54;
    return {
      id: `s-${String(index + 1).padStart(2, "0")}`,
      pack: "material",
      ask: `synthetic ask ${index + 1}`,
      expect: noFit ? { accept: "empty-or-weak" } : { lead: "Tooltip", accept: "exact" },
      alternates: noFit ? [] : ["Badge"],
      tags: [...(index < 32 ? ["meaning-only"] : []), ...(index >= 40 && !noFit ? ["confusable"] : []), ...(noFit ? ["no-fit"] : [])],
    };
  });
}

function threeRuns(cases: Case[], answer: (row: Case, index: number) => "right" | "wrong" | "no-fit"): Run[] {
  return cases.flatMap((row, index) => [1, 2, 3].map((run) => {
    const kind = answer(row, index);
    if (kind === "no-fit") return noFitRun(row.id, run);
    return shownRun(row.id, run, kind === "right" ? "tooltip" : "slider", kind === "right" ? "place" : "ask");
  }));
}

// Main as the ticket describes it: 20/60 top-1 on Material, so top-1 vs main needs 23/60.
const main: MainRates = { material: { asks: 60, top1: 20, top3: 20, noFit: 6, noFitHit: 3 }, acme: { asks: 0, top1: 0, top3: 0, noFit: 0, noFitHit: 0 } };

function section(text: string, header: string, next: string): string[] {
  return text.split(`${header}\n`)[1]!.split(`\n${next}`)[0]!.split("\n");
}

function lineOf(lines: string[], label: string): string {
  const found = lines.find((line) => line.startsWith(`${label} `));
  if (!found) throw new Error(`no line for ${label}\n${lines.join("\n")}`);
  return found;
}

function score(cases: Case[], runs: Run[], mainRates: MainRates | undefined = main) {
  const report = scorer.scoreRecorded(cases, runs, names, indexIds, {});
  const text = scorer.formatScore(report, cases, mainRates);
  return { report, text, material: section(text, "Material 60", "Acme "), json: scorer.scoreJson(report, cases, mainRates) };
}

describe("F1b-R7 synthetic scores", () => {
  it("fails Material top-1 28/60 even when it beats main", () => {
    const cases = materialSet();
    const got = score(cases, threeRuns(cases, (_row, index) => (index >= 54 ? "no-fit" : index < 22 ? "right" : "wrong")));
    expect(lineOf(got.material, "top-1")).toBe("top-1 28/60 46.7% target 80% (48/60) fail");
    expect(lineOf(got.material, "top-1 vs main")).toMatch(/^top-1 vs main 28\/60 .* \(23\/60\) pass$/);
    expect(got.json.marks["material"]!["top-1"]).toEqual({ n: 28, N: 60, rate: 28 / 60, pass: false });
    expect(lineOf(got.material, "verdict")).toBe("verdict fail (top-1, top-3, name-avoiding top-3)");
  });

  it("fails no-fit 4/6 and passes 6/6", () => {
    const cases = materialSet();
    const four = score(cases, threeRuns(cases, (_row, index) => (index >= 58 ? "wrong" : index >= 54 ? "no-fit" : "right")));
    expect(lineOf(four.material, "no-fit")).toBe("no-fit 4/6 66.7% target 90% (6/6) fail");
    expect(lineOf(four.material, "verdict")).toBe("verdict fail (no-fit)");
    const six = score(cases, threeRuns(cases, (_row, index) => (index >= 54 ? "no-fit" : "right")));
    expect(lineOf(six.material, "no-fit")).toBe("no-fit 6/6 100% target 90% (6/6) pass");
    expect(lineOf(six.material, "verdict")).toBe("verdict pass");
  });

  it("fails an all-no-fit run", () => {
    const cases = materialSet();
    const got = score(cases, threeRuns(cases, () => "no-fit"));
    expect(lineOf(got.material, "top-1")).toBe("top-1 6/60 10% target 80% (48/60) fail");
    expect(lineOf(got.material, "top-3")).toMatch(/ fail$/);
    expect(lineOf(got.material, "name-avoiding top-3")).toBe("name-avoiding top-3 0/32 0% target 85% (28/32) fail");
    expect(lineOf(got.material, "no-fit")).toMatch(/ pass$/);
    expect(lineOf(got.material, "verdict")).toMatch(/^verdict fail \(top-1, top-1 vs main, top-3, top-3 vs main, name-avoiding top-3/);
  });
});

describe("F1b-R5 m-q04: majority on the accepted-answer set", () => {
  const row: Case = { id: "q-1", pack: "material", ask: "synthetic judgement ask", expect: { lead: "Tooltip", accept: "exact" }, alternates: ["Badge"], tags: [] };

  it("scores every-run-accepted as correct and stable even when tiers and components differ", () => {
    const report = scorer.scoreRecorded([row], [shownRun("q-1", 1, "tooltip", "place"), shownRun("q-1", 2, "tooltip", "ask"), shownRun("q-1", 3, "badge", "place")], names, indexIds);
    const material = report.groups.material;
    expect([material["top1"], material["top3"], material["gate"], material["split"], material["tierFlips"]]).toEqual([1, 1, 0, 0, 0]);
  });

  it("lets two accepted runs win over a no-fit, and still reports the gate hit", () => {
    const report = scorer.scoreRecorded([row], [shownRun("q-1", 1, "tooltip", "place"), shownRun("q-1", 2, "badge", "ask"), noFitRun("q-1", 3)], names, indexIds);
    expect([report.groups.material["top1"], report.groups.material["gate"]]).toEqual([1, 1]);
  });

  it("has no winner when only one run is accepted", () => {
    const report = scorer.scoreRecorded([row], [shownRun("q-1", 1, "tooltip"), shownRun("q-1", 2, "slider"), shownRun("q-1", 3, "chip")], names, indexIds);
    expect([report.groups.material["top1"], report.groups.material["split"], report.groups.material["gate"]]).toEqual([0, 1, 1]);
  });
});

describe("F1b-R3 tier flips and F1b-R6 rejections", () => {
  const row: Case = { id: "f-1", pack: "material", ask: "synthetic ask", expect: { lead: "Chip", accept: "exact" }, alternates: [], tags: [] };
  const groupOf = (runs: Run[]) => scorer.scoreRecorded([row], runs, names, indexIds).groups.material;

  it("counts place X / ask X / no-fit as a gate hit, not a flip", () => {
    const material = groupOf([shownRun("f-1", 1, "slider", "place"), shownRun("f-1", 2, "slider", "ask"), noFitRun("f-1", 3)]);
    expect([material["gate"], material["tierFlips"]]).toEqual([1, 0]);
  });

  it("counts a flip only with the same component in all 3 runs", () => {
    expect(groupOf([shownRun("f-1", 1, "slider", "place"), shownRun("f-1", 2, "slider", "ask"), shownRun("f-1", 3, "slider", "ask")])["tierFlips"]).toBe(1);
    expect(groupOf([shownRun("f-1", 1, "slider", "place"), shownRun("f-1", 2, "slider", "place"), shownRun("f-1", 3, "chip", "ask")])["tierFlips"]).toBe(0);
  });

  it("reports a rejection in one run as rejected, not as a pick change", () => {
    const report = scorer.scoreRecorded([row], [shownRun("f-1", 1, "chip"), rejectedRun("f-1", 2, "chip"), shownRun("f-1", 3, "chip")], names, indexIds);
    expect([report.groups.material["gate"], report.groups.material["rejected"], report.groups.material["top1"]]).toEqual([0, 1, 1]);
    expect(report.rejections).toEqual([{ caseId: "f-1", run: 2, failed: ["quote"] }]);
    const text = scorer.formatScore(report, [row]);
    expect(text.split("\nchecker rejections\n")[1]!.split("\n")[0]).toBe("f-1 run 2 quote");
  });

  it("still counts a rejected run that picked another component as a pick change", () => {
    const material = groupOf([shownRun("f-1", 1, "chip"), rejectedRun("f-1", 2, "slider"), shownRun("f-1", 3, "chip")]);
    expect([material["gate"], material["rejected"]]).toEqual([1, 1]);
  });

  it("never counts a rejected pick as correct", () => {
    const material = groupOf([shownRun("f-1", 1, "chip"), rejectedRun("f-1", 2, "chip"), rejectedRun("f-1", 3, "chip")]);
    expect([material["top1"], material["gate"], material["rejected"]]).toEqual([0, 0, 1]);
  });
});

describe("F1b-R4 thin list", () => {
  it("prints one line per component, not one per case, with the name-only mark", () => {
    const cases: Case[] = ["t-1", "t-2", "t-3"].map((id) => ({ id, pack: "material", ask: "synthetic", expect: { lead: "Chip", accept: "exact" }, alternates: ["Badge"], tags: [] }));
    const thin = [{ id: "chip", missing: ["description", "properties"] }, { id: "badge", missing: ["description", "properties"] }];
    const runs = [
      shownRun("t-1", 1, "chip", "ask", { reason: "Chip", nameOnly: true, thin }),
      shownRun("t-2", 1, "chip", "ask", { reason: "Chip", nameOnly: true, thin }),
      shownRun("t-3", 1, "badge", "ask", { reason: "Badge", nameOnly: true, thin }),
    ];
    const report = scorer.scoreRecorded(cases, runs, names, indexIds);
    expect(report["nameOnly"]).toBe(3);
    const text = scorer.formatScore(report, cases);
    expect(text.split("\nthin description\n")[1]!.split("\nchecker rejections")[0]).toBe("chip name-only\nbadge name-only");
  });
});

describe("F1b-R1 and F1b-R8 marks", () => {
  function report(material: Group, extra: Partial<Report> = {}): Report {
    const blank = { asks: 0, top1: 0, top3: 0, avoid: 0, avoidHit: 0, noFit: 0, noFitHit: 0, confusableWrong: 0, unstable: 0, gate: 0, tierFlips: 0, split: 0, rejected: 0, invented: 0, named: 0, libraryQuotes: 0, libraryShown: 0 };
    return { groups: { material: { ...blank, ...material }, acme: blank, total: blank }, rejections: [], incomplete: [], thinDescribed: [], lost: { material: [], acme: [] }, ...extra };
  }
  function holdout(size: number, noFit: number, avoid: number): Case[] {
    return Array.from({ length: size }, (_, index) => ({
      id: `h-${index}`,
      pack: "material",
      ask: "synthetic",
      expect: index < noFit ? { accept: "empty" } : { lead: "Tooltip", accept: "exact" },
      tags: index >= size - avoid ? ["meaning-only"] : [],
    }));
  }
  const markOf = (cases: Case[], material: Group, field: string) => scorer.scoreJson(report(material), cases)["marks"]["material"]![field];

  it("scales every bar with n >= ceil(rate × N) for a holdout of any size", () => {
    const cases = holdout(45, 7, 20);
    expect(markOf(cases, { top1: 36 }, "top-1")!.pass).toBe(true);
    expect(markOf(cases, { top1: 35 }, "top-1")!.pass).toBe(false);
    expect(markOf(cases, { top3: 41 }, "top-3")!.pass).toBe(true);
    expect(markOf(cases, { top3: 40 }, "top-3")!.pass).toBe(false);
    expect(markOf(cases, { avoidHit: 17 }, "name-avoiding top-3")!.pass).toBe(true);
    expect(markOf(cases, { avoidHit: 16 }, "name-avoiding top-3")!.pass).toBe(false);
    expect(markOf(cases, { noFitHit: 7 }, "no-fit")!.pass).toBe(true);
    expect(markOf(cases, { noFitHit: 6 }, "no-fit")!.pass).toBe(false);
    expect(markOf(cases, { gate: 2 }, "gate")!.pass).toBe(true);
    expect(markOf(cases, { gate: 3 }, "gate")!.pass).toBe(false);
    expect(markOf(cases, { invented: 1, named: 90 }, "invented")).toEqual({ n: 1, N: 90, rate: 1 / 90, pass: false });
  });

  it("uses the ticket numbers on the frozen 60 and 32", () => {
    const cases = holdout(60, 6, 32);
    expect([markOf(cases, { top1: 48 }, "top-1")!.pass, markOf(cases, { top1: 47 }, "top-1")!.pass]).toEqual([true, false]);
    expect([markOf(cases, { top3: 54 }, "top-3")!.pass, markOf(cases, { top3: 53 }, "top-3")!.pass]).toEqual([true, false]);
    expect([markOf(cases, { avoidHit: 28 }, "name-avoiding top-3")!.pass, markOf(cases, { avoidHit: 27 }, "name-avoiding top-3")!.pass]).toEqual([true, false]);
    const beat = (top1: number) => scorer.scoreJson(report({ top1 }), cases, main).marks["material"]!["top-1 vs main"]!.pass;
    expect([beat(23), beat(22)]).toEqual([true, false]);
  });

  it("prints n/a for N = 0 and never counts it as a pass", () => {
    const cases = holdout(10, 0, 0);
    const text = scorer.formatScore(report({ top1: 10, top3: 10 }), cases, { material: { asks: 10, top1: 0, top3: 0, noFit: 0, noFitHit: 0 } });
    const material = section(text, "Material 10", "Acme ");
    expect(lineOf(material, "no-fit")).toBe("no-fit 0/0 n/a");
    expect(lineOf(material, "name-avoiding top-3")).toBe("name-avoiding top-3 0/0 n/a");
    expect(lineOf(material, "verdict")).toBe("verdict incomplete (n/a: name-avoiding top-3, no-fit, invented, confusable sure-wrong, library quote)");
    expect(markOf(cases, {}, "no-fit")).toEqual({ n: 0, N: 0, rate: null, pass: null });
  });

  it("prints every acceptance metric per library group as n/N and %", () => {
    const cases = [...holdout(60, 6, 32), { id: "a-1", pack: "acme", ask: "synthetic", expect: { lead: "Switch", accept: "exact" }, tags: [] }];
    const text = scorer.formatScore(report({ top1: 50, top3: 55, avoidHit: 30, noFitHit: 6, named: 180, libraryQuotes: 40, libraryShown: 40 }), cases, main);
    const material = section(text, "Material 60", "Acme ");
    const labels = ["top-1", "top-1 vs main", "top-3", "top-3 vs main", "name-avoiding top-3", "no-fit", "invented", "gate", "tier flips", "confusable sure-wrong", "main lost", "library quote"];
    for (const label of labels) expect(lineOf(material, label), label).toMatch(/ \d+\/\d+ (\d+(\.\d)?% .* (pass|fail)( \(soft\))?|n\/a)$/);
    expect(lineOf(material, "rejected")).toBe("rejected 0/60 0%");
    expect(lineOf(material, "nothing-fits asks")).toBe("nothing-fits asks 6/60 10% target TBD (fresh set at least 8)");
    const acme = section(text, "Acme 1", "Total ");
    for (const label of ["top-1", "top-3", "name-avoiding top-3", "no-fit", "invented", "gate", "tier flips", "confusable sure-wrong", "main lost", "library quote", "rejected"]) {
      expect(lineOf(acme, label), label).toMatch(/ \d+\/\d+ /);
    }
  });

  it("adds marks and rejections to the JSON score and keeps the existing field names", () => {
    const json = scorer.scoreJson(report({ top1: 50 }, { rejections: [{ caseId: "h-1", run: 2, failed: ["quote"] }] }), holdout(60, 6, 32), main);
    for (const field of ["groups", "rejections", "incomplete", "thinDescribed", "lost", "marks", "main"]) expect(json, field).toHaveProperty(field);
    expect(json.rejections).toEqual([{ caseId: "h-1", run: 2, failed: ["quote"] }]);
    expect(json.marks["material"]!["top-1"]).toEqual({ n: 50, N: 60, rate: 50 / 60, pass: true });
  });
});

describe("F1b-R2 main's weak-lead rule", () => {
  it("fails a weak lead on both paths", () => {
    expect(scorer.mainPath(true, ["Tooltip"], ["Tooltip"], true)).toEqual({ top1: false, top3: false, noFit: false });
    expect(scorer.mainPath(false, [], ["Tooltip"], true)).toEqual({ top1: false, top3: false, noFit: false });
    expect(scorer.mainPath(true, ["Tooltip"], ["Badge", "Tooltip"], false)).toEqual({ top1: false, top3: true, noFit: false });
    expect(scorer.eitherCorrect(true, ["Tooltip"], ["Tooltip"], "", false, true).top1).toBe(false);
  });

  it("takes main's bar from the better path per metric and lost cases from either path", () => {
    const cases: Case[] = ["w-1", "w-2", "w-3"].map((id) => ({ id, pack: "material", ask: "synthetic", expect: { lead: "Tooltip", accept: "exact" }, tags: [] }));
    const evidence: Evidence[] = [
      { id: "w-1", frozenNames: ["Tooltip"], frozenWeak: false, lead: "Badge", weak: false },
      { id: "w-2", frozenNames: ["Badge"], frozenWeak: false, lead: "Tooltip", weak: false },
      { id: "w-3", frozenNames: ["Tooltip"], frozenWeak: true, lead: "Tooltip", weak: true },
    ];
    const { correct, rates } = scorer.ratesFrom(cases, evidence);
    const material = rates["material"]!;
    expect([material.top1, material.paths["frozen"]!["top1"], material.paths["recommend"]!["top1"]]).toEqual([1, 1, 1]);
    expect(correct).toEqual({ "w-1": true, "w-2": true, "w-3": false });
  });
});

describe("F1b score errors and incomplete cases", () => {
  it("leaves a case with 2 of 3 runs out of every count and lists it", () => {
    const cases: Case[] = ["i-1", "i-2"].map((id) => ({ id, pack: "material", ask: "synthetic", expect: { lead: "Chip", accept: "exact" }, tags: [] }));
    const runs = [1, 2, 3].map((run) => shownRun("i-1", run, "chip")).concat([1, 2].map((run) => shownRun("i-2", run, "chip")));
    const report = scorer.scoreRecorded(cases, runs, names, indexIds);
    expect([report.incomplete, report.groups.material["asks"], report.groups.material["top1"], report["badRuns"]]).toEqual([["i-2"], 1, 1, 0]);
    const text = scorer.formatScore(report, cases);
    expect(text.split("\n")[0]).toBe("Material 1");
    expect(text).toContain("\nincomplete 1 (2 of 3 runs, left out of every count): i-2\n");
  });

  it("exits 2 on a missing run file and 3 when runs and cases do not match", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-picks-marks-"));
    const cases = join(dir, "cases.json");
    const runs = join(dir, "runs.jsonl");
    const map = join(dir, "id-map.json");
    writeFileSync(cases, JSON.stringify({ cases: [{ id: "e-1", pack: "material", ask: "synthetic", expect: { lead: "Chip", accept: "exact" } }] }));
    writeFileSync(runs, `${[1, 2, 3].map((run) => JSON.stringify({ caseId: "x-9", run, request: { tier: "no-fit", shortlist: [] } })).join("\n")}\n`);
    writeFileSync(map, "{}\n");
    const scoreWith = (runFile: string) => spawnSync(process.execPath, ["scripts/ai-picks-eval.mjs", "score", "--cases", cases, "--runs", runFile, "--id-map", map], { encoding: "utf8" });
    const missing = scoreWith(join(dir, "nope.jsonl"));
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("No run file");
    const mismatched = scoreWith(runs);
    expect(mismatched.status).toBe(3);
    expect(mismatched.stderr).toContain("x-9");
    expect(mismatched.stderr).toContain("e-1");
    rmSync(dir, { recursive: true, force: true });
  });
});
