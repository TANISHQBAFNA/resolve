import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SourceDocumentSchema } from "@/core/ingestion/types";
import { buildGraph } from "@/core/transform";
import { composeParts, composeRecipe, indexGraph, starterRecipes, type GraphIndex } from "@/core/query";
import { runCli } from "@/server/cli";
import { callTool, DEFAULT_TOOL_NAMES } from "@/server/tools";
import { clearCache, loadRecipes, readSock, saveGraph } from "@/server/store";
import set from "../scoreboard/compose/acme.json";

const root = fileURLToPath(new URL("..", import.meta.url));

function fixtureGraph() {
  const raw: unknown = JSON.parse(readFileSync(join(root, "scoreboard/fixture/library.json"), "utf8"));
  return buildGraph(SourceDocumentSchema.parse(raw), { builtAt: "2026-01-01T00:00:00.000Z" });
}

type Card = {
  found: boolean;
  composed: boolean;
  slots?: Array<{ role: string; status: string; master?: { id: string; name: string } }>;
  part?: { name: string };
  noMatch?: string[];
  proposal?: string;
  compose?: string;
  hint: string;
};

/** Returned names, from filled slots or the single part. */
function returned(card: Card): Array<{ id?: string; name: string }> {
  if (card.part) return [card.part];
  return (card.slots ?? []).flatMap((slot) => (slot.master && slot.status === "filled" ? [slot.master] : []));
}

/** Strict: the returned part has the expected name. A set returned for a variant ask is a miss. */
function hit(_index: GraphIndex, expected: string, got: { id?: string; name: string }): boolean {
  return got.name === expected;
}

async function cliJson(argv: string[]): Promise<Card> {
  const writes: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await runCli(argv);
  } finally {
    process.stdout.write = write;
  }
  return JSON.parse(writes.join("")) as Card;
}

describe("composed recipes", () => {
  const previousHome = process.env["RESOLVE_HOME"];
  const previousAdvanced = process.env["RESOLVE_MCP_ADVANCED"];

  beforeEach(() => {
    process.env["RESOLVE_HOME"] = mkdtempSync(join(tmpdir(), "resolve-compose-"));
    clearCache();
  });

  afterEach(() => {
    clearCache();
    if (previousHome === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previousHome;
    if (previousAdvanced === undefined) delete process.env["RESOLVE_MCP_ADVANCED"];
    else process.env["RESOLVE_MCP_ADVANCED"] = previousAdvanced;
  });

  it("splits a request into the screen name and one phrase per named part", () => {
    expect(composeParts("checkout with a radio list for delivery and a footer bar")).toEqual({
      title: "checkout",
      phrases: ["radio list", "footer bar"],
    });
    expect(composeParts("a header bar, breadcrumbs and a divider")).toEqual({ title: "", phrases: ["header bar", "breadcrumbs", "divider"] });
  });

  it("measures slot precision and recall on the fresh set, tune and held-out apart, and never invents", () => {
    const graph = fixtureGraph();
    const index = indexGraph(graph);
    const live = new Set(index.getNodesByType("COMPONENT_SET", "MAIN_COMPONENT").filter((node) => node.status !== "deprecated").map((node) => node.id));
    const measured: Record<string, { cases: number; returned: number; right: number; expected: number; found: number; composedOk: number; noMatchOk: number; noMatchCases: number; invented: number }> = {};
    for (const row of set.cases) {
      const card = composeRecipe({ request: row.request, index, recipes: starterRecipes() }).card as Card;
      const got = returned(card);
      const m = (measured[row.split] ??= { cases: 0, returned: 0, right: 0, expected: 0, found: 0, composedOk: 0, noMatchOk: 0, noMatchCases: 0, invented: 0 });
      m.cases += 1;
      m.returned += got.length;
      m.right += got.filter((part) => row.expect.some((name) => hit(index, name, part))).length;
      m.expected += row.expect.length;
      m.found += row.expect.filter((name) => got.some((part) => hit(index, name, part))).length;
      m.invented += got.filter((part) => !part.id || !live.has(part.id)).length;
      if (card.composed === row.composed) m.composedOk += 1;
      if (!row.expect.length) {
        m.noMatchCases += 1;
        if (!got.length && card.hint.startsWith("No match.")) m.noMatchOk += 1;
      }
    }
    expect(measured).toEqual(set.measured);
    for (const m of Object.values(measured)) expect(m.invented).toBe(0);
  });

  it("needs two filled parts, and keeps an empty slot as No match with no id", () => {
    const index = indexGraph(fixtureGraph());
    const one = composeRecipe({ request: "a tag", index, recipes: starterRecipes() });
    expect(one.recipe).toBeUndefined();
    expect(one.card).toMatchObject({ found: false, composed: false, part: { name: "Tag" } });
    const mixed = composeRecipe({ request: "panel with a tag, a switch and a flux gauge", index, recipes: starterRecipes() });
    expect(mixed.card).toMatchObject({ composed: true, saved: false, noMatch: ["flux-gauge"] });
    const empty = mixed.recipe!.slots.find((slot) => slot.role === "flux-gauge")!;
    expect(empty).toEqual({ role: "flux-gauge", required: false, hints: ["flux", "gauge"] });
    const saved = composeRecipe({ request: "checkout summary", index, recipes: starterRecipes() });
    expect(saved.card).toMatchObject({ composed: false, recipe: { id: "checkout-summary" } });
  });

  it("gives the same card from the CLI and from MCP, only in advanced mode, and saves only after a person approves", async () => {
    saveGraph(fixtureGraph());
    const request = "profile page with an avatar, a text field and a save button";
    const cli = await cliJson(["recipe", request, "--compose", "--json"]);
    process.env["RESOLVE_MCP_ADVANCED"] = "1";
    const mcp = callTool("recipe", { query: request, compose: true }) as Card;
    expect(mcp).toEqual(cli);
    expect(returned(cli).map((part) => part.name)).toEqual(["Avatar", "Text Field", "Save CTA"]);

    delete process.env["RESOLVE_MCP_ADVANCED"];
    expect(DEFAULT_TOOL_NAMES).toHaveLength(7);
    const plain = callTool("recipe", { query: request, compose: true }) as Card;
    expect(plain.composed).toBeUndefined();
    expect(plain.compose).toMatch(/advanced/);

    const proposed = await cliJson(["recipe", request, "--compose", "--propose", "--json"]);
    expect(proposed.proposal).toMatch(/^soci:recipe-update:new-composed-profile-page$/);
    expect(loadRecipes().some((recipe) => recipe.id === "composed-profile-page")).toBe(false);
    expect(readSock().proposals.find((row) => row.id === proposed.proposal)?.status).toBe("pending");

    await cliJson(["approve", proposed.proposal!, "--who", "Avery", "--json"]);
    clearCache();
    const recipe = loadRecipes().find((row) => row.id === "composed-profile-page");
    expect(recipe?.slots.map((slot) => slot.defaultMasterId)).toEqual(returned(cli).map((part) => part.id));
    const again = await cliJson(["recipe", request, "--compose", "--json"]);
    expect(again).toMatchObject({ composed: false, recipe: { id: "composed-profile-page" } });
  });

  it("refuses --propose without --compose, and prints ok:false JSON", async () => {
    saveGraph(fixtureGraph());
    await expect(runCli(["recipe", "a tag and a chip", "--propose"])).rejects.toThrow(/--compose/);
    const json = (await cliJson(["recipe", "a tag and a chip", "--propose", "--json"])) as unknown as { ok: boolean; message: string };
    expect(json).toMatchObject({ ok: false, message: "--propose needs --compose." });
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});
