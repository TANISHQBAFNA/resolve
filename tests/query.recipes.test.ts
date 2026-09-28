import { describe, expect, it } from "vitest";
import type { DesignGraph } from "@/core/model";
import {
  fillRecipe,
  indexGraph,
  capRecipePayload,
  listRecipes,
  matchRecipe,
  RECIPE_RESPONSE_BUDGET,
  mergeRecipes,
  parseRecipeFile,
  recipeCard,
  starterRecipes,
} from "@/core/query";
import { ids, index as demo } from "./fixture";

const sampleFile = {
  version: 1,
  recipes: [
    {
      id: "checkout-summary",
      title: "Checkout summary",
      intentAliases: ["checkout", "order summary", "pay now"],
      notes: "Header, line list, primary CTA, optional input.",
      slots: [
        { role: "header", required: false, hints: ["header", "title"] },
        { role: "line-list", required: true, hints: ["payment", "row", "list"] },
        { role: "primary-cta", required: true, hints: ["button", "primary"] },
        { role: "input", required: false, hints: ["input"] },
      ],
    },
    {
      id: "sign-in",
      title: "Sign in",
      intentAliases: ["login", "auth", "log in"],
      slots: [{ role: "primary-cta", required: true, hints: ["button"] }],
    },
  ],
};

describe("recipe load", () => {
  it("parses a designer JSON pack and ignores unknown keys", () => {
    const recipes = parseRecipeFile({
      ...sampleFile,
      howToAdd: "edit this file",
      extra: true,
    });
    expect(recipes).toHaveLength(2);
    expect(recipes[0]?.id).toBe("checkout-summary");
    expect(recipes[0]?.slots).toHaveLength(4);
    expect(recipes[0]?.slots[2]?.required).toBe(true);
    expect(recipes[0]?.slots[0]?.required).toBe(false);
  });

  it("rejects invented empty packs rather than crashing", () => {
    expect(parseRecipeFile({})).toEqual([]);
    expect(parseRecipeFile({ recipes: "nope" })).toEqual([]);
    expect(parseRecipeFile(null)).toEqual([]);
  });

  it("ships a starter set designers can edit without code", () => {
    const recipes = starterRecipes();
    expect(recipes.length).toBeGreaterThanOrEqual(4);
    expect(recipes.length).toBeLessThanOrEqual(9);
    const ids = new Set(recipes.map((recipe) => recipe.id));
    expect(ids.has("checkout-summary")).toBe(true);
    expect(ids.has("sign-in")).toBe(true);
    expect(ids.has("search-results")).toBe(true);
    const search = recipes.find((recipe) => recipe.id === "search-results");
    expect(search?.slots.map((slot) => slot.role)).toEqual(
      expect.arrayContaining(["search", "results", "empty"]),
    );
    const checkout = recipes.find((recipe) => recipe.id === "checkout-summary");
    expect(checkout?.slots.find((slot) => slot.role === "primary-cta")?.defaultMasterId).toBe("Pay CTA");
    for (const recipe of recipes) {
      expect(recipe.slots.length).toBeGreaterThan(0);
      for (const slot of recipe.slots) {
        if (recipe.id === "checkout-summary" && slot.role === "primary-cta") continue;
        expect(slot.defaultMasterId).toBeUndefined();
      }
    }
  });

  it("overlays a designer file by id without dropping the starter pack", () => {
    const merged = mergeRecipes(
      starterRecipes(),
      parseRecipeFile({
        recipes: [
          {
            id: "checkout-summary",
            title: "Checkout (local)",
            slots: [{ role: "primary-cta", required: true, hints: ["button"] }],
          },
          {
            id: "custom-pack",
            title: "Custom pack",
            slots: [{ role: "badge", required: false, hints: ["badge"] }],
          },
        ],
      }),
    );
    expect(merged.find((recipe) => recipe.id === "checkout-summary")?.title).toBe("Checkout (local)");
    expect(merged.some((recipe) => recipe.id === "sign-in")).toBe(true);
    expect(merged.some((recipe) => recipe.id === "custom-pack")).toBe(true);
  });
});

describe("recipe list + match by intent", () => {
  const recipes = parseRecipeFile(sampleFile);

  it("lists id, title, aliases, and unbound nextRecommend without inventing ids", () => {
    const listed = listRecipes(recipes);
    expect(listed.recipes.map((row) => row.id)).toEqual(["checkout-summary", "sign-in"]);
    expect(listed.recipes[0]?.title).toBe("Checkout summary");
    expect(listed.recipes[0]?.slots.map((slot) => slot.role)).toContain("primary-cta");
    expect(listed.recipes[0]?.slots.every((slot) => slot.status === "unbound")).toBe(true);
    expect(listed.recipes[0]?.slots.every((slot) => !slot.master)).toBe(true);
    expect(listed.recipes[0]?.slots.find((slot) => slot.role === "primary-cta")?.nextRecommend).toMatch(
      /button/i,
    );
    expect(listed.hint).toMatch(/Do not invent node ids/);
  });

  it("matches by id, title, alias, and loose intent", () => {
    expect(matchRecipe(recipes, "checkout-summary")?.id).toBe("checkout-summary");
    expect(matchRecipe(recipes, "Checkout summary")?.id).toBe("checkout-summary");
    expect(matchRecipe(recipes, "pay now")?.id).toBe("checkout-summary");
    expect(matchRecipe(recipes, "I need a login screen")?.id).toBe("sign-in");
    expect(matchRecipe(recipes, "quantum flux")).toBeUndefined();
  });

  it("routes search-results intents away from empty-state, keeps no-results on empty-state", () => {
    const recipes = starterRecipes();
    expect(matchRecipe(recipes, "search results list")?.id).toBe("search-results");
    expect(matchRecipe(recipes, "search results")?.id).toBe("search-results");
    expect(matchRecipe(recipes, "no results")?.id).toBe("empty-state");
    expect(matchRecipe(recipes, "empty state")?.id).toBe("empty-state");
  });
});

describe("recipe slot fill", () => {
  it("fills unbound slots through the recommend ranking path", () => {
    const recipes = parseRecipeFile(sampleFile);
    const recipe = matchRecipe(recipes, "checkout summary")!;
    const filled = fillRecipe(demo, recipe);

    const line = filled.slots.find((slot) => slot.role === "line-list");
    const cta = filled.slots.find((slot) => slot.role === "primary-cta");
    const input = filled.slots.find((slot) => slot.role === "input");

    expect(line?.status).toBe("filled");
    expect(line?.master?.id).toBe(ids.paymentRow);
    expect(line?.master?.figmaNodeId).toBeTruthy();

    expect(cta?.status).toBe("filled");
    expect(cta?.master?.id).toBeDefined();
    expect(["COMPONENT_SET", "MAIN_COMPONENT", "VARIANT"]).toContain(cta?.master?.type);
    expect(demo.getNode(cta!.master!.id)).toBeDefined();
    expect(cta?.master?.deprecated).toBe(false);

    expect(input?.master?.id).toBe(ids.inputSet);
    expect(filled.slots.every((slot) => slot.master?.figmaNodeId || slot.status === "unbound")).toBe(
      true,
    );
  });

  it("returns a stored master when the bound id is still live in the graph", () => {
    const recipe = parseRecipeFile({
      recipes: [
        {
          id: "bound-cta",
          title: "Bound CTA",
          slots: [
            {
              role: "primary-cta",
              required: true,
              hints: ["button"],
              defaultMasterId: ids.buttonPrimaryLarge,
            },
          ],
        },
      ],
    })[0]!;
    const filled = fillRecipe(demo, recipe);
    expect(filled.slots[0]?.status).toBe("bound");
    expect(filled.slots[0]?.master?.id).toBe(ids.buttonPrimaryLarge);
    expect(filled.slots[0]?.master?.figmaNodeId).toBeTruthy();
    expect(filled.slots[0]?.master?.deprecated).toBe(false);
  });

  it("flags missing and deprecated bound masters without inventing ids", () => {
    const recipe = parseRecipeFile({
      recipes: [
        {
          id: "broken-pack",
          title: "Broken pack",
          slots: [
            {
              role: "primary-cta",
              required: true,
              hints: ["button"],
              defaultMasterId: "node:does-not-exist",
            },
            {
              role: "message",
              required: true,
              hints: ["banner"],
              defaultMasterId: ids.banner,
            },
          ],
        },
      ],
    })[0]!;
    const filled = fillRecipe(demo, recipe);
    const missing = filled.slots.find((slot) => slot.role === "primary-cta");
    const deprecated = filled.slots.find((slot) => slot.role === "message");

    expect(missing?.status).toBe("missing");
    expect(missing?.master).toBeUndefined();
    expect(missing?.nextRecommend).toMatch(/button/i);

    expect(deprecated?.status).toBe("deprecated");
    expect(deprecated?.master?.id).toBe(ids.banner);
    expect(deprecated?.master?.deprecated).toBe(true);
    expect(deprecated?.nextRecommend).toBeTruthy();
  });

  it("recipeCard looks up by intent and tells the agent where to recommend next", () => {
    const card = recipeCard(parseRecipeFile(sampleFile), "order summary", demo);
    expect(card.found).toBe(true);
    if (!card.found) return;
    expect(card.recipe.id).toBe("checkout-summary");
    expect(card.slots.some((slot) => slot.master?.figmaNodeId)).toBe(true);
    expect(card.hint).toMatch(/verify_frame/);
    expect(card.hint).toMatch(/Do not Read graph\.json/);
    expect(card.cost.chars).toBeLessThan(1200);
    for (const slot of card.slots) {
      if (!slot.master) continue;
      expect(Object.keys(slot.master).sort()).toEqual(
        expect.arrayContaining(["id", "name", "fileKey", "status", "hint"]),
      );
      expect(slot.master).not.toHaveProperty("variantProperties");
      expect(slot.master).not.toHaveProperty("set");
      expect("hints" in slot).toBe(false);
    }
  });

  it("recipeCard without a graph leaves slots unbound instead of inventing nodes", () => {
    const card = recipeCard(parseRecipeFile(sampleFile), "checkout");
    expect(card.found).toBe(true);
    if (!card.found) return;
    expect(card.slots.every((slot) => slot.status === "unbound")).toBe(true);
    expect(card.slots.every((slot) => !slot.master)).toBe(true);
    expect(card.slots[2]?.nextRecommend).toMatch(/button/i);
  });

  it("listRecipes binds live masters after ingest and keeps overlay ids", () => {
    const overlay = parseRecipeFile({
      recipes: [
        {
          id: "checkout-summary",
          title: "Checkout summary",
          intentAliases: ["checkout"],
          slots: [
            {
              role: "primary-cta",
              required: true,
              hints: ["button"],
              defaultMasterId: ids.buttonPrimaryLarge,
            },
            { role: "line-list", required: true, hints: ["payment", "row"] },
          ],
        },
      ],
    });
    const listed = listRecipes(mergeRecipes(parseRecipeFile(sampleFile), overlay), demo);
    const checkout = listed.recipes.find((row) => row.id === "checkout-summary");
    const cta = checkout?.slots.find((slot) => slot.role === "primary-cta");
    const line = checkout?.slots.find((slot) => slot.role === "line-list");

    expect(cta?.status).toBe("bound");
    expect(cta?.master?.id).toBe(ids.buttonPrimaryLarge);
    expect(cta?.master?.figmaNodeId).toBeTruthy();
    expect(cta?.nextRecommend).toBeUndefined();

    expect(line?.status).toBe("filled");
    expect(line?.master?.id).toBe(ids.paymentRow);
    expect(line?.master?.figmaNodeId).toBeTruthy();
    expect(listed.hint).toMatch(/Overlay/);
  });

  it("does not fill a header slot with a private .Header master", () => {
    const graph: DesignGraph = {
      fileKey: "M3",
      fileName: "Material",
      builtAt: "2026-01-01T00:00:00.000Z",
      source: { kind: "mock", ingestedAt: "2026-01-01T00:00:00.000Z" },
      warnings: [],
      nodes: [
        { id: "file:M3", type: "FILE", name: "Material", fileKey: "M3" },
        { id: "node:p", type: "PAGE", name: "App", parentId: "file:M3", pageId: "node:p", fileKey: "M3" },
        {
          id: "node:dot",
          type: "MAIN_COMPONENT",
          name: ".Header",
          parentId: "node:p",
          pageId: "node:p",
          figmaNodeId: "4:10",
          fileKey: "M3",
          isMainComponent: true,
        },
      ],
      edges: [
        { id: "CONTAINS|file:M3|node:p", source: "file:M3", target: "node:p", type: "CONTAINS" },
        { id: "CONTAINS|node:p|node:dot", source: "node:p", target: "node:dot", type: "CONTAINS" },
      ],
    };
    const recipe = parseRecipeFile(sampleFile).find((row) => row.id === "checkout-summary")!;
    const filled = fillRecipe(indexGraph(graph), recipe);
    const header = filled.slots.find((slot) => slot.role === "header");
    expect(header?.master?.name).not.toBe(".Header");
    expect(header?.status).toBe("unbound");
  });

  it("listRecipes leaves missing overlay ids unbound with a recommend query", () => {
    const overlay = parseRecipeFile({
      recipes: [
        {
          id: "sign-in",
          title: "Sign in",
          slots: [
            {
              role: "primary-cta",
              required: true,
              hints: ["button"],
              defaultMasterId: "node:does-not-exist",
            },
          ],
        },
      ],
    });
    const listed = listRecipes(mergeRecipes(parseRecipeFile(sampleFile), overlay), demo);
    const signIn = listed.recipes.find((row) => row.id === "sign-in");
    expect(signIn?.slots[0]?.status).toBe("missing");
    expect(signIn?.slots[0]?.master).toBeUndefined();
    expect(signIn?.slots[0]?.nextRecommend).toMatch(/button/i);
  });
});

describe("recipe response budget", () => {
  it("returns the best recipe plus the other names when several matches exceed 2000 characters", () => {
    const recipes = Array.from({ length: 6 }, (_, index) => ({
      id: `pack-${index}`,
      title: `Pack ${index}`,
      intentAliases: ["shared job"],
      notes: "n".repeat(280),
      slots: Array.from({ length: 4 }, (_, slot) => ({
        role: `role-${slot}`,
        required: true,
        status: "unbound" as const,
        nextRecommend: "recommend this long slot query ".repeat(6),
      })),
    }));
    const listed = { recipes, hint: "full list" };
    expect(JSON.stringify(listed).length).toBeGreaterThan(RECIPE_RESPONSE_BUDGET);
    const capped = capRecipePayload(listed);
    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(RECIPE_RESPONSE_BUDGET);
    expect(capped).toEqual(
      expect.objectContaining({
        recipe: expect.objectContaining({ id: "pack-0", title: "Pack 0" }),
        also: expect.arrayContaining(["Pack 1", "Pack 2"]),
      }),
    );
    expect(capped).not.toHaveProperty("recipes");
  });
});
