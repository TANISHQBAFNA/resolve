import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SourceDocumentSchema } from "@/core/ingestion/types";
import { buildGraph } from "@/core/transform";
import { briefScreen, composeParts, composeRecipe, indexGraph, starterRecipes, type GraphIndex } from "@/core/query";
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
  return (card.slots ?? []).flatMap((slot) => (slot.master && (slot.status === "filled" || slot.status === "bound") ? [slot.master] : []));
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
      context: [],
    });
    expect(composeParts("a header bar, breadcrumbs and a divider")).toEqual({ title: "", phrases: ["header bar", "breadcrumbs", "divider"], context: [] });
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
    expect(DEFAULT_TOOL_NAMES.some((name) => /compose/.test(name))).toBe(false);
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
    await expect(runCli(["recipe", "a tag and a chip", "--propose"])).rejects.toThrow(/propose needs compose/);
    const json = (await cliJson(["recipe", "a tag and a chip", "--propose", "--json"])) as unknown as { ok: boolean; message: string };
    expect(json).toMatchObject({ ok: false, message: "propose needs compose." });
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
  describe("r1 findings, by category", () => {
    const compose = (request: string) => composeRecipe({ request, index: indexGraph(fixtureGraph()), recipes: starterRecipes() });

    it("M1: a part that shares only a non-head word is weak, not a fit, also in the one-part answer", () => {
      const out = compose("screen with a header image, a flux gauge and a tag");
      expect(out.recipe).toBeUndefined();
      const card = out.card as Card & { weak?: string[] };
      expect(card.part?.name).toBe("Tag");
      expect(card.weak).toEqual(["header-image: Header Bar (weak, check)"]);
      expect(card.noMatch).toEqual(["flux-gauge"]);
      expect(card.hint).toMatch(/^One part fits \(Tag\)/);
      expect(card.hint).toMatch(/Weak, check header-image/);
      const two = compose("screen with a header image, a toast and a tag");
      const slots = (two.card as Card).slots!;
      expect(slots.find((slot) => slot.role === "header-image")).toMatchObject({ status: "weak" });
      expect(two.recipe!.slots.find((slot) => slot.role === "header-image")!.defaultMasterId).toBeUndefined();
      for (const request of ["a save button and a toast", "a payment row and badges", "checkboxes and a switch"]) {
        expect(returned(compose(request).card as Card).length, request).toBe(2);
      }
    });

    it("container words (list, group, set) are not the part word: the word before them must match", () => {
      const card = compose("panel with a radio list, an avatar group, a chip set and a price list").card as Card;
      expect(returned(card).map((part) => part.name)).toEqual(["Radio", "Avatar", "Chip", "Price"]);
      const weak = compose("panel with a warp list and a tag").card as Card & { weak?: string[] };
      expect(returned(weak).map((part) => part.name)).toEqual(["Tag"]);
      expect(returned(compose("a list and a tag").card as Card).map((part) => part.name)).toContain("Tag");
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
        ["same id or title", { id: "composed-f", title: "Checkout summary", slots: [{ role: "x", required: true, hints: ["x"], defaultMasterId: tag }, { role: "y", required: true, hints: ["y"], defaultMasterId: byName("Chip").id }] }],
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
      expect(composeParts("a badge beside the avatar, a tag under a warp gauge").phrases).toEqual(["badge", "avatar", "tag", "warp gauge"]);
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
  describe("briefing and compose", () => {
    it("brief offers to compose when no saved recipe fits and two or more parts are named, and never runs it", () => {
      saveGraph(fixtureGraph());
      const index = indexGraph(fixtureGraph());
      const brief = (request: string) => briefScreen({ request, index, recipes: starterRecipes() });
      const offered = brief("profile page with an avatar, a text field and a save button");
      expect(offered.composeOffer).toMatch(/^No saved recipe fits\. .*compose.*Not run\.$/);
      expect(readSock().proposals).toEqual([]);
      for (const request of ["checkout summary", "a tag", "warp drive console with flux gauges and a hologram"]) {
        expect(brief(request).composeOffer, request).toBeUndefined();
      }
      const mcp = callTool("brief", { request: "profile page with an avatar, a text field and a save button" }) as { composeOffer?: string };
      expect(mcp.composeOffer).toBe(offered.composeOffer);
    });

    it("briefing answers fill composed slots with their real parts, the same in CLI and MCP, and bad answers are refused", async () => {
      saveGraph(fixtureGraph());
      const request = "alerts page with a toast and a tag";
      const cli = await cliJson(["recipe", request, "--compose", "--answer", "states=empty", "--answer", "states=error", "--json"]);
      expect(returned(cli).map((part) => part.name)).toEqual(["Toast", "Tag", "Empty Message", "Alert"]);
      process.env["RESOLVE_MCP_ADVANCED"] = "1";
      const mcp = callTool("recipe", { query: request, compose: true, answers: { states: ["empty", "error"] } }) as Card;
      expect(mcp).toEqual(cli);
      const once = composeRecipe({ request: "page with an alert and a tag", answerParts: [{ id: returned(cli)[3]!.id!, name: "Alert" }], index: indexGraph(fixtureGraph()), recipes: starterRecipes() });
      expect(returned(once.card as Card).map((part) => part.name)).toEqual(["Alert", "Tag"]);
      expect(() => callTool("recipe", { query: request, compose: true, answers: { states: "nope" } })).toThrow(ToolError);
      const bad = (await cliJson(["recipe", request, "--compose", "--answer", "goal=pay", "--json"])) as unknown as { ok: boolean };
      expect(bad.ok).toBe(false);
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
    });
  });
  describe("r2 findings, by category", () => {
    const index = () => indexGraph(fixtureGraph());
    const compose = (request: string) => composeRecipe({ request, index: index(), recipes: starterRecipes() });

    it("M1: a fit needs every main word in the name, a variant name or a synonym; a matching head alone is weak", () => {
      for (const [request, weakRole] of [
        ["sheet with a tangerine toast and a tag", "tangerine-toast"],
        ["sheet with a wobbly divider and a tag", "wobbly-divider"],
        ["sheet with a velvet switch and a chip", "velvet-switch"],
      ] as const) {
        const card = compose(request).card as Card & { weak?: string[] };
        expect(card.weak?.[0], request).toMatch(new RegExp(`^${weakRole}: .* \\(weak, check\\)$`));
        expect(card.composed, request).toBe(false);
      }
      const strict = compose("sheet with a save cta, a danger button and a close icon").card as Card;
      expect(returned(strict).map((part) => part.name)).toEqual(["Save CTA", "Button", "Icon Close"]);
    });

    it("L1b: approve refuses a composed recipe with fewer than two parts", async () => {
      const graph = fixtureGraph();
      saveGraph(graph);
      const tag = indexGraph(graph).getNodesByType("MAIN_COMPONENT", "COMPONENT_SET").find((node) => node.name === "Tag")!.id;
      saveSock({
        ...readSock(),
        proposals: [{
          id: "soci:recipe-update:trimmed",
          createdAt: "2026-01-01T00:00:00.000Z",
          type: "recipe-update",
          status: "pending",
          summary: "trimmed",
          evidence: [],
          suggestedNewRecipe: { id: "composed-trimmed", title: "Trimmed", intentAliases: [], slots: [{ role: "tag", required: true, hints: ["tag"], defaultMasterId: tag }, { role: "gone", required: false, hints: ["gone"] }] },
        }],
      });
      await expect(runCli(["approve", "soci:recipe-update:trimmed", "--who", "Avery"])).rejects.toThrow(/needs 2 or more parts; this one has 1/);
    });

    it("L5: on/in phrases are context, not parts, and the card says so", () => {
      expect(composeParts("a toast and a tag on mobile")).toMatchObject({ phrases: ["toast", "tag"], context: ["on mobile"] });
      expect(composeParts("kiosk with a chip in the lobby and a switch inside the settings drawer")).toMatchObject({ phrases: ["chip", "switch"], context: ["in the lobby", "inside the settings drawer"] });
      const card = compose("a toast and a tag on a smart fridge").card as Card & { readAsContext?: string[] };
      expect(returned(card).map((part) => part.name)).toEqual(["Toast", "Tag"]);
      expect(card.readAsContext).toEqual(["on a smart fridge"]);
      expect(card.noMatch).toBeUndefined();
      expect(card.hint).toMatch(/Read as context, not parts: on a smart fridge\./);
    });

    it("L6: a container of X takes X", () => {
      expect(composeParts("a set of chips and a group of avatars").phrases).toEqual(["chips", "avatars"]);
      expect(composeParts("drawer with a stack of toasts, a collection of tags").phrases).toEqual(["toasts", "tags"]);
      expect(returned(compose("a set of chips and a list of badges").card as Card).map((part) => part.name)).toEqual(["Chip", "Badge"]);
    });

    it("L7: brief and compose agree when a saved recipe already covers the parts", () => {
      const graph = fixtureGraph();
      saveGraph(graph);
      const request = "Settings form with a text field and a save button";
      const composeSays = compose(request).card as Card & { duplicates?: string[] };
      expect(composeSays.duplicates).toEqual(["Settings form"]);
      const brief = briefScreen({ request, index: index(), recipes: starterRecipes() });
      expect(brief.composeOffer).toBeUndefined();
      expect(brief.savedRecipe).toMatch(/^Saved recipe Settings form already covers this/);
      const fresh = briefScreen({ request: "lounge with a chip, a switch and a badge", index: index(), recipes: starterRecipes() });
      expect(fresh.composeOffer).toMatch(/^No saved recipe fits/);
      expect(fresh.savedRecipe).toBeUndefined();
      expect((compose("lounge with a chip, a switch and a badge").card as Card & { duplicates?: string[] }).duplicates).toBeUndefined();
    });
  });
});
