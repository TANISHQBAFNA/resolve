import { describe, expect, it } from "vitest";
import { adaptFigmaRestFile } from "@/core/ingestion";
import { buildScreenMap, expandAll, expandRef } from "@/core/screenMap/document";
import { nodeView, outlineView } from "@/core/screenMap/views";
import { buildGraph } from "@/core/transform";

const FROZEN = "2026-11-05T00:00:00.000Z";

function namesUnder(nodes: Record<string, { name: string; childIds: string[] }>, id: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const child of nodes[current]?.childIds ?? []) {
      const node = nodes[child];
      if (!node) continue;
      out.push(node.name);
      walk(child);
    }
  };
  walk(id);
  return out.sort();
}

function file() {
  const rows = Array.from({ length: 50 }, (_, index) => ({
    id: `3:${index}`,
    name: "List row",
    type: "INSTANCE",
    componentId: "9:1",
    children: [{ id: `4:${index}`, name: "Label", type: "TEXT", characters: "Row" }],
  }));
  return {
    name: "Acme Checkout",
    version: "4",
    document: {
      id: "0:0",
      name: "Acme Checkout",
      type: "DOCUMENT",
      children: [
        {
          id: "0:1",
          name: "Checkout",
          type: "CANVAS",
          children: [
            { id: "1:1", name: "Cart", type: "FRAME", children: rows },
            { id: "1:2", name: "Pay", type: "FRAME" },
            { id: "1:3", name: "Done", type: "FRAME" },
          ],
        },
        {
          id: "0:2",
          name: "Components",
          type: "CANVAS",
          children: [{ id: "9:1", name: "List row", type: "COMPONENT", children: [{ id: "9:2", name: "Label", type: "TEXT", characters: "Row" }] }],
        },
      ],
    },
    components: { "9:1": { key: "row", name: "List row" } },
  };
}

function graph() {
  return buildGraph(adaptFigmaRestFile({ fileKey: "acme-checkout", file: file(), kind: "figma-rest", ingestedAt: FROZEN }), { builtAt: FROZEN });
}

describe("screen map depth, paging, and refs", () => {
  it("includes every row by default and caps only when asked", () => {
    const map = buildScreenMap(graph(), { builtAt: FROZEN });
    const cart = Object.values(map.nodes).find((node) => node.name === "Cart")!;
    const full = nodeView(map, cart.id, undefined, "screen");
    expect(full.nodes.filter((node) => node.name === "List row")).toHaveLength(50);
    expect(full.viewCapped).toBeUndefined();
    expect(full.truncated).toBe(false);
    const capped = nodeView(map, cart.id, 0, "node");
    expect(capped.nodes).toHaveLength(1);
    expect(capped.viewCapped).toBe(true);
    expect(capped.warnings.some((warning) => warning.code === "W-MAP-CAP")).toBe(true);
    const page = outlineView(map, { page: 1, offset: 0 });
    expect(page.items).toHaveLength(1);
    expect(page.viewCapped).toBe(true);
    expect(page.page).toEqual({ size: 1, offset: 0, total: outlineView(map).items.length });
  });

  it("writes repeated row internals once and expands them losslessly", () => {
    const full = buildScreenMap(graph(), { builtAt: FROZEN });
    const deduped = buildScreenMap(graph(), { builtAt: FROZEN, refs: true });
    const masterId = Object.values(deduped.nodes).find((node) => node.name === "List row" && node.type !== "instance")?.id;
    expect(masterId).toBeTruthy();
    const body = expandRef(deduped, masterId!);
    expect(body?.nodes && Object.values(body.nodes).some((node) => node.name === "Label")).toBe(true);
    const instances = Object.values(deduped.nodes).filter((node) => node.name === "List row" && node.type === "instance");
    expect(instances).toHaveLength(50);
    expect(instances.every((node) => node.ref === masterId && node.childIds.length === 0)).toBe(true);
    const expanded = expandAll(deduped);
    expect(expanded.masters).toBeUndefined();
    for (const instance of Object.values(full.nodes).filter((node) => node.type === "instance" && node.name === "List row")) {
      const again = Object.values(expanded.nodes).find((node) => node.id === instance.id);
      expect(namesUnder(expanded.nodes, again!.id)).toEqual(namesUnder(full.nodes, instance.id));
    }
  });
});
