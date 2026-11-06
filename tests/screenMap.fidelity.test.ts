import { describe, expect, it } from "vitest";
import { adaptFigmaMcpMetadata, adaptFigmaRestFile } from "@/core/ingestion";
import { buildScreenMap } from "@/core/screenMap/document";
import { driftView, journeyView } from "@/core/screenMap/views";
import { buildGraph } from "@/core/transform";

const FROZEN = "2026-11-05T00:00:00.000Z";

/** Hand audit for ten Acme screens. The REST payload is built from this table. */
const AUDIT = [
  { screen: "Cart", gap: 8, padding: [8, 8, 8, 8], fill: "raw" as const },
  { screen: "Address", gap: 12, padding: [12, 16, 12, 16], fill: "variable" as const },
  { screen: "Shipping", gap: 4, padding: [4, 4, 4, 4], fill: "raw" as const },
  { screen: "Payment", gap: 16, padding: [16, 16, 16, 16], fill: "variable" as const },
  { screen: "Review", gap: 8, padding: [8, 12, 8, 12], fill: "raw" as const },
  { screen: "Confirmation", gap: 4, padding: [0, 0, 0, 0], fill: "raw" as const },
  { screen: "Empty cart", gap: 8, padding: [24, 24, 24, 24], fill: "variable" as const },
  { screen: "Sign in", gap: 12, padding: [12, 12, 12, 12], fill: "raw" as const },
  { screen: "Order list", gap: 4, padding: [8, 8, 8, 8], fill: "raw" as const },
  { screen: "Order detail", gap: 16, padding: [16, 8, 16, 8], fill: "variable" as const },
];

function restFile() {
  const screens = AUDIT.map((row, index) => ({
    id: `1:${index + 1}`,
    name: row.screen,
    type: "FRAME",
    layoutMode: "VERTICAL",
    itemSpacing: row.gap,
    paddingTop: row.padding[0],
    paddingRight: row.padding[1],
    paddingBottom: row.padding[2],
    paddingLeft: row.padding[3],
    fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }],
    ...(row.fill === "variable" ? { boundVariables: { fills: { type: "VARIABLE_ALIAS", id: "VariableID:1:1" } } } : {}),
    children: [{ id: `2:${index + 1}`, name: "Button", type: "INSTANCE", componentId: "9:1" }],
  }));
  return {
    name: "Acme Checkout",
    version: "11",
    document: {
      id: "0:0",
      name: "Acme Checkout",
      type: "DOCUMENT",
      children: [
        { id: "0:1", name: "Checkout", type: "CANVAS", children: screens },
        { id: "0:2", name: "Components", type: "CANVAS", children: [{ id: "9:1", name: "Button", type: "COMPONENT" }] },
      ],
    },
    components: { "9:1": { key: "acme-button", name: "Button" } },
  };
}

describe("screen map fidelity", () => {
  it("matches the ten-screen Acme hand audit for master, binding kind, and layout", () => {
    const graph = buildGraph(adaptFigmaRestFile({ fileKey: "acme-checkout", file: restFile(), kind: "figma-rest", ingestedAt: FROZEN }), { builtAt: FROZEN });
    const map = buildScreenMap(graph, { builtAt: FROZEN });
    const drift = driftView(map);
    for (const row of AUDIT) {
      const screen = Object.values(map.nodes).find((node) => node.name === row.screen && node.type === "screen");
      expect(screen?.layout).toMatchObject({ direction: "VERTICAL", gap: row.gap, padding: row.padding });
      const button = Object.values(map.nodes).find((node) => node.parentId === screen?.id && node.name === "Button");
      expect(button?.ds?.masterId).toBe("node:9:1");
      expect(button?.identity).toBe("extracted");
      const fill = screen?.binding?.find((item) => item.slot === "fill");
      expect(fill?.kind).toBe(row.fill);
      if (row.fill === "raw") expect(drift.raw.some((item) => item.id === screen?.id && item.slot === "fill")).toBe(true);
    }
  });

  it("marks the same screens guessed via MCP and does not invent a journey", () => {
    const xml = AUDIT.map((row, index) => `<frame id="1:${index + 1}" name="${row.screen}" x="0" y="${index * 40}" width="200" height="40"><instance id="2:${index + 1}" name="Button" x="0" y="0" width="80" height="32" /></frame>`).join("");
    const graph = buildGraph(adaptFigmaMcpMetadata({ fileKey: "acme-checkout", fileName: "Acme Checkout", ingestedAt: FROZEN, metadataXml: xml }), { builtAt: FROZEN });
    const map = buildScreenMap(graph, { builtAt: FROZEN });
    const screens = Object.values(map.nodes).filter((node) => AUDIT.some((row) => row.screen === node.name));
    expect(screens.length).toBeGreaterThan(0);
    expect(Object.values(map.nodes).some((node) => node.identity === "extracted")).toBe(false);
    expect(Object.values(map.nodes).some((node) => node.identity === "guessed")).toBe(true);
    const start = screens[0]!;
    const journey = journeyView(map, graph, start.id);
    expect(journey.steps).toEqual([]);
    expect(journey.warnings.some((warning) => warning.code === "W-MAP-NO-PROTO")).toBe(true);
  });
});
