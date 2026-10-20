import { describe, expect, it } from "vitest";
import type { DesignGraph, GraphNode, NodeType } from "@/core/model";
import { indexGraph } from "@/core/query";
import { weakMatchWhy } from "@/core/query/recommendLexicon";
import { inventsInCard } from "@/core/query/scoreboard";

const FROZEN = "2026-01-01T00:00:00.000Z";
const n = (id: string, type: NodeType, name: string, extra: Partial<GraphNode> = {}): GraphNode => ({ id, type, name, fileKey: "GLOW", ...extra });

/** A made-up library: one part, and a frame whose name is a word the why text quotes. */
function glowGraph(): DesignGraph {
  return {
    fileKey: "GLOW",
    fileName: "Glow Kit",
    builtAt: FROZEN,
    source: { kind: "mock", ingestedAt: FROZEN },
    warnings: [],
    nodes: [
      n("file:GLOW", "FILE", "Glow Kit"),
      n("page:1", "PAGE", "Screens", { parentId: "file:GLOW" }),
      n("node:1:1", "FRAME", "panel", { parentId: "page:1", figmaNodeId: "1:1" }),
      n("node:1:2", "FRAME", "main", { parentId: "page:1", figmaNodeId: "1:2" }),
      n("node:1:3", "COMPONENT_INSTANCE", "Glowbar", { parentId: "node:1:2", figmaNodeId: "1:3", mainComponentId: "node:9:2" }),
      n("node:1:4", "COMPONENT_INSTANCE", "Glowbar", { parentId: "node:1:2", figmaNodeId: "1:4", mainComponentId: "node:9:2" }),
      n("node:9:1", "MAIN_COMPONENT", "Glowbar Panel", { figmaNodeId: "9:1", isMainComponent: true }),
      n("node:9:2", "MAIN_COMPONENT", "Glowbar", { figmaNodeId: "9:2", isMainComponent: true }),
      n("node:9:3", "MAIN_COMPONENT", "Primary", { figmaNodeId: "9:3", isMainComponent: true }),
    ],
    edges: [
      { id: "e1", source: "node:1:3", target: "node:9:2", type: "INSTANCE_OF" },
      { id: "e2", source: "node:1:4", target: "node:9:2", type: "INSTANCE_OF" },
    ],
  };
}

describe("invented-part check ignores the why text", () => {
  it("does not count a word quoted in why as an invented part", () => {
    const index = indexGraph(glowGraph());
    const card = {
      candidates: [{ id: "node:9:1", name: "Glowbar Panel", why: "only the word 'panel' matched; no variant or role matched" }],
    };
    expect(inventsInCard(card, index)).toEqual([]);
    // Ids and names outside why are still checked.
    expect(inventsInCard({ candidates: [{ id: "node:404", name: "Ghost Panel" }] }, index)).toEqual(["id node:404", "name Ghost Panel"]);
  });

  it("counts nothing invented for a correct weak typo card whose why quotes a frame name", () => {
    const index = indexGraph(glowGraph());
    // The card recommend gives for a weak typo: the right part, flagged weak, and the why line recommend writes.
    const why = weakMatchWhy("main glowbr", "Glowbar");
    expect(why).toMatch(/'main'/);
    const card = { intent: "main glowbr", match: "weak match", candidates: [{ id: "node:9:2", name: "Glowbar", fileKey: "GLOW", figmaNodeId: "9:2", why }] };
    expect(inventsInCard(card, index)).toEqual([]);
    // The same card still counts a part that is not in the library.
    expect(inventsInCard({ ...card, candidates: [{ ...card.candidates[0]!, id: "node:9:9", name: "Glowbar Pro" }] }, index)).toEqual(["id node:9:9", "name Glowbar Pro"]);
  });
});
