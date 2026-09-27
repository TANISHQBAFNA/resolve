import { describe, expect, it } from "vitest";
import type { DesignGraph, GraphEdge, GraphNode, NodeType } from "@/core/model";
import {
  fillRecipe,
  indexGraph,
  listRecipes,
  matchContextPack,
  packForRecipe,
  parseContextPackFile,
  parseRecipeFile,
  recipeCard,
  recommendMasters,
  verifyFrame,
} from "@/core/query";
import examplePacks from "@/data/context-packs.example.json";

const FROZEN = "2026-01-01T00:00:00.000Z";

function n(
  id: string,
  type: NodeType,
  name: string,
  extra: Partial<GraphNode> = {},
): GraphNode {
  return { id, type, name, ...extra };
}

function e(type: GraphEdge["type"], source: string, target: string): GraphEdge {
  return { id: `${type}|${source}|${target}`, source, target, type };
}

/** Two products share a Button set. Checkout Pay CTA vs settings Save CTA. */
function productLab() {
  const file = "file:CTX";
  const page = "node:p";
  const checkoutFrame = "node:checkout";
  const settingsFrame = "node:settings";
  const btnSet = "node:btn-set";
  const pay = "node:pay";
  const save = "node:save";
  const instPay = "node:ip";
  const instSave = ["node:is1", "node:is2", "node:is3"] as const;

  const graph: DesignGraph = {
    fileKey: "CTX",
    fileName: "Context lab",
    builtAt: FROZEN,
    source: { kind: "mock", ingestedAt: FROZEN },
    warnings: [],
    nodes: [
      n(file, "FILE", "Context lab"),
      n(page, "PAGE", "App", { parentId: file, pageId: page }),
      n(checkoutFrame, "FRAME", "Storefront Checkout Summary", {
        parentId: page,
        pageId: page,
        figmaNodeId: "1:1",
      }),
      n(settingsFrame, "FRAME", "Admin Settings Form", {
        parentId: page,
        pageId: page,
        figmaNodeId: "2:1",
      }),
      n(btnSet, "COMPONENT_SET", "Button", { parentId: page, pageId: page, figmaNodeId: "9:0" }),
      n(pay, "VARIANT", "Pay CTA", {
        parentId: btnSet,
        pageId: page,
        componentSetId: btnSet,
        figmaNodeId: "9:1",
        variantProperties: { Variant: "Primary" },
      }),
      n(save, "VARIANT", "Save CTA", {
        parentId: btnSet,
        pageId: page,
        componentSetId: btnSet,
        figmaNodeId: "9:2",
        variantProperties: { Variant: "Primary" },
      }),
      n(instPay, "COMPONENT_INSTANCE", "Pay CTA", {
        parentId: checkoutFrame,
        pageId: page,
        isInstance: true,
        mainComponentId: pay,
        componentSetId: btnSet,
        figmaNodeId: "1:2",
      }),
      ...instSave.map((id, i) =>
        n(id, "COMPONENT_INSTANCE", "Save CTA", {
          parentId: settingsFrame,
          pageId: page,
          isInstance: true,
          mainComponentId: save,
          componentSetId: btnSet,
          figmaNodeId: `2:${i + 2}`,
        }),
      ),
    ],
    edges: [
      e("CONTAINS", file, page),
      e("CONTAINS", page, checkoutFrame),
      e("CONTAINS", page, settingsFrame),
      e("CONTAINS", page, btnSet),
      e("CONTAINS", btnSet, pay),
      e("CONTAINS", btnSet, save),
      e("CONTAINS", checkoutFrame, instPay),
      ...instSave.map((id) => e("CONTAINS", settingsFrame, id)),
      e("VARIANT_OF", pay, btnSet),
      e("VARIANT_OF", save, btnSet),
      e("INSTANCE_OF", instPay, pay),
      ...instSave.map((id) => e("INSTANCE_OF", id, save)),
      e("NESTS", checkoutFrame, instPay),
      ...instSave.map((id) => e("NESTS", settingsFrame, id)),
    ],
  };

  return { index: indexGraph(graph), ids: { pay, save } };
}

const samplePackFile = {
  version: 1,
  howToAdd: "edit this file",
  active: "storefront-checkout-summary",
  packs: [
    {
      id: "storefront-checkout-summary",
      product: { id: "storefront", name: "Storefront" },
      domain: "checkout",
      journey: { step: "summary", screenJob: "checkout summary" },
      audience: "returning shopper",
      constraints: { density: "compact", a11y: "wcag-aa" },
      recipeIds: ["checkout-summary"],
      files: ["Storefront"],
      client: { id: "northwind", name: "Northwind" },
      libraryRules: { deny: ["Banner"] },
      figmaNodeId: "9:1",
    },
    {
      id: "admin-settings",
      product: "Admin",
      domain: "settings",
      journey: "form",
      recipeIds: ["settings-form"],
    },
  ],
};

describe("context pack load", () => {
  it("parses designer JSON and ignores unknown keys and invented node ids", () => {
    const file = parseContextPackFile(samplePackFile);
    expect(file.packs).toHaveLength(2);
    expect(file.active).toBe("storefront-checkout-summary");
    const pack = file.packs[0];
    expect(pack?.id).toBe("storefront-checkout-summary");
    expect(pack?.product).toEqual({ id: "storefront", name: "Storefront" });
    expect(pack?.domain).toBe("checkout");
    expect(pack?.journey).toEqual({ step: "summary", screenJob: "checkout summary" });
    expect(pack?.audience).toBe("returning shopper");
    expect(pack?.constraints).toEqual({ density: "compact", a11y: "wcag-aa" });
    expect(pack?.recipeIds).toEqual(["checkout-summary"]);
    expect(pack?.files).toEqual(["Storefront"]);
    expect(pack?.client).toEqual({ id: "northwind", name: "Northwind" });
    expect(pack?.libraryRules).toEqual({ deny: ["Banner"] });
    expect(pack && "figmaNodeId" in pack).toBe(false);
  });

  it("accepts product and journey as strings", () => {
    const admin = parseContextPackFile(samplePackFile).packs[1];
    expect(admin?.product).toEqual({ id: "admin", name: "Admin" });
    expect(admin?.journey).toEqual({ step: "form", screenJob: "form" });
  });

  it("rejects invented empty packs rather than crashing", () => {
    expect(parseContextPackFile({})).toEqual({ packs: [] });
    expect(parseContextPackFile({ packs: "nope" })).toEqual({ packs: [] });
    expect(parseContextPackFile(null)).toEqual({ packs: [] });
  });

  it("parses the shipped example template without node ids", () => {
    const file = parseContextPackFile(examplePacks);
    expect(file.packs[0]?.id).toBe("storefront-checkout-summary");
    expect(file.packs[0]?.recipeIds).toContain("checkout-summary");
    expect(file.packs.every((pack) => !("figmaNodeId" in pack))).toBe(true);
  });
});

describe("bind pack to recipe", () => {
  const packs = parseContextPackFile(samplePackFile).packs;
  const recipes = parseRecipeFile({
    recipes: [
      {
        id: "checkout-summary",
        title: "Checkout summary",
        intentAliases: ["checkout"],
        slots: [{ role: "primary-cta", required: true, hints: ["button", "primary"] }],
      },
      {
        id: "settings-form",
        title: "Settings form",
        slots: [{ role: "primary-cta", required: true, hints: ["button"] }],
      },
      {
        id: "empty-state",
        title: "Empty state",
        contextPackId: "admin-settings",
        slots: [{ role: "message", required: true, hints: ["banner"] }],
      },
    ],
  });

  it("binds by recipeIds, recipe.contextPackId, then explicit pack id", () => {
    const checkout = recipes.find((recipe) => recipe.id === "checkout-summary")!;
    const settings = recipes.find((recipe) => recipe.id === "settings-form")!;
    const empty = recipes.find((recipe) => recipe.id === "empty-state")!;

    expect(packForRecipe(checkout, { packs })?.id).toBe("storefront-checkout-summary");
    expect(packForRecipe(settings, { packs })?.id).toBe("admin-settings");
    expect(packForRecipe(empty, { packs })?.id).toBe("admin-settings");
    expect(packForRecipe(checkout, { packs, packId: "admin-settings" })?.id).toBe("admin-settings");
  });

  it("matches product + journey flags to a pack", () => {
    expect(
      matchContextPack(packs, { product: "storefront", journey: "summary", domain: "checkout" })?.id,
    ).toBe("storefront-checkout-summary");
    expect(matchContextPack(packs, { packId: "missing" })).toBeUndefined();
  });

  it("scopes nextRecommend and slot fill with the bound pack", () => {
    const { index, ids } = productLab();
    const checkout = recipes.find((recipe) => recipe.id === "checkout-summary")!;
    const pack = packForRecipe(checkout, { packs });
    const filled = fillRecipe(index, checkout, undefined, pack);

    expect(filled.context?.id).toBe("storefront-checkout-summary");
    expect(filled.slots[0]?.status).toBe("filled");
    expect(filled.slots[0]?.master?.id).toBe(ids.pay);
    expect(filled.slots[0]?.nextRecommend).toMatch(/storefront|checkout/i);
    expect(filled.slots[0]?.master?.figmaNodeId).toBe("9:1");
  });

  it("list and recipe cards surface bound context without inventing ids", () => {
    const listed = listRecipes(recipes, undefined, { packs, active: "storefront-checkout-summary" });
    const checkout = listed.recipes.find((row) => row.id === "checkout-summary");
    expect(checkout?.context?.id).toBe("storefront-checkout-summary");
    expect(checkout?.context?.domain).toBe("checkout");
    expect(checkout?.slots.every((slot) => !slot.master)).toBe(true);
    expect(checkout?.slots[0]?.nextRecommend).toMatch(/checkout/i);

    const card = recipeCard(recipes, "checkout summary", undefined, undefined, { packs });
    expect(card.found).toBe(true);
    if (!card.found) return;
    expect(card.context?.product).toMatch(/storefront/i);
    expect(card.slots[0]?.nextRecommend).toMatch(/button/i);
  });
});

describe("recommend ranking with product/journey context", () => {
  it("without context prefers the more-used settings CTA", () => {
    const { index, ids } = productLab();
    const result = recommendMasters(index, "primary button");
    expect(result.candidates[0]?.id).toBe(ids.save);
    expect(result.context).toBeUndefined();
  });

  it("with checkout pack ranks the checkout Pay CTA above the settings cousin", () => {
    const { index, ids } = productLab();
    const pack = parseContextPackFile(samplePackFile).packs[0];
    const result = recommendMasters(index, "primary button", { context: pack });
    expect(result.candidates[0]?.id).toBe(ids.pay);
    expect(result.candidates[0]?.why).toMatch(/matches/i);
    expect(result.context?.id).toBe("storefront-checkout-summary");
    expect(result.context?.domain).toBe("checkout");
  });

  it("empty match still does not invent, even when a pack is active", () => {
    const { index } = productLab();
    const pack = parseContextPackFile(samplePackFile).packs[0];
    const result = recommendMasters(index, "quantum flux capacitor widget", { context: pack });
    expect(result.candidates).toEqual([]);
  });

  it("verify_frame stays invent/deprecated/unresolved; pack libraryRules are a light hook", () => {
    const { index, ids } = productLab();
    const pack = parseContextPackFile(samplePackFile).packs[0];
    const ok = verifyFrame(index, { components: [ids.pay], context: pack });
    expect(ok.pass).toBe(true);
    expect(ok.invents).toEqual([]);
    expect("wrongCousin" in ok).toBe(false);

    const denied = verifyFrame(index, { components: ["Banner"], context: pack });
    expect(denied.pass).toBe(false);
    expect(denied.invents.some((hit) => hit.reason === "denied" || hit.reason === "not-in-graph")).toBe(
      true,
    );
  });
});
