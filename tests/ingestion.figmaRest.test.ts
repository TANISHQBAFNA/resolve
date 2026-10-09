import { describe, expect, it } from "vitest";
import { adaptFigmaRestFile, parseVariantName } from "@/core/ingestion";
import { buildGraph } from "@/core/transform";
import { sourceDocument } from "./fixture";

const findNode = (id: string) => {
  const walk = (node: typeof sourceDocument.root): typeof sourceDocument.root | undefined => {
    if (node.id === id) return node;
    for (const child of node.children ?? []) {
      const found = walk(child);
      if (found) return found;
    }
    return undefined;
  };
  return walk(sourceDocument.root);
};

describe("figma REST adapter", () => {
  it("normalises the document tree without losing pages", () => {
    expect(sourceDocument.root.type).toBe("DOCUMENT");
    expect(sourceDocument.root.children).toHaveLength(4);
    expect(sourceDocument.fileName).toBe("Demo Pay — Product");
  });

  it("parses Figma's variant naming convention", () => {
    expect(parseVariantName("Variant=Primary, Size=Medium")).toEqual({
      Variant: "Primary",
      Size: "Medium",
    });
    expect(parseVariantName("Button")).toBeUndefined();
  });

  it("attaches variant properties only inside a component set", () => {
    expect(findNode("30:11")?.variantProperties).toEqual({
      Variant: "Primary",
      Size: "Medium",
    });
    expect(findNode("30:30")?.variantProperties).toBeUndefined();
  });

  it("flattens bound variables into property -> variable id", () => {
    expect(findNode("10:21")?.variableIds).toEqual({ itemSpacing: "VariableID:1:2" });
    expect(findNode("30:11")?.variableIds).toEqual({
      "fills[0]": "VariableID:2:3",
      topLeftRadius: "VariableID:1:3",
    });
  });

  it("keeps style slot names so the edge can be labelled", () => {
    expect(findNode("10:10")?.styleIds).toEqual({
      fill: "S:a1b2c3d4e5f6,1",
      grid: "S:f6a1b2c3d4e5,6",
    });
  });

  it("converts prototype transitions, including seconds to milliseconds", () => {
    expect(findNode("10:10")?.transitions).toEqual([
      {
        destinationId: "10:20",
        trigger: "ON_CLICK",
        action: "NAVIGATE",
        durationMs: 300,
        easing: "EASE_OUT",
      },
    ]);
  });

  it("keeps text and sizing from the REST node", () => {
    const doc = adaptFigmaRestFile({
      fileKey: "SIZE",
      file: {
        name: "Sizing",
        document: {
          id: "0:0",
          type: "DOCUMENT",
          children: [
            {
              id: "1:1",
              type: "TEXT",
              name: "Label",
              characters: "Request Bank Certificate",
              layoutSizingVertical: "FIXED",
              minHeight: 320,
            },
          ],
        },
      },
      kind: "mock",
    });
    const text = doc.root.children?.[0];
    expect(text?.characters).toBe("Request Bank Certificate");
    expect(text?.layoutSizingVertical).toBe("FIXED");
    expect(text?.minHeight).toBe(320);
  });

  it("detects image fills and auto layout", () => {
    expect(findNode("10:14")?.hasImageFill).toBe(true);
    expect(findNode("10:21")?.layoutMode).toBe("VERTICAL");
    expect(findNode("10:20")?.layoutMode).toBeUndefined();
  });

  it("links a node only when the figma URL names this file", () => {
    const ingested = "THISFILEKEY0001";
    const doc = adaptFigmaRestFile({
      fileKey: ingested,
      kind: "mock",
      ingestedAt: "2026-01-01T00:00:00.000Z",
      file: {
        name: "A",
        document: {
          id: "0:0",
          type: "DOCUMENT",
          children: [
            {
              id: "1:1",
              name: "Screen",
              type: "FRAME",
              documentationLinks: [{ uri: `https://www.figma.com/design/${ingested}/A?node-id=1-9` }],
            },
            { id: "1:9", name: "Guide", type: "FRAME" },
            {
              id: "1:2",
              name: "Elsewhere",
              type: "FRAME",
              documentationLinks: [{ uri: "https://www.figma.com/design/OTHERFILEKEY0001/Other?node-id=1-9" }],
            },
          ],
        },
      },
    });
    const same = doc.root.children?.[0]?.links?.[0];
    const other = doc.root.children?.[2]?.links?.[0];
    expect(same?.targetFigmaNodeId).toBe("1:9");
    expect(same?.targetFileKey).toBe(ingested);
    expect(other?.targetFigmaNodeId).toBeUndefined();
    expect(other?.targetFileKey).toBe("OTHERFILEKEY0001");
    const built = buildGraph(doc, { builtAt: "2026-01-01T00:00:00.000Z" });
    const links = built.edges.filter((edge) => edge.type === "LINKS_TO");
    expect(links).toHaveLength(1);
    expect(links[0]?.source).toBe("node:1:1");
    expect(links[0]?.target).toBe("node:1:9");
  });

  it("resolves figma links to node ids and keeps external links raw", () => {
    const docLink = sourceDocument.components["30:30"]?.documentationLinks?.[0];
    expect(docLink?.targetFileKey).toBe("DemoPay0000DemoFileKey");
    expect(docLink?.targetFigmaNodeId).toBeUndefined();
    expect(findNode("10:26")?.links?.[0]).toEqual({
      url: "https://demo.example.com/legal/terms",
    });
  });

  it("groups remote entities under a synthetic library", () => {
    expect(sourceDocument.libraries["external-unknown"]).toBeDefined();
    expect(sourceDocument.components["RE:1001"]?.remote).toBe(true);
    expect(sourceDocument.components["RE:1001"]?.libraryId).toBe("external-unknown");
  });

  it("reads variables from the separate variables payload", () => {
    expect(Object.keys(sourceDocument.variables)).toHaveLength(6);
    expect(sourceDocument.variables["VariableID:2:2"]?.aliasOf).toEqual(["VariableID:1:1"]);
    expect(sourceDocument.variableCollections["VariableCollectionId:2:0"]?.modes).toEqual([
      { id: "2:0", name: "Light" },
      { id: "2:1", name: "Dark" },
    ]);
  });

  it("works with no variables payload at all", () => {
    const withoutVariables = adaptFigmaRestFile({
      fileKey: "NOVARS",
      file: { name: "Empty", document: { id: "0:0", type: "DOCUMENT", children: [] } },
    });
    expect(withoutVariables.variables).toEqual({});
    expect(withoutVariables.variableCollections).toEqual({});
  });
});
