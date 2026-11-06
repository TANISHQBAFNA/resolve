import { describe, expect, it } from "vitest";
import { adaptFigmaMcpMetadata, adaptFigmaRestFile } from "@/core/ingestion";
import { buildGraph } from "@/core/transform";
import { controllingFromReferences, projectMeta, textLineCount } from "@/core/screenMap/capture";

const FROZEN = "2026-11-05T00:00:00.000Z";

function frame(id: string, name: string, fields: Record<string, unknown>) {
  return { id, name, type: "FRAME", ...fields };
}

const hands = [
  { id: "1:1", name: "Form", layoutMode: "VERTICAL", paddingTop: 8, paddingRight: 8, paddingBottom: 8, paddingLeft: 8, itemSpacing: 16, primaryAxisAlignItems: "MIN", counterAxisAlignItems: "CENTER", cornerRadius: 4 },
  { id: "1:2", name: "Input", layoutMode: "HORIZONTAL", paddingTop: 12, paddingRight: 16, paddingBottom: 12, paddingLeft: 16, itemSpacing: 8, cornerRadius: 8, primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "CENTER" },
  { id: "1:3", name: "Zero pad", layoutMode: "VERTICAL", paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0, itemSpacing: 4 },
  { id: "1:4", name: "Wrapped", layoutMode: "HORIZONTAL", layoutWrap: "WRAP", itemSpacing: 4, primaryAxisAlignItems: "SPACE_BETWEEN", counterAxisAlignItems: "MIN" },
  { id: "1:5", name: "Corners", layoutMode: "VERTICAL", itemSpacing: 0, topLeftRadius: 2, topRightRadius: 4, bottomRightRadius: 6, bottomLeftRadius: 8 },
  { id: "1:6", name: "Raw fill", layoutMode: "VERTICAL", itemSpacing: 4, fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }] },
  { id: "1:7", name: "Token fill", layoutMode: "VERTICAL", itemSpacing: 4, fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, boundVariables: { color: { type: "VARIABLE_ALIAS", id: "VariableID:1:1" } } }] },
  { id: "1:8", name: "Token gap", layoutMode: "VERTICAL", itemSpacing: 4, boundVariables: { itemSpacing: { type: "VARIABLE_ALIAS", id: "VariableID:1:2" } } },
  { id: "1:9", name: "Shadow", layoutMode: "VERTICAL", itemSpacing: 8, effects: [{ type: "DROP_SHADOW", visible: true, color: { r: 0, g: 0, b: 0, a: 0.2 }, offset: { x: 0, y: 2 }, radius: 8 }] },
  { id: "1:10", name: "Helper", type: "TEXT", characters: "Pay Acme\n411122", layoutMode: "VERTICAL", itemSpacing: 0, componentPropertyReferences: { visible: "showHelper#9:1" } },
];

function acmeFile() {
  return {
    name: "Acme Checkout",
    version: "7",
    document: {
      id: "0:0",
      name: "Document",
      type: "DOCUMENT",
      children: [{ id: "0:1", name: "Checkout", type: "CANVAS", children: hands.map((hand) => frame(hand.id, hand.name, hand)) }],
    },
    components: {},
    componentSets: {},
  };
}

function sourceNodes() {
  const doc = adaptFigmaRestFile({ fileKey: "acme-checkout", file: acmeFile(), kind: "figma-rest", ingestedAt: FROZEN });
  const page = doc.root.children?.[0];
  return new Map((page?.children ?? []).map((node) => [node.id, node]));
}

describe("screen map capture", () => {
  it("matches hand layout values on 10 Acme nodes", () => {
    const nodes = sourceNodes();
    expect(nodes.size).toBe(10);
    const form = nodes.get("1:1")!;
    expect(form.layoutMode).toBe("VERTICAL");
    expect(form.paint?.padding).toEqual([8, 8, 8, 8]);
    expect(form.paint?.gap).toBe(16);
    expect(form.paint?.radius).toBe(4);
    expect(form.primaryAxisAlignItems).toBe("MIN");
    expect(form.counterAxisAlignItems).toBe("CENTER");

    const input = nodes.get("1:2")!;
    expect(input.layoutMode).toBe("HORIZONTAL");
    expect(input.paint?.padding).toEqual([12, 16, 12, 16]);
    expect(input.paint?.gap).toBe(8);
    expect(input.paint?.radius).toBe(8);

    expect(nodes.get("1:3")?.paint?.padding).toEqual([0, 0, 0, 0]);
    expect(nodes.get("1:3")?.paint?.gap).toBe(4);
    expect(nodes.get("1:4")?.layoutWrap).toBe("WRAP");
    expect(nodes.get("1:5")?.paint?.cornerRadii).toEqual({ tl: 2, tr: 4, br: 6, bl: 8 });
    expect(nodes.get("1:9")?.paint?.effects).toEqual([{ type: "DROP_SHADOW", bound: false }]);
    expect(nodes.get("1:9")?.paint?.effectUnbound).toBe(true);
    expect(JSON.stringify(nodes.get("1:9")?.paint?.effects)).not.toMatch(/offset|image/i);
  });

  it("marks token and raw bindings, and keeps a hidden child controlled by showHelper", () => {
    const nodes = sourceNodes();
    const graph = buildGraph(adaptFigmaRestFile({ fileKey: "acme-checkout", file: acmeFile(), kind: "figma-rest", ingestedAt: FROZEN }), { builtAt: FROZEN });
    const helper = graph.nodes.find((node) => node.figmaNodeId === "1:10");
    expect(helper?.metadata?.["componentPropertyReferences"]).toEqual({ visible: "showHelper#9:1" });
    expect(controllingFromReferences({ visible: "showHelper#9:1" }, [{ name: "showHelper", type: "BOOLEAN" }])).toEqual({
      property: "showHelper",
      type: "BOOLEAN",
    });

    const raw = projectMeta({ meta: { paint: nodes.get("1:6")?.paint }, sourceKind: "figma-rest" });
    expect(raw.binding?.find((row) => row.slot === "fill")).toMatchObject({ kind: "raw", raw: "#FF0000" });

    const token = projectMeta({
      meta: { paint: nodes.get("1:7")?.paint },
      sourceKind: "figma-rest",
      variables: { fills: "var:color-surface", "fills[0]": "var:color-surface" },
      names: { "var:color-surface": "color-surface" },
    });
    expect(token.binding?.find((row) => row.slot === "fill")?.kind).toBe("variable");

    const gap = projectMeta({
      meta: { paint: nodes.get("1:8")?.paint, layoutMode: "VERTICAL" },
      sourceKind: "figma-rest",
      variables: { itemSpacing: "var:space-1" },
      names: { "var:space-1": "space-1" },
    });
    expect(gap.binding?.find((row) => row.slot === "gap")).toMatchObject({ kind: "variable", name: "space-1" });
    expect(gap.layout).toMatchObject({ direction: "VERTICAL", gap: 4 });
  });

  it("counts lines and does not keep the words", () => {
    expect(textLineCount("Pay Acme\n411122")).toBe(2);
    const projected = projectMeta({
      meta: { text: "Pay Acme\n411122", figmaType: "TEXT" },
      sourceKind: "figma-rest",
      textNode: true,
    });
    expect(projected.text).toEqual({ present: true, lines: 2 });
    const json = JSON.stringify(projected);
    expect(json).not.toContain("Pay Acme");
    expect(json).not.toContain("411122");
    expect(json).not.toContain("characters");
    expect(json).not.toContain("thumbnailUrl");
  });

  it("marks an MCP capture unknown and guessed, never extracted", () => {
    const doc = adaptFigmaMcpMetadata({
      fileKey: "acme-checkout",
      fileName: "Acme Checkout",
      ingestedAt: FROZEN,
      metadataXml: `<frame id="1:1" name="Payment" x="0" y="0" width="400" height="800"><instance id="1:2" name="Input field" x="16" y="16" width="200" height="48" /></frame>`,
    });
    const graph = buildGraph(doc, { builtAt: FROZEN });
    const guessed = graph.nodes.filter((node) => node.metadata?.["identity"] === "inferred-from-name");
    expect(guessed.length).toBeGreaterThan(0);
    expect(graph.nodes.some((node) => node.metadata?.["identity"] === "extracted")).toBe(false);
    const projected = projectMeta({ meta: {}, sourceKind: "figma-mcp" });
    expect(projected.layout).toEqual({ unknown: true });
    expect(projected.binding).toEqual([{ slot: "style", kind: "unknown" }]);
    expect(JSON.stringify(projected)).not.toMatch(/extracted/);
  });
});
