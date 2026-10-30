import { describe, expect, it } from "vitest";
import { adaptFigmaMcpMetadata } from "@/core/ingestion/adapters/figmaMcp";
import { buildGraph } from "@/core/transform";
import { handoffSheet, indexGraph } from "@/core/query";

const XML = `<canvas id="0:1" name="Lib">
  <component-set id="10:0" name="Table cell" x="0" y="0" width="400" height="80">
    <component id="10:1" name="Data type=Text, Align=Left" x="0" y="0" width="200" height="40" />
    <component id="10:2" name="Data type=Amount, Align=Right" x="0" y="40" width="200" height="40" />
  </component-set>
</canvas>
<canvas id="0:2" name="Screens">
  <frame id="40:1" name="Orders Table" x="0" y="0" width="600" height="200">
    <instance id="30:1" name="Table cell" x="0" y="0" width="200" height="40" />
  </frame>
</canvas>`;

describe("draft handoff of a name-guessed copy", () => {
  it("shows the variant axes learned from layer names, still labelled name-guess", () => {
    const graph = buildGraph(adaptFigmaMcpMetadata({ fileKey: "PROPLAB", fileName: "Props Lab", metadataXml: XML }));
    const pack = handoffSheet(indexGraph(graph), ["Orders Table"], { draft: true });
    if (!pack.ok) throw new Error("draft refused");
    const cell = pack.screens[0]!.components.find((c) => c.name === "Table cell")!;
    expect(cell.identity).toBe("name-guess");
    expect(cell.properties?.map((p) => [p.property, p.values])).toEqual([
      ["Data type", ["Text", "Amount"]],
      ["Align", ["Left", "Right"]],
    ]);
    expect(cell.properties?.every((p) => p.defaultUnknown)).toBe(true);
  });
});
