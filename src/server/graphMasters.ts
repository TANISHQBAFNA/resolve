import { componentKeyOf } from "@/core/query/workspaceMerge";
import { includesPack, activeMode, readConfig } from "./mode.ts";
import { resolveGraph } from "./store";

/** Figma masters from the learned graph, so code_scan can link them by name. Empty when nothing is learned. */
export function graphMasters(): Array<{ name: string; nodeId: string; fileKey?: string; variants?: string[] }> {
  if (!includesPack(activeMode(), "figma")) return [];
  try {
    const resolved = resolveGraph();
    if (!resolved) return [];
    const fileKey = resolved.graph.fileKey;
    const nodes = resolved.index.getNodesByType("COMPONENT_SET", "MAIN_COMPONENT");
    const anyKey = nodes.some((node) => Boolean(componentKeyOf(node)));
    const include = readConfig().includeUnpublished === true;
    const visible = include ? nodes : nodes.filter((node) => {
      if (node.metadata?.["published"] === false || node.metadata?.["publishState"] === "local-only") return false;
      return !anyKey || Boolean(componentKeyOf(node));
    });
    return visible.map((node) => {
      const variants = [...new Set(resolved.index.getVariantsOf(node.id).flatMap((v) => Object.values(v.variantProperties ?? {})))].sort();
      return { name: node.name, nodeId: node.id, ...(fileKey ? { fileKey } : {}), ...(variants.length ? { variants } : {}) };
    });
  } catch {
    return [];
  }
}
