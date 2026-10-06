import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SourceDocumentSchema } from "@/core/ingestion/types";
import { buildGraph } from "@/core/transform";
import { indexGraph } from "@/core/query";
import {
  PHRASE_TYPES,
  formatPhraseTable,
  loadPhraseCases,
  phraseExitCode,
  scorePhrases,
} from "@/core/query/phraseScore";
import { runCli } from "@/server/cli";
import { clearCache } from "@/server/store";

const root = fileURLToPath(new URL("..", import.meta.url));
const phrasesDir = join(root, "scoreboard", "phrases");

function fixtureIndex() {
  const raw: unknown = JSON.parse(readFileSync(join(root, "scoreboard", "fixture", "library.json"), "utf8"));
  return indexGraph(buildGraph(SourceDocumentSchema.parse(raw), { builtAt: "2026-01-01T00:00:00.000Z" }));
}

describe("designer phrase scoreboard", () => {
  const previousStore = process.env["RESOLVE_HOME"];
  afterEach(() => {
    if (previousStore === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previousStore;
    clearCache();
    process.exitCode = undefined;
  });

  it("ships 60+ phrases covering every phrase type, and every named part exists", () => {
    const cases = loadPhraseCases([phrasesDir]);
    expect(cases.length).toBeGreaterThanOrEqual(60);
    for (const type of PHRASE_TYPES) expect(cases.some((row) => row.type === type), type).toBe(true);
    const report = scorePhrases(fixtureIndex(), cases);
    expect(report.skipped).toEqual([]);
    expect(report.phrases).toBe(cases.length);
  });

  // The gate: a made-up part or a retired/private recommendation fails the suite.
  it("never invents a part and never recommends a retired or private one", () => {
    const report = scorePhrases(fixtureIndex(), loadPhraseCases([phrasesDir]));
    expect(report.misses.filter((row) => row.kind === "invent" || row.kind === "retired")).toEqual([]);
    expect(report.totals.invented).toBe(0);
    expect(report.totals.retiredRecommended).toBe(0);
    expect(report.inventRate).toBe(0);
    expect(report.pass).toBe(true);
    expect(phraseExitCode(report)).toBe(0);
  });

  it("exits 1 when the gate fails, and a retired part asked for by name is not offered", () => {
    const index = fixtureIndex();
    expect(phraseExitCode({ pass: false })).toBe(1);
    const report = scorePhrases(index, [{ id: "x", phrase: "Legacy Banner", type: "retired", expect: ["Banner"] }]);
    expect(report.totals.retiredRecommended).toBe(0);
    expect(report.totals.top1).toBe(1);
  });

  it("keeps type breakdown, plain summary first, and a skipped list for unknown parts", () => {
    const report = scorePhrases(fixtureIndex(), [
      ...loadPhraseCases([phrasesDir]),
      { id: "team-x", phrase: "teleporter", type: "team", expect: ["Teleport Pad"] },
    ]);
    expect(report.skipped.map((row) => row.id)).toEqual(["team-x"]);
    expect(report.byType.map((row) => row.type)).toEqual([...PHRASE_TYPES]);
    const sum = (key: "phrases" | "top1" | "top3") => report.byType.reduce((n, row) => n + row[key], 0);
    expect(report.totals.phrases).toBe(sum("phrases"));
    expect(report.totals.top1).toBe(sum("top1"));
    const text = formatPhraseTable(report);
    expect(text.split("\n")[0]).toMatch(/^Resolve tried \d+ designer phrases/);
    expect(text).toMatch(/\nDetails\n/);
    expect(text).toMatch(/skipped team-x/);
  });

  it("rejects duplicate phrase ids across files", () => {
    const dir = mkdtempSync(join(tmpdir(), "resolve-phrases-"));
    const row = { id: "dup", phrase: "tabs", type: "exact", expect: ["Tabs"] };
    writeFileSync(join(dir, "a.json"), JSON.stringify({ version: 1, cases: [row] }));
    writeFileSync(join(dir, "b.json"), JSON.stringify({ version: 1, cases: [row] }));
    expect(() => loadPhraseCases([dir])).toThrow(/Ids must be unique/);
  });

  it("resolve score phrases adds the team's own phrases from the store, without touching the repo", async () => {
    const store = mkdtempSync(join(tmpdir(), "resolve-phrases-store-"));
    process.env["RESOLVE_HOME"] = store;
    clearCache();
    await runCli(["ingest", join(root, "scoreboard", "fixture", "library.json"), "--role", "library", "--name", "Fixture"]);
    clearCache();
    mkdirSync(join(store, "scoreboard", "phrases"), { recursive: true });
    writeFileSync(
      join(store, "scoreboard", "phrases", "team.json"),
      JSON.stringify({ version: 1, cases: [{ id: "team-tabs", phrase: "tabs", type: "team", expect: ["Tabs"] }] }),
    );
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runCli(["score", "phrases", "--json"]);
    } finally {
      process.stdout.write = write;
    }
    const report = JSON.parse(chunks.join("")) as { byType: { type: string }[]; pass: boolean };
    expect(report.byType.some((row) => row.type === "team")).toBe(true);
    expect(report.byType.some((row) => row.type === "exact")).toBe(true);
    expect(report.pass).toBe(true);
    expect(process.exitCode ?? 0).toBe(0);
  });
});
