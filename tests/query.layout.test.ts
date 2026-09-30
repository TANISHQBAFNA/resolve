import { describe, expect, it } from "vitest";
import {
  columnWidthFor,
  deriveLayout,
  layoutSummary,
  offScale,
  snapToToken,
  type DimensionToken,
  type Rect,
} from "@/core/query/layout";

/** COIN v3's Dimensions collection. */
const TOKENS: DimensionToken[] = [
  { name: "spacing/0", value: 0 },
  { name: "spacing/2", value: 2 },
  { name: "spacing/4", value: 4 },
  { name: "spacing/8", value: 8 },
  { name: "spacing/10", value: 10 },
  { name: "spacing/12", value: 12 },
  { name: "spacing/16", value: 16 },
  { name: "spacing/20", value: 20 },
  { name: "spacing/24", value: 24 },
  { name: "spacing/32", value: 32 },
  { name: "spacing/40", value: 40 },
  { name: "spacing/48", value: 48 },
  { name: "spacing/56", value: 56 },
];

/**
 * The real grid from Trade FO "Review : Import LC Issuance" (2138:6817):
 * 1728 wide, columns starting at 56 / 603 / 1149, fields 523x62, row pitch 86.
 */
function tradeReviewFields(): Rect[] {
  const starts = [56, 603, 1149];
  const rows = [0, 86, 172, 258];
  const out: Rect[] = [];
  for (const y of rows) {
    for (const x of starts) out.push({ x, y, width: 523, height: 62 });
  }
  return out;
}

describe("snapToToken", () => {
  it("returns the token on an exact match", () => {
    expect(snapToToken(24, TOKENS)).toEqual({ px: 24, token: "spacing/24" });
  });

  it("names the nearest token and the distance when off-scale", () => {
    const snapped = snapToToken(23, TOKENS);
    expect(snapped.token).toBeUndefined();
    expect(snapped.nearest).toBe("spacing/24");
    expect(snapped.off).toBe(-1);
  });

  it("matches a token even when nothing in the library binds to it", () => {
    // spacing/56 has zero bindings in COIN v3. It is still on the scale, and
    // that is exactly the case worth surfacing.
    expect(snapToToken(56, TOKENS).token).toBe("spacing/56");
  });

  it("survives an empty scale", () => {
    expect(snapToToken(24, [])).toEqual({ px: 24 });
  });
});

describe("deriveLayout", () => {
  it("derives the Trade FO review grid in tokens", () => {
    const spec = deriveLayout(tradeReviewFields(), TOKENS, { containerWidth: 1728 });
    expect(spec).toBeDefined();
    expect(spec!.columns).toBe(3);
    expect(spec!.columnWidth).toBe(523);
    expect(spec!.gutter.token).toBe("spacing/24");
    expect(spec!.marginLeft.token).toBe("spacing/56");
    expect(spec!.marginRight.token).toBe("spacing/56");
    expect(spec!.rowGap?.token).toBe("spacing/24");
    expect(spec!.sampleSize).toBe(12);
  });

  it("reports an off-scale gutter rather than rounding it away", () => {
    // Same grid, nudged so the gutter lands on 23.
    const fields = tradeReviewFields().map((f) =>
      f.x === 603 ? { ...f, x: 602 } : f.x === 1149 ? { ...f, x: 1147 } : f,
    );
    const spec = deriveLayout(fields, TOKENS, { containerWidth: 1728 });
    expect(spec).toBeDefined();
    expect(spec!.gutter.token).toBeUndefined();
    expect(spec!.gutter.nearest).toBe("spacing/24");
    expect(offScale(spec!)[0]).toContain("gutter");
  });

  it("declines on a single column rather than inventing a grid", () => {
    const stacked: Rect[] = [0, 86, 172, 258].map((y) => ({ x: 56, y, width: 523, height: 62 }));
    expect(deriveLayout(stacked, TOKENS, { containerWidth: 1728 })).toBeUndefined();
  });

  it("declines when column pitch disagrees", () => {
    const irregular: Rect[] = [];
    for (const y of [0, 86, 172]) {
      irregular.push({ x: 56, y, width: 300, height: 62 });
      irregular.push({ x: 420, y, width: 300, height: 62 });
      irregular.push({ x: 1100, y, width: 300, height: 62 });
    }
    expect(deriveLayout(irregular, TOKENS, { containerWidth: 1728 })).toBeUndefined();
  });

  it("declines below the evidence threshold", () => {
    const thin: Rect[] = [
      { x: 56, y: 0, width: 523, height: 62 },
      { x: 603, y: 0, width: 523, height: 62 },
    ];
    expect(deriveLayout(thin, TOKENS, { containerWidth: 1728 })).toBeUndefined();
  });

  it("handles absolute bounds via originX", () => {
    const offset = tradeReviewFields().map((f) => ({ ...f, x: f.x + 13628 }));
    const spec = deriveLayout(offset, TOKENS, { containerWidth: 1728, originX: 13628 });
    expect(spec?.marginLeft.token).toBe("spacing/56");
    expect(spec?.columns).toBe(3);
  });
});

describe("columnWidthFor", () => {
  it("reproduces the measured column width from the rule", () => {
    // (1728 - 56 - 56 - 24*2) / 3 = 522.67 -> 523
    expect(columnWidthFor(1728, 3, 56, 56, 24)).toBe(523);
  });

  it("adapts the same convention to a narrower viewport", () => {
    expect(columnWidthFor(1440, 3, 56, 56, 24)).toBe(427);
  });
});

describe("recipe round-trip", () => {
  const withLayout = {
    version: 1,
    recipes: [
      {
        id: "trade-review-form",
        title: "Trade review form",
        intentAliases: ["review form", "import lc review"],
        layout: {
          columns: 3,
          columnWidth: 523,
          gutter: { px: 24, token: "spacing/24" },
          marginLeft: { px: 56, token: "spacing/56" },
          marginRight: { px: 56, token: "spacing/56" },
          rowGap: { px: 24, token: "spacing/24" },
          sampleSize: 12,
          evidence: { frames: ["ajTYKrXrjGyKNk6keTfuAQ:2138:6817"], confidence: "strong" },
        },
        slots: [{ role: "input", required: true, hints: ["input"] }],
      },
    ],
  };

  it("parses and re-serializes a layout without loss", async () => {
    const { parseRecipeFile, serializeRecipeFile } = await import("@/core/query");
    const parsed = parseRecipeFile(withLayout);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].layout?.columns).toBe(3);
    expect(parsed[0].layout?.gutter.token).toBe("spacing/24");
    expect(parsed[0].layout?.evidence?.confidence).toBe("strong");
    const round = serializeRecipeFile(parsed);
    expect(round.recipes[0].layout).toEqual(withLayout.recipes[0].layout);
  });

  it("still accepts a recipe with no layout", async () => {
    const { parseRecipeFile, starterRecipes } = await import("@/core/query");
    const plain = parseRecipeFile({
      version: 1,
      recipes: [{ id: "x", title: "X", slots: [{ role: "input" }] }],
    });
    expect(plain[0].layout).toBeUndefined();
    // The shipped starters stay product-agnostic — a grid is never a default.
    expect(starterRecipes().every((r) => r.layout === undefined)).toBe(true);
  });

  it("rejects a malformed layout rather than half-storing it", () => {
    const bad = JSON.parse(JSON.stringify(withLayout));
    bad.recipes[0].layout.columns = 0;
    return import("@/core/query").then(({ parseRecipeFile }) => {
      expect(parseRecipeFile(bad)).toHaveLength(0);
    });
  });
});

describe("layoutSummary", () => {
  it("prefers tokens over pixels", () => {
    const spec = deriveLayout(tradeReviewFields(), TOKENS, { containerWidth: 1728 })!;
    expect(layoutSummary(spec)).toBe(
      "3 cols · margin spacing/56 · gutter spacing/24 · row spacing/24",
    );
  });

  it("stays inside a card budget", () => {
    const spec = deriveLayout(tradeReviewFields(), TOKENS, { containerWidth: 1728 })!;
    expect(layoutSummary(spec).length).toBeLessThan(120);
  });
});
