import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SourceDocumentSchema } from "@/core/ingestion/types";
import { buildGraph } from "@/core/transform";
import { indexGraph } from "@/core/query";
import { loadGoldenCases, scoreGraph } from "@/core/query/scoreboard";
import { loadPhraseCases, scorePhrases, type PhraseCase } from "@/core/query/phraseScore";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Fixed seed. Lowest 20% of phrase ids are held out. Not used to pick synonyms. */
const HOLDOUT_SEED = 90;

function holdoutIds(ids: string[]): Set<string> {
  const ranked = ids.map((id) => {
    let hash = HOLDOUT_SEED >>> 0;
    for (let i = 0; i < id.length; i += 1) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619) >>> 0;
    return { id, hash };
  });
  ranked.sort((a, b) => a.hash - b.hash || a.id.localeCompare(b.id));
  const count = Math.round(ids.length * 0.2);
  return new Set(ranked.slice(0, count).map((row) => row.id));
}

function fixtureIndex() {
  const raw: unknown = JSON.parse(readFileSync(join(root, "scoreboard/fixture/library.json"), "utf8"));
  return indexGraph(buildGraph(SourceDocumentSchema.parse(raw), { builtAt: "2026-01-01T00:00:00.000Z" }));
}

function rate(cases: PhraseCase[], held: Set<string>) {
  const index = fixtureIndex();
  const subset = cases.filter((row) => held.has(row.id));
  return scorePhrases(index, subset);
}

describe("phrase holdout and fresh Acme asks", () => {
  const cases = loadPhraseCases([join(root, "scoreboard/phrases")]);
  const held = holdoutIds(cases.map((row) => row.id));

  it("holds out about 20% with a fixed seed and scores that slice on its own", () => {
    expect(cases.length).toBe(118);
    expect(held.size).toBe(24);
    const report = rate(cases, held);
    expect(report.totals.matchCases).toBe(19);
    expect(report.totals.top3).toBe(18);
    expect(report.totals.emptyCases).toBe(5);
    expect(report.totals.correctEmpty).toBe(5);
    expect(report.totals.invented).toBe(0);
    expect(report.totals.retiredRecommended).toBe(0);
    const top3Miss = report.misses.filter((row) => row.kind === "top3" || row.kind === "false-empty").map((row) => row.id);
    expect(top3Miss).toEqual(["retired-hidden-badge"]);
  });

  it("scores a fresh Acme phrase file that is not part of the headline set", () => {
    const fresh = loadPhraseCases([join(root, "scoreboard/fresh/acme.json")]);
    expect(fresh.length).toBeGreaterThanOrEqual(20);
    expect(fresh.every((row) => row.id.startsWith("fresh-"))).toBe(true);
    const report = scorePhrases(fixtureIndex(), fresh);
    expect(report.skipped).toEqual([]);
    expect(report.totals.invented).toBe(0);
    expect(report.totals.retiredRecommended).toBe(0);
    expect(report.totals.matchCases).toBe(14);
    expect(report.totals.emptyCases).toBe(7);
    expect(report.totals.correctEmpty).toBe(7);
    expect(report.totals.top1).toBe(13);
    expect(report.totals.top3).toBe(14);
  });

  it("keeps the golden regression at 75 cases", () => {
    const golden = loadGoldenCases(join(root, "scoreboard/golden"));
    expect(golden.length).toBe(75);
    const report = scoreGraph(fixtureIndex(), golden, { at: "2026-10-12T00:00:00.000Z" });
    expect(report.pass).toBe(true);
    expect(report.inventCount).toBe(0);
    expect(report.top1Count).toBe(report.top1Base);
  });
});
