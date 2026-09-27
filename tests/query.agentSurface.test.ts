import { describe, expect, it } from "vitest";
import type { DesignGraph, GraphEdge, GraphNode, NodeType } from "@/core/model";
import { demoScreensSource } from "@/core/ingestion/adapters/mcpSource";
import { buildGraph } from "@/core/transform";
import {
  buildOrientBrief,
  checkFrame,
  componentUsageCard,
  costOf,
  explainNode,
  indexGraph,
  pathBetween,
  queryQuestion,
  similarUsage,
  toGraphReportMarkdown,
} from "@/core/query";
import { ids, index as demo } from "./fixture";

function n(id: string, type: NodeType, name: string, extra: Partial<GraphNode> = {}): GraphNode {
  return { id, type, name, ...extra };
}
function e(type: GraphEdge["type"], source: string, target: string): GraphEdge {
  return { id: `${type}|${source}|${target}`, source, target, type };
}

async function load() {
  return indexGraph(buildGraph(await demoScreensSource.load()));
}

describe("agent surface", () => {
  it("orient names god nodes and questions without the source file", async () => {
    const brief = buildOrientBrief(await load());
    expect(brief.godNodes.length).toBeGreaterThan(0);
    expect(brief.askNext.length).toBeGreaterThan(0);
    expect(brief.totals.componentDefinitions).toBeGreaterThan(0);

    const report = toGraphReportMarkdown(brief);
    expect(report).toContain("## God nodes");
    expect(report).toContain("Ask next");
    expect(report).toContain("## Implement a screen");
    expect(report).toContain("resolve");
    expect(report).toMatch(/Do \*\*not\*\* call `get_design_context` on a FRAME/);
    expect(costOf(brief).chars).toBeLessThan(8000);
  });

  it("querying a frame lists each component once with a count, not every instance", async () => {
    const result = queryQuestion(await load(), "What is Portfolio built from?");
    expect("components" in result).toBe(true);
    if (!("components" in result) || !result.components) return;
    const names = result.components.map((row) => row.name);
    expect(new Set(names).size).toBe(names.length);
    const heading = result.components.find((row) => row.name === "Heading");
    expect(heading?.count).toBeGreaterThan(1);
    expect(result.cost.chars).toBeLessThan(4000);
  });

  it("query is one hop: match + bounded neighbourhood, under budget", async () => {
    const result = queryQuestion(await load(), "Input Field", { budgetChars: 4000 });
    expect(result.cost.chars).toBeLessThanOrEqual(4000);
    if ("use" in result && result.use) {
      expect(result.use.name).toMatch(/input|field/i);
      return;
    }
    if ("focus" in result && result.focus) {
      expect(result.focus.name).toMatch(/Input Field/i);
    }
    if ("nodes" in result && Array.isArray(result.nodes)) {
      expect(result.nodes.length).toBeGreaterThan(0);
    }
  });

  it("path resolves names, not just ids", async () => {
    const result = pathBetween(await load(), "Portfolio", "Input Field");
    expect(result.connected).toBe(true);
    expect(result.hops).toBeGreaterThan(0);
  });

  it("explain returns markdown cheaper than a file dump", async () => {
    const result = explainNode(await load(), "Main Card");
    expect(result.found).toBe(true);
    if ("markdown" in result && result.markdown) {
      expect(result.markdown).toContain("Main Card");
      expect(result.markdown.length).toBeLessThan(20_000);
    }
  });
});

describe("similar usage (analog screens)", () => {
  it("recommends the button variant nested on related screens, not the page tree", () => {
    const analog = similarUsage(demo, "create account buttons");
    expect(analog.screens.some((screen) => screen.id === ids.frameCreateAccount)).toBe(true);
    expect(analog.variants[0]?.id).toBe(ids.buttonPrimaryLarge);
    expect(analog.variants[0]?.variantProperties?.["Variant"]).toBe("Primary");
  });

  it("walks prototype neighbours so a new payment screen sees Confirm payment's danger button", () => {
    const result = queryQuestion(demo, "receipt page buttons");
    expect("use" in result).toBe(true);
    if (!("also" in result) || !result.also) return;
    const names = [result.use.name, ...result.also.map((variant) => variant.name)].join(" ");
    expect(names).toMatch(/Danger|Primary/i);
    expect(result.similarScreens.some((screen) => screen.why === "prototype")).toBe(true);
  });

  it("check_frame recommends a live variant and lists deprecated ones", () => {
    const result = checkFrame(demo, "create account buttons");
    expect(result.use?.id).toBe(ids.buttonPrimaryLarge);
    expect(result.use?.status).not.toBe("deprecated");
    expect(result.avoid.every((variant) => variant.status === "deprecated")).toBe(true);
  });

  it("path between two screens reports shared components", () => {
    const result = pathBetween(demo, "Welcome", "Create account");
    expect(result.connected).toBe(true);
    if (!("via" in result) || !result.via) throw new Error("expected via hops");
    expect(result.via.some((hop) => hop.type === "PROTOTYPES_TO")).toBe(true);
    expect(result.path.some((node) => node.type === "PAGE")).toBe(false);
  });
});

describe("usage cards (resolve)", () => {
  it("Main Card lists screens, slot fills, and stays under 2000 chars", async () => {
    const card = componentUsageCard(await load(), "Main Card");
    expect(card.found).toBe(true);
    if (!("kind" in card) || card.kind !== "component") throw new Error("expected component card");
    expect(card.component.name).toBe("Main Card");
    expect(card.instances).toBeGreaterThan(1);
    expect(card.byScreen.length).toBeGreaterThan(0);
    expect(card.byScreen.some((row) => typeof row.name === "string" && row.count > 0)).toBe(true);
    const slots = card.byScreen.flatMap((row) => row.slots ?? []);
    expect(slots.length).toBeGreaterThan(0);
    expect(card.cost.chars).toBeLessThan(2000);
  });

  it("returns a zero-usage master with id + fileKey + figmaNodeId, not an empty list", () => {
    const graph: DesignGraph = {
      fileKey: "CAP",
      fileName: "Hand capture",
      builtAt: "2026-01-01T00:00:00.000Z",
      source: { kind: "mock", ingestedAt: "2026-01-01T00:00:00.000Z" },
      warnings: [],
      nodes: [
        n("file:CAP", "FILE", "Hand capture", { fileKey: "CAP" }),
        n("node:p", "PAGE", "Page", { parentId: "file:CAP", pageId: "node:p", fileKey: "CAP" }),
        n("node:frame", "FRAME", "Main Card", {
          parentId: "node:p",
          pageId: "node:p",
          figmaNodeId: "1:1",
          fileKey: "CAP",
        }),
        n("node:card", "MAIN_COMPONENT", "Main Card", {
          parentId: "node:p",
          pageId: "node:p",
          figmaNodeId: "9:9",
          fileKey: "CAP",
          isMainComponent: true,
        }),
        n("node:box", "MAIN_COMPONENT", "Information Container", {
          parentId: "node:p",
          pageId: "node:p",
          figmaNodeId: "8:8",
          fileKey: "CAP",
          isMainComponent: true,
        }),
      ],
      edges: [
        e("CONTAINS", "file:CAP", "node:p"),
        e("CONTAINS", "node:p", "node:frame"),
        e("CONTAINS", "node:p", "node:card"),
        e("CONTAINS", "node:p", "node:box"),
      ],
    };
    const index = indexGraph(graph);

    const card = componentUsageCard(index, "Main Card");
    expect(card.found).toBe(true);
    if (!("kind" in card) || card.kind !== "component") throw new Error("expected component card");
    expect(card.component.id).toBe("node:card");
    expect(card.component.figmaNodeId).toBe("9:9");
    expect(card.component.fileKey).toBe("CAP");
    expect(card.instances).toBe(0);
    expect("components" in card ? card.components : undefined).toBeUndefined();

    const box = componentUsageCard(index, "Information Container");
    expect(box.found).toBe(true);
    if (!("kind" in box) || box.kind !== "component") throw new Error("expected component card");
    expect(box.component.figmaNodeId).toBe("8:8");
    expect(box.component.fileKey).toBe("CAP");

    const miss = componentUsageCard(index, "Not A Real Master");
    expect(miss.found).toBe(false);
    expect(miss.hint).toMatch(/recommend/i);
    expect(miss.hint).not.toMatch(/\[\]/);
  });

  it("Heading counts placements per named screen", async () => {
    const card = componentUsageCard(await load(), "Heading");
    expect(card.found).toBe(true);
    if (!("kind" in card) || card.kind !== "component") throw new Error("expected component card");
    expect(card.component.name).toBe("Heading");
    expect(card.instances).toBeGreaterThan(1);
    expect(card.byScreen.some((row) => row.count > 1)).toBe(true);
    expect(card.cost.chars).toBeLessThan(2000);
  });
});
