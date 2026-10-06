import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { SourceDocumentSchema } from "@/core/ingestion/types";
import { buildGraph } from "@/core/transform";
import { indexGraph } from "@/core/query";
import {
  PHRASE_TYPES,
  formatPhraseTable,
  isSampleLibrary,
  loadPhraseCases,
  phraseExitCode,
  scorePhrases,
} from "@/core/query/phraseScore";
import { runCli } from "@/server/cli";
import { clearCache } from "@/server/store";

const root = fileURLToPath(new URL("..", import.meta.url));
const phrasesDir = join(root, "scoreboard", "phrases");

/** The same parts, but from another file: not the sample library. */
function otherLibraryIndex() {
  const raw = JSON.parse(readFileSync(join(root, "scoreboard", "fixture", "library.json"), "utf8")) as { fileKey: string };
  raw.fileKey = "OTHERLIB";
  return indexGraph(buildGraph(SourceDocumentSchema.parse(raw), { builtAt: "2026-01-01T00:00:00.000Z" }));
}

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
    expect(text).toMatch(/\nSkipped\nteam-x: No part named "Teleport Pad" in this library/);
    expect(text).not.toMatch(/golden/i);
    // Misses use plain words, not tags.
    expect(text).not.toMatch(/\[(top1|top3|false-empty|not-empty|wrong-cousin)\]/);
    expect(text).toMatch(/: nothing offered\./);
  });

  it("counts a component set as a hit for one of its variants, like the golden scorer", () => {
    const report = scorePhrases(fixtureIndex(), [
      { id: "fam", phrase: "red danger button", type: "cousin-trap", expect: ["Button Danger"], mustNot: ["Button Primary"] },
      { id: "weak-strict", phrase: "red danger button", type: "weak-match", expect: "weak", accept: ["Button Danger"] },
    ]);
    expect(report.totals.top1).toBe(1);
    expect(report.totals.wrongCousin).toBe(0);
    // "weak" stays strict: the set is not the accepted variant, so it is not a correct empty.
    expect(report.totals.correctEmpty).toBe(0);
  });

  it("an empty phrase folder is an error, and a run that scores nothing does not pass", () => {
    const dir = mkdtempSync(join(tmpdir(), "resolve-phrases-empty-"));
    expect(() => loadPhraseCases([dir])).toThrow(/No phrases found/);
    const report = scorePhrases(fixtureIndex(), [{ id: "gone", phrase: "teleporter", type: "team", expect: ["Teleport Pad"] }]);
    expect(report.phrases).toBe(0);
    expect(report.pass).toBe(false);
    expect(phraseExitCode(report)).toBe(1);
    const text = formatPhraseTable(report);
    // Lead with the failure, and never claim "never made up a part" when nothing ran.
    expect(text.split("\n")[0]).toMatch(/^Nothing was tested/);
    expect(text).not.toMatch(/never made up/);
    expect(text).toMatch(/Result: FAIL/);
  });

  it("reads the same folder once when it is given twice", () => {
    expect(loadPhraseCases([phrasesDir, relative(process.cwd(), phrasesDir) || "."]).length).toBe(loadPhraseCases([phrasesDir]).length);
  });

  it("rejects duplicate phrase ids across files", () => {
    const dir = mkdtempSync(join(tmpdir(), "resolve-phrases-"));
    const row = { id: "dup", phrase: "tabs", type: "exact", expect: ["Tabs"] };
    writeFileSync(join(dir, "a.json"), JSON.stringify({ version: 1, cases: [row] }));
    writeFileSync(join(dir, "b.json"), JSON.stringify({ version: 1, cases: [row] }));
    expect(() => loadPhraseCases([dir])).toThrow(/Ids must be unique/);
  });

  it("a wrong-shape phrase file gets one plain line, not a validator dump", () => {
    const dir = mkdtempSync(join(tmpdir(), "resolve-phrases-shape-"));
    writeFileSync(join(dir, "a.json"), JSON.stringify({ version: 2, cases: [{ id: "a", phrase: "tabs" }] }));
    let message = "";
    try {
      loadPhraseCases([dir]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/^Bad phrase file .*a\.json: version: /);
    expect(message).toMatch(/more problem/);
    expect(message).not.toContain("\n");
  });

  it("knows the sample library from any other library", () => {
    expect(isSampleLibrary(fixtureIndex())).toBe(true);
    expect(isSampleLibrary(otherLibraryIndex())).toBe(false);
  });

  it("resolve score phrases uses the team's own phrases only, never mixed with the shipped set", async () => {
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
    const report = JSON.parse(chunks.join("")) as { byType: { type: string }[]; pass: boolean; phrases: number; note?: string };
    expect(report.byType.map((row) => row.type)).toEqual(["team"]);
    expect(report.phrases).toBe(1);
    expect(report.note).toMatch(/team's phrases only/);
    expect(report.pass).toBe(true);
    expect(process.exitCode ?? 0).toBe(0);
  });
  async function cliOut(argv: string[]): Promise<string> {
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runCli(argv);
    } finally {
      process.stdout.write = write;
    }
    return chunks.join("");
  }

  async function storeWith(library: string, fileKey?: string): Promise<string> {
    const store = mkdtempSync(join(tmpdir(), "resolve-phrases-lib-"));
    process.env["RESOLVE_HOME"] = store;
    clearCache();
    await runCli(["ingest", library, "--role", "library", "--name", "Lib", ...(fileKey ? ["--file-key", fileKey] : [])]);
    clearCache();
    return store;
  }

  it("on the sample library with no team phrases, runs the shipped set alone", async () => {
    await storeWith(join(root, "scoreboard", "fixture", "library.json"));
    const report = JSON.parse(await cliOut(["score", "phrases", "--json"])) as { phrases: number; pass: boolean; note?: string };
    expect(report.phrases).toBe(loadPhraseCases([phrasesDir]).length);
    expect(report.note).toMatch(/built-in phrase set on the sample library/);
    expect(report.pass).toBe(true);
  });

  it("on another library with no team phrases, refuses the shipped set instead of giving a misleading score", async () => {
    await storeWith(join(root, "docs", "examples", "acme-ui.json"), "ACMEUI");
    await expect(runCli(["score", "phrases"])).rejects.toThrow(/No team phrases yet\. The built-in phrase set only fits the sample library/);
  });

  it("on another library with team phrases, scores only the team's phrases", async () => {
    const store = await storeWith(join(root, "docs", "examples", "acme-ui.json"), "ACMEUI");
    mkdirSync(join(store, "scoreboard", "phrases"), { recursive: true });
    writeFileSync(
      join(store, "scoreboard", "phrases", "team.json"),
      JSON.stringify({ version: 1, cases: [{ id: "t1", phrase: "choose a payee", type: "team", expect: ["Payee picker"] }] }),
    );
    const report = JSON.parse(await cliOut(["score", "phrases", "--json"])) as {
      phrases: number;
      byType: { type: string }[];
      totals: { top1: number };
    };
    expect(report.phrases).toBe(1);
    expect(report.byType.map((row) => row.type)).toEqual(["team"]);
    expect(report.totals.top1).toBe(1);
  });

  it("routes score --json phrases, score phrase and score Phrases to phrases, and rejects unknown words", async () => {
    await storeWith(join(root, "scoreboard", "fixture", "library.json"));
    for (const argv of [["score", "--json", "phrases"], ["score", "phrase", "--json"], ["score", "Phrases", "--json"]]) {
      const report = JSON.parse(await cliOut(argv)) as { phrases?: number; byType?: unknown };
      expect(report.phrases, argv.join(" ")).toBe(loadPhraseCases([phrasesDir]).length);
    }
    await expect(runCli(["score", "frases"])).rejects.toThrow(/Unknown score option "frases"/);
  });
});
