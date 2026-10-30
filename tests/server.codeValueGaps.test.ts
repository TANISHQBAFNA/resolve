import { describe, expect, it } from "vitest";
import { codeValueWarnings } from "@/core/query/codeValueGaps";
import { pickComponents } from "@/server/code/pick";
import type { CodeCatalog } from "@/server/code/scan";

const properties = { "Data type": ["Text", "Amount", "Date", "Email"], Align: ["Left", "Right"] };
const modifiers = { "table-cell": ["table-cell--text", "table-cell--amount", "table-cell--date", "table-cell--money"] };

describe("Figma values against code modifiers", () => {
  it("warns about Figma values with no modifier and modifiers with no Figma value, with a next step", () => {
    expect(codeValueWarnings(properties, modifiers).warnings).toEqual([
      "Figma Data type values with no code modifier: Email. next: build these from the base class or say the modifier is missing; do not invent a class.",
      "Code modifiers with no Figma value: money. next: check whether Figma names it differently before using it.",
    ]);
  });

  it("skips an axis code does not build with modifiers, and says nothing when all values match", () => {
    expect(codeValueWarnings({ Align: ["Left", "Right"] }, modifiers)).toEqual({});
    expect(codeValueWarnings({ "Data type": ["Text", "Amount", "Date", "Money"] }, modifiers)).toEqual({});
    expect(codeValueWarnings(undefined, modifiers)).toEqual({});
  });

  it("code_pick carries the warnings on a linked component", () => {
    const catalog: CodeCatalog = {
      version: 1,
      builtAt: "2026-01-01T00:00:00.000Z",
      repoPath: "/repo",
      cssFiles: ["table-cell.css"],
      globalClasses: [],
      deprecated: {},
      tokens: { names: [], colors: {}, fonts: {} },
      components: [
        {
          name: "table-cell",
          kind: "block",
          description: "",
          variants: ["amount", "date", "money", "text"],
          rules: [],
          figma: { name: "Table cell", variants: ["Amount", "Date", "Email", "Left", "Right", "Text"], properties },
          matchedBy: "exact",
          code: { roots: ["table-cell"], elements: [], states: [], modifiers, deprecated: [], tokens: [], markup: '<div class="table-cell">', cssFile: "table-cell.css", cssFiles: ["table-cell.css"], primary: "table-cell", usedIn: 0 },
        },
      ],
    } as unknown as CodeCatalog;
    const [cell] = pickComponents(catalog, "amount table cell").components as Array<{ warnings?: string[] }>;
    expect(cell?.warnings).toHaveLength(2);
  });
});
