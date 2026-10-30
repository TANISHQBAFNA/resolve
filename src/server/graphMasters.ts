import { componentKeyOf } from "@/core/query/workspaceMerge";
import { includesPack, activeMode, readConfig } from "./mode.ts";
import { resolveGraph } from "./store";

/** Figma masters from the learned graph, so code_scan can link them by name. Empty when nothing is learned. */
export function graphMasters(): Array<{ name: string; nodeId: string; fileKey?: string; variants?: string[]; properties?: Record<string, string[]>; description?: string }> {
  if (!includesPack(activeMode(), "figma")) return [];
  try {
    const resolved = resolveGraph();
    if (!resolved) return [];
    const fileKey = resolved.graph.fileKey;
    const nodes = resolved.index.getNodesByType("COMPONENT_SET", "MAIN_COMPONENT");
    const anyKey = nodes.some((node) => Boolean(componentKeyOf(node)));
    const include = readConfig().includeUnpublished === true;
    const visible = include ? nodes : nodes.filter((node) => {
      const published = node.metadata?.["published"];
      const state = node.metadata?.["publishState"];
      if (published === false || state === "local-only") return false;
      if (published === true || state === "published") return true;
      return !anyKey || Boolean(componentKeyOf(node));
    });
    return visible.map((node) => {
      const properties: Record<string, string[]> = {};
      for (const v of resolved.index.getVariantsOf(node.id)) for (const [axis, value] of Object.entries(v.variantProperties ?? {})) if (!(properties[axis] ??= []).includes(value)) properties[axis]!.push(value);
      const variants = [...new Set(Object.values(properties).flat())].sort();
      const description = node.description?.trim();
      return { name: node.name, nodeId: node.id, ...(fileKey ? { fileKey } : {}), ...(variants.length ? { variants, properties } : {}), ...(description ? { description } : {}) };
    });
  } catch {
    return [];
  }
}
