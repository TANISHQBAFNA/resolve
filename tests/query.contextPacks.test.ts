import { describe, expect, it } from "vitest";
import type { DesignGraph, GraphEdge, GraphNode, NodeType } from "@/core/model";
import {
  appliedContext,
  fillRecipe,
  indexGraph,
  listRecipes,
  matchContextPack,
  packForRecipe,
  packForRecommend,
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

  it("parses the shipped example template without node ids or an active pack", () => {
    const file = parseContextPackFile(examplePacks);
    expect(file.packs[0]?.id).toBe("storefront-checkout-summary");
    expect(file.packs[0]?.recipeIds).toContain("checkout-summary");
    expect(file.packs.every((pack) => !("figmaNodeId" in pack))).toBe(true);
    expect(file.active).toBeUndefined();
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

  it("overlays audience and a11y from the call without dropping the pack", () => {
    const pack = packForRecommend({
      packs,
      packId: "storefront-checkout-summary",
      audience: "new customer",
      a11y: "wcag-aaa",
    });
    expect(pack?.id).toBe("storefront-checkout-summary");
    expect(pack?.audience).toBe("new customer");
    expect(pack?.constraints).toEqual({ density: "compact", a11y: "wcag-aaa" });
    expect(pack && "figmaNodeId" in pack).toBe(false);
  });

  it("audience and a11y alone are context, with no invented component id", () => {
    const pack = packForRecommend({ packs: [], audience: "returning customer", a11y: "AA" });
    expect(pack?.id).toBe("");
    expect(pack?.audience).toBe("returning customer");
    expect(pack?.constraints).toEqual({ a11y: "wcag-aa" });
    expect(pack?.sources).toEqual({ audience: "document", a11y: "document" });
    expect(pack && "figmaNodeId" in pack).toBe(false);
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
    expect(card.context?.audience).toBe("returning shopper");
    expect(card.context?.a11y).toBe("wcag-aa");
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

const acmePacks = [
  {
    id: "acme-pay-confirm",
    product: { id: "acme-pay", name: "Acme Pay" },
    journey: { step: "confirm", screenJob: "Send money" },
    audience: "returning customer",
    constraints: { density: "comfortable", a11y: "wcag-aa" },
    recipeIds: ["checkout-summary"],
  },
  {
    id: "acme-cards",
    product: { id: "acme-cards", name: "Acme Cards" },
    journey: { step: "apply", screenJob: "Apply for card" },
    audience: "small business owners",
    constraints: { density: "compact", a11y: "wcag-aaa" },
    recipeIds: ["checkout-summary"],
  },
];

describe("H41 exact pack match and echo-only audience", () => {
  const checkout = {
    id: "checkout-summary",
    title: "Checkout summary",
    intentAliases: ["checkout"],
    slots: [{ role: "primary-cta", required: true, hints: ["button", "primary"] }],
  };

  it("H41-1 does not pick a pack from one shared token, and an active pack does not override another product", () => {
    const { index } = productLab();
    const decided = packForRecommend({ packs: acmePacks, product: "Acme Loans", journey: "Apply for loan" });
    const card = recommendMasters(index, "primary button", decided ? { context: decided, budgetChars: 2000 } : {});
    const text = JSON.stringify(card.context);
    expect(text).not.toMatch(/Acme Cards|small business|wcag-aaa/i);
    expect(card.context?.product).toBe("Acme Loans");
    expect(card.context?.productFrom).toBe("document");
    expect(card.context?.journey).toBe("Apply for loan");
    expect(card.context?.journeyFrom).toBe("document");
    expect(card.context?.id).toBeUndefined();

    const recipePack = packForRecipe(checkout, { packs: acmePacks, active: "acme-cards", product: "Globex Wallet" });
    const echo = appliedContext(recipePack!);
    expect(JSON.stringify(echo)).not.toMatch(/Acme Cards|small business|wcag-aaa/i);
    expect(echo?.product).toBe("Globex Wallet");
    expect(echo?.productFrom).toBe("document");
    expect(echo?.id).toBeUndefined();
  });

  it("H41-2 audience, a11y, and density do not change the candidate list", () => {
    const { index } = productLab();
    const dense = packForRecommend({
      packs: [
        {
          id: "acme-density",
          product: { name: "Acme Pay" },
          audience: "returning customer",
          constraints: { density: "compact", a11y: "wcag-aaa" },
        },
      ],
      active: "acme-density",
    });
    for (const ask of ["button compact", "button aaa"]) {
      const bare = recommendMasters(index, ask);
      const packed = recommendMasters(index, ask, dense ? { context: dense } : {});
      expect(packed.candidates.map((row) => row.id)).toEqual(bare.candidates.map((row) => row.id));
      expect(packed.hint).toMatch(/No master matched\. Do not invent/);
    }
    const pay = packForRecommend({ packs: acmePacks, packId: "acme-pay-confirm" });
    for (const ask of ["button wcag", "button aa", "button comfortable", "input wcag"]) {
      const bare = recommendMasters(index, ask);
      const packed = recommendMasters(index, ask, pay ? { context: pay } : {});
      expect(packed.candidates.map((row) => row.id), ask).toEqual(bare.candidates.map((row) => row.id));
      expect(packed.hint, ask).toMatch(/No master matched\. Do not invent/);
    }
  });

  it("M41-1 labels each echoed field with its source and does not borrow audience from an unchosen pack", () => {
    const chosen = packForRecommend({
      packs: acmePacks,
      product: "Acme Pay",
      journey: "confirm",
      audience: "new customer",
    });
    const echo = appliedContext(chosen!);
    expect(echo?.id).toBe("acme-pay-confirm");
    expect(echo?.productFrom).toBe("document");
    expect(echo?.journeyFrom).toBe("document");
    expect(echo?.audience).toBe("new customer");
    expect(echo?.audienceFrom).toBe("document");
    expect(echo?.a11y).toBe("wcag-aa");
    expect(echo?.a11yFrom).toBe("pack acme-pay-confirm");

    const loans = appliedContext(packForRecommend({ packs: acmePacks, product: "Acme Loans" })!);
    expect(loans?.audience).toBeUndefined();
    expect(loans?.a11y).toBeUndefined();
    expect(loans?.id).toBeUndefined();

    const missing = packForRecommend({ packs: acmePacks, packId: "nope", product: "Acme Pay" });
    expect(missing?.warning).toBe('No context pack "nope".');
    expect(appliedContext(missing!)?.id).toBeUndefined();

    const fight = packForRecommend({ packs: acmePacks, packId: "acme-cards", product: "Globex Wallet" });
    expect(fight?.warning).toBe('Context pack "acme-cards" is for Acme Cards, not Globex Wallet.');
    expect(appliedContext(fight!)?.audience).toBeUndefined();
    expect(appliedContext(fight!)?.a11y).toBeUndefined();
    expect(appliedContext(fight!)?.product).toBe("Globex Wallet");
    expect(appliedContext(packForRecommend({ packs: [], product: "Acme Pay", a11y: "AA" })!)?.a11y).toBe("wcag-aa");
  });
});
