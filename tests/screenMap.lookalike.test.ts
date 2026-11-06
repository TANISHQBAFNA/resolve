import { describe, expect, it } from "vitest";
import { adaptFigmaRestFile } from "@/core/ingestion";
import { buildScreenMap } from "@/core/screenMap/document";
import { driftView } from "@/core/screenMap/views";
import { buildGraph } from "@/core/transform";

const FROZEN = "2026-11-05T00:00:00.000Z";

function graph() {
  return buildGraph(adaptFigmaRestFile({
    fileKey: "acme-checkout",
    file: {
      name: "Acme Checkout",
      version: "12",
      document: {
        id: "0:0",
        name: "Acme Checkout",
        type: "DOCUMENT",
        children: [
          {
            id: "0:1",
            name: "Checkout",
            type: "CANVAS",
            children: [{
              id: "1:1",
              name: "Payment",
              type: "FRAME",
              children: [
                { id: "1:2", name: "Button", type: "FRAME" },
                { id: "1:3", name: "Button", type: "TEXT", characters: "Pay" },
              ],
            }],
          },
          { id: "0:2", name: "Components", type: "CANVAS", children: [{ id: "9:1", name: "Button", type: "COMPONENT" }] },
        ],
      },
      components: { "9:1": { key: "acme-button", name: "Button" } },
    },
    kind: "figma-rest",
    ingestedAt: FROZEN,
  }), { builtAt: FROZEN });
}

describe("screen map lookalikes", () => {
  it("stays off unless asked, and never shares the detached flag", () => {
    const off = buildScreenMap(graph(), { builtAt: FROZEN, lookalikes: false });
    expect(Object.values(off.nodes).some((node) => node.flags?.lookalike)).toBe(false);
    const on = buildScreenMap(graph(), { builtAt: FROZEN, lookalikes: true });
    const frame = Object.values(on.nodes).find((node) => node.figmaNodeId === "1:2");
    const text = Object.values(on.nodes).find((node) => node.figmaNodeId === "1:3");
    expect(frame?.flags?.detached).toBe(true);
    expect(frame?.flags?.lookalike).toBeUndefined();
    expect(text?.flags?.lookalike).toBe(true);
    expect(text?.flags?.detached).toBeUndefined();
    const drift = driftView(on);
    expect(drift.detached.map((row) => row.id)).toEqual([frame?.id]);
    expect(drift.lookalikes?.map((row) => row.id)).toEqual([text?.id]);
    expect(drift.lookalikes?.[0]?.message).toBe("looks like Button, but hand-built");
    expect(drift.warnings[0]?.code).toBe("W-MAP-LOOKALIKE");
    expect(drift.warnings[0]?.next).toContain("DS instance");
    expect(drift.warnings.some((warning) => warning.code === "W-MAP-DETACHED")).toBe(true);
  });
});
