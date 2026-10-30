import { describe, expect, it } from "vitest";
import { adaptFigmaMcpMetadata } from "@/core/ingestion/adapters/figmaMcp";
import { applyLearnedProperties } from "@/core/ingestion/componentProperties";
import { buildGraph } from "@/core/transform";

const KIT = `<frame id="1:1" name="Kit">
  <component-set id="10:0" name="Table cell">
    <component id="10:1" name="Data type=Text, Align=Left" />
    <component id="10:2" name="Data type=Amount, Align=Right" />
  </component-set>
</frame>`;

const setOf = (graph: ReturnType<typeof buildGraph>) => graph.nodes.find((n) => n.type === "COMPONENT_SET" && n.name === "Table cell")!;

describe("design context merges property definitions", () => {
  it("adds on/off and text properties without dropping variant axes read from names", () => {
    const graph = buildGraph(adaptFigmaMcpMetadata({ fileKey: "PROPLAB", fileName: "Props Lab", metadataXml: KIT }));
    const context = {
      nodes: [
        {
          id: "10:0",
          componentPropertyDefinitions: {
            "Data type": { type: "VARIANT", defaultValue: "Text" },
            "Show icon#12:0": { type: "BOOLEAN", defaultValue: true },
            "Value#12:1": { type: "TEXT", defaultValue: "-" },
          },
        },
      ],
    };
    expect(applyLearnedProperties(graph, context)).toBe(1);
    const defs = setOf(graph).propertyDefinitions!;
    expect(defs.map((d) => d.name)).toEqual(["Data type", "Show icon", "Value", "Align"]);
    expect(defs.find((d) => d.name === "Data type")).toMatchObject({ defaultValue: "Text", options: ["Text", "Amount"] });
    expect(defs.find((d) => d.name === "Data type")?.optionsUnknown).toBeUndefined();
    expect(defs.find((d) => d.name === "Align")?.options).toEqual(["Left", "Right"]);
  });
});
