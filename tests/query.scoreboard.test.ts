import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SourceDocumentSchema } from "@/core/ingestion/types";
import { buildGraph } from "@/core/transform";
import { indexGraph } from "@/core/query";
import {
  formatScoreTable,
  inventsInCard,
  loadGoldenCases,
  resolveMasterByName,
  scoreExitCode,
  scoreGraph,
  deltaAgainst,
} from "@/core/query/scoreboard";
import { runCli } from "@/server/cli";
import { clearCache } from "@/server/store";
import {
  readScoreHistory,
  scoreboardHistoryDir,
  scoreboardView,
  scoreboardWorkspaceName,
  writeScoreHistory,
} from "@/server/scoreboardView";

const root = fileURLToPath(new URL("..", import.meta.url));
const goldenDir = join(root, "scoreboard", "golden");

function fixtureIndex() {
  const raw: unknown = JSON.parse(readFileSync(join(root, "scoreboard", "fixture", "library.json"), "utf8"));
  const source = SourceDocumentSchema.parse(raw);
  return indexGraph(buildGraph(source, { builtAt: "2026-01-01T00:00:00.000Z" }));
}

describe("scoreboard", () => {
  const previousHome = process.env["HOME"];
  const previousWorkspace = process.env["RESOLVE_WORKSPACE"];
  const previousGraphify = process.env["GRAPHIFY_HOME"];
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "resolve-score-home-"));
    process.env["HOME"] = home;
    process.env["RESOLVE_WORKSPACE"] = "fixture";
    delete process.env["GRAPHIFY_HOME"];
    clearCache();
  });

  afterEach(() => {
    clearCache();
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
    if (previousWorkspace === undefined) delete process.env["RESOLVE_WORKSPACE"];
    else process.env["RESOLVE_WORKSPACE"] = previousWorkspace;
    if (previousGraphify === undefined) delete process.env["GRAPHIFY_HOME"];
    else process.env["GRAPHIFY_HOME"] = previousGraphify;
    process.exitCode = undefined;
  });

  it("loads 60 or more golden cases and resolves every named master", () => {
    const cases = loadGoldenCases(goldenDir);
    expect(cases.length).toBeGreaterThanOrEqual(60);
    const kinds = {
      exact: cases.filter((row) => row.id.startsWith("exact-")).length,
      synonym: cases.filter((row) => row.id.startsWith("syn-")).length,
      context: cases.filter((row) => row.id.startsWith("ctx-")).length,
      cousin: cases.filter((row) => row.id.startsWith("cousin-")).length,
      deprecated: cases.filter((row) => row.id.startsWith("dep-")).length,
      private: cases.filter((row) => row.id.startsWith("priv-")).length,
      empty: cases.filter((row) => row.expect === "empty").length,
    };
    expect(kinds.exact).toBeGreaterThan(0);
    expect(kinds.synonym).toBeGreaterThan(0);
    expect(kinds.context).toBeGreaterThan(0);
    expect(kinds.cousin).toBeGreaterThan(0);
    expect(kinds.deprecated).toBeGreaterThan(0);
    expect(kinds.private).toBeGreaterThan(0);
    expect(kinds.empty).toBeGreaterThanOrEqual(12);
    const index = fixtureIndex();
    for (const row of cases) {
      if (row.expected) expect(resolveMasterByName(index, row.expected).id).toMatch(/^node:/);
      for (const name of [...(row.accept ?? []), ...(row.mustNot ?? [])]) {
        expect(resolveMasterByName(index, name).name).toBe(name);
      }
    }
  });

  it("refuses to invent an id when the expected name is missing", () => {
    const index = fixtureIndex();
    expect(() => resolveMasterByName(index, "Made Up Widget")).toThrow(/not invent/i);
  });

  it("flags a card id that is not in the graph", () => {
    const index = fixtureIndex();
    const invented = inventsInCard(
      { candidates: [{ id: "node:not-real", name: "Pay CTA" }] },
      index,
    );
    expect(invented.some((row) => row.includes("node:not-real"))).toBe(true);
    const known = resolveMasterByName(index, "Pay CTA");
    expect(inventsInCard({ candidates: [{ id: known.id, name: known.name }] }, index)).toEqual([]);
    const frame = index.allNodes.find((node) => node.type === "FRAME" && node.name);
    expect(frame).toBeTruthy();
    const frameName = inventsInCard({ candidates: [{ id: frame!.id, name: frame!.name }] }, index);
    expect(frameName.some((row) => row.includes(frame!.name))).toBe(true);
    expect(inventsInCard({ candidates: [{ whereUsed: [{ name: frame!.name }] }] }, index)).toEqual([]);
    expect(inventsInCard({ found: false, why: "see node:not-real" }, index).some((row) => row.includes("node:not-real"))).toBe(
      true,
    );
  });

  it("scores the fixture golden set with invent rate 0 and writes a delta", () => {
    const index = fixtureIndex();
    const cases = loadGoldenCases(goldenDir);
    const first = scoreGraph(index, cases, {
      at: "2026-09-27T00:00:00.000Z",
      workspaceName: "fixture",
      golden: goldenDir,
    });
    expect(first.cases).toBe(cases.length);
    expect(first.inventCount).toBe(0);
    expect(first.inventRate).toBe(0);
    expect(first.budgetBreach).toBe(false);
    expect(first.pass).toBe(true);
    expect(first.tools.every((tool) => tool.sizeMax <= tool.budget)).toBe(true);
    expect(first.tools.map((tool) => tool.tool)).toEqual(["recommend", "resolve", "recipe", "verify"]);
    for (const tool of first.tools) {
      expect(tool.budget).toBeGreaterThan(0);
      expect(tool.sizeMax).toBeGreaterThan(0);
    }
    const dir = scoreboardHistoryDir("fixture");
    writeScoreHistory(dir, first);
    const second = scoreGraph(index, cases, {
      at: "2026-09-27T01:00:00.000Z",
      workspaceName: "fixture",
      golden: goldenDir,
    });
    const delta = deltaAgainst(second, readScoreHistory(dir).at(-1));
    expect(delta.hasPrevious).toBe(true);
    const table = formatScoreTable(second, delta);
    expect(table).toMatch(/Invent rate: 0%/);
    expect(table).toMatch(/Result: pass/);
    expect(table).toMatch(/recommend/);
    expect(table).toMatch(/on screen cases/);
    expect(table).toMatch(/n\/a \(N=0\)/);
    expect(table).not.toMatch(/n\/a \(1 candidate\)/);
    expect(table).toMatch(/Run top-1: \d+\/\d+ \(verify excluded\)/);
    expect(table).toMatch(/Compared with/);
    const compared = table.split("\n").find((line) => line.startsWith("Compared"));
    expect(compared).toBeTruthy();
    expect(compared).not.toMatch(/top-3/);
    const recipe = second.tools.find((tool) => tool.tool === "recipe");
    const recommend = second.tools.find((tool) => tool.tool === "recommend");
    const resolveTool = second.tools.find((tool) => tool.tool === "resolve");
    const verify = second.tools.find((tool) => tool.tool === "verify");
    expect(recipe?.scored).toBe(3);
    expect(recipe?.top1Count).toBe(3);
    expect(recipe?.emptyWhenWeak).toBeNull();
    expect(verify?.emptyWhenWeak).toBeNull();
    expect(recipe?.top3Base).toBe(0);
    expect(recommend?.scored).toBe(54);
    expect(recommend?.top1Count).toBe(54);
    expect(recommend?.top3Base).toBe(9);
    expect(recommend?.top3Count).toBe(9);
    expect(recommend?.candidatesMax).toBeGreaterThanOrEqual(3);
    expect(recommend?.emptyWhenWeak).toBe(1);
    expect(recommend?.wrongCousinRate).toBe(0);
    expect(recommend?.leakRate).toBe(0);
    expect(resolveTool?.scored).toBe(57);
    expect(resolveTool?.top1Count).toBe(57);
    expect(resolveTool?.leakRate).toBe(0);
    expect(resolveTool?.emptyWhenWeak).toBe(1);
    expect(second.top1Count).toBe((recommend?.top1Count ?? 0) + (resolveTool?.top1Count ?? 0) + (recipe?.top1Count ?? 0));
    expect(second.top1Base).toBe((recommend?.scored ?? 0) + (resolveTool?.scored ?? 0) + (recipe?.scored ?? 0));
    expect(second.top1Base).toBe(114);
    expect(second.top1Count).toBe(114);
    expect(verify?.scored).toBeGreaterThan(0);
    expect(second.top3Base).toBe(9);
    expect(second.top3Base).toBeLessThan(10);
    const recipeLine = table.split("\n").find((line) => line.startsWith("recipe"));
    expect(recipeLine).toMatch(/recipe\s+3\/3\s+n\/a \(N=0\)\s+n\/a\s+/);
    const verifyLine = table.split("\n").find((line) => line.startsWith("verify"));
    expect(verifyLine).toMatch(/n\/a \(N=0\)\s+n\/a\s+/);
    expect(second.misses).toEqual([]);
    expect(second.misses.filter((row) => row.id === "dep-legacy-banner-exact" && row.tool === "resolve")).toEqual([]);
    expect(second.misses.filter((row) => row.id === "priv-note" && row.tool === "resolve")).toEqual([]);
    const cold = deltaAgainst(first);
    expect(cold.hasPrevious).toBe(false);
    expect(cold.top1).toBeNull();
    expect(cold.top3).toBeNull();
    expect(cold.inventRate).toBeNull();
    expect(cold.wrongCousinRate).toBeNull();
    expect(cold.emptyWhenWeak).toBeNull();
    expect(cold.leakRate).toBeNull();
    const otherHash = { ...first, goldenHash: "different-set" };
    const mismatched = deltaAgainst(second, otherHash);
    expect(mismatched.hasPrevious).toBe(false);
    expect(mismatched.top1).toBeNull();
    expect(mismatched.inventRate).toBeNull();
    expect(scoreExitCode(first)).toBe(0);
    const page = scoreboardView();
    expect(page.workspace).toBe("fixture");
    expect(page.latest?.cases).toBe(cases.length);
    expect(page.trend).toHaveLength(1);
    writeScoreHistory(dir, { ...first, at: "2026-09-26T00:00:00.000Z", goldenHash: "other-set" });
    const mixed = scoreboardView();
    expect(mixed.trend.every((point) => point.goldenHash === second.goldenHash)).toBe(true);
    expect(mixed.trend.some((point) => point.goldenHash === "other-set")).toBe(false);
    expect(scoreboardView({ HOME: home }, "..").status).toBe(400);
    expect(JSON.stringify(page)).not.toMatch(/"nodes"\s*:/);
    expect(page.workspace).toBe("fixture");
    expect(page.workspaces.some((row) => row.name === "fixture")).toBe(true);
  });

  it("counts a marked recipe case with no card as a miss", () => {
    const index = fixtureIndex();
    const cases = loadGoldenCases(goldenDir).filter(
      (row) => Array.isArray(row.tools) && row.tools.includes("recipe"),
    );
    expect(cases.map((row) => row.id).sort()).toEqual([
      "ctx-recipe-checkout",
      "ctx-recipe-empty",
      "ctx-recipe-sign-in",
    ]);
    const broken = scoreGraph(index, cases, { recipes: [] });
    const recipe = broken.tools.find((tool) => tool.tool === "recipe");
    expect(recipe?.scored).toBe(3);
    expect(recipe?.top1Count).toBe(0);
    expect(broken.misses.filter((row) => row.tool === "recipe" && row.kind === "top1")).toHaveLength(3);
    const unmarked = scoreGraph(index, [
      {
        id: "not-a-recipe",
        intent: "checkout summary",
        slot: "primary-cta",
        expected: "Pay CTA",
        expect: "master",
      },
    ]);
    expect(unmarked.tools.find((tool) => tool.tool === "recipe")?.scored).toBe(0);
  });

  it("rejects workspace names that escape ~/.resolve", () => {
    expect(() => scoreboardHistoryDir("..", { HOME: home })).toThrow(/not allowed/);
    expect(() => scoreboardHistoryDir(".", { HOME: home })).toThrow(/not allowed/);
    expect(() => scoreboardHistoryDir("foo/bar", { HOME: home })).toThrow(/not allowed/);
    expect(() => scoreboardWorkspaceName({ RESOLVE_WORKSPACE: ".." })).toThrow(/not allowed/);
    expect(scoreboardHistoryDir("fixture", { HOME: home })).toBe(join(home, ".resolve", "fixture", "scoreboard"));
  });

  it("resolve score --workspace .. does not leave ~/.resolve", async () => {
    await expect(runCli(["score", "--workspace", "..", "--golden", goldenDir])).rejects.toThrow(/not allowed/);
    expect(existsSync(join(home, "scoreboard"))).toBe(false);
  });

  it("resolve score exits non-zero only for invent or a budget breach", async () => {
    const store = mkdtempSync(join(tmpdir(), "resolve-score-store-"));
    process.env["GRAPHIFY_HOME"] = store;
    clearCache();
    await runCli([
      "ingest",
      join(root, "scoreboard", "fixture", "library.json"),
      "--role",
      "library",
      "--name",
      "Scoreboard fixture",
    ]);
    clearCache();
    await runCli(["score", "--golden", goldenDir, "--workspace", "fixture", "--json"]);
    const history = readScoreHistory(scoreboardHistoryDir("fixture"));
    expect(history).toHaveLength(1);
    expect(history[0]?.inventCount).toBe(0);
    expect(history[0]?.pass).toBe(true);
    expect(process.exitCode ?? 0).toBe(0);
  });
});
