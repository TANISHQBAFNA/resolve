import { describe, expect, it } from "vitest";
import { adaptFigmaMcpMetadata } from "@/core/ingestion/adapters/figmaMcp";
import { mergeDesignGraphs } from "@/core/ingestion/learnLibrary";
import { buildGraph } from "@/core/transform/buildGraph";
import { checkCousins, indexGraph, verifyFrame } from "@/core/query";
import type { WorkspaceManifest } from "@/core/query/workspace";

const libraryXml = `<frame id="1:1" name="Kit">
  <component id="88:1" name="buildings-88-smart-home" />
  <component id="14:101" name="Button" />
  <component id="33:235" name="Text field" />
</frame>`;

const workspace: WorkspaceManifest = {
  version: 1,
  files: [
    { key: "LIB", role: "library", label: "Library" },
    { key: "APP", role: "product", label: "App" },
  ],
};

function graphs(productXml: string) {
  const library = buildGraph(
    adaptFigmaMcpMetadata({ fileKey: "LIB", fileName: "Library", metadataXml: libraryXml }),
  );
  const product = buildGraph(
    adaptFigmaMcpMetadata({ fileKey: "APP", fileName: "App", metadataXml: productXml }),
  );
  return indexGraph(mergeDesignGraphs(library, product));
}

describe("layer name is a label, not the component", () => {
  it("uses the real master name when the instance has a real id", () => {
    const index = graphs(`<frame id="2:1" name="Home">
      <instance id="2:2" name="Icon" componentId="88:1" />
    </frame>`);
    const instance = index.allNodes.find((node) => node.figmaNodeId === "2:2");
    const main = instance ? index.getMainComponent(instance.id) : undefined;
    expect(instance?.name).toBe("Icon");
    expect(main?.name).toBe("buildings-88-smart-home");
    expect(main?.metadata?.["identity"]).not.toBe("inferred-from-name");
    const result = verifyFrame(index, {
      frame: "Home",
      designContext: `<div data-node-id="2:2" componentId="88:1"></div>`,
    });
    expect(result.pass).toBe(true);
    expect(result.labelDiffers).toBe(true);
    expect(result.renamed).toEqual([
      { node: "2:2", layerName: "Icon", masterName: "buildings-88-smart-home" },
    ]);
    expect(JSON.stringify(result).toLowerCase()).not.toContain("mcp-name:");
    expect(result.guess).toBeUndefined();
  });

  it("marks a layer-name-only instance as a guess, not verified, not a confirmed cousin", () => {
    const index = graphs(`<frame id="2:1" name="Home">
      <instance id="2:2" name="Button" />
    </frame>`);
    const named = verifyFrame(index, { frame: "Home" });
    expect(named.pass).toBe(false);
    expect(named.guess).toBe("guess from layer name, not confirmed");
    expect(JSON.stringify(named)).toContain('"result":"name-only"');
    expect(JSON.stringify(named).toLowerCase()).not.toContain("verified");
    expect(named.hint).toMatch(/Figma access token|design-context/i);

    const cousins = checkCousins(index, { frame: "Home", workspace });
    expect(cousins.cousins).toEqual([]);
    expect(JSON.stringify(cousins)).not.toContain('"confidence":"cousin"');
    expect(cousins.unsure.some((hit) => hit.why.includes("worth checking"))).toBe(true);
  });

  it("keeps two renamed layers of the same master as one component", () => {
    const index = graphs(`<frame id="2:1" name="Home">
      <instance id="2:2" name="Icon" componentId="88:1" />
      <instance id="2:3" name="House" componentId="88:1" />
    </frame>`);
    const result = verifyFrame(index, {
      frame: "Home",
      designContext: `<div data-node-id="2:2" componentId="88:1"></div><div data-node-id="2:3" componentId="88:1"></div>`,
    });
    expect(result.pass).toBe(true);
    expect(result.approved).toBe(1);
    expect(result.labelDiffers).toBe(true);
    const layers = (result.renamed ?? []).map((row) => row.layerName).sort();
    expect(layers).toEqual(["House", "Icon"]);
    expect(result.renamed?.every((row) => row.masterName === "buildings-88-smart-home")).toBe(true);
  });

  it("does not treat a layer named like another master as that master", () => {
    const index = graphs(`<frame id="2:1" name="Home">
      <instance id="2:2" name="Button" componentId="33:235" />
    </frame>`);
    const instance = index.allNodes.find((node) => node.figmaNodeId === "2:2");
    const main = instance ? index.getMainComponent(instance.id) : undefined;
    expect(main?.name).toBe("Text field");
    const result = verifyFrame(index, {
      frame: "Home",
      designContext: `<div data-node-id="2:2" componentId="33:235"></div>`,
    });
    expect(result.pass).toBe(true);
    expect(result.renamed).toEqual([{ node: "2:2", layerName: "Button", masterName: "Text field" }]);
    expect(JSON.stringify(result)).not.toMatch(/"name":"Button"/);
  });
});
