import { describe, expect, it } from "vitest";
import type { DesignGraph, GraphEdge, GraphNode, NodeType } from "@/core/model";
import {
  checkCousins,
  indexGraph,
  mergeWorkspaceGraphs,
  parseRecipeFile,
} from "@/core/query";

const FROZEN = "2026-01-01T00:00:00.000Z";

function n(id: string, type: NodeType, name: string, extra: Partial<GraphNode> = {}): GraphNode {
  return { id, type, name, ...extra };
}

function e(type: GraphEdge["type"], source: string, target: string): GraphEdge {
  return { id: `${type}|${source}|${target}`, source, target, type };
}

const recipes = parseRecipeFile({
  recipes: [
    {
      id: "checkout-summary",
      title: "Checkout summary",
      intentAliases: ["checkout"],
      slots: [{ role: "primary-cta", required: true, hints: ["button", "primary"] }],
    },
  ],
});

const workspace = {
  version: 1 as const,
  files: [
    { role: "library" as const, key: "LIB", label: "Shared DS" },
    { role: "product" as const, key: "PROD", label: "Storefront" },
  ],
};

function cousinLab() {
  const lib: DesignGraph = {
    fileKey: "LIB",
    fileName: "Shared DS",
    builtAt: FROZEN,
    source: { kind: "mock", ingestedAt: FROZEN },
    warnings: [],
    nodes: [
      n("file:LIB", "FILE", "Shared DS", { fileKey: "LIB" }),
      n("node:lp", "PAGE", "Components", { parentId: "file:LIB", pageId: "node:lp", fileKey: "LIB" }),
      n("node:btn-set", "COMPONENT_SET", "Button", {
        parentId: "node:lp",
        pageId: "node:lp",
        figmaNodeId: "9:0",
        fileKey: "LIB",
      }),
      n("node:primary", "VARIANT", "Primary", {
        parentId: "node:btn-set",
        pageId: "node:lp",
        componentSetId: "node:btn-set",
        figmaNodeId: "9:1",
        fileKey: "LIB",
        isMainComponent: true,
        variantProperties: { Variant: "Primary" },
      }),
    ],
    edges: [
      e("CONTAINS", "file:LIB", "node:lp"),
      e("CONTAINS", "node:lp", "node:btn-set"),
      e("CONTAINS", "node:btn-set", "node:primary"),
      e("VARIANT_OF", "node:primary", "node:btn-set"),
    ],
  };

  const prod: DesignGraph = {
    fileKey: "PROD",
    fileName: "Storefront",
    builtAt: FROZEN,
    source: { kind: "mock", ingestedAt: FROZEN },
    warnings: [],
    nodes: [
      n("file:PROD", "FILE", "Storefront", { fileKey: "PROD" }),
      n("node:pp", "PAGE", "App", { parentId: "file:PROD", pageId: "node:pp", fileKey: "PROD" }),
      n("node:frame", "FRAME", "Checkout Summary", {
        parentId: "node:pp",
        pageId: "node:pp",
        figmaNodeId: "2:1",
        fileKey: "PROD",
      }),
      n("node:oneoff", "MAIN_COMPONENT", "One-off Pay Button", {
        parentId: "node:pp",
        pageId: "node:pp",
        figmaNodeId: "8:8",
        fileKey: "PROD",
        isMainComponent: true,
      }),
      n("node:stub", "MAIN_COMPONENT", "Primary", {
        figmaNodeId: "9:1",
        fileKey: "PROD",
        isRemote: true,
        isMainComponent: true,
        metadata: { key: "btn-primary-key", remote: true },
      }),
      n("node:okinst", "COMPONENT_INSTANCE", "Primary", {
        parentId: "node:frame",
        pageId: "node:pp",
        isInstance: true,
        mainComponentId: "node:stub",
        figmaNodeId: "2:9",
        fileKey: "PROD",
        isRemote: true,
      }),
      n("node:badinst", "COMPONENT_INSTANCE", "One-off Pay Button", {
        parentId: "node:frame",
        pageId: "node:pp",
        isInstance: true,
        mainComponentId: "node:oneoff",
        figmaNodeId: "2:2",
        fileKey: "PROD",
      }),
      n("node:mystery", "MAIN_COMPONENT", "Quantum Flux", {
        parentId: "node:pp",
        pageId: "node:pp",
        figmaNodeId: "7:7",
        fileKey: "PROD",
        isMainComponent: true,
      }),
    ],
    edges: [
      e("CONTAINS", "file:PROD", "node:pp"),
      e("CONTAINS", "node:pp", "node:frame"),
      e("CONTAINS", "node:pp", "node:oneoff"),
      e("CONTAINS", "node:pp", "node:mystery"),
      e("CONTAINS", "node:frame", "node:okinst"),
      e("CONTAINS", "node:frame", "node:badinst"),
      e("INSTANCE_OF", "node:okinst", "node:stub"),
      e("INSTANCE_OF", "node:badinst", "node:oneoff"),
      e("USED_IN", "node:stub", "node:okinst"),
      e("USED_IN", "node:oneoff", "node:badinst"),
      e("NESTS", "node:frame", "node:okinst"),
      e("NESTS", "node:frame", "node:badinst"),
    ],
  };

  const merged = mergeWorkspaceGraphs(
    [
      { graph: lib, role: "library" },
      { graph: prod, role: "product" },
    ],
    workspace,
  );
  return { index: indexGraph(merged), merged };
}

describe("wrong-cousin report", () => {
  it("flags a product one-off that shares a role with the library Primary", () => {
    const { index } = cousinLab();
    const report = checkCousins(index, {
      frame: "Checkout Summary",
      job: "checkout summary",
      recipes,
      workspace,
    });
    expect(report.checked).toBe(true);
    expect(report.cousins.length).toBeGreaterThan(0);
    expect(report.cousins.some((hit) => hit.placed.name === "One-off Pay Button")).toBe(true);
    const cousin = report.cousins.find((hit) => hit.placed.name === "One-off Pay Button");
    expect(cousin?.expected?.fileKey).toBe("LIB");
    expect(cousin?.expected?.figmaNodeId).toBe("9:1");
    expect(cousin?.expected?.name).toMatch(/primary/i);
    expect(cousin && "graph" in cousin).toBe(false);
  });

  it("does not flag a placement of the real library master", () => {
    const { index } = cousinLab();
    const report = checkCousins(index, {
      components: ["Primary"],
      job: "checkout summary",
      recipes,
      workspace,
    });
    expect(report.cousins).toEqual([]);
    expect(report.ok).toBeGreaterThan(0);
  });

  it("refuses to guess when the name does not match a library master", () => {
    const { index } = cousinLab();
    const report = checkCousins(index, {
      components: ["Quantum Flux"],
      workspace,
    });
    expect(report.cousins).toEqual([]);
    expect(report.unsure.some((hit) => hit.placed.name === "Quantum Flux")).toBe(true);
    expect(report.unsure[0]?.expected).toBeUndefined();
    expect(report.hint.toLowerCase()).toMatch(/not sure|do not invent/);
  });

  it("does not flag a same-name library master when the product node is only a name guess", () => {
    const { index } = cousinLab();
    const graph = index.graph;
    graph.nodes.push(
      n("node:lib-card", "MAIN_COMPONENT", "Summary Card", {
        figmaNodeId: "4:1",
        fileKey: "LIB",
        isMainComponent: true,
      }),
      n("node:lib-price", "MAIN_COMPONENT", "Price", {
        figmaNodeId: "4:2",
        fileKey: "LIB",
        isMainComponent: true,
      }),
      n("node:guess-card", "MAIN_COMPONENT", "Summary Card", {
        figmaNodeId: "mcp-name:Summary Card",
        fileKey: "PROD",
        isMainComponent: true,
        metadata: { identity: "inferred-from-name" },
      }),
      n("node:guess-price", "MAIN_COMPONENT", "Price", {
        figmaNodeId: "mcp-name:Price",
        fileKey: "PROD",
        isMainComponent: true,
        metadata: { identity: "inferred-from-name" },
      }),
    );
    const report = checkCousins(indexGraph(graph), {
      components: ["node:guess-card", "node:guess-price"],
      workspace,
    });
    expect(report.cousins.map((hit) => hit.placed.name)).not.toContain("Summary Card");
    expect(report.cousins.map((hit) => hit.placed.name)).not.toContain("Price");
    expect(report.ok).toBeGreaterThan(0);
  });

  it("still flags a real local copy that shares a library master's name", () => {
    const { index } = cousinLab();
    const graph = index.graph;
    graph.nodes.push(
      n("node:lib-card", "MAIN_COMPONENT", "Summary Card", {
        figmaNodeId: "4:1",
        fileKey: "LIB",
        isMainComponent: true,
      }),
      n("node:lib-price", "MAIN_COMPONENT", "Price", {
        figmaNodeId: "4:2",
        fileKey: "LIB",
        isMainComponent: true,
      }),
      n("node:local-card", "MAIN_COMPONENT", "Summary Card", {
        figmaNodeId: "3:1",
        fileKey: "PROD",
        isMainComponent: true,
      }),
      n("node:local-price", "MAIN_COMPONENT", "Price", {
        figmaNodeId: "3:2",
        fileKey: "PROD",
        isMainComponent: true,
      }),
    );
    const report = checkCousins(indexGraph(graph), {
      components: ["node:local-card", "node:local-price"],
      workspace,
    });
    const flagged = report.cousins.map((hit) => hit.placed.name);
    expect(flagged).toContain("Summary Card");
    expect(flagged).toContain("Price");
    expect(report.cousins.every((hit) => hit.expected?.fileKey === "LIB")).toBe(true);
    expect(report.ok).toBe(0);
  });

  it("flags local Price and Summary Card on Cart Page even when instances are name guesses", () => {
    const graph: DesignGraph = {
      fileKey: "LIB",
      fileName: "Shared DS",
      builtAt: FROZEN,
      source: { kind: "mock", ingestedAt: FROZEN },
      warnings: [],
      nodes: [
        n("file:LIB", "FILE", "Shared DS", { fileKey: "LIB" }),
        n("node:lib-price", "MAIN_COMPONENT", "Price", {
          figmaNodeId: "22:3",
          fileKey: "LIB",
          isMainComponent: true,
        }),
        n("node:lib-card", "MAIN_COMPONENT", "Summary Card", {
          figmaNodeId: "22:4",
          fileKey: "LIB",
          isMainComponent: true,
        }),
        n("file:PROD", "FILE", "Storefront", { fileKey: "PROD" }),
        n("node:cart", "FRAME", "Cart Page", { figmaNodeId: "5:1", fileKey: "PROD" }),
        n("node:local-price", "MAIN_COMPONENT", "Price", {
          figmaNodeId: "5:4",
          fileKey: "PROD",
          isMainComponent: true,
        }),
        n("node:local-card", "MAIN_COMPONENT", "Summary Card", {
          figmaNodeId: "5:5",
          fileKey: "PROD",
          isMainComponent: true,
        }),
        n("node:guess-price", "MAIN_COMPONENT", "Price", {
          figmaNodeId: "mcp-name:Price",
          fileKey: "PROD",
          isMainComponent: true,
          metadata: { identity: "inferred-from-name" },
        }),
        n("node:guess-card", "MAIN_COMPONENT", "Summary Card", {
          figmaNodeId: "mcp-name:Summary Card",
          fileKey: "PROD",
          isMainComponent: true,
          metadata: { identity: "inferred-from-name" },
        }),
        n("node:inst-price", "COMPONENT_INSTANCE", "Price", {
          parentId: "node:cart",
          mainComponentId: "node:guess-price",
          figmaNodeId: "5:2",
          fileKey: "PROD",
          isInstance: true,
        }),
        n("node:inst-card", "COMPONENT_INSTANCE", "Summary Card", {
          parentId: "node:cart",
          mainComponentId: "node:guess-card",
          figmaNodeId: "5:3",
          fileKey: "PROD",
          isInstance: true,
        }),
      ],
      edges: [
        e("NESTS", "node:cart", "node:inst-price"),
        e("NESTS", "node:cart", "node:inst-card"),
        e("INSTANCE_OF", "node:inst-price", "node:guess-price"),
        e("INSTANCE_OF", "node:inst-card", "node:guess-card"),
      ],
    };
    const index = indexGraph(graph);
    const expectBoth = (report: ReturnType<typeof checkCousins>) => {
      expect(report.checked).toBe(true);
      const names = report.cousins.map((hit) => hit.placed.name).sort();
      expect(names).toEqual(["Price", "Summary Card"]);
      expect(report.cousins.every((hit) => hit.placed.fileKey === "PROD")).toBe(true);
      expect(report.cousins.every((hit) => hit.placed.id === "node:local-price" || hit.placed.id === "node:local-card")).toBe(
        true,
      );
      expect(JSON.stringify(report.cousins)).not.toContain("mcp-name:");
      expect(report.cousins.every((hit) => hit.expected?.fileKey === "LIB")).toBe(true);
      expect(report.ok).toBe(0);
    };
    expectBoth(checkCousins(index, { frame: "Cart Page", workspace }));
    expectBoth(checkCousins(index, { fileKey: "PROD", workspace }));
    expectBoth(checkCousins(index, { components: ["Price", "Summary Card"], workspace }));
  });

  it("refuses when the workspace has no library-role file", () => {
    const { index } = cousinLab();
    const report = checkCousins(index, {
      frame: "Checkout Summary",
      workspace: { version: 1, files: [{ role: "product", key: "PROD", label: "Storefront" }] },
    });
    expect(report.checked).toBe(false);
    expect(report.reason).toBe("no-library-file");
    expect(report.cousins).toEqual([]);
  });
});
