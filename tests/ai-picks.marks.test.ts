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
  result: { tier: string; id?: string; name?: string; reason?: string; nameOnly?: boolean; shortlist?: string[]; failed: string[]; thin: Array<{ id: string; missing: string[]; nameOnly?: boolean }> };
}

type Group = Record<string, number>;
interface Report {
  groups: Record<"material" | "acme" | "total", Group>;
  rejections: Array<{ caseId: string; run: number; failed: string[] }>;
  incomplete: string[];
  twoOfThree?: string[];
  modelShortlist?: Array<{ caseId: string; run: number; shortlist: string[] }>;
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
  ratesFrom(cases: Case[], evidence: Evidence[]): {
    correct: Record<string, boolean>;
    correctByRule: Record<string, Record<string, boolean>>;
    rates: Record<string, MainRates[string] & { path?: string; paths: Record<string, Group>; rules?: Record<string, { top1: number; top3: number; path: string }> }>;
  };
  mainPath(exact: boolean, accepted: string[], names: string[], weak: boolean, rule?: string): { top1: boolean; top3: boolean; noFit: boolean };
  eitherCorrect(exact: boolean, accepted: string[], frozenNames: string[], lead: string, weak: boolean, frozenWeak?: boolean, rule?: string): { top1: boolean; top3: boolean; noFit: boolean };
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
    expect(lineOf(got.material, "old top-1")).toBe("old top-1 28/60 46.7% target 80% (48/60) fail");
    expect(lineOf(got.material, "new top-1")).toBe("new top-1 28/60 46.7% target 80% (48/60) fail");
    expect(lineOf(got.material, "old top-1 vs main")).toBe("old top-1 vs main 28/60 46.7% target 35% (21/60) pass");
    expect(lineOf(got.material, "new top-1 vs main")).toBe("new top-1 vs main 28/60 46.7% target 35% (21/60) pass");
    expect(got.json.marks["material"]!["old top-1"]).toEqual({ n: 28, N: 60, rate: 28 / 60, pass: false });
    expect(got.json.marks["material"]!["new top-1"]).toEqual({ n: 28, N: 60, rate: 28 / 60, pass: false });
    expect(lineOf(got.material, "verdict")).toBe("verdict fail (old top-1, new top-1, old top-3, new top-3, old name-avoiding top-3, new name-avoiding top-3)");
  });

  it("fails no-fit 4/6 and passes 6/6", () => {
    const cases = materialSet();
    const four = score(cases, threeRuns(cases, (_row, index) => (index >= 58 ? "wrong" : index >= 54 ? "no-fit" : "right")));
    expect(lineOf(four.material, "old no-fit")).toBe("old no-fit 4/6 66.7% target 90% (6/6) fail");
    expect(lineOf(four.material, "new no-fit")).toBe("new no-fit 4/6 66.7% target 90% (6/6) fail");
    expect(lineOf(four.material, "verdict")).toBe("verdict fail (old no-fit, new no-fit)");
    const six = score(cases, threeRuns(cases, (_row, index) => (index >= 54 ? "no-fit" : "right")));
    expect(lineOf(six.material, "old no-fit")).toBe("old no-fit 6/6 100% target 90% (6/6) pass");
    expect(lineOf(six.material, "new no-fit")).toBe("new no-fit 6/6 100% target 90% (6/6) pass");
    expect(lineOf(six.material, "verdict")).toBe("verdict pass");
  });

  it("fails an all-no-fit run", () => {
    const cases = materialSet();
    const got = score(cases, threeRuns(cases, () => "no-fit"));
    expect(lineOf(got.material, "old top-1")).toBe("old top-1 6/60 10% target 80% (48/60) fail");
    expect(lineOf(got.material, "new top-1")).toBe("new top-1 6/60 10% target 80% (48/60) fail");
    expect(lineOf(got.material, "old top-3")).toMatch(/ fail$/);
    expect(lineOf(got.material, "new top-3")).toMatch(/ fail$/);
    expect(lineOf(got.material, "old name-avoiding top-3")).toBe("old name-avoiding top-3 0/32 0% target 85% (28/32) fail");
    expect(lineOf(got.material, "new name-avoiding top-3")).toBe("new name-avoiding top-3 0/32 0% target 85% (28/32) fail");
    expect(lineOf(got.material, "old no-fit")).toMatch(/ pass$/);
    expect(lineOf(got.material, "new no-fit")).toMatch(/ pass$/);
    expect(lineOf(got.material, "verdict")).toMatch(/^verdict fail \(old top-1, new top-1, old top-1 vs main, new top-1 vs main, old top-3, new top-3, old top-3 vs main, new top-3 vs main, old name-avoiding top-3/);
  });
});

describe("F1b-R5 m-q04: majority on the accepted-answer set", () => {
  const row: Case = { id: "q-1", pack: "material", ask: "synthetic judgement ask", expect: { lead: "Tooltip", accept: "exact" }, alternates: ["Badge"], tags: [] };

  it("scores every-run-accepted as correct and stable even when tiers and components differ", () => {
    const report = scorer.scoreRecorded([row], [shownRun("q-1", 1, "tooltip", "place"), shownRun("q-1", 2, "tooltip", "ask"), shownRun("q-1", 3, "badge", "place")], names, indexIds);
    const material = report.groups.material;
    expect([material["top1"], material["top3"], material["gate"], material["split"], material["tierFlips"]]).toEqual([1, 1, 0, 0, 0]);
    expect([material["top1New"], material["top3New"]]).toEqual([0, 0]);
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
    for (const prefix of ["old", "new"]) {
      expect(markOf(cases, { top1: 36 }, `${prefix} top-1`)!.pass).toBe(true);
      expect(markOf(cases, { top1: 35 }, `${prefix} top-1`)!.pass).toBe(false);
      expect(markOf(cases, { top3: 41 }, `${prefix} top-3`)!.pass).toBe(true);
      expect(markOf(cases, { top3: 40 }, `${prefix} top-3`)!.pass).toBe(false);
      expect(markOf(cases, { avoidHit: 17 }, `${prefix} name-avoiding top-3`)!.pass).toBe(true);
      expect(markOf(cases, { avoidHit: 16 }, `${prefix} name-avoiding top-3`)!.pass).toBe(false);
      expect(markOf(cases, { noFitHit: 7 }, `${prefix} no-fit`)!.pass).toBe(true);
      expect(markOf(cases, { noFitHit: 6 }, `${prefix} no-fit`)!.pass).toBe(false);
      expect(markOf(cases, { gate: 2 }, `${prefix} gate`)!.pass).toBe(true);
      expect(markOf(cases, { gate: 3 }, `${prefix} gate`)!.pass).toBe(false);
      expect(markOf(cases, { invented: 1, named: 90 }, `${prefix} invented`)).toEqual({ n: 1, N: 90, rate: 1 / 90, pass: false });
      expect(markOf(cases, { top1: 16 }, `${prefix} top-1 vs main`)!.pass).toBe(true);
      expect(markOf(cases, { top1: 15 }, `${prefix} top-1 vs main`)!.pass).toBe(false);
    }
  });

  it("uses the ticket numbers on the frozen 60 and 32", () => {
    const cases = holdout(60, 6, 32);
    for (const prefix of ["old", "new"]) {
      expect([markOf(cases, { top1: 48 }, `${prefix} top-1`)!.pass, markOf(cases, { top1: 47 }, `${prefix} top-1`)!.pass]).toEqual([true, false]);
      expect([markOf(cases, { top3: 54 }, `${prefix} top-3`)!.pass, markOf(cases, { top3: 53 }, `${prefix} top-3`)!.pass]).toEqual([true, false]);
      expect([markOf(cases, { avoidHit: 28 }, `${prefix} name-avoiding top-3`)!.pass, markOf(cases, { avoidHit: 27 }, `${prefix} name-avoiding top-3`)!.pass]).toEqual([true, false]);
      const beat = (top1: number) => scorer.scoreJson(report({ top1 }), cases, main).marks["material"]![`${prefix} top-1 vs main`]!.pass;
      expect([beat(21), beat(20)]).toEqual([true, false]);
    }
    const beat3 = (field: string, top3: number) => scorer.scoreJson(report({ top3 }), cases, main).marks["material"]![field]!.pass;
    expect([beat3("old top-3 vs main", 27), beat3("old top-3 vs main", 26)]).toEqual([true, false]);
    expect([beat3("new top-3 vs main", 21), beat3("new top-3 vs main", 20)]).toEqual([true, false]);
  });

  it("prints floors of top-1 21 and top-3 27 old / 21 new", () => {
    const cases = holdout(60, 6, 32);
    const text = scorer.formatScore(report({ top1: 30, top3: 30 }), cases, main);
    const material = section(text, "Material 60", "Acme ");
    expect(lineOf(material, "old top-1 vs main")).toContain("(21/60)");
    expect(lineOf(material, "new top-1 vs main")).toContain("(21/60)");
    expect(lineOf(material, "old top-3 vs main")).toContain("(27/60)");
    expect(lineOf(material, "new top-3 vs main")).toContain("(21/60)");
  });

  it("prints n/a for N = 0 and never counts it as a pass", () => {
    const cases = holdout(10, 0, 0);
    const text = scorer.formatScore(report({ top1: 10, top3: 10 }), cases, { material: { asks: 10, top1: 0, top3: 0, noFit: 0, noFitHit: 0 } });
    const material = section(text, "Material 10", "Acme ");
    expect(lineOf(material, "old no-fit")).toBe("old no-fit 0/0 n/a");
    expect(lineOf(material, "new no-fit")).toBe("new no-fit 0/0 n/a");
    expect(lineOf(material, "old name-avoiding top-3")).toBe("old name-avoiding top-3 0/0 n/a");
    expect(lineOf(material, "new name-avoiding top-3")).toBe("new name-avoiding top-3 0/0 n/a");
    expect(lineOf(material, "verdict")).toBe("verdict incomplete (n/a: old name-avoiding top-3, new name-avoiding top-3, old no-fit, new no-fit, old invented, new invented, old confusable sure-wrong, new confusable sure-wrong, old library quote, new library quote)");
    expect(markOf(cases, {}, "old no-fit")).toEqual({ n: 0, N: 0, rate: null, pass: null });
    expect(markOf(cases, {}, "new no-fit")).toEqual({ n: 0, N: 0, rate: null, pass: null });
  });

  it("prints every acceptance metric per library group as n/N and %", () => {
    const cases = [...holdout(60, 6, 32), { id: "a-1", pack: "acme", ask: "synthetic", expect: { lead: "Switch", accept: "exact" }, tags: [] }];
    const text = scorer.formatScore(report({ top1: 50, top3: 55, avoidHit: 30, noFitHit: 6, named: 180, libraryQuotes: 40, libraryShown: 40 }), cases, main);
    const material = section(text, "Material 60", "Acme ");
    const labels = ["top-1", "top-1 vs main", "top-3", "top-3 vs main", "name-avoiding top-3", "no-fit", "invented", "gate", "tier flips", "confusable sure-wrong", "main lost", "library quote"];
    for (const prefix of ["old", "new"]) {
      for (const label of labels) expect(lineOf(material, `${prefix} ${label}`), `${prefix} ${label}`).toMatch(/ \d+\/\d+ (\d+(\.\d)?% .* (pass|fail)( \(soft\))?|n\/a)$/);
    }
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
    expect(json.marks["material"]!["old top-1"]).toEqual({ n: 50, N: 60, rate: 50 / 60, pass: true });
    expect(json.marks["material"]!["new top-1"]).toEqual({ n: 50, N: 60, rate: 50 / 60, pass: true });
  });
});

describe("F1b-R2 main's weak-lead rule", () => {
  it("fails a weak lead on both paths under the new rule and still counts it under the old rule", () => {
    expect(scorer.mainPath(true, ["Tooltip"], ["Tooltip"], true)).toEqual({ top1: false, top3: false, noFit: false });
    expect(scorer.mainPath(true, ["Tooltip"], ["Tooltip"], true, "old")).toEqual({ top1: true, top3: true, noFit: false });
    expect(scorer.mainPath(false, [], ["Tooltip"], true)).toEqual({ top1: false, top3: false, noFit: false });
    expect(scorer.mainPath(false, [], ["Tooltip"], true, "old")).toEqual({ top1: false, top3: false, noFit: false });
    expect(scorer.mainPath(true, ["Tooltip"], ["Badge", "Tooltip"], false)).toEqual({ top1: false, top3: true, noFit: false });
    expect(scorer.eitherCorrect(true, ["Tooltip"], ["Tooltip"], "", false, true).top1).toBe(false);
    expect(scorer.eitherCorrect(true, ["Tooltip"], [], "Tooltip", true, false, "old").top1).toBe(true);
    expect(scorer.eitherCorrect(true, ["Tooltip"], ["Tooltip"], "", true, true, "old").top1).toBe(true);
  });

  it("counts tier ask as a weak lead on the AI path", () => {
    const row: Case = { id: "q-ask", pack: "material", ask: "synthetic", expect: { lead: "Tooltip", accept: "exact" }, alternates: ["Badge"], tags: ["meaning-only"] };
    const runs = [1, 2, 3].map((run) => shownRun("q-ask", run, "tooltip", "ask"));
    const report = scorer.scoreRecorded([row], runs, names, indexIds);
    expect([report.groups.material["top1"], report.groups.material["top3"], report.groups.material["avoidHit"]]).toEqual([1, 1, 1]);
    expect([report.groups.material["top1New"], report.groups.material["top3New"], report.groups.material["avoidHitNew"]]).toEqual([0, 0, 0]);
    const listed = shownRun("q-ask", 1, "slider", "ask", { shortlist: ["slider", "tooltip", "badge"] });
    listed.request.shortlist = ["slider", "tooltip", "badge"];
    const top3 = scorer.scoreRecorded([row], [listed], names, indexIds).groups.material;
    expect([top3["top1"], top3["top3"], top3["top1New"], top3["top3New"]]).toEqual([0, 1, 0, 0]);
  });

  it("fails the run unless every bar passes under both rules", () => {
    const cases = materialSet();
    const runs = cases.flatMap((row, index) => [1, 2, 3].map((run) => (index >= 54 ? noFitRun(row.id, run) : shownRun(row.id, run, "tooltip", "ask"))));
    const got = score(cases, runs);
    expect(lineOf(got.material, "old top-1")).toMatch(/ 60\/60 .* pass$/);
    expect(lineOf(got.material, "new top-1")).toMatch(/ fail$/);
    expect(got.report.groups.material["top1"]).toBe(60);
    expect(got.report.groups.material["top1New"]).toBe(6);
    expect(lineOf(got.material, "verdict")).toBe("verdict fail (new top-1, new top-1 vs main, new top-3, new top-3 vs main, new name-avoiding top-3)");
  });

  it("takes the baseline from main's better single path, and lost cases from either path", () => {
    const cases: Case[] = ["w-1", "w-2", "w-3"].map((id) => ({ id, pack: "material", ask: "synthetic", expect: { lead: "Tooltip", accept: "exact" }, tags: [] }));
    const evidence: Evidence[] = [
      { id: "w-1", frozenNames: ["Tooltip"], frozenWeak: false, lead: "Badge", weak: false },
      { id: "w-2", frozenNames: ["Badge"], frozenWeak: false, lead: "Tooltip", weak: false },
      { id: "w-3", frozenNames: ["Tooltip"], frozenWeak: true, lead: "Tooltip", weak: true },
    ];
    const { correct, correctByRule, rates } = scorer.ratesFrom(cases, evidence);
    const material = rates["material"]!;
    expect([material.top1, material.paths["frozen"]!["top1"], material.paths["recommend"]!["top1"]]).toEqual([1, 1, 1]);
    expect(material.path).toBe("frozen");
    expect(material.rules!["new"]!.top1).toBe(1);
    expect(material.rules!["old"]!.top1).toBe(2);
    expect(correct).toEqual({ "w-1": true, "w-2": true, "w-3": false });
    expect(correctByRule["old"]).toEqual({ "w-1": true, "w-2": true, "w-3": true });
    const split: Case[] = ["s-1", "s-2", "s-3", "s-4"].map((id) => ({ id, pack: "material", ask: "synthetic", expect: { lead: "Tooltip", accept: "exact" }, tags: [] }));
    const splitEvidence: Evidence[] = [
      { id: "s-1", frozenNames: ["Tooltip"], frozenWeak: false, lead: "Badge", weak: false },
      { id: "s-2", frozenNames: ["Badge", "Tooltip"], frozenWeak: false, lead: "Tooltip", weak: false },
      { id: "s-3", frozenNames: ["Chip", "Tooltip"], frozenWeak: false, lead: "Tooltip", weak: false },
      { id: "s-4", frozenNames: ["Badge"], frozenWeak: false, lead: "Badge", weak: false },
    ];
    const picked = scorer.ratesFrom(split, splitEvidence).rates["material"]!;
    expect([picked.paths["frozen"]!["top1"], picked.paths["frozen"]!["top3"]]).toEqual([1, 3]);
    expect([picked.paths["recommend"]!["top1"], picked.paths["recommend"]!["top3"]]).toEqual([2, 2]);
    expect([picked.top1, picked.top3, picked.path]).toEqual([2, 2, "recommend"]);
  });
});

describe("F1b score errors and partial agreement", () => {
  it("counts a 2-of-3 case instead of leaving it out", () => {
    const cases: Case[] = ["i-1", "i-2"].map((id) => ({ id, pack: "material", ask: "synthetic", expect: { lead: "Chip", accept: "exact" }, tags: [] }));
    const runs = [1, 2, 3].map((run) => shownRun("i-1", run, "chip")).concat([1, 2].map((run) => shownRun("i-2", run, "chip")));
    const report = scorer.scoreRecorded(cases, runs, names, indexIds);
    expect([report.incomplete, report.groups.material["asks"], report.groups.material["top1"], report["badRuns"]]).toEqual([[], 2, 2, 0]);
    const text = scorer.formatScore(report, cases);
    expect(text.split("\n")[0]).toBe("Material 2");
    expect(text).toContain("\nincomplete 0\n");
    expect(text).not.toContain("left out of every count");
  });

  it("lists every incomplete or 2-of-3 case by id with the count", () => {
    const cases: Case[] = ["i-1", "i-2", "i-3"].map((id) => ({ id, pack: "material", ask: "synthetic", expect: { lead: "Chip", accept: "exact" }, tags: [] }));
    const runs = [1, 2, 3].map((run) => shownRun("i-1", run, "chip"))
      .concat([1, 2].map((run) => shownRun("i-2", run, "chip")))
      .concat([2, 3].map((run) => shownRun("i-3", run, "slider")));
    const report = scorer.scoreRecorded(cases, runs, names, indexIds);
    expect(report.incomplete).toEqual([]);
    expect(report.twoOfThree).toEqual(["i-2", "i-3"]);
    expect(report.groups.material["asks"]).toBe(3);
    expect(report.groups.material["top1"]).toBe(2);
    const text = scorer.formatScore(report, cases);
    expect(text).toContain("\nincomplete 0\n");
    expect(text).toContain("\nincomplete or 2-of-3 2: i-2, i-3\n");
    expect(text).not.toContain("left out of every count");
    const held: Report = {
      ...report,
      incomplete: ["z-9"],
      twoOfThree: ["i-2"],
    };
    const heldText = scorer.formatScore(held, cases);
    expect(heldText).toContain("\nincomplete 1 (2 of 3 runs, left out of every count): z-9\n");
    expect(heldText).toContain("\nincomplete or 2-of-3 2: z-9, i-2\n");
  });

  it("scores two agreeing runs and keeps a disagreement in the count", () => {
    const row: Case = { id: "p-1", pack: "material", ask: "synthetic", expect: { lead: "Chip", accept: "exact" }, tags: [] };
    const agree = scorer.scoreRecorded([row], [shownRun("p-1", 1, "chip"), shownRun("p-1", 2, "chip")], names, indexIds);
    expect([agree.incomplete, agree.groups.material["asks"], agree.groups.material["top1"], agree.groups.material["split"]]).toEqual([[], 1, 1, 0]);
    expect(scorer.formatScore(agree, [row])).toContain("partial agreement (2 of 3)");
    const split = scorer.scoreRecorded([row], [shownRun("p-1", 1, "chip"), shownRun("p-1", 2, "slider")], names, indexIds);
    expect([split.incomplete, split.groups.material["asks"], split.groups.material["top1"], split.groups.material["split"]]).toEqual([[], 1, 0, 1]);
  });

  it("scores the engine shortlist and reports the model shortlist only", () => {
    const row: Case = { id: "q-ask", pack: "material", ask: "synthetic", expect: { lead: "Tooltip", accept: "exact" }, alternates: ["Badge"], tags: [] };
    const missed = shownRun("q-ask", 1, "slider", "place", { shortlist: ["slider"] });
    missed.request.shortlist = ["tooltip", "badge", "chip"];
    const report = scorer.scoreRecorded([row], [missed], names, indexIds);
    expect([report.groups.material["top1"], report.groups.material["top3"]]).toEqual([0, 0]);
    expect(report.modelShortlist).toEqual([{ caseId: "q-ask", run: 1, shortlist: ["tooltip", "badge", "chip"] }]);
    const text = scorer.formatScore(report, [row]);
    expect(text).toContain("model shortlist (not scored)");
    expect(text).toContain("q-ask run 1 tooltip, badge, chip");
    const seen = shownRun("q-ask", 1, "slider", "place", { shortlist: ["slider", "tooltip"] });
    seen.request.shortlist = ["chip"];
    const hit = scorer.scoreRecorded([row], [seen], names, indexIds);
    expect([hit.groups.material["top1"], hit.groups.material["top3"]]).toEqual([0, 1]);
    expect(hit.modelShortlist).toEqual([{ caseId: "q-ask", run: 1, shortlist: ["chip"] }]);
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
