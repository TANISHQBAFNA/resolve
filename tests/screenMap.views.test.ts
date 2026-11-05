import { describe, expect, it } from "vitest";
import { adaptFigmaMcpMetadata, adaptFigmaRestFile } from "@/core/ingestion";
import { buildScreenMap } from "@/core/screenMap/document";
import { driftView, journeyView, nodeView, outlineView } from "@/core/screenMap/views";
import { buildGraph } from "@/core/transform";

const FROZEN = "2026-11-05T00:00:00.000Z";

function file() {
  const solid = (bound: boolean) => ({
    type: "SOLID",
    color: { r: 1, g: 0, b: 0 },
    ...(bound ? { boundVariables: { color: { type: "VARIABLE_ALIAS", id: "VariableID:9:9" } } } : {}),
  });
  return {
    name: "Acme Checkout",
    version: "3",
    document: {
      id: "0:0",
      name: "Acme Checkout",
      type: "DOCUMENT",
      children: [
        {
          id: "0:1",
          name: "Checkout",
          type: "CANVAS",
          children: [
            {
              id: "1:1",
              name: "Cart",
              type: "FRAME",
              transitionNodeID: "1:2",
              layoutMode: "VERTICAL",
              paddingTop: 18,
              paddingRight: 18,
              paddingBottom: 18,
              paddingLeft: 18,
              itemSpacing: 8,
              fills: [solid(false)],
              children: [
                { id: "1:4", name: "Button", type: "FRAME" },
                {
                  id: "1:5",
                  name: "Input field",
                  type: "INSTANCE",
                  componentId: "8:2",
                  componentProperties: {
                    "size#1:0": { type: "VARIANT", value: "md" },
                    "state#1:1": { type: "VARIANT", value: "error" },
                    "required#1:2": { type: "BOOLEAN", value: true },
                    "showHelper#1:3": { type: "BOOLEAN", value: false },
                  },
                  children: [
                    { id: "1:6", name: "Label", type: "TEXT", characters: "Label" },
                    {
                      id: "1:7",
                      name: "Input",
                      type: "FRAME",
                      layoutMode: "HORIZONTAL",
                      paddingTop: 12,
                      paddingRight: 16,
                      paddingBottom: 12,
                      paddingLeft: 16,
                      cornerRadius: 8,
                    },
                    {
                      id: "1:8",
                      name: "Helper text",
                      type: "TEXT",
                      visible: false,
                      characters: "Pay Acme 411122",
                      componentPropertyReferences: { visible: "showHelper#1:3" },
                    },
                  ],
                },
              ],
            },
            { id: "1:2", name: "Pay", type: "FRAME", transitionNodeID: "1:3" },
            { id: "1:3", name: "Done", type: "FRAME", transitionNodeID: "1:1" },
          ],
        },
        {
          id: "0:2",
          name: "Components",
          type: "CANVAS",
          children: [
            { id: "8:1", name: "Button", type: "COMPONENT" },
            { id: "8:2", name: "Input field", type: "COMPONENT" },
          ],
        },
      ],
    },
    components: {
      "8:1": { key: "button", name: "Button" },
      "8:2": { key: "input", name: "Input field" },
    },
  };
}

function built() {
  const graph = buildGraph(
    adaptFigmaRestFile({ fileKey: "acme-checkout", file: file(), kind: "figma-rest", ingestedAt: FROZEN }),
    { builtAt: FROZEN },
  );
  return { graph, map: buildScreenMap(graph, { builtAt: FROZEN }) };
}

describe("screen map views", () => {
  it("walks a 3-screen loop once and records the back edge", () => {
    const { graph, map } = built();
    const cart = Object.values(map.nodes).find((node) => node.name === "Cart")!;
    const journey = journeyView(map, graph, cart.id);
    expect(journey.steps.map((step) => step["name"])).toEqual(["Cart", "Pay", "Done"]);
    expect(journey.loops).toEqual([expect.objectContaining({ to: cart.id })]);
    expect(journey.truncated).toBe(false);
    expect(String(journey.next).length).toBeGreaterThan(0);
  });

  it("shows the Acme input field as its own tree, including a hidden helper", () => {
    const { map } = built();
    const screen = Object.values(map.nodes).find((node) => node.name === "Cart")!;
    const view = nodeView(map, screen.id, undefined, "screen");
    const input = view.nodes.find((node) => node.name === "Input field");
    expect(input?.ds?.componentProperties).toMatchObject({ size: "md", state: "error", required: true, showHelper: false });
    expect(view.nodes.map((node) => node.name)).toEqual(expect.arrayContaining(["Label", "Input", "Helper text"]));
    const helper = view.nodes.find((node) => node.name === "Helper text");
    expect(helper?.flags?.hidden).toBe(true);
    expect(helper?.controlledBy?.property).toBe("showHelper");
    expect(JSON.stringify(view)).not.toContain("Pay Acme");
    expect(JSON.stringify(view)).not.toContain("411122");
  });

  it("lists every raw padding and fill in drift, and the detached Button, with no lookalike flag", () => {
    const { map } = built();
    const drift = driftView(map);
    expect(drift.raw.some((row) => row.slot === "padding" && Array.isArray(row.raw) && row.raw[0] === 18)).toBe(true);
    expect(drift.raw.some((row) => row.slot === "fill" && row.raw === "#FF0000")).toBe(true);
    expect(drift.detached.map((row) => row.name)).toContain("Button");
    expect(drift.warnings.some((warning) => warning.code === "W-MAP-DETACHED")).toBe(true);
    expect(Object.values(map.nodes).some((node) => node.flags?.lookalike)).toBe(false);
    expect(drift.lookalikes).toBeUndefined();
    expect(outlineView(map).items.map((item) => item.name)).toEqual(expect.arrayContaining(["Cart", "Pay", "Done"]));
  });

  it("warns when a journey has no prototype edges", () => {
    const graph = buildGraph(
      adaptFigmaMcpMetadata({
        fileKey: "acme-checkout",
        fileName: "Acme Checkout",
        ingestedAt: FROZEN,
        metadataXml: `<frame id="1:1" name="Payment" x="0" y="0" width="400" height="800" />`,
      }),
      { builtAt: FROZEN },
    );
    const map = buildScreenMap(graph, { builtAt: FROZEN });
    const screen = Object.values(map.nodes).find((node) => node.type === "screen")!;
    const journey = journeyView(map, graph, screen.id);
    expect(journey.steps).toEqual([]);
    expect(journey.warnings[0]?.code).toBe("W-MAP-NO-PROTO");
    expect(journey.next).toContain("REST");
  });
});
