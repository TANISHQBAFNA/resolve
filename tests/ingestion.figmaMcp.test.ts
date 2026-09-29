import { describe, expect, it } from "vitest";
import {
  adaptFigmaMcpMetadata,
  classifyTokenValue,
  figmaTypeForElement,
  inferredComponentId,
  parseMetadataXml,
} from "@/core/ingestion";
import { demoPortfolioSource, demoScreensSource } from "@/core/ingestion/adapters/mcpSource";
import { buildGraph } from "@/core/transform";
import { computeAnalytics, indexGraph } from "@/core/query";
import { buildAiGraphContext, toMarkdownPrompt } from "@/core/ai";
import capture from "@/data/demo-mobile-portfolio.mcp.json";

const SAMPLE = `
Currently selected nodes:
- 1:1: Screen

<frame id="1:1" name="Screen" x="0" y="0" width="440" height="956">
  <instance id="1:2" name="Card" x="8" y="8" width="424" height="200">
    <slot id="1:3" name="Slot" x="16" y="16" width="392" height="168">
      <instance id="1:4" name="Button" x="0" y="0" width="120" height="48" />
    </slot>
  </instance>
  <instance id="1:5" name="Card" x="8" y="216" width="424" height="200" hidden="true" />
  <rounded-rectangle id="1:6" name="Divider" x="8" y="424" width="424" height="1" />
</frame>
IMPORTANT: After you call this tool, you MUST call get_design_context.
`;

describe("MCP metadata parsing", () => {
  it("reads the XML out of the surrounding prose", () => {
    const roots = parseMetadataXml(SAMPLE);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.tag).toBe("frame");
    expect(roots[0]?.attrs["name"]).toBe("Screen");
    expect(roots[0]?.children).toHaveLength(3);
  });

  it("handles nesting and self-closing elements", () => {
    const [root] = parseMetadataXml(SAMPLE);
    const card = root?.children[0];
    expect(card?.tag).toBe("instance");
    expect(card?.children[0]?.tag).toBe("slot");
    expect(card?.children[0]?.children[0]?.attrs["name"]).toBe("Button");
  });

  it("maps element names onto Figma node types", () => {
    expect(figmaTypeForElement("frame")).toBe("FRAME");
    expect(figmaTypeForElement("rounded-rectangle")).toBe("RECTANGLE");
    expect(figmaTypeForElement("slot")).toBe("SLOT");
    expect(figmaTypeForElement("symbol")).toBe("COMPONENT");
    expect(figmaTypeForElement("component_set")).toBe("COMPONENT_SET");
    expect(figmaTypeForElement("component-set")).toBe("COMPONENT_SET");
    expect(figmaTypeForElement("some-future-thing")).toBe("SOME_FUTURE_THING");
  });

  it("classifies the flattened token map by value shape", () => {
    expect(classifyTokenValue("#ffffff")).toEqual({ kind: "variable", resolvedType: "COLOR" });
    expect(classifyTokenValue("16")).toEqual({ kind: "variable", resolvedType: "FLOAT" });
    expect(classifyTokenValue("true")).toEqual({ kind: "variable", resolvedType: "BOOLEAN" });
    expect(classifyTokenValue("Montserrat")).toEqual({ kind: "variable", resolvedType: "STRING" });
    expect(classifyTokenValue("Effect(type: DROP_SHADOW)")).toEqual({
      kind: "style",
      styleType: "EFFECT",
    });
    expect(classifyTokenValue("Font(family: x)")).toEqual({ kind: "style", styleType: "TEXT" });
    expect(classifyTokenValue("")).toEqual({ kind: "style", styleType: "FILL" });
  });
});

describe("MCP adapter", () => {
  const doc = adaptFigmaMcpMetadata({
    fileKey: "KEY",
    fileName: "Test File",
    metadataXml: SAMPLE,
    variableDefs: { "color/bg": "#ffffff", "Shadow/Card": "Effect(type: DROP_SHADOW)" },
    ingestedAt: "2026-01-01T00:00:00.000Z",
  });

  it("roots the document at the queried subtree", () => {
    expect(doc.root.type).toBe("DOCUMENT");
    expect(doc.root.children).toHaveLength(1);
    expect(doc.root.children?.[0]?.name).toBe("Screen");
    expect(doc.source.kind).toBe("figma-mcp");
  });

  it("carries bounds and hidden state", () => {
    const [screen] = doc.root.children ?? [];
    expect(screen?.bounds).toEqual({ x: 0, y: 0, width: 440, height: 956 });
    expect(screen?.children?.[1]?.visible).toBe(false);
  });

  it("groups instances by name and flags the inference", () => {
    expect(doc.components[inferredComponentId("Card")]).toEqual({
      id: "mcp-name:Card",
      name: "Card",
      identity: "inferred-from-name",
    });
    // Two "Card" instances collapse onto one inferred component.
    expect(Object.keys(doc.components).sort()).toEqual(["mcp-name:Button", "mcp-name:Card"]);
  });

  it("trusts a real componentId over the layer name", () => {
    const adapted = adaptFigmaMcpMetadata({
      fileKey: "KEY",
      fileName: "Ids",
      metadataXml: `<frame id="1:1" name="Kit">
        <component id="88:1" name="buildings-88-smart-home" />
        <instance id="2:1" name="Icon" componentId="88:1" />
        <instance id="2:2" name="House" componentId="88:1" />
        <instance id="2:3" name="Button" />
      </frame>`,
      ingestedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(adapted.components["88:1"]).toEqual({
      id: "88:1",
      name: "buildings-88-smart-home",
      identity: "id",
    });
    expect(adapted.components[inferredComponentId("Icon")]).toBeUndefined();
    expect(adapted.components[inferredComponentId("Button")]?.identity).toBe("inferred-from-name");
    const icon = adapted.root.children?.[0]?.children?.[1];
    const house = adapted.root.children?.[0]?.children?.[2];
    expect(icon?.name).toBe("Icon");
    expect(icon?.componentId).toBe("88:1");
    expect(house?.name).toBe("House");
    expect(house?.componentId).toBe("88:1");
  });

  it("splits the flattened token map into styles and variables", () => {
    expect(Object.values(doc.styles).map((style) => style.name)).toEqual(["Shadow/Card"]);
    expect(Object.values(doc.variables).map((variable) => variable.name)).toEqual(["color/bg"]);
  });

  it("attaches subtree tokens to the queried root, not to invented children", () => {
    const [screen] = doc.root.children ?? [];
    expect(screen?.variableIds).toEqual({ "color/bg": "mcp:color/bg" });
    expect(screen?.styleIds).toEqual({ "effect:Shadow/Card": "mcp:Shadow/Card" });
  });

  it("does not copy a text layer name into characters when characters are absent", () => {
    const xml = `<frame id="1:1" name="Screen" x="0" y="0" width="200" height="80">
      <text id="1:9" name="Request Bank Certificate" x="0" y="0" width="180" height="24" />
      <text id="1:10" name="Label" x="0" y="28" width="80" height="16" characters="Pay now" />
    </frame>`;
    const adapted = adaptFigmaMcpMetadata({
      fileKey: "KEY",
      fileName: "Text",
      metadataXml: xml,
      ingestedAt: "2026-01-01T00:00:00.000Z",
    });
    const graph = buildGraph(adapted, { builtAt: "2026-01-01T00:00:00.000Z" });
    const untitled = graph.nodes.find((node) => node.figmaNodeId === "1:9");
    const filled = graph.nodes.find((node) => node.figmaNodeId === "1:10");
    expect(untitled?.metadata?.["text"]).toBeUndefined();
    expect(filled?.metadata?.["text"]).toBe("Pay now");
  });

  it("refuses an empty payload rather than producing a hollow graph", () => {
    expect(() =>
      adaptFigmaMcpMetadata({ fileKey: "K", fileName: "F", metadataXml: "no xml here" }),
    ).toThrow(/no elements/i);
  });
});

describe("Figma MCP get_metadata component shapes", () => {
  function masterNames(xml: string): string[] {
    const graph = buildGraph(
      adaptFigmaMcpMetadata({ fileKey: "LIB", fileName: "DS", metadataXml: xml }),
    );
    return indexGraph(graph)
      .getNodesByType("COMPONENT_SET", "MAIN_COMPONENT", "VARIANT")
      .map((node) => `${node.type}:${node.name}`)
      .sort();
  }

  it("reads a component element as a main component", () => {
    expect(masterNames(`<component id="1:1" name="Price" />`)).toEqual(["MAIN_COMPONENT:Price"]);
  });

  it("reads a symbol element as a main component", () => {
    expect(masterNames(`<symbol id="2:2" name="Summary Card" />`)).toEqual([
      "MAIN_COMPONENT:Summary Card",
    ]);
  });

  it("reads a component-set of symbols as a set plus variants", () => {
    expect(
      masterNames(`
        <component-set id="3:0" name="Button">
          <symbol id="3:1" name="Type=Primary" />
          <symbol id="3:2" name="Type=Secondary" />
        </component-set>
      `),
    ).toEqual([
      "COMPONENT_SET:Button",
      "VARIANT:Type=Primary",
      "VARIANT:Type=Secondary",
    ]);
  });

  it("reads a component_set of components as a set plus variants", () => {
    expect(
      masterNames(`
        <component_set id="4:0" name="Button">
          <component id="4:1" name="Type=Primary, Size=Large" />
        </component_set>
      `),
    ).toEqual(["COMPONENT_SET:Button", "VARIANT:Type=Primary, Size=Large"]);
  });

  it("treats a frame of only variant-named symbols as a component set", () => {
    expect(
      masterNames(`
        <frame id="5:0" name="Button" x="0" y="0" width="200" height="40">
          <symbol id="5:1" name="Type=Primary" x="0" y="0" width="200" height="40" />
          <symbol id="5:2" name="Type=Secondary" x="0" y="48" width="200" height="40" />
        </frame>
      `),
    ).toEqual([
      "COMPONENT_SET:Button",
      "VARIANT:Type=Primary",
      "VARIANT:Type=Secondary",
    ]);
  });

  it("leaves a frame that also contains a non-variant child as a frame", () => {
    const graph = buildGraph(
      adaptFigmaMcpMetadata({
        fileKey: "LIB",
        fileName: "DS",
        metadataXml: `
          <frame id="6:0" name="Screen">
            <symbol id="6:1" name="Type=Primary" />
            <text id="6:2" name="Hello" />
          </frame>
        `,
      }),
    );
    const index = indexGraph(graph);
    expect(index.getNodesByType("FRAME").map((node) => node.name)).toContain("Screen");
    expect(index.getNodesByType("COMPONENT_SET")).toEqual([]);
    expect(index.getNodesByType("MAIN_COMPONENT").map((node) => node.name)).toEqual(["Type=Primary"]);
  });
});

describe("the captured demo Portfolio screen", () => {
  it("builds a traversable graph from a captured file", async () => {
    const doc = await demoPortfolioSource.load();
    const graph = buildGraph(doc);
    const index = indexGraph(graph);
    const analytics = computeAnalytics(index);

    expect(graph.fileKey).toBe("DEMOFILEKEY0000000001");
    expect(analytics.totals.instances).toBe(87);
    expect(analytics.totals.componentDefinitions).toBe(20);
    expect(analytics.totals.frames).toBe(18);
    expect(analytics.totals.styles).toBe(16);
    expect(analytics.totals.variables).toBe(56);

    const root = index.getNodesByType("FRAME").find((node) => node.name === "Portfolio");
    expect(root?.figmaNodeId).toBe("14430:56021");
    expect(root?.figmaUrl).toBe(
      "https://www.figma.com/design/DEMOFILEKEY0000000001/Demo-Mobile?node-id=14430-56021",
    );
  });

  it("ranks the most reused components on the screen", async () => {
    const index = indexGraph(buildGraph(await demoPortfolioSource.load()));
    const analytics = computeAnalytics(index);
    expect(analytics.componentUsage.slice(0, 4).map((usage) => usage.component.name)).toEqual([
      "Heading",
      "Main Card",
      "Information Container",
      "Input Field",
    ]);
    expect(analytics.componentUsage[0]?.instanceCount).toBe(16);
  });

  it("reports that component identity was inferred", async () => {
    const graph = buildGraph(await demoPortfolioSource.load());
    const warning = graph.warnings.find((w) => w.code === "INFERRED_COMPONENT_IDENTITY");
    expect(warning?.detail?.["count"]).toBe(20);
  });

  it("answers a question in a fraction of the source payload", async () => {
    const index = indexGraph(buildGraph(await demoPortfolioSource.load()));
    const mainCard = index
      .getNodesByType("MAIN_COMPONENT")
      .find((node) => node.name === "Main Card")!;

    const context = buildAiGraphContext(index, mainCard.id, { nodeBudget: 40 })!;
    const prompt = toMarkdownPrompt(context, "Where is this used?");

    // The whole point: a targeted answer must never cost more than re-reading
    // the source it was derived from.
    expect(prompt.length).toBeLessThan(capture.metadataXml.length / 2);
    expect(context.neighbors.length).toBeLessThanOrEqual(40);
  });

  it("answers 'where is this used' from the graph alone", async () => {
    const index = indexGraph(buildGraph(await demoPortfolioSource.load()));
    const mainCard = index
      .getNodesByType("MAIN_COMPONENT")
      .find((node) => node.name === "Main Card")!;

    const instances = index.getAllInstancesOf(mainCard.id);
    expect(instances).toHaveLength(13);
    // Every usage resolves to a real path back up to the screen.
    for (const instance of instances) {
      expect(index.getHierarchyPath(instance.id).length).toBeGreaterThan(2);
    }
  });
});


describe("combining several MCP captures into one graph", () => {
  const SECOND_SCREEN = `
<frame id="9:1" name="Settings" x="0" y="0" width="440" height="900">
  <instance id="9:2" name="Top Tab" x="0" y="0" width="424" height="48" />
  <instance id="9:3" name="Input Field" x="0" y="64" width="424" height="50" />
</frame>
`;

  const FIRST_SCREEN = `
<frame id="8:1" name="Home" x="0" y="0" width="440" height="900">
  <instance id="8:2" name="Top Tab" x="0" y="0" width="424" height="48" />
  <instance id="8:3" name="Card" x="0" y="64" width="424" height="120" />
</frame>
`;

  const combined = adaptFigmaMcpMetadata({
    fileKey: "KEY",
    fileName: "Two screens",
    captures: [
      { nodeId: "8:1", metadataXml: FIRST_SCREEN, variableDefs: { "color/a": "#111111" } },
      { nodeId: "9:1", metadataXml: SECOND_SCREEN, variableDefs: { "color/b": "#222222" } },
    ],
  });

  it("hangs every captured frame off one document", () => {
    expect(combined.root.children?.map((child) => child.name)).toEqual(["Home", "Settings"]);
  });

  it("dedupes a component used on more than one screen", () => {
    // Three Top Tab / Input Field / Card instances across two captures resolve
    // to three components, not six.
    expect(Object.keys(combined.components).sort()).toEqual([
      "mcp-name:Card",
      "mcp-name:Input Field",
      "mcp-name:Top Tab",
    ]);
  });

  it("attaches each capture's tokens to that capture's own root", () => {
    const [home, settings] = combined.root.children ?? [];
    expect(home?.variableIds).toEqual({ "color/a": "mcp:color/a" });
    expect(settings?.variableIds).toEqual({ "color/b": "mcp:color/b" });
  });

  it("proves cross-screen reuse through the graph", () => {
    const index = indexGraph(buildGraph(combined));
    const topTab = index
      .getNodesByType("MAIN_COMPONENT")
      .find((node) => node.name === "Top Tab")!;

    const screens = new Set(
      index
        .getAllInstancesOf(topTab.id)
        .map((instance) => index.getHierarchyPath(instance.id).find((n) => n.type === "FRAME")?.name),
    );
    expect([...screens].sort()).toEqual(["Home", "Settings"]);
  });

  it("maps slot contents onto the graph, not just the Main Card shell", () => {
    const graph = buildGraph(
      adaptFigmaMcpMetadata({ fileKey: "KEY", fileName: "File", metadataXml: SAMPLE }),
    );
    expect(graph.nodes.some((node) => node.name === "Button")).toBe(true);
    expect(graph.nodes.some((node) => node.name === "Slot" && node.type === "GROUP")).toBe(true);
  });

  it("skips an empty capture instead of failing the whole batch", () => {
    const withGap = adaptFigmaMcpMetadata({
      fileKey: "KEY",
      fileName: "Partial",
      captures: [{ metadataXml: "nothing here" }, { metadataXml: FIRST_SCREEN }],
    });
    expect(withGap.root.children).toHaveLength(1);
  });
});

describe("the captured demo screens", () => {
  it("merges two real frames into one graph", async () => {
    const index = indexGraph(buildGraph(await demoScreensSource.load()));
    const analytics = computeAnalytics(index);

    expect(index.getNodesByType("FRAME").filter((n) => n.parentId?.startsWith("file:"))).toHaveLength(2);
    expect(analytics.totals.instances).toBe(90);
    // Both screens draw on the same 20 components — nothing double-counted.
    expect(analytics.totals.componentDefinitions).toBe(20);
  });

  it("finds the components shared across both screens", async () => {
    const index = indexGraph(buildGraph(await demoScreensSource.load()));

    const shared = index
      .getNodesByType("MAIN_COMPONENT")
      .filter((main) => {
        const screens = new Set(
          index
            .getAllInstancesOf(main.id)
            .map((instance) => index.getHierarchyPath(instance.id)[1]?.name),
        );
        return screens.size > 1;
      })
      .map((main) => main.name)
      .sort();

    expect(shared).toEqual(["Input Field", "Top Tab"]);
  });
});
