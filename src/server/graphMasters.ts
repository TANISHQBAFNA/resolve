import { includesPack, activeMode } from "./mode.ts";
import { resolveGraph } from "./store";

/** Figma masters from the learned graph, so code_scan can link them by name. Empty when nothing is learned. */
export function graphMasters(): Array<{ name: string; nodeId: string; fileKey?: string; variants?: string[] }> {
  if (!includesPack(activeMode(), "figma")) return [];
  try {
    const resolved = resolveGraph();
    if (!resolved) return [];
    const fileKey = resolved.graph.fileKey;
    return resolved.index.getNodesByType("COMPONENT_SET", "MAIN_COMPONENT").map((node) => {
      const variants = [...new Set(resolved.index.getVariantsOf(node.id).flatMap((v) => Object.values(v.variantProperties ?? {})))].sort();
      return { name: node.name, nodeId: node.id, ...(fileKey ? { fileKey } : {}), ...(variants.length ? { variants } : {}) };
    });
  } catch {
    return [];
  }
}
