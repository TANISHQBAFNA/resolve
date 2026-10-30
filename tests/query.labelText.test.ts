import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adaptFigmaRestFile } from "@/core/ingestion/adapters/figmaRest";
import { buildGraph } from "@/core/transform/buildGraph";
import { indexGraph } from "@/core/query/GraphIndex";
import { recommendMasters } from "@/core/query";
import { dropLabelText } from "@/core/query/labelText";
import { tokensOf } from "@/core/query/queryTokens";
import { clearCache } from "@/server/store";

const part = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, type: "COMPONENT", ...extra });

function acmeIndex() {
  const button = {
    id: "a:btn",
    name: "ingredients/button",
    type: "COMPONENT_SET",
    children: [
      part("a:btn-p", "Style=Primary", { componentSetId: "a:btn", variantProperties: { Style: "Primary" } }),
      part("a:btn-s", "Style=Secondary", { componentSetId: "a:btn", variantProperties: { Style: "Secondary" } }),
    ],
  };
  const file = {
    fileKey: "ACMEKEY",
    name: "Acme Library",
    document: { id: "0:0", name: "Document", type: "DOCUMENT", children: [{ id: "p:c", name: "Components", type: "CANVAS", children: [
      button,
      part("a:in", "ingredients/input"),
      part("a:if", "recipes/input-field"),
      part("a:pp", "recipes/payment-parties"),
      part("a:tg", "ingredients/toggle"),
      part("a:bd", "ingredients/badge"),
      part("a:fl", "base/field-label"),
    ] }] },
    components: {}, componentSets: {},
  };
  return indexGraph(buildGraph(adaptFigmaRestFile({ fileKey: file.fileKey, file, variables: {}, kind: "json", ingestedAt: "2026-10-29T00:00:00.000Z" }), { builtAt: "2026-10-29T00:00:00.000Z" }));
}

describe("dropLabelText", () => {
  it("drops quoted copy and a label clause, and keeps a describing tail", () => {
    expect(dropLabelText("A primary button labelled Pay now")).toBe("A primary button");
    expect(dropLabelText('primary button "Pay now"')).toBe("primary button");
    expect(dropLabelText("button “Pay now” for checkout")).toBe("button for checkout");
    expect(dropLabelText("button titled Pay now for the checkout")).toBe("button for the checkout");
    expect(dropLabelText("toggle that says Notify me with an icon")).toBe("toggle with an icon");
  });

  it("keeps a label word that describes the part, apostrophes, and an ask that is only copy", () => {
    expect(dropLabelText("labelled text field with helper text")).toBe("labelled text field with helper text");
    expect(dropLabelText("a labelled toggle")).toBe("a labelled toggle");
    expect(dropLabelText("the user's badge")).toBe("the user's badge");
    expect(dropLabelText('"Pay now"')).toBe('"Pay now"');
  });
});

describe("Figma pick with label text after the part name", () => {
  const previous = process.env["RESOLVE_HOME"];
  let names: (text: string) => string[];
  beforeEach(() => {
    process.env["RESOLVE_HOME"] = mkdtempSync(join(tmpdir(), "resolve-label-"));
    clearCache();
    const index = acmeIndex();
    names = (text) => (recommendMasters(index, text, { budgetChars: 4000 }) as unknown as { candidates: Array<{ name?: string }> }).candidates.map((row) => row.name ?? "");
  });
  afterEach(() => {
    clearCache();
    if (previous === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previous;
  });

  it("finds the part when trailing label text follows it", () => {
    for (const text of ["primary button", "A primary button labelled Pay now", "button labeled Pay now", "button that says Pay now", "button titled Pay now for checkout"]) {
      expect(names(text)[0], text).toBe("ingredients/button");
    }
  });

  it("finds the part when the label is quoted", () => {
    for (const text of ['primary button "Pay now"', "a toggle 'Notify me'", "badge “3 new”"]) {
      expect(names(text).length, text).toBeGreaterThan(0);
    }
    expect(names('primary button "Pay now"')[0]).toBe("ingredients/button");
    expect(names("a toggle 'Notify me'")[0]).toBe("ingredients/toggle");
    expect(names("badge “3 new”")[0]).toBe("ingredients/badge");
  });

  it("does not let label copy pull in a part named like the copy", () => {
    expect(names("button labelled Pay now")).not.toContain("recipes/payment-parties");
  });

  it("a leading 'titled' describes the part and is not a word to match", () => {
    expect(tokensOf("a titled card")).toEqual(["card"]);
    expect(names("a titled button")[0]).toBe("ingredients/button");
  });

  it("keeps the gate: extra words that are not label copy still find nothing", () => {
    for (const text of ["button pay", "toggle shop", '"Pay now"']) {
      expect(names(text), text).toEqual([]);
    }
  });
});
