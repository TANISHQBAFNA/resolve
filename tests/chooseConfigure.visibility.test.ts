import { describe, expect, it } from "vitest";
import { adaptFigmaMcpMetadata, adaptFigmaRestFile } from "@/core/ingestion";
import { buildGraph } from "@/core/transform";
import { indexGraph } from "@/core/query";
import { configureChoice, type ControlledChild } from "@/core/chooseConfigure/configure";

const FROZEN = "2026-11-05T00:00:00.000Z";

function restGraph() {
  const file = {
    name: "Acme",
    version: "1",
    document: {
      id: "0:0",
      name: "Document",
      type: "DOCUMENT",
      children: [{
        id: "0:1",
        name: "Checkout",
        type: "CANVAS",
        children: [{
          id: "1:1",
          name: "Button",
          type: "COMPONENT_SET",
          componentPropertyDefinitions: { "showHelper#1:3": { type: "BOOLEAN", defaultValue: true } },
          children: [{
            id: "1:2",
            name: "Style=Primary",
            type: "COMPONENT",
            children: [
              { id: "1:10", name: "Helper on", type: "TEXT", characters: "On", componentPropertyReferences: { visible: "showHelper#1:3" }, componentProperties: { "showHelper#1:3": { type: "BOOLEAN", value: true } } },
              { id: "1:11", name: "Helper off", type: "TEXT", characters: "Off", visible: false, componentPropertyReferences: { visible: "showHelper#1:3" }, componentProperties: { "showHelper#1:3": { type: "BOOLEAN", value: false } } },
              { id: "1:12", name: "Helper missing", type: "TEXT", characters: "Missing", componentPropertyReferences: { visible: "showHelper#1:3" } },
              { id: "1:13", name: "Helper overridden", type: "TEXT", characters: "Over", componentPropertyReferences: { visible: "showHelper#1:3" }, componentProperties: { "showHelper#1:3": { type: "BOOLEAN", value: true } }, overrides: [{ id: "1:13", overriddenFields: ["visible"] }] },
              { id: "1:14", name: "Helper stray", type: "TEXT", characters: "Stray", componentPropertyReferences: { visible: "notAProperty#9:9" } },
            ],
          }],
        }],
      }],
    },
    components: { "1:2": { key: "btn", name: "Button", componentSetId: "1:1" } },
    componentSets: { "1:1": { key: "set", name: "Button" } },
  };
  const source = adaptFigmaRestFile({ fileKey: "acme", file, kind: "figma-rest", ingestedAt: FROZEN });
  return indexGraph(buildGraph(source, { builtAt: FROZEN }));
}

describe("configure reads captured visibility", () => {
  it("keeps boolean true, false, missing, and overridden children, and ignores a stray reference", () => {
    const report = configureChoice(restGraph(), "button");
    expect(report.choice?.name).toBe("Button");
    expect(report.visibility.state).toBe("controlled");
    if (report.visibility.state !== "controlled") return;
    const byName = new Map(report.visibility.children.map((child) => [child.child, child]));
    expect(byName.get("Helper on")).toMatchObject({ property: "showHelper", type: "BOOLEAN", value: true });
    expect(byName.get("Helper off")).toMatchObject({ property: "showHelper", type: "BOOLEAN", value: false, hidden: true } satisfies Partial<ControlledChild>);
    expect(byName.get("Helper missing")).toMatchObject({ property: "showHelper", value: "missing" });
    expect(byName.get("Helper overridden")).toMatchObject({ property: "showHelper", value: true, overridden: true });
    expect(byName.has("Helper stray")).toBe(false);
    expect(report.warnings.some((row) => row.warning.includes("does not match a property"))).toBe(true);
  });

  it("does not treat a guessed instance as a controlling property", () => {
    const source = adaptFigmaMcpMetadata({
      fileKey: "acme",
      fileName: "Acme",
      metadataXml: `<canvas id="0:1" name="Checkout"><frame id="1:1" name="Screen"><instance id="2:1" name="Guessed button" /></frame></canvas>`,
      ingestedAt: FROZEN,
    });
    const index = indexGraph(buildGraph(source, { builtAt: FROZEN }));
    const guessed = index.graph.nodes.find((node) => node.metadata?.["identity"] === "inferred-from-name");
    expect(guessed).toBeTruthy();
    const report = configureChoice(index, "guessed button");
    expect(report.visibility).toEqual({
      state: "unknown",
      reason: "This graph does not name which property shows or hides a child.",
    });
  });
});
