import type { GraphNode } from "@/core/model/graph";
import type { GraphIndex } from "@/core/query/GraphIndex";

/**
 * Same node, or a variant and its component set (or two variants of one set).
 * This is the scoreboard rule. Cousin checks use it too.
 */
export function sameFamily(a: GraphNode, b: GraphNode): boolean {
  if (a.id === b.id) return true;
  if (a.componentSetId && (a.componentSetId === b.id || a.componentSetId === b.componentSetId)) {
    return true;
  }
  if (b.componentSetId && b.componentSetId === a.id) return true;
  return false;
}

/** The component set that owns a variant, or the set itself. */
export function setOf(index: GraphIndex, node: GraphNode): GraphNode | undefined {
  if (node.type === "COMPONENT_SET") return node;
  return node.componentSetId ? index.getNode(node.componentSetId) : undefined;
}
