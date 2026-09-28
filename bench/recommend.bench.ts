import { describe, expect, it } from "vitest";
import type { DesignGraph, GraphEdge, GraphNode, NodeType } from "@/core/model";
import { exampleCard, indexGraph, recommendMasters, verifyFrame } from "@/core/query";

/**
 * Generated large file. One fixed component is placed on many screens so the
 * peer-height check can go quadratic; the rest of the nodes are filler.
 * Not part of `npm test` — run with `npm run bench`.
 */

function n(id: string, type: NodeType, name: string, extra: Partial<GraphNode> = {}): GraphNode {
  return { id, type, name, ...extra };
}

function e(type: GraphEdge["type"], source: string, target: string): GraphEdge {
  return { id: `${type}|${source}|${target}`, source, target, type };
}

function largeFile(nodesTarget: number, instances: number) {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const file = "file:B";
  const page = "node:page";
  const master = "node:button";
  const masterText = "node:button-text";
  nodes.push(
    n(file, "FILE", "Bench", { fileKey: "BENCH" }),
    n(page, "PAGE", "Screens", { parentId: file, pageId: page, fileKey: "BENCH" }),
    n(master, "MAIN_COMPONENT", "Button", {
      parentId: page,
      pageId: page,
      figmaNodeId: "9:1",
      fileKey: "BENCH",
      isMainComponent: true,
      metadata: { layoutMode: "VERTICAL", layoutSizingVertical: "FIXED" },
      bounds: { x: 0, y: 0, width: 200, height: 48 },
    }),
    n(masterText, "TEXT_LAYER", "Label", {
      parentId: master,
      metadata: { text: "Click here please" },
      bounds: { x: 0, y: 0, width: 120, height: 20 },
    }),
  );
  edges.push(
    e("CONTAINS", file, page),
    e("CONTAINS", page, master),
    e("CONTAINS", master, masterText),
  );

  for (let i = 0; i < instances; i += 1) {
    const frame = `node:f:${i}`;
    const inst = `node:i:${i}`;
    const text = `node:t:${i}`;
    nodes.push(
      n(frame, "FRAME", `Screen ${i}`, {
        parentId: page,
        pageId: page,
        figmaNodeId: `1:${i}`,
        fileKey: "BENCH",
      }),
      n(inst, "COMPONENT_INSTANCE", "Button", {
        parentId: frame,
        pageId: page,
        isInstance: true,
        mainComponentId: master,
        figmaNodeId: `2:${i}`,
        fileKey: "BENCH",
        bounds: { x: 0, y: 0, width: 200, height: 160 },
        metadata: { layoutMode: "VERTICAL", layoutSizingVertical: "FIXED" },
      }),
      n(text, "TEXT_LAYER", "Label", {
        parentId: inst,
        metadata: { text: `Pay invoice number ${i} today` },
        bounds: { x: 0, y: 8, width: 160, height: 24 },
      }),
    );
    edges.push(
      e("CONTAINS", page, frame),
      e("CONTAINS", frame, inst),
      e("CONTAINS", inst, text),
      e("INSTANCE_OF", inst, master),
      e("NESTS", frame, inst),
    );
  }

  const fillerFrame = "node:filler";
  nodes.push(n(fillerFrame, "FRAME", "Filler", { parentId: page, pageId: page, figmaNodeId: "8:1", fileKey: "BENCH" }));
  edges.push(e("CONTAINS", page, fillerFrame));
  const fillerCount = Math.max(0, nodesTarget - nodes.length);
  for (let i = 0; i < fillerCount; i += 1) {
    const id = `node:z:${i}`;
    nodes.push(
      n(id, "LAYER", "Mark", {
        parentId: fillerFrame,
        pageId: page,
        bounds: { x: 0, y: i, width: 4, height: 4 },
      }),
    );
    edges.push(e("CONTAINS", fillerFrame, id));
  }

  const graph: DesignGraph = {
    fileKey: "BENCH",
    fileName: "Bench",
    builtAt: "2026-01-01T00:00:00.000Z",
    source: { kind: "mock", ingestedAt: "2026-01-01T00:00:00.000Z" },
    warnings: [],
    nodes,
    edges,
  };
  return { index: indexGraph(graph), nodes: nodes.length, instances };
}

function time(run: () => void): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

describe("large-file bench", () => {
  it("prints recommend and get_example timings", { timeout: 180_000 }, () => {
    const sizes = [
      { nodes: 24_000, instances: 900 },
      { nodes: 73_000, instances: 2_800 },
    ];
    const rows: string[] = [];
    for (const size of sizes) {
      const file = largeFile(size.nodes, size.instances);
      const recommendMs = time(() => {
        recommendMasters(file.index, "button");
      });
      const exampleMs = time(() => {
        exampleCard(file.index, "Button");
      });
      const verifyMs = time(() => {
        verifyFrame(file.index, { frame: "Screen 0" });
      });
      rows.push(
        `${file.nodes} nodes, ${file.instances} fixed instances: recommend ${recommendMs.toFixed(0)} ms, get_example ${exampleMs.toFixed(0)} ms, verify ${verifyMs.toFixed(0)} ms`,
      );
      if (file.nodes >= 70_000) {
        expect(recommendMs).toBeLessThan(600);
        expect(exampleMs).toBeLessThan(300);
        expect(verifyMs).toBeLessThan(80);
      }
    }
    console.log(rows.join("\n"));
    expect(rows.length).toBe(2);
  });

  it("prints a heavy 40-component graph", { timeout: 180_000 }, () => {
    const components = 40;
    const perComponent = 900;
    const perScreen = 10;
    const screens = (components * perComponent) / perScreen;
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const file = "file:H";
    const page = "node:page";
    nodes.push(
      n(file, "FILE", "Heavy", { fileKey: "HEAVY" }),
      n(page, "PAGE", "Screens", { parentId: file, pageId: page, fileKey: "HEAVY" }),
    );
    edges.push(e("CONTAINS", file, page));
    const masters: string[] = [];
    for (let c = 0; c < components; c += 1) {
      const master = `node:m:${c}`;
      const text = `node:mt:${c}`;
      masters.push(master);
      nodes.push(
        n(master, "MAIN_COMPONENT", c === 0 ? "Button" : `Button ${c}`, {
          parentId: page,
          pageId: page,
          figmaNodeId: `9:${c}`,
          fileKey: "HEAVY",
          isMainComponent: true,
          metadata: { layoutMode: "VERTICAL", layoutSizingVertical: "FIXED" },
          bounds: { x: 0, y: 0, width: 200, height: 48 },
        }),
        n(text, "TEXT_LAYER", "Label", {
          parentId: master,
          metadata: { text: "Click here please" },
          bounds: { x: 0, y: 0, width: 120, height: 20 },
        }),
      );
      edges.push(e("CONTAINS", page, master), e("CONTAINS", master, text));
    }
    let placed = 0;
    for (let s = 0; s < screens; s += 1) {
      const frame = `node:hf:${s}`;
      nodes.push(
        n(frame, "FRAME", `Heavy ${s}`, {
          parentId: page,
          pageId: page,
          figmaNodeId: `3:${s}`,
          fileKey: "HEAVY",
        }),
      );
      edges.push(e("CONTAINS", page, frame));
      for (let slot = 0; slot < perScreen; slot += 1) {
        const master = masters[placed % components]!;
        const inst = `node:hi:${placed}`;
        const text = `node:ht:${placed}`;
        nodes.push(
          n(inst, "COMPONENT_INSTANCE", "Button", {
            parentId: frame,
            pageId: page,
            isInstance: true,
            mainComponentId: master,
            figmaNodeId: `4:${placed}`,
            fileKey: "HEAVY",
            bounds: { x: 0, y: slot * 40, width: 200, height: 160 },
            metadata: { layoutMode: "VERTICAL", layoutSizingVertical: "FIXED" },
          }),
          n(text, "TEXT_LAYER", "Label", {
            parentId: inst,
            metadata: { text: `Pay invoice number ${placed} today` },
            bounds: { x: 0, y: 8, width: 160, height: 24 },
          }),
        );
        edges.push(
          e("CONTAINS", frame, inst),
          e("CONTAINS", inst, text),
          e("INSTANCE_OF", inst, master),
          e("NESTS", frame, inst),
        );
        placed += 1;
      }
    }
    const graph: DesignGraph = {
      fileKey: "HEAVY",
      fileName: "Heavy",
      builtAt: "2026-01-01T00:00:00.000Z",
      source: { kind: "mock", ingestedAt: "2026-01-01T00:00:00.000Z" },
      warnings: [],
      nodes,
      edges,
    };
    const index = indexGraph(graph);
    const recommendMs = time(() => {
      recommendMasters(index, "button");
    });
    const verifyMs = time(() => {
      verifyFrame(index, { frame: "Heavy 0" });
    });
    console.log(
      `${nodes.length} nodes, ${components} components × ${perComponent} instances: recommend ${recommendMs.toFixed(0)} ms, verify ${verifyMs.toFixed(0)} ms`,
    );
    expect(verifyMs).toBeLessThan(80);
    expect(nodes.length).toBeGreaterThan(70_000);
  });
});
