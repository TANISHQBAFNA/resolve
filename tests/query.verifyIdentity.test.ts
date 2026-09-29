import { describe, expect, it } from "vitest";
import { adaptFigmaMcpMetadata } from "@/core/ingestion/adapters/figmaMcp";
import { mergeDesignGraphs } from "@/core/ingestion/learnLibrary";
import { buildGraph } from "@/core/transform/buildGraph";
import { indexGraph, verifyFrame } from "@/core/query";

const libraryXml = `<frame id="1:1" name="Kit">
  <component id="33:235" name="Text field" />
  <component id="14:101" name="Button" />
</frame>`;

const productXml = `<frame id="990:1" name="Spoof4">
  <instance id="990:2" name="Text field" />
  <instance id="990:3" name="Button" />
</frame>
<frame id="990:9" name="Empty">
  <text id="990:10" name="Title" characters="Hello" />
</frame>
<frame id="990:20" name="Drawn">
  <rectangle id="990:21" name="Button" x="0" y="0" width="80" height="32" />
</frame>`;

function spoofIndex() {
  const library = buildGraph(
    adaptFigmaMcpMetadata({ fileKey: "LIB", fileName: "Library", metadataXml: libraryXml }),
  );
  const product = buildGraph(
    adaptFigmaMcpMetadata({ fileKey: "APP", fileName: "App", metadataXml: productXml }),
  );
  return indexGraph(mergeDesignGraphs(library, product));
}

function card(designContext?: string) {
  return verifyFrame(spoofIndex(), {
    frame: "Spoof4",
    ...(designContext ? { designContext } : {}),
  });
}

describe("verify means a real component id on that node", () => {
  const index = spoofIndex();

  it("fails when a neighbour's real id is the only library id", () => {
    const textFirst = card(
      `<div data-node-id="990:2" componentId="33:235"></div><div data-node-id="990:3" componentId="8:8"></div>`,
    );
    const buttonFirst = card(
      `<div data-node-id="990:3" componentId="8:8"></div><div data-node-id="990:2" componentId="33:235"></div>`,
    );
    for (const result of [textFirst, buttonFirst]) {
      expect(result.pass).toBe(false);
      expect(JSON.stringify(result).toLowerCase()).not.toContain("verified");
      expect(result.invents.some((hit) => hit.name === "Button")).toBe(true);
    }
  });

  it("does not verify a node that has no id of its own", () => {
    const result = card(
      `<div data-node-id="990:2" componentId="14:101"></div><div data-node-id="990:3"></div>`,
    );
    expect(result.pass).toBe(false);
    expect(JSON.stringify(result).toLowerCase()).not.toContain("verified");
    expect(result.invents.some((hit) => hit.name === "Button")).toBe(true);
  });

  it("verifies when each node carries its own library id", () => {
    const result = card(
      `<div data-node-id="990:3" componentId="14:101"></div><div data-node-id="990:2" componentId="33:235"></div>`,
    );
    expect(result.pass).toBe(true);
    expect(JSON.stringify(result)).toContain('"result":"verified"');
    expect(result.approved).toBe(2);
    expect(result.invents).toEqual([]);
    expect(result.renamed).toBeUndefined();
    expect(result.hint).not.toMatch(/label differs/i);
  });

  it("ignores a component id hidden in an attribute value, a data-name, or a comment", () => {
    const contexts = [
      `<div data-node-id="990:2" componentId="33:235"></div><div data-node-id="990:3" title="componentId='14:101'"></div>`,
      `<div data-node-id="990:2" componentId="33:235"></div><div data-node-id="990:3" data-name="Button componentId='14:101'"></div>`,
      `<div data-node-id="990:2" componentId="33:235"></div><!-- <div data-node-id="990:3" componentId='14:101'></div> --><div data-node-id="990:3"></div>`,
    ];
    for (const designContext of contexts) {
      const result = card(designContext);
      expect(result.pass).toBe(false);
      expect(JSON.stringify(result).toLowerCase()).not.toContain("verified");
      expect(result.invents.some((hit) => hit.name === "Button")).toBe(true);
    }
  });

  it("does not verify a node id that appears on two tags, in either order", () => {
    const realFirst = card(
      `<div data-node-id="990:2" componentId="33:235"></div><div data-node-id="990:3" componentId="14:101"></div><div data-node-id="990:3" componentId="8:8"></div>`,
    );
    const emptyFirst = card(
      `<div data-node-id="990:2" componentId="33:235"></div><div data-node-id="990:3"></div><div data-node-id="990:3" componentId="14:101"></div>`,
    );
    for (const result of [realFirst, emptyFirst]) {
      expect(result.pass).toBe(false);
      expect(JSON.stringify(result).toLowerCase()).not.toContain("verified");
      expect(result.invents.some((hit) => hit.name === "Button")).toBe(true);
    }
  });

  it("verifies a renamed layer by id and says the label differs", () => {
    const result = card(
      `<div data-node-id="990:2" componentId="33:235"></div><div data-node-id="990:3" componentId="33:235"></div>`,
    );
    expect(result.pass).toBe(true);
    expect(JSON.stringify(result)).toContain('"result":"verified"');
    expect(result.approved).toBe(1);
    expect(result.renamed).toEqual([{ node: "990:3", layerName: "Button", masterName: "Text field" }]);
    expect(result.hint).toMatch(/Label differs/);
    expect(result.hint).not.toMatch(/matched by layer name/i);
  });

  it("does not verify an empty frame or a hand-drawn layer", () => {
    for (const frame of ["Empty", "Drawn"]) {
      const result = verifyFrame(index, { frame });
      expect(result.pass, frame).toBe(false);
      expect(result.approved, frame).toBe(0);
      expect(JSON.stringify(result)).toContain('"result":"nothing checked"');
      expect(result.hint.toLowerCase()).not.toContain("verified");
    }
  });

  it("does not verify a component name when no id was checked", () => {
    const result = verifyFrame(index, { components: ["Button"] });
    expect(result.pass).toBe(false);
    expect(result.approved).toBe(1);
    expect(JSON.stringify(result)).toContain('"result":"nothing checked"');
    expect(result.hint.toLowerCase()).not.toContain("verified");
  });
});
