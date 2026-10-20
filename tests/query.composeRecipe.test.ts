import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SourceDocumentSchema } from "@/core/ingestion/types";
import { buildGraph } from "@/core/transform";
import { composeParts, composeRecipe, indexGraph, starterRecipes, type GraphIndex } from "@/core/query";
import { runCli } from "@/server/cli";
import { callTool, DEFAULT_TOOL_NAMES, ToolError } from "@/server/tools";
import { clearCache, loadRecipes, readSock, saveGraph, saveSock } from "@/server/store";
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
    expect(proposed.proposal).toMatch(/^soci:recipe-update:new-composed-profile-page-[0-9a-f]{8}$/);
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
  describe("r1 findings, by category", () => {
    const compose = (request: string) => composeRecipe({ request, index: indexGraph(fixtureGraph()), recipes: starterRecipes() });

    it("M1: a part that shares only a non-head word is weak, not a fit, also in the one-part answer", () => {
      const out = compose("screen with a price list, a header image and a tag");
      expect(out.recipe).toBeUndefined();
      const card = out.card as Card & { weak?: string[] };
      expect(card.part?.name).toBe("Tag");
      expect(card.weak).toEqual(["price-list: Price (weak, check)", "header-image: Header Bar (weak, check)"]);
      expect(card.hint).toMatch(/^One part fits \(Tag\)/);
      expect(card.hint).toMatch(/Weak, check price-list/);
      const two = compose("screen with a price list, a toast and a tag");
      const slots = (two.card as Card).slots!;
      expect(slots.find((slot) => slot.role === "price-list")).toMatchObject({ status: "weak" });
      expect(two.recipe!.slots.find((slot) => slot.role === "price-list")!.defaultMasterId).toBeUndefined();
      for (const request of ["a save button and a toast", "a payment row and badges", "checkboxes and a switch"]) {
        expect(returned(compose(request).card as Card).length, request).toBe(2);
      }
    });

    it("M2: a different set of parts is a different proposal, and a decided one is refused clearly", async () => {
      saveGraph(fixtureGraph());
      const first = await cliJson(["recipe", "promo page with a banner and a toast", "--compose", "--propose", "--json"]);
      const other = await cliJson(["recipe", "promo page with a banner and a tag", "--compose", "--propose", "--json"]);
      expect(first.proposal).not.toBe(other.proposal);
      const again = await cliJson(["recipe", "promo page with a banner and a toast", "--compose", "--propose", "--json"]);
      expect(again.proposal).toBe(first.proposal);
      expect(again.hint).toMatch(/Already proposed/);
      await cliJson(["reject", first.proposal!, "--who", "Avery", "--json"]);
      const refused = await cliJson(["recipe", "promo page with a banner and a toast", "--compose", "--propose", "--json"]);
      expect(refused.proposal).toBe("none");
      expect(refused.hint).toMatch(/already rejected .*Nothing filed\./);
      await cliJson(["approve", other.proposal!, "--who", "Avery", "--json"]);
      clearCache();
      const saved = loadRecipes().find((recipe) => recipe.id === "composed-promo-page");
      expect(saved?.slots.map((slot) => slot.role)).toEqual(["banner", "tag"]);
      const after = await cliJson(["recipe", "promo page with a banner and a tag", "--compose", "--propose", "--json"]);
      expect(after.proposal).toBe("none");
    });

    it("L1: approve refuses private parts, variants, non-components, no parts, no id and a duplicate title", async () => {
      const graph = fixtureGraph();
      saveGraph(graph);
      const index = indexGraph(graph);
      const byName = (name: string) => index.getNodesByType("MAIN_COMPONENT", "COMPONENT_SET", "FRAME").find((node) => node.name === name)!;
      const privateId = index.getNodesByType("MAIN_COMPONENT", "COMPONENT_SET").find((node) => node.name.startsWith("_"))!.id;
      const variantId = index.getNodesByType("VARIANT")[0]!.id;
      const frameId = index.getNodesByType("FRAME")[0]!.id;
      const tag = byName("Tag").id;
      const bad: Array<[string, object]> = [
        ["private", { id: "composed-a", title: "A", slots: [{ role: "x", required: true, hints: ["x"], defaultMasterId: privateId }] }],
        ["variant inside a set", { id: "composed-b", title: "B", slots: [{ role: "x", required: true, hints: ["x"], defaultMasterId: variantId }] }],
        ["not a library component", { id: "composed-c", title: "C", slots: [{ role: "x", required: true, hints: ["x"], defaultMasterId: frameId }] }],
        ["no parts", { id: "composed-d", title: "D", slots: [] }],
        ["no id", { id: " ", title: "E", slots: [{ role: "x", required: true, hints: ["x"], defaultMasterId: tag }] }],
        ["same id or title", { id: "composed-f", title: "Checkout summary", slots: [{ role: "x", required: true, hints: ["x"], defaultMasterId: tag }] }],
      ];
      const sock = readSock();
      saveSock({
        ...sock,
        proposals: bad.map(([why, recipe], i) => ({
          id: `soci:recipe-update:bad-${i}`,
          createdAt: "2026-01-01T00:00:00.000Z",
          type: "recipe-update" as const,
          status: "pending" as const,
          summary: why,
          evidence: [],
          suggestedNewRecipe: { intentAliases: [], ...recipe } as never,
        })),
      });
      const want = [/is private/, /variant inside a set/, /not a library component/, /no parts/, /no id/, /same id or title/];
      for (const [i, [why]] of bad.entries()) {
        await expect(runCli(["approve", `soci:recipe-update:bad-${i}`, "--who", "Avery"]), why).rejects.toThrow(want[i]!);
      }
    });

    it("L2: parts after a place word are kept, and every part with no fit is listed", () => {
      expect(composeParts("a toast next to the header bar").phrases).toEqual(["toast", "header bar"]);
      expect(composeParts("a badge on the avatar, a tag under a warp gauge").phrases).toEqual(["badge", "avatar", "tag", "warp gauge"]);
      const card = compose("a tag beside a flux gauge").card as Card;
      expect(card.part?.name).toBe("Tag");
      expect(card.noMatch).toEqual(["flux-gauge"]);
      expect(card.hint).toMatch(/No match for flux-gauge/);
      const many = compose("a toast above the header bar below a warp gauge").card as Card;
      expect(returned(many).map((part) => part.name)).toEqual(["Toast", "Header Bar"]);
      expect(many.noMatch).toEqual(["warp-gauge"]);
    });

    it("L3: warns when a saved recipe already covers the screen, and does not propose it", async () => {
      const out = compose("Settings form with a text field and a save button");
      expect((out.card as Card & { duplicates?: string[] }).duplicates).toEqual(["Settings form"]);
      expect(out.card.hint).toMatch(/Warning: saved recipe Settings form already covers this/);
      saveGraph(fixtureGraph());
      const proposed = await cliJson(["recipe", "Settings form with a text field and a save button", "--compose", "--propose", "--json"]);
      expect(proposed.proposal).toBe("none");
    });

    it("L4: an empty request or a non-boolean compose is an error in the CLI and MCP", async () => {
      saveGraph(fixtureGraph());
      for (const argv of [["recipe", "--compose", "--json"], ["recipe", "  ", "--compose", "--json"]]) {
        const json = (await cliJson(argv)) as unknown as { ok: boolean; message: string };
        expect(json, argv.join(" ")).toMatchObject({ ok: false });
        expect(json.message).toMatch(/needs a screen request/);
        expect(process.exitCode).toBe(1);
        process.exitCode = 0;
      }
      process.env["RESOLVE_MCP_ADVANCED"] = "1";
      expect(() => callTool("recipe", { query: "a tag and a chip", compose: "yes" })).toThrow(ToolError);
      expect(() => callTool("recipe", { query: "a tag and a chip", compose: true, propose: 1 })).toThrow(/propose must be true or false/);
      expect(() => callTool("recipe", { compose: true })).toThrow(/needs a screen request/);
      expect(() => callTool("recipe", { query: "", compose: true })).toThrow(ToolError);
    });
  });
});
