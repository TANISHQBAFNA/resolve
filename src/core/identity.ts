import type { GraphNode } from "@/core/model";

/** Colon and hyphen forms of one Figma id. `1:2` and `1-2` are the same id. */
export function idVariants(value: string): string[] {
  return [...new Set([value, value.replace(/-/g, ":"), value.replace(/:/g, "-")])];
}

/**
 * One part. Same node, a variant and its component set, two variants of one set,
 * or the same Figma node recorded twice in one file.
 * Scoreboard, cousin check, and recommend all use this. They must agree.
 */
export function sameFamily(a: GraphNode, b: GraphNode): boolean {
  if (a.id === b.id) return true;
  if (a.componentSetId && (a.componentSetId === b.id || a.componentSetId === b.componentSetId)) return true;
  if (b.componentSetId && b.componentSetId === a.id) return true;
  if (a.figmaNodeId && a.figmaNodeId === b.figmaNodeId && a.fileKey && a.fileKey === b.fileKey) return true;
  return false;
}
