/**
 * Score the frozen meaning set. The fixture's expectations are not edited here.
 * Report only. No score floor. Generate files with scripts/build-meaning-sock.mjs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { meaningCandidates, type MeaningCandidate, type MeaningPack } from "@/core/query/meaning/sock";
import { loadPacks, writePacks } from "../scripts/meaning-sock-build";

export { writePacks };

const root = process.cwd();

interface FrozenCase {
  id: string;
  library: string;
  pack: "material" | "acme" | "acme-small";
  ask: string;
  expect: { lead?: string; accept: "exact" | "empty-or-weak" | "empty" };
  alternates?: string[];
  tags?: string[];
}

export interface FrozenReport {
  cases: number;
  top1: { hit: number; of: number; rate: number };
  top3: { hit: number; of: number; rate: number };
  nameAvoidingTop3: { hit: number; of: number; rate: number };
  noFit: { hit: number; of: number; rate: number };
  confusableWrongSure: number;
  invented: number;
  misses: string[];
}

function accepted(row: FrozenCase): Set<string> {
  return new Set([row.expect.lead ?? "", ...(row.alternates ?? [])].filter(Boolean));
}

function inTop(names: string[], row: FrozenCase, limit: number): boolean {
  const ok = accepted(row);
  return names.slice(0, limit).some((name) => ok.has(name));
}

function noFitPass(candidates: MeaningCandidate[]): boolean {
  return candidates.length === 0;
}

export function scoreFrozen(cases: FrozenCase[], packs = loadPacks()): FrozenReport {
  const names = new Map<FrozenCase["pack"], Set<string>>();
  for (const [pack, built] of Object.entries(packs) as Array<[FrozenCase["pack"], MeaningPack]>) {
    names.set(pack, new Set(built.components.map((component) => component.name)));
  }
  let top1 = 0;
  let top3 = 0;
  let avoidHit = 0;
  let avoid = 0;
  let noFitHit = 0;
  let noFit = 0;
  let confusableWrongSure = 0;
  let invented = 0;
  const misses: string[] = [];
  for (const row of cases) {
    const pack = packs[row.pack];
    const candidates = meaningCandidates(row.ask, pack);
    const lead = candidates[0];
    const got = candidates.map((candidate) => candidate.name);
    const libraryNames = names.get(row.pack) ?? new Set<string>();
    for (const name of got) if (!libraryNames.has(name)) invented += 1;
    const isExact = row.expect.accept === "exact";
    const fit1 = isExact ? inTop(got, row, 1) : noFitPass(candidates);
    const fit3 = isExact ? inTop(got, row, 3) : noFitPass(candidates);
    if (fit1) top1 += 1;
    if (fit3) top3 += 1;
    else misses.push(`${row.id} ${isExact ? "top" : "no-fit"} ${lead ? `${lead.name} ${lead.confidence}` : "∅"} want ${row.expect.lead ?? row.expect.accept} [${got.slice(0, 3).join(", ")}]`);
    if ((row.tags ?? []).includes("meaning-only")) {
      avoid += 1;
      if (fit3) avoidHit += 1;
    }
    if (!isExact || (row.tags ?? []).includes("no-fit")) {
      noFit += 1;
      if (noFitPass(candidates)) noFitHit += 1;
    }
    if ((row.tags ?? []).includes("confusable") && lead?.confidence === "sure" && !accepted(row).has(lead.name)) {
      confusableWrongSure += 1;
    }
  }
  const rate = (hit: number, of: number) => (of === 0 ? 0 : hit / of);
  return {
    cases: cases.length,
    top1: { hit: top1, of: cases.length, rate: rate(top1, cases.length) },
    top3: { hit: top3, of: cases.length, rate: rate(top3, cases.length) },
    nameAvoidingTop3: { hit: avoidHit, of: avoid, rate: rate(avoidHit, avoid) },
    noFit: { hit: noFitHit, of: noFit, rate: rate(noFitHit, noFit) },
    confusableWrongSure,
    invented,
    misses,
  };
}

export function formatReport(report: FrozenReport): string {
  const pct = (rate: number) => `${Math.round(rate * 1000) / 10}%`;
  return [
    `frozen ${report.cases}`,
    `top-1 ${report.top1.hit}/${report.top1.of} ${pct(report.top1.rate)} target 80%`,
    `top-3 ${report.top3.hit}/${report.top3.of} ${pct(report.top3.rate)} target 90%`,
    `name-avoiding top-3 ${report.nameAvoidingTop3.hit}/${report.nameAvoidingTop3.of} ${pct(report.nameAvoidingTop3.rate)} target 85%`,
    `no-fit ${report.noFit.hit}/${report.noFit.of} ${pct(report.noFit.rate)} target 90%`,
    `confusable sure-wrong ${report.confusableWrongSure} target 0`,
    `invented ${report.invented} target 0`,
  ].join("\n");
}

export function targetsMet(report: FrozenReport): boolean {
  return report.top1.rate >= 0.8 && report.top3.rate >= 0.9 && report.nameAvoidingTop3.rate >= 0.85 && report.noFit.rate >= 0.9 && report.confusableWrongSure === 0 && report.invented === 0;
}

export function readFrozenCases(): FrozenCase[] {
  const parsed = JSON.parse(readFileSync(join(root, "scoreboard/meaning/frozen.json"), "utf8")) as { cases: FrozenCase[] };
  return parsed.cases;
}

const direct = process.argv[1]?.includes("meaning.frozen-score");
if (direct) {
  const report = scoreFrozen(readFrozenCases());
  process.stdout.write(`${formatReport(report)}\n`);
  process.stdout.write(`frozen top-1 ${report.top1.hit}/111\n`);
  if (report.misses.length) process.stdout.write(`${report.misses.join("\n")}\n`);
}
