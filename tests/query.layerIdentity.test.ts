import { describe, expect, it } from "vitest";
import { adaptFigmaMcpMetadata } from "@/core/ingestion/adapters/figmaMcp";
import { mergeDesignGraphs } from "@/core/ingestion/learnLibrary";
import { buildGraph } from "@/core/transform/buildGraph";
import { checkCousins, indexGraph, verifyFrame } from "@/core/query";
import { mergeWorkspaceGraphs } from "@/core/query/workspaceMerge";
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

function workspaceIndex(productXml: string) {
  const library = buildGraph(
    adaptFigmaMcpMetadata({ fileKey: "LIB", fileName: "Library", metadataXml: libraryXml }),
  );
  const product = buildGraph(
    adaptFigmaMcpMetadata({ fileKey: "APP", fileName: "App", metadataXml: productXml }),
  );
  return indexGraph(
    mergeWorkspaceGraphs(
      [
        { graph: library, role: "library" },
        { graph: product, role: "product" },
      ],
      workspace,
    ),
  );
}

function expectNameOnly(result: ReturnType<typeof verifyFrame>) {
  expect(result.pass).toBe(false);
  expect(JSON.stringify(result)).toContain('"result":"name-only"');
  expect(JSON.stringify(result).toLowerCase()).not.toContain("verified");
  expect(result.guess).toBe("guess from layer name, not confirmed");
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

describe("an id that is not in any library stays a guess", () => {
  const fakeXml = `<frame id="3:1" name="F1"><instance id="3:2" name="Button" componentId="8:8" /></frame>`;
  const lookalikeXml = `<frame id="3:1" name="F1"><instance id="3:2" name="Text field" componentId="8:8" /></frame>`;
  const nameOnlyXml = `<frame id="3:1" name="F1"><instance id="3:2" name="Button" /></frame>`;
  const fakeJson = `{"nodes":[{"data-node-id":"3:2","componentId":"8:8"}]}`;
  const fakeDataAttr = `<div data-node-id="3:2" data-component-id="8:8"></div>`;
  const fakeHtml = `<div data-node-id="3:2" componentId="8:8"></div>`;

  it("does not verify a fake XML componentId, including a layer named like a master", () => {
    for (const xml of [fakeXml, lookalikeXml, `<frame id="3:1" name="F1"><instance id="3:2" name="Button" data-component-id="8:8" /></frame>`]) {
      const index = graphs(xml);
      expectNameOnly(verifyFrame(index, { frame: "F1" }));
      const instance = index.allNodes.find((node) => node.figmaNodeId === "3:2");
      const main = instance ? index.getMainComponent(instance.id) : undefined;
      expect(main?.name).not.toBe("8:8");
      expect(main?.metadata?.["identity"]).toBe("inferred-from-name");
      expect(index.allNodes.some((node) => node.figmaNodeId === "8:8")).toBe(false);
    }
  });

  it("gives the same name-only answer via JSON, data-component-id, and --design-context", () => {
    const xmlIndex = graphs(fakeXml);
    const xmlCard = verifyFrame(xmlIndex, { frame: "F1" });
    expectNameOnly(xmlCard);

    const named = graphs(nameOnlyXml);
    for (const designContext of [fakeHtml, fakeDataAttr, fakeJson]) {
      const viaContext = verifyFrame(named, { frame: "F1", designContext });
      expectNameOnly(viaContext);
      expect(viaContext.pass).toBe(xmlCard.pass);
    }
  });

  it("still verifies a real id and reports cousins as worth checking for a fake id", () => {
    const real = graphs(`<frame id="3:1" name="F1"><instance id="3:2" name="Button" componentId="14:101" /></frame>`);
    const verified = verifyFrame(real, { frame: "F1" });
    expect(verified.pass).toBe(true);
    expect(JSON.stringify(verified)).toContain('"result":"verified"');
    expect(verified.guess).toBeUndefined();

    const fake = workspaceIndex(fakeXml);
    expectNameOnly(verifyFrame(fake, { frame: "F1" }));
    const cousins = checkCousins(fake, { frame: "F1", workspace });
    expect(cousins.cousins).toEqual([]);
    expect(JSON.stringify(cousins)).not.toContain('"confidence":"cousin"');
    expect(cousins.unsure.some((hit) => hit.why.includes("worth checking"))).toBe(true);
  });

  it("keeps the token hint when the frame name is long", () => {
    const frameName = `Home ${"Nav".repeat(59)}`;
    expect(frameName.length).toBeGreaterThan(170);
    const index = graphs(
      `<frame id="3:1" name="${frameName}"><instance id="3:2" name="Button" /><text id="3:3" name="Button" /></frame>`,
    );
    const result = verifyFrame(index, { frame: frameName });
    expectNameOnly(result);
    expect(result.hint).toMatch(/Figma access token|design-context/i);
    expect(result.hint.length).toBeGreaterThan(40);
    expect(JSON.stringify(result)).not.toMatch(/\.\.\.t\.\.\./);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(600);
  });
});

describe("a name in an id slot is not a component id", () => {
  const nameOnly = `<frame id="3:1" name="F1"><instance id="3:2" name="Button" /></frame>`;
  const xmlNamed = `<frame id="3:1" name="F1"><instance id="3:2" name="Button" componentId="Button" /></frame>`;
  const xmlWrongName = `<frame id="3:1" name="F1"><instance id="3:2" name="Button" componentId="Text field" /></frame>`;
  const xmlKeyNamed = `<frame id="3:1" name="F1"><instance id="3:2" name="Button" componentKey="Button" /></frame>`;
  const xmlDataNamed = `<frame id="3:1" name="F1"><instance id="3:2" name="Button" data-component-id="Button" /></frame>`;

  const namedContexts = [
    `<div data-node-id="3:2" componentId="Button"></div>`,
    `<div data-node-id="3:2" componentId="button"></div>`,
    `<div data-node-id="3:2" componentId="Text field"></div>`,
    `<div data-node-id="3:2" componentKey="Button"></div>`,
    `<div data-node-id="3:2" data-component-id="Button"></div>`,
    `{"nodes":[{"data-node-id":"3:2","componentId":"Button"}]}`,
    `{"nodes":[{"data-node-id":"3:2","componentKey":"Button"}]}`,
  ];

  it("does not verify a master name placed in componentId, including XML ingest", () => {
    for (const xml of [xmlNamed, xmlWrongName, xmlKeyNamed, xmlDataNamed]) {
      const index = graphs(xml);
      const result = verifyFrame(index, { frame: "F1" });
      expectNameOnly(result);
      expect(result.approved).toBe(0);
      const instance = index.allNodes.find((node) => node.figmaNodeId === "3:2");
      const main = instance ? index.getMainComponent(instance.id) : undefined;
      expect(main?.metadata?.["identity"]).toBe("inferred-from-name");
      expect(main?.name).toBe("Button");
    }
  });

  it("does not verify a name in JSON, data-component-id, componentKey, or lowercase", () => {
    const index = graphs(nameOnly);
    for (const designContext of namedContexts) {
      const result = verifyFrame(index, { frame: "F1", designContext });
      expectNameOnly(result);
      expect(result.approved, designContext).toBe(0);
      expect(result.labelDiffers, designContext).toBeUndefined();
    }
  });

  it("does not verify a variant card name used as an id", () => {
    const library = buildGraph(
      adaptFigmaMcpMetadata({
        fileKey: "LIB",
        fileName: "Library",
        metadataXml: `<frame id="1:1" name="Kit">
          <frame id="40:1" name="Chip">
            <component id="40:2" name="Style=Primary" />
          </frame>
        </frame>`,
      }),
    );
    const product = buildGraph(
      adaptFigmaMcpMetadata({
        fileKey: "APP",
        fileName: "App",
        metadataXml: `<frame id="3:1" name="F1"><instance id="3:2" name="Chip" /></frame>`,
      }),
    );
    const index = indexGraph(mergeDesignGraphs(library, product));
    const variantName = index.allNodes.find((node) => node.figmaNodeId === "40:2");
    expect(variantName?.name).toMatch(/Primary/);
    const named = verifyFrame(index, {
      frame: "F1",
      designContext: `<div data-node-id="3:2" componentId="Chip / Style=Primary"></div>`,
    });
    expectNameOnly(named);
    const xmlNamedVariant = indexGraph(
      mergeDesignGraphs(
        library,
        buildGraph(
          adaptFigmaMcpMetadata({
            fileKey: "APP",
            fileName: "App",
            metadataXml: `<frame id="3:1" name="F1"><instance id="3:2" name="Chip" componentId="Chip / Style=Primary" /></frame>`,
          }),
        ),
      ),
    );
    expectNameOnly(verifyFrame(xmlNamedVariant, { frame: "F1" }));
    const real = verifyFrame(index, {
      frame: "F1",
      designContext: `<div data-node-id="3:2" componentId="40:2"></div>`,
    });
    expect(real.pass).toBe(true);
    expect(JSON.stringify(real)).toContain('"result":"verified"');
  });

  it("still verifies a real node id and a real published key", () => {
    const index = graphs(nameOnly);
    const button = index.allNodes.find((node) => node.figmaNodeId === "14:101");
    expect(button).toBeTruthy();
    button!.metadata = { ...button!.metadata, key: "pub-btn-key" };

    const byId = verifyFrame(index, {
      frame: "F1",
      designContext: `<div data-node-id="3:2" componentId="14:101"></div>`,
    });
    expect(byId.pass).toBe(true);
    expect(JSON.stringify(byId)).toContain('"result":"verified"');
    expect(byId.guess).toBeUndefined();

    const byKey = verifyFrame(index, {
      frame: "F1",
      designContext: `<div data-node-id="3:2" componentKey="pub-btn-key"></div>`,
    });
    expect(byKey.pass).toBe(true);
    expect(JSON.stringify(byKey)).toContain('"result":"verified"');

    const xmlReal = graphs(
      `<frame id="3:1" name="F1"><instance id="3:2" name="Button" componentId="14:101" /></frame>`,
    );
    const xmlCard = verifyFrame(xmlReal, { frame: "F1" });
    expect(xmlCard.pass).toBe(true);
    expect(verifyFrame(xmlReal, { frame: "F1", designContext: `<div data-node-id="3:2" componentId="14:101"></div>` }).pass).toBe(
      true,
    );
  });

  it("still verifies a renamed layer bound by a real id, with labelDiffers", () => {
    const index = graphs(`<frame id="3:1" name="F1"><instance id="3:2" name="Button" /></frame>`);
    const result = verifyFrame(index, {
      frame: "F1",
      designContext: `<div data-node-id="3:2" componentId="33:235"></div>`,
    });
    expect(result.pass).toBe(true);
    expect(result.labelDiffers).toBe(true);
    expect(result.renamed).toEqual([{ node: "3:2", layerName: "Button", masterName: "Text field" }]);
    const xml = graphs(
      `<frame id="3:1" name="F1"><instance id="3:2" name="Button" componentId="33:235" /></frame>`,
    );
    const viaXml = verifyFrame(xml, { frame: "F1" });
    expect(viaXml.pass).toBe(true);
    expect(viaXml.labelDiffers).toBe(true);
    expect(
      verifyFrame(xml, { frame: "F1", designContext: `<div data-node-id="3:2" componentId="33:235"></div>` }).pass,
    ).toBe(true);
  });
});

describe("a non-master node id is not a component id", () => {
  function expectGuess(index: ReturnType<typeof graphs>, claimed: string) {
    const result = verifyFrame(index, { frame: "F1" });
    expectNameOnly(result);
    expect(result.approved).toBe(0);
    expect(JSON.stringify(result)).not.toContain('"result":"verified"');
    const viaContext = verifyFrame(index, {
      frame: "F1",
      designContext: `<div data-node-id="3:2" componentId="${claimed}"></div>`,
    });
    expectNameOnly(viaContext);
    expect(viaContext.pass).toBe(result.pass);
    const instance = index.allNodes.find((node) => node.figmaNodeId === "3:2");
    const main = instance ? index.getMainComponent(instance.id) : undefined;
    expect(main?.metadata?.["identity"]).toBe("inferred-from-name");
    expect(main?.name).toBe("Button");
    expect(main?.figmaNodeId).not.toBe(claimed);
  }

  it("does not verify a sibling rectangle, text, instance, or the instance's own id", () => {
    const cases = [
      {
        xml: `<frame id="3:1" name="F1"><instance id="3:2" name="Button" componentId="3:3"/><rectangle id="3:3" name="Rect"/></frame>`,
        claimed: "3:3",
      },
      {
        xml: `<frame id="3:1" name="F1"><instance id="3:2" name="Button" componentId="3:3"/><text id="3:3" name="Label" /></frame>`,
        claimed: "3:3",
      },
      {
        xml: `<frame id="3:1" name="F1"><instance id="3:2" name="Button" componentId="3:2"/></frame>`,
        claimed: "3:2",
      },
      {
        xml: `<frame id="3:1" name="F1"><instance id="3:2" name="Button" componentId="3:3"/><instance id="3:3" name="Text field" /></frame>`,
        claimed: "3:3",
      },
    ];
    for (const row of cases) {
      expectGuess(graphs(row.xml), row.claimed);
    }
  });

  it("does not verify the enclosing frame id, including with no library", () => {
    const xml = `<frame id="3:1" name="F1"><instance id="3:2" name="Button" componentId="3:1"/></frame>`;
    expectGuess(graphs(xml), "3:1");
    const productOnly = indexGraph(
      buildGraph(
        adaptFigmaMcpMetadata({ fileKey: "APP", fileName: "App", metadataXml: xml }),
      ),
    );
    expectNameOnly(verifyFrame(productOnly, { frame: "F1" }));
    expect(verifyFrame(productOnly, { frame: "F1" }).approved).toBe(0);
  });

  it("still verifies a real component or symbol id, including a renamed layer", () => {
    const real = graphs(`<frame id="3:1" name="F1"><instance id="3:2" name="Button" componentId="14:101" /></frame>`);
    const verified = verifyFrame(real, { frame: "F1" });
    expect(verified.pass).toBe(true);
    expect(JSON.stringify(verified)).toContain('"result":"verified"');
    expect(
      verifyFrame(real, { frame: "F1", designContext: `<div data-node-id="3:2" componentId="14:101"></div>` }).pass,
    ).toBe(true);

    const renamed = graphs(
      `<frame id="3:1" name="F1"><instance id="3:2" name="Button" componentId="33:235" /></frame>`,
    );
    const viaXml = verifyFrame(renamed, { frame: "F1" });
    expect(viaXml.pass).toBe(true);
    expect(viaXml.labelDiffers).toBe(true);
    expect(viaXml.renamed).toEqual([{ node: "3:2", layerName: "Button", masterName: "Text field" }]);
    const viaContext = verifyFrame(renamed, {
      frame: "F1",
      designContext: `<div data-node-id="3:2" componentId="33:235"></div>`,
    });
    expect(viaContext.pass).toBe(true);
    expect(viaContext.labelDiffers).toBe(true);
  });
});
