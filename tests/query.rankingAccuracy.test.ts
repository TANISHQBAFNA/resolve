import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SourceDocumentSchema } from "@/core/ingestion/types";
import { buildGraph } from "@/core/transform";
import { indexGraph, starterRecipes } from "@/core/query";
import { componentUsageCard, recommendMasters } from "@/core/query/agentSurface";
import { recipeCard } from "@/core/query/recipes";
import { loadGoldenCases, scoreGraph } from "@/core/query/scoreboard";

const root = fileURLToPath(new URL("..", import.meta.url));

function fixtureIndex() {
  const raw: unknown = JSON.parse(readFileSync(join(root, "scoreboard", "fixture", "library.json"), "utf8"));
  const source = SourceDocumentSchema.parse(raw);
  return indexGraph(buildGraph(source, { builtAt: "2026-01-01T00:00:00.000Z" }));
}

function topName(
  index: ReturnType<typeof fixtureIndex>,
  intent: string,
  context?: { screenType?: string; journey?: string; domain?: string; slot?: string },
) {
  const screenJob = [context?.journey, context?.screenType].filter(Boolean).join(" ");
  const result = recommendMasters(index, intent, {
    ...(context
      ? {
          context: {
            id: context.screenType || context.journey || context.slot,
            ...(context.screenType ? { screenType: context.screenType, domain: context.domain ?? context.screenType } : {}),
            ...(screenJob || context.slot
              ? {
                  journey: {
                    ...(context.slot ? { step: context.slot } : {}),
                    ...(screenJob ? { screenJob } : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
  });
  return result;
}

describe("recommend name match beats screen usage", () => {
  const index = fixtureIndex();

  it("ranks everyday asks by name, not by a busier neighbor", () => {
    expect(topName(index, "primary button").candidates[0]?.name).toBe("Button / Style=Primary");
    expect(topName(index, "page header").candidates[0]?.name).toBe("Header Bar");
    expect(topName(index, "user avatar").candidates[0]?.name).toBe("Avatar");
    expect(topName(index, "price label").candidates[0]?.name).toBe("Price");
    expect(topName(index, "close icon").candidates[0]?.name).toBe("Icon Close");
    expect(topName(index, "search box").candidates[0]?.name).toBe("Search Field");
  });

  it("uses screen context only to separate name-relevant cousins", () => {
    const filter = topName(index, "filter", { screenType: "catalog", journey: "browse", slot: "filter" });
    const filterName = filter.candidates[0]?.name;
    expect(filterName === undefined || filterName === "Tag").toBe(true);
    expect(filter.candidates.map((row) => row.name)).not.toContain("Chip");
    expect(filter.candidates.map((row) => row.name)).not.toContain("List Row");
    expect(topName(index, "card", { screenType: "checkout", journey: "review" }).candidates[0]?.name).toBe(
      "Summary Card",
    );
    expect(topName(index, "row", { screenType: "checkout", journey: "payment" }).candidates[0]?.name).toBe(
      "Payment Row",
    );
    expect(topName(index, "cta", { screenType: "settings", journey: "save", slot: "primary-cta" }).candidates[0]?.name).toBe(
      "Save CTA",
    );
    expect(topName(index, "cta", { screenType: "checkout", journey: "payment", slot: "primary-cta" }).candidates[0]?.name).toBe(
      "Pay CTA",
    );
    expect(
      topName(index, "checkout summary", { screenType: "checkout", journey: "payment", slot: "primary-cta" }).candidates[0]?.name,
    ).toBe("Pay CTA");
    expect(topName(index, "sign in", { slot: "primary-cta" }).candidates[0]?.name).toBe(
      "Button / Style=Primary",
    );
  });

  it("fits two or three candidates in the 600-character card", () => {
    const result = recommendMasters(index, "button");
    expect(result.candidates.length).toBeGreaterThanOrEqual(2);
    expect(result.candidates.length).toBeLessThanOrEqual(3);
    expect(result.cost.chars).toBeLessThanOrEqual(600);
    const lead = result.candidates[0];
    expect(lead && "fileKey" in lead && lead.fileKey).toBeTruthy();
    expect(lead && "nodeId" in lead && lead.nodeId).toBeTruthy();
    const alt = result.candidates[1];
    expect(alt && Object.keys(alt).sort()).toEqual(["figmaNodeId", "fileKey", "id", "name", "why"]);
    expect(alt && "fileKey" in alt && alt.fileKey).toBeTruthy();
    expect(alt && "figmaNodeId" in alt && alt.figmaNodeId).toBeTruthy();
    expect(lead && "type" in lead && lead.type).toBeTruthy();
    expect(lead && "score" in lead && lead.score).toEqual(expect.any(Number));
    expect(lead && "hint" in lead && lead.hint).toBeTruthy();
  });
});

describe("phrase match and typos", () => {
  const index = fixtureIndex();

  it("prefers a whole specific name over a shared generic token", () => {
    expect(topName(index, "radio button").candidates[0]?.name).toBe("Radio");
    expect(topName(index, "tab bar").candidates[0]?.name).toBe("Tabs");
    expect(topName(index, "bottom bar").candidates[0]?.name).toBe("Footer Bar");
    expect(topName(index, "top bar").candidates[0]?.name).toBe("Header Bar");
    expect(topName(index, "navigation item").candidates[0]?.name).toBe("Nav Item");
    expect(topName(index, "check box").candidates[0]?.name).toBe("Checkbox");
    expect(topName(index, "page header").candidates[0]?.name).toBe("Header Bar");
    expect(topName(index, "primary button").candidates[0]?.name).toBe("Button / Style=Primary");
    const mainAction = topName(index, "main action button").candidates[0]?.name;
    expect(mainAction).toBeTruthy();
    expect(mainAction).not.toBe("Pay CTA");
    expect(mainAction).not.toBe("Save CTA");
  });

  it("typos the whole name only when nothing else matches", () => {
    expect(topName(index, "buton").candidates[0]?.name).toBe("Button");
    expect(topName(index, "avtar").candidates[0]?.name).toBe("Avatar");
    expect(topName(index, "chekbox").candidates[0]?.name).toBe("Checkbox");
    expect(topName(index, "swtich").candidates[0]?.name).toBe("Switch");
    expect(topName(index, "tag").candidates[0]?.name).toBe("Tag");
    expect(topName(index, "kelp forest gauge").candidates).toEqual([]);
  });

  it("returns empty for ordinary words and non-UI phrases", () => {
    const junk = [
      "cart",
      "bard",
      "coast",
      "roast",
      "moral",
      "radix",
      "badger",
      "rice",
      "chop",
      "swatch",
      "maple",
      "orbit",
      "tablet",
      "switchboard",
      "cardigan",
      "modality",
      "chipper",
      "paycheck",
      "radiology",
      "tagline",
      "heading south",
      "bottoms",
      "footer ball",
      "x ray",
      "cancel culture",
      "image processing",
      "money order",
      "card game",
      "radio station",
      "price of gold",
      "badge of honor",
      "chip shop",
      "exit strategy",
      "stepper motor",
      "divider wall",
      "switch off lights",
      "link in bio",
      "card window",
      "pic",
      "user head",
    ];
    for (const word of junk) {
      expect(recommendMasters(index, word).candidates, word).toEqual([]);
      const resolved = componentUsageCard(index, word);
      expect(resolved.found, word).toBe(false);
    }
  });

  it("keeps inflections, the x mark, UI modifiers, and design synonyms", () => {
    expect(topName(index, "buttons").candidates[0]?.name).toBe("Button");
    expect(topName(index, "chips").candidates[0]?.name).toBe("Chip");
    expect(topName(index, "tabs").candidates[0]?.name).toBe("Tabs");
    expect(topName(index, "x").candidates[0]?.name).toBe("Icon Close");
    expect(topName(index, "x icon").candidates[0]?.name).toBe("Icon Close");
    expect(topName(index, "x button").candidates[0]?.name).toBe("Icon Close");
    expect(topName(index, "error alert").candidates[0]?.name).toBe("Alert");
    expect(topName(index, "info banner").candidates[0]?.name).toBe("Banner");
    expect(topName(index, "count badge").candidates[0]?.name).toBe("Badge");
    expect(topName(index, "close button").candidates[0]?.name).toBe("Icon Close");
    expect(topName(index, "toast message").candidates[0]?.name).toBe("Toast");
    expect(topName(index, "total price").candidates[0]?.name).toBe("Price");
    expect(topName(index, "primary button").candidates[0]?.name).toBe("Button / Style=Primary");
    expect(topName(index, "on off switch").candidates[0]?.name).toBe("Switch");
    expect(topName(index, "headshot").candidates[0]?.name).toBe("Avatar");
    expect(topName(index, "masthead").candidates[0]?.name).toBe("Header Bar");
    expect(topName(index, "exit").candidates[0]?.name).toBe("Icon Close");
    expect(topName(index, "query").candidates[0]?.name).toBe("Search Field");
    expect(topName(index, "tick box").candidates[0]?.name).toBe("Checkbox");
    expect(topName(index, "hyperlink").candidates[0]?.name).toBe("Link Button");
    expect(["Coupon Field", "Promo Field"]).toContain(topName(index, "voucher").candidates[0]?.name);
    expect(topName(index, "sidebar item").candidates[0]?.name).toBe("Nav Item");
    expect(topName(index, "table row").candidates[0]?.name).toBe("List Row");
  });

  it("keeps a component that is the head noun, and marks the modifier as low confidence", () => {
    const login = topName(index, "login field");
    expect(login.candidates[0]?.name).toBe("Text Field");
    expect(login.candidates[0] && "confidence" in login.candidates[0] && login.candidates[0].confidence).toBe("low");
    expect(login.cost.chars).toBeLessThanOrEqual(600);
    expect(topName(index, "billing address field").candidates[0]?.name).toBe("Text Field");
    expect(topName(index, "cart badge").candidates[0]?.name).toBe("Badge");
    expect(topName(index, "shipping alert").candidates[0]?.name).toBe("Alert");
    expect(topName(index, "newsletter checkbox").candidates[0]?.name).toBe("Checkbox");
    expect(topName(index, "delivery banner").candidates[0]?.name).toBe("Banner");
    expect(topName(index, "wishlist chip").candidates[0]?.name).toBe("Chip");
    expect(topName(index, "notifications switch").candidates[0]?.name).toBe("Switch");
    const modal = topName(index, "modal window");
    expect(modal.candidates[0]?.name).toBe("Modal");
    expect(modal.candidates[0] && "confidence" in modal.candidates[0]).toBe(false);
    expect(topName(index, "dialog window").candidates[0]?.name).toBe("Modal");
    const avatar = topName(index, "user pic");
    expect(avatar.candidates[0]?.name).toBe("Avatar");
    expect(avatar.candidates[0] && "confidence" in avatar.candidates[0]).toBe(false);
    const close = topName(index, "close mark");
    expect(close.candidates[0]?.name).toBe("Icon Close");
    expect(close.candidates[0] && "confidence" in close.candidates[0]).toBe(false);
    const promo = topName(index, "promo input");
    expect(promo.candidates[0]?.name).toBe("Promo Field");
    expect(promo.candidates.map((row) => row.name)).not.toContain("Input");
    const alert = topName(index, "error alert");
    expect(alert.candidates[0]?.name).toBe("Alert");
    expect(alert.candidates[0] && "confidence" in alert.candidates[0]).toBe(false);
  });
});

describe("deprecated names", () => {
  const index = fixtureIndex();

  it("recommend returns the live replacement, not the retired master", () => {
    for (const [intent, live, retired] of [
      ["Legacy Banner", "Banner", "Legacy Banner"],
      ["old price", "Price", "Old Price"],
      ["legacy price", "Price", "Old Price"],
      ["Legacy Alert", "Alert", "Legacy Alert"],
    ] as const) {
      const result = recommendMasters(index, intent);
      expect(result.candidates[0]?.name).toBe(live);
      expect(result.candidates[0]?.why).toBe(`replaces ${retired} (deprecated)`);
      expect(result.candidates.some((row) => row.name === retired)).toBe(false);
      expect(result.cost.chars).toBeLessThanOrEqual(600);
    }
  });

  it("resolve of a differently cased retired name returns the live replacement", () => {
    for (const [intent, live] of [
      ["legacy banner", "Banner"],
      ["old price", "Price"],
    ] as const) {
      const card = componentUsageCard(index, intent);
      expect(card.found).toBe(true);
      if (!card.found || card.kind !== "component") return;
      expect(card.component.name).toBe(live);
      expect(card.component.name).not.toMatch(/legacy|old price/i);
    }
  });

  it("resolve returns the exact retired master, flagged, plus the replacement", () => {
    const card = componentUsageCard(index, "Legacy Banner");
    expect(card.found).toBe(true);
    if (!card.found || card.kind !== "component") return;
    expect(card.component.name).toBe("Legacy Banner");
    expect(card.component.status).toBe("deprecated");
    expect(card.deprecated).toBe(true);
    expect(card.replacement?.name).toBe("Banner");
    expect(card.replacement?.why).toBe("replaces Legacy Banner (deprecated)");
    expect(card.replacement?.id).toMatch(/^node:/);
  });

  it("follows an explicit replacedBy note before the name cousin", () => {
    const banner = index.allNodes.find((node) => node.name === "Legacy Banner");
    expect(banner).toBeTruthy();
    banner!.description = "status: deprecated\nreplacedBy: Alert";
    const result = recommendMasters(index, "Legacy Banner");
    expect(result.candidates[0]?.name).toBe("Alert");
    expect(result.candidates[0]?.why).toBe("replaces Legacy Banner (deprecated)");
  });
});

describe("private masters", () => {
  const index = fixtureIndex();

  it("fuzzy words do not return a _ or . master", () => {
    for (const intent of ["internal icon", "hidden badge", "private note"]) {
      const recommended = recommendMasters(index, intent);
      expect(recommended.candidates).toEqual([]);
      const resolved = componentUsageCard(index, intent);
      expect(resolved.found).toBe(false);
    }
  });

  it("an exact private name resolves, and recommend stays empty", () => {
    const resolved = componentUsageCard(index, "_Private Note");
    expect(resolved.found).toBe(true);
    if (!resolved.found || resolved.kind !== "component") return;
    expect(resolved.component.name).toBe("_Private Note");
    expect(recommendMasters(index, "_Private Note").candidates).toEqual([]);
  });
});

describe("resolve screen context", () => {
  const index = fixtureIndex();

  it("prefers Save CTA for cta on a settings screen", () => {
    const card = componentUsageCard(index, "cta", {
      context: { screenType: "settings", domain: "settings", journey: { screenJob: "save settings", step: "primary-cta" } },
    });
    expect(card.found).toBe(true);
    if (!card.found || card.kind !== "component") return;
    expect(card.component.name).toBe("Save CTA");
    const filter = componentUsageCard(index, "filter", {
      context: { screenType: "catalog", domain: "catalog", journey: { screenJob: "browse catalog", step: "filter" } },
    });
    expect(filter.found).toBe(false);
  });
});

describe("checkout recipe default", () => {
  it("binds the primary button slot to Pay CTA on the fixture", () => {
    const card = recipeCard(starterRecipes(), "checkout summary", fixtureIndex());
    expect(card.found).toBe(true);
    if (!card.found) return;
    const slot = card.slots.find((row) => row.role === "primary-cta");
    expect(slot?.status).toBe("bound");
    expect(slot?.master?.name).toBe("Pay CTA");
  });
});

describe("scoreboard tools", () => {
  it("keeps scoring tools an array does not name, and applies object overrides", () => {
    const index = fixtureIndex();
    const recipeMarked = scoreGraph(index, [
      {
        id: "only-recipe",
        intent: "checkout summary",
        slot: "primary-cta",
        screenType: "checkout",
        journey: "payment",
        expected: "Pay CTA",
        expect: "master",
        tools: ["recipe"],
      },
    ]);
    expect(recipeMarked.tools.find((tool) => tool.tool === "recipe")?.scored).toBe(1);
    expect(recipeMarked.tools.find((tool) => tool.tool === "recommend")?.top1Count).toBe(1);
    expect(recipeMarked.tools.find((tool) => tool.tool === "resolve")?.top1Count).toBe(1);

    const resolveOverride = scoreGraph(
      index,
      loadGoldenCases(join(root, "scoreboard", "golden", "private.json")).filter((row) => row.id === "priv-note"),
    );
    expect(resolveOverride.tools.find((tool) => tool.tool === "resolve")?.top1Count).toBe(1);
    expect(resolveOverride.tools.find((tool) => tool.tool === "recommend")?.scored).toBe(0);
    expect(resolveOverride.misses.filter((row) => row.tool === "recommend")).toEqual([]);
  });
});
