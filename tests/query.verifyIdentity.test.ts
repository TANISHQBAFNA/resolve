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
</frame>
<frame id="990:30" name="Mixed">
  <instance id="990:31" name="Text field" />
  <rectangle id="990:32" name="Button" x="0" y="0" width="80" height="32" />
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

  it("ignores a component id inside script, style, CDATA, or an open comment", () => {
    const real = `<div data-node-id="990:2" componentId="33:235"></div>`;
    const hidden = `<div data-node-id="990:3" componentId="14:101"></div>`;
    const contexts = [
      `${real}<script>${hidden}</script>`,
      `${real}<style>${hidden}</style>`,
      `${real}<![CDATA[${hidden}]]>`,
      `${real}<script>${hidden}`,
      `${real}<!-- ${hidden}`,
    ];
    for (const designContext of contexts) {
      const result = card(designContext);
      expect(result.pass).toBe(false);
      expect(JSON.stringify(result).toLowerCase()).not.toContain("verified");
      expect(result.invents.some((hit) => hit.name === "Button")).toBe(true);
    }
  });

  it("still verifies a real id outside those blocks, in each attribute form", () => {
    const contexts = [
      `<script><div data-node-id="1:9" componentId="8:8"></div></script><div data-node-id="990:2" componentId="33:235"></div><div data-node-id="990:3" componentId='14:101'></div>`,
      `<style><div data-node-id="1:9" componentId="8:8"></div></style><div data-node-id="990:2" componentKey="33:235"></div><div data-node-id="990:3" componentId=14:101></div>`,
      `<![CDATA[<div data-node-id="1:9" componentId="8:8"></div>]]><div data-node-id="990:2" componentKey='33:235'></div><div data-node-id="990:3" componentId="14:101"></div>`,
    ];
    for (const designContext of contexts) {
      const result = card(designContext);
      expect(result.pass).toBe(true);
      expect(JSON.stringify(result)).toContain('"result":"verified"');
      expect(result.approved).toBe(2);
      expect(result.invents).toEqual([]);
    }
  });

  it("strips a long unterminated comment without a quadratic scan", () => {
    const designContext = "<!--".repeat(50_000);
    expect(designContext.length).toBe(200_000);
    const started = performance.now();
    const result = card(designContext);
    expect(performance.now() - started).toBeLessThan(300);
    expect(result.pass).toBe(false);
    expect(JSON.stringify(result).toLowerCase()).not.toContain("verified");
  });

  it("verifies a renamed layer by id and says the label differs", () => {
    const result = card(
      `<div data-node-id="990:2" componentId="33:235"></div><div data-node-id="990:3" componentId="33:235"></div>`,
    );
    expect(result.pass).toBe(true);
    expect(JSON.stringify(result)).toContain('"result":"verified"');
    expect(result.approved).toBe(1);
    expect(result.renamed).toEqual([{ node: "990:3", layerName: "Button", masterName: "Text field" }]);
    expect(result.labelDiffers).toBe(true);
    expect(result.hint).toMatch(/Label differs/);
    expect(result.hint).not.toMatch(/matched by layer name/i);
    expect(result.renamedNote).toBeUndefined();
  });

  it("caps a long renamed list at five and counts the rest", () => {
    const count = 7;
    const instances = Array.from({ length: count }, (_, n) => {
      return `<instance id="8:${n + 1}" name="Layer ${n + 1}" />`;
    }).join("");
    const library = buildGraph(
      adaptFigmaMcpMetadata({
        fileKey: "LIB",
        fileName: "Library",
        metadataXml: `<frame id="1:1" name="Kit"><component id="33:235" name="Text field" /></frame>`,
      }),
    );
    const product = buildGraph(
      adaptFigmaMcpMetadata({
        fileKey: "APP",
        fileName: "App",
        metadataXml: `<frame id="2:1" name="Many">${instances}</frame>`,
      }),
    );
    const tags = Array.from({ length: count }, (_, n) => {
      return `<div data-node-id="8:${n + 1}" componentId="33:235"></div>`;
    }).join("");
    const result = verifyFrame(indexGraph(mergeDesignGraphs(library, product)), {
      frame: "Many",
      designContext: tags,
    });
    expect(result.pass).toBe(true);
    expect(JSON.stringify(result)).toContain('"result":"verified"');
    const shown = result.renamed ?? [];
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThanOrEqual(5);
    const hiddenMatch = /^\+(\d+) more$/.exec(result.renamedNote ?? "");
    expect(hiddenMatch).not.toBeNull();
    expect(shown.length + Number(hiddenMatch?.[1])).toBe(count);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(600);
    for (const row of shown) {
      expect(row.layerName).not.toBe(row.masterName);
    }
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

  it("lists a hand-drawn look-alike as unchecked next to a verified instance", () => {
    const result = verifyFrame(index, {
      frame: "Mixed",
      designContext: `<div data-node-id="990:31" componentId="33:235"></div>`,
    });
    expect(result.pass).toBe(true);
    expect(JSON.stringify(result)).toContain('"result":"verified"');
    expect(result.unchecked).toEqual({ count: 1, names: ["Button"] });
    expect(result.hint).toMatch(/unchecked look-alike \(Button\)/);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(600);
  });

  it("accepts data-component-id and quoted-key JSON, and ignores spoofs", () => {
    const ok = [
      `<div data-node-id="990:2" data-component-id="33:235"></div><div data-node-id="990:3" data-component-id="14:101"></div>`,
      `{"nodes":[{"data-node-id":"990:2","componentId":"33:235"},{"data-node-id":"990:3","componentId":"14:101"}]}`,
      `<div data-node-id="990:2" componentId="33:235"></div>{"data-node-id":"990:3","componentId":"14:101"}`,
    ];
    for (const designContext of ok) {
      const result = card(designContext);
      expect(result.pass, designContext).toBe(true);
      expect(result.approved, designContext).toBe(2);
    }
    const spoofed = [
      `<div data-node-id="990:2" componentId="33:235"></div><div data-node-id="990:3" title='"componentId": "14:101"'></div>`,
      `<div data-node-id="990:2" componentId="33:235"></div><!-- {"data-node-id":"990:3","componentId":"14:101"} --><div data-node-id="990:3"></div>`,
      `<div data-node-id="990:2" componentId="33:235"></div><script>{"data-node-id":"990:3","componentId":"14:101"}</script><div data-node-id="990:3"></div>`,
      `<div data-node-id="990:2" componentId="33:235"></div><style>{"data-node-id":"990:3","componentId":"14:101"}</style><div data-node-id="990:3"></div>`,
      `<div data-node-id="990:2" componentId="33:235"></div><![CDATA[{"data-node-id":"990:3","componentId":"14:101"}]]><div data-node-id="990:3"></div>`,
    ];
    for (const designContext of spoofed) {
      const result = card(designContext);
      expect(result.pass, designContext).toBe(false);
      expect(JSON.stringify(result).toLowerCase()).not.toContain("verified");
      expect(result.invents.some((hit) => hit.name === "Button")).toBe(true);
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
