import { describe, expect, it } from "vitest";
import { idVariants, sameFamily } from "@/core/identity";
import type { GraphNode } from "@/core/model";

function node(partial: Pick<GraphNode, "id"> & Partial<GraphNode>): GraphNode {
  return { type: "MAIN_COMPONENT", name: partial.id, ...partial };
}

describe("shared part identity", () => {
  it("treats colon and hyphen as one Figma id", () => {
    expect(idVariants("12:34").sort()).toEqual(["12:34", "12-34"].sort());
    expect(idVariants("12-34").sort()).toEqual(["12:34", "12-34"].sort());
  });

  it("counts a variant, its set, and the same Figma node as one part", () => {
    const set = node({ id: "set", type: "COMPONENT_SET", name: "Button" });
    const primary = node({ id: "primary", type: "VARIANT", name: "Button Primary", componentSetId: "set" });
    const danger = node({ id: "danger", type: "VARIANT", name: "Button Danger", componentSetId: "set" });
    const copy = node({ id: "copy", name: "Button", figmaNodeId: "1:2", fileKey: "FILE" });
    const again = node({ id: "again", name: "Button", figmaNodeId: "1:2", fileKey: "FILE" });
    const otherFile = node({ id: "other", name: "Button", figmaNodeId: "1:2", fileKey: "OTHER" });
    expect(sameFamily(primary, set)).toBe(true);
    expect(sameFamily(set, primary)).toBe(true);
    expect(sameFamily(primary, danger)).toBe(true);
    expect(sameFamily(copy, again)).toBe(true);
    expect(sameFamily(copy, otherFile)).toBe(false);
    expect(sameFamily(primary, copy)).toBe(false);
  });
});
