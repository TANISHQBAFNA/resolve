import { describe, expect, it } from "vitest";
import {
  collectTopLevelScreens,
  fileFromNodesResponse,
  resolveIngestScope,
} from "@/core/ingestion/figmaScope";

describe("resolveIngestScope", () => {
  it("uses the shared node when the URL has a node-id", () => {
    expect(resolveIngestScope({ fileKey: "abc", nodeIds: ["1:2"] })).toBe("node");
    expect(resolveIngestScope({ fileKey: "abc", nodeIds: [] })).toBe("screens");
    expect(resolveIngestScope({ fileKey: "abc", nodeIds: [] }, "file")).toBe("file");
  });

  it("refuses scope=node without a node-id", () => {
    expect(() => resolveIngestScope({ fileKey: "abc", nodeIds: [] }, "node")).toThrow(/node-id/);
  });
});

describe("collectTopLevelScreens", () => {
  it("takes FRAME and SECTION on a page, recurses GROUP, skips nested frames in a section", () => {
    const screens = collectTopLevelScreens({
      id: "0:0",
      type: "DOCUMENT",
      children: [
        {
          id: "1:0",
          name: "Page",
          type: "CANVAS",
          children: [
            { id: "1:1", name: "Home", type: "FRAME" },
            {
              id: "1:2",
              name: "Checkout",
              type: "SECTION",
              children: [{ id: "1:3", name: "Step 1", type: "FRAME" }],
            },
            {
              id: "1:4",
              name: "wrap",
              type: "GROUP",
              children: [{ id: "1:5", name: "Settings", type: "FRAME" }],
            },
            { id: "1:6", name: "Button", type: "COMPONENT" },
          ],
        },
      ],
    });
    expect(screens.map((screen) => screen.id)).toEqual(["1:1", "1:2", "1:5", "1:6"]);
    expect(screens[1]).toMatchObject({ pageId: "1:0", pageName: "Page", type: "SECTION" });
    expect(screens[3]).toMatchObject({ id: "1:6", name: "Button", type: "COMPONENT" });
  });

  it("collects page-level COMPONENT_SET and labels unnamed sections", () => {
    const screens = collectTopLevelScreens({
      id: "0:0",
      type: "DOCUMENT",
      children: [
        {
          id: "2:0",
          name: "Search",
          type: "CANVAS",
          children: [
            { id: "2:1", name: "Search docked layout", type: "COMPONENT_SET" },
            { id: "2:2", name: "", type: "SECTION" },
            { id: "2:3", type: "COMPONENT_SET" },
          ],
        },
      ],
    });
    expect(screens.map((screen) => screen.id)).toEqual(["2:1", "2:2", "2:3"]);
    expect(screens[0]?.type).toBe("COMPONENT_SET");
    expect(screens[1]?.name).toBe("Search 2");
    expect(screens[2]?.name).toMatch(/^Search /);
  });
});

describe("fileFromNodesResponse", () => {
  it("wraps a frame under a synthetic Shared page", () => {
    const file = fileFromNodesResponse({
      name: "Pay",
      nodes: {
        "1:1": {
          document: { id: "1:1", name: "Home", type: "FRAME", children: [] },
          components: { "2:1": { name: "Button" } },
        },
      },
    }) as { name: string; document: { children: Array<{ name: string; children: Array<{ id: string }> }> }; components: Record<string, { name: string }> };

    expect(file.name).toBe("Pay");
    expect(file.document.children[0]?.name).toBe("Shared");
    expect(file.document.children[0]?.children[0]?.id).toBe("1:1");
    expect(file.components["2:1"]?.name).toBe("Button");
  });

  it("keeps the original page when screen refs are provided", () => {
    const file = fileFromNodesResponse(
      {
        name: "Pay",
        nodes: {
          "1:1": {
            document: { id: "1:1", name: "Home", type: "FRAME" },
          },
        },
      },
      [{ id: "1:1", pageId: "1:0", pageName: "Checkout" }],
    ) as { document: { children: Array<{ id: string; name: string }> } };

    expect(file.document.children[0]).toMatchObject({ id: "1:0", name: "Checkout" });
  });
});
