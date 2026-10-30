import { describe, expect, it } from "vitest";
import { adaptFigmaRestFile } from "@/core/ingestion";
import { buildGraph } from "@/core/transform";
import { formatHandoffScreen, handoffSheet, indexGraph } from "@/core/query";

const FROZEN = "2026-01-01T00:00:00.000Z";
const copy = (id: string, show: boolean, value: string, icon: string) => ({
  id,
  name: "Table cell",
  type: "INSTANCE",
  componentId: "10:2",
  componentProperties: {
    "Data type": { type: "VARIANT", value: "Amount" },
    "Show icon#12:0": { type: "BOOLEAN", value: show },
    "Value#12:1": { type: "TEXT", value },
    "Icon#12:2": { type: "INSTANCE_SWAP", value: icon },
  },
  children: [],
});
const file = {
  name: "Props Lab",
  document: {
    id: "0:0",
    name: "Document",
    type: "DOCUMENT",
    children: [
      {
        id: "0:1",
        name: "Lib",
        type: "CANVAS",
        children: [
          {
            id: "10:0",
            name: "Table cell",
            type: "COMPONENT_SET",
            componentPropertyDefinitions: {
              "Data type": { type: "VARIANT", defaultValue: "Text", variantOptions: ["Text", "Amount"] },
              "Show icon#12:0": { type: "BOOLEAN", defaultValue: true },
              "Value#12:1": { type: "TEXT", defaultValue: "-" },
              "Icon#12:2": { type: "INSTANCE_SWAP", defaultValue: "20:1" },
            },
            children: [
              { id: "10:1", name: "Data type=Text", type: "COMPONENT", children: [] },
              { id: "10:2", name: "Data type=Amount", type: "COMPONENT", children: [] },
            ],
          },
          { id: "20:1", name: "Icon/Arrow", type: "COMPONENT", children: [] },
          { id: "20:2", name: "Icon/Check", type: "COMPONENT", children: [] },
        ],
      },
      { id: "0:2", name: "Screens", type: "CANVAS", children: [{ id: "40:1", name: "Orders Table", type: "FRAME", children: [copy("30:1", false, "1,200", "20:2"), copy("30:2", true, "30", "20:1")] }] },
    ],
  },
  components: { "10:1": { key: "k1", name: "Data type=Text", componentSetId: "10:0" }, "10:2": { key: "k2", name: "Data type=Amount", componentSetId: "10:0" }, "20:1": { key: "kA", name: "Icon/Arrow" }, "20:2": { key: "kC", name: "Icon/Check" } },
  componentSets: { "10:0": { key: "kCell", name: "Table cell" } },
};

describe("handoff carries each copy's own property values", () => {
  const graph = buildGraph(adaptFigmaRestFile({ fileKey: "PROPLAB", file, kind: "mock", ingestedAt: FROZEN }), { builtAt: FROZEN });
  const pack = handoffSheet(indexGraph(graph), ["Orders Table"]);

  it("lists on/off, text, and swap values per copy, swap ids read as names", () => {
    if (!pack.ok) throw new Error("handoff refused");
    const cell = pack.screens[0]!.components.find((c) => c.name === "Table cell")!;
    expect(cell.copyValues).toEqual([
      { copy: "30:1", values: { "Show icon": "false", Value: "1,200", Icon: "Icon/Check" } },
      { copy: "30:2", values: { "Show icon": "true", Value: "30", Icon: "Icon/Arrow" } },
    ]);
  });

  it("prints them in the markdown sheet", () => {
    if (!pack.ok) throw new Error("handoff refused");
    expect(formatHandoffScreen(pack.screens[0]!, false)).toContain("- Copy values: 30:1 Show icon=false, Value=1,200, Icon=Icon/Check; 30:2 Show icon=true, Value=30, Icon=Icon/Arrow");
  });
});
