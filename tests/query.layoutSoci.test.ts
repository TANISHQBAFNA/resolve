import { describe, expect, it } from "vitest";
import type { DesignGraph, GraphEdge, GraphNode, NodeType } from "@/core/model";
import {
  advanceSoci,
  applyRecipeLayoutChange,
  dimensionTokensFrom,
  emptySock,
  indexGraph,
  parseRecipeFile,
  proposalTypeOf,
  recordVerifiedUsage,
} from "@/core/query";

const FROZEN = "2026-01-01T00:00:00.000Z";

function n(id: string, type: NodeType, name: string, extra: Partial<GraphNode> = {}): GraphNode {
  return { id, type, name, ...extra };
}

function e(type: GraphEdge["type"], source: string, target: string): GraphEdge {
  return { id: `${type}|${source}|${target}`, source, target, type };
}

/**
 * A frame whose body holds a 3-column field grid — the Trade FO review shape:
 * 1728 wide, columns at 56 / 603 / 1149, fields 523x62, rows every 86.
 */
function screenNodes(frameId: string, columns = [56, 603, 1149]): {
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  const nodes: GraphNode[] = [
    n(frameId, "FRAME", "Review form", {
      parentId: "node:p",
      pageId: "node:p",
      fileKey: "APP",
      bounds: { x: 0, y: 0, width: 1728, height: 1117 },
    }),
    n(`${frameId}:body`, "FRAME", "Body", {
      parentId: frameId,
      pageId: "node:p",
      fileKey: "APP",
      bounds: { x: 0, y: 0, width: 1728, height: 900 },
    }),
  ];
  const edges: GraphEdge[] = [e("CONTAINS", frameId, `${frameId}:body`)];
  let i = 0;
  for (const y of [0, 86, 172, 258]) {
    for (const x of columns) {
      const id = `${frameId}:field${i++}`;
      nodes.push(
        n(id, "COMPONENT_INSTANCE", "input-field", {
          parentId: `${frameId}:body`,
          pageId: "node:p",
          fileKey: "APP",
          mainComponentId: "node:input",
          bounds: { x, y, width: 523, height: 62 },
        }),
      );
      edges.push(e("CONTAINS", `${frameId}:body`, id));
      edges.push(e("INSTANCE_OF", id, "node:input"));
    }
  }
  return { nodes, edges };
}

function buildGraph(frameIds: string[], tokens = true): DesignGraph {
  const nodes: GraphNode[] = [
    n("file:APP", "FILE", "App", { fileKey: "APP" }),
    n("node:p", "PAGE", "Screens", { parentId: "file:APP", pageId: "node:p", fileKey: "APP" }),
    n("node:input", "MAIN_COMPONENT", "input-field", {
      parentId: "node:p",
      pageId: "node:p",
      fileKey: "APP",
    }),
  ];
  const edges: GraphEdge[] = [];
  if (tokens) {
    for (const [name, value] of [
      ["spacing/24", 24],
      ["spacing/56", 56],
      ["spacing/8", 8],
    ] as const) {
      nodes.push({
        ...n(`node:var:${name}`, "VARIABLE", name, { fileKey: "APP" }),
        value,
      } as GraphNode);
    }
  }
  for (const id of frameIds) {
    const part = screenNodes(id);
    nodes.push(...part.nodes);
    edges.push(...part.edges);
  }
  return {
    fileKey: "APP",
    fileName: "App",
    builtAt: FROZEN,
    source: { kind: "mock", ingestedAt: FROZEN },
    warnings: [],
    nodes,
    edges,
  };
}

const RECIPES = parseRecipeFile({
  version: 1,
  recipes: [
    {
      id: "review-form",
      title: "Review form",
      intentAliases: ["review form"],
      slots: [{ role: "field", required: true, hints: ["input", "field"] }],
    },
  ],
});

function verifiedOn(frameIds: string[]) {
  let sock = emptySock();
  for (const frameId of frameIds) {
    sock = recordVerifiedUsage(sock, {
      screenId: frameId,
      screenName: "Review form",
      masters: [{ id: "node:input", name: "input-field", fileKey: "APP", figmaNodeId: "input" }],
      frameId,
      countsTowardThreshold: true,
      verifiedAt: FROZEN,
    });
  }
  return sock;
}

describe("dimensionTokensFrom", () => {
  it("reads spacing variables out of the graph", () => {
    const tokens = dimensionTokensFrom(indexGraph(buildGraph(["node:f1"])));
    expect(tokens).toContainEqual({ name: "spacing/24", value: 24 });
    expect(tokens).toContainEqual({ name: "spacing/56", value: 56 });
  });

  it("returns nothing on a metadata-only ingest", () => {
    expect(dimensionTokensFrom(indexGraph(buildGraph(["node:f1"], false)))).toEqual([]);
  });

  it("is safe with no index at all", () => {
    expect(dimensionTokensFrom(undefined)).toEqual([]);
  });
});

describe("detectLayoutUpdates via advanceSoci", () => {
  it("proposes the grid it saw on verified frames", () => {
    const index = indexGraph(buildGraph(["node:f1", "node:f2", "node:f3"]));
    const sock = advanceSoci(verifiedOn(["node:f1", "node:f2", "node:f3"]), {
      recipes: RECIPES,
      index,
      now: FROZEN,
    });
    const proposal = sock.proposals.find((p) => proposalTypeOf(p) === "layout-update");
    expect(proposal).toBeDefined();
    expect(proposal!.suggestedLayout?.recipeId).toBe("review-form");
    const layout = proposal!.suggestedLayout!.layout;
    expect(layout.columns).toBe(3);
    expect(layout.gutter.token).toBe("spacing/24");
    expect(layout.marginLeft.token).toBe("spacing/56");
    expect(layout.evidence?.confidence).toBe("strong");
    expect(proposal!.summary).toContain("3 cols");
  });

  it("stays weak on a single frame — one frame is an anecdote", () => {
    const index = indexGraph(buildGraph(["node:f1"]));
    const sock = advanceSoci(verifiedOn(["node:f1"]), {
      recipes: RECIPES,
      index,
      now: FROZEN,
    });
    const proposal = sock.proposals.find((p) => proposalTypeOf(p) === "layout-update");
    expect(proposal?.confidence).toBe("low");
    expect(proposal?.suggestedLayout?.layout.evidence?.confidence).toBe("weak");
  });

  it("says nothing when the recipe already records that grid", () => {
    const index = indexGraph(buildGraph(["node:f1", "node:f2", "node:f3"]));
    const first = advanceSoci(verifiedOn(["node:f1", "node:f2", "node:f3"]), {
      recipes: RECIPES,
      index,
      now: FROZEN,
    });
    const approved = applyRecipeLayoutChange(
      RECIPES[0],
      first.proposals.find((p) => proposalTypeOf(p) === "layout-update")!.suggestedLayout!,
    );
    const second = advanceSoci(verifiedOn(["node:f1", "node:f2", "node:f3"]), {
      recipes: [approved],
      index,
      now: FROZEN,
    });
    expect(second.proposals.find((p) => proposalTypeOf(p) === "layout-update")).toBeUndefined();
  });

  it("never proposes without an index — geometry is not guessable", () => {
    const sock = advanceSoci(verifiedOn(["node:f1"]), { recipes: RECIPES, now: FROZEN });
    expect(sock.proposals.find((p) => proposalTypeOf(p) === "layout-update")).toBeUndefined();
  });

  it("still derives a grid when the file carries no tokens", () => {
    const index = indexGraph(buildGraph(["node:f1", "node:f2", "node:f3"], false));
    const sock = advanceSoci(verifiedOn(["node:f1", "node:f2", "node:f3"]), {
      recipes: RECIPES,
      index,
      now: FROZEN,
    });
    const layout = sock.proposals.find((p) => proposalTypeOf(p) === "layout-update")
      ?.suggestedLayout?.layout;
    expect(layout?.columns).toBe(3);
    expect(layout?.gutter.px).toBe(24);
    expect(layout?.gutter.token).toBeUndefined();
  });
});

describe("applyRecipeLayoutChange", () => {
  it("stores exactly what was reviewed and leaves slots alone", () => {
    const layout = {
      columns: 3,
      columnWidth: 523,
      gutter: { px: 24, token: "spacing/24" },
      marginLeft: { px: 56, token: "spacing/56" },
      marginRight: { px: 56, token: "spacing/56" },
      sampleSize: 12,
    };
    const updated = applyRecipeLayoutChange(RECIPES[0], {
      recipeId: "review-form",
      layout,
      frames: ["node:f1"],
    });
    expect(updated.layout).toEqual(layout);
    expect(updated.slots).toEqual(RECIPES[0].slots);
  });
});
