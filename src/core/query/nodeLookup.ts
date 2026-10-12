/** Exact id and name lookup. */
import type { GraphNode } from "@/core/model";
import { idVariants } from "@/core/rules/ids";
import { isNameInferredMaster } from "@/core/rules/names";
import type { GraphIndex } from "./GraphIndex";
import { readFigmaLink } from "./learnedLink";
import { isMasterType, variantCardName } from "./masterNames";
import { searchNodes } from "./search";
import { nodeFileKey } from "./workspaceMerge";

export function matchesFigmaId(node: GraphNode, raw: string): boolean {
  const figmaId = node.figmaNodeId;
  if (!figmaId) return false;
  const needles = new Set(idVariants(raw));
  return idVariants(figmaId).some((id) => needles.has(id));
}
export function matchesStampedId(node: GraphNode, given: string, graphFileKey?: string): boolean {
  const fileKey = nodeFileKey(node, graphFileKey);
  if (!fileKey) return false;
  const prefix = fileKey.toLowerCase();
  const lower = given.toLowerCase();
  if (lower.length <= prefix.length + 1) return false;
  if (!lower.startsWith(prefix)) return false;
  const sep = given[fileKey.length];
  if (sep !== ":" && sep !== "-") return false;
  const rest = given.slice(fileKey.length + 1);
  if (!rest) return false;
  if (idVariants(node.id).includes(rest) || node.id === rest) return true;
  return matchesFigmaId(node, rest);
}
/** Exact graph id, Figma id, stamped `fileKey:nodeId`, or exact name. No fuzzy. */
export function resolveNodeExact(index: GraphIndex, nameOrId: string): GraphNode | undefined {
  const trimmed = nameOrId.trim();
  if (!trimmed) return undefined;
  const direct = index.getNode(trimmed);
  if (direct) return direct;
  // A pasted Figma link (`...?node-id=20-40`) is the frame it points at.
  // The bare node id is used only when that file is already learned. A link to
  // another file must not match a node that happens to share the id.
  if (/figma\.com\//i.test(trimmed)) {
    const link = readFigmaLink(index, trimmed);
    if (!link?.ok) return undefined;
    for (const id of link.nodeIds) {
      const hit = resolveNodeExact(index, `${link.fileKey}:${id}`) ?? resolveNodeExact(index, id);
      if (hit) return hit;
    }
    return undefined;
  }
  const lower = trimmed.toLowerCase();
  let exactName: GraphNode | undefined;
  let realMaster: GraphNode | undefined;
  let inferredMaster: GraphNode | undefined;
  for (const node of index.allNodes) {
    if (matchesFigmaId(node, trimmed)) return node;
    if (matchesStampedId(node, trimmed, index.graph.fileKey)) return node;
    const nameHit =
      node.name.toLowerCase() === lower ||
      (node.type === "VARIANT" && variantCardName(index, node).toLowerCase() === lower);
    if (!nameHit) continue;
    if (isMasterType(node.type)) {
      if (isNameInferredMaster(node)) inferredMaster ??= node;
      else realMaster ??= node;
      continue;
    }
    exactName ??= node;
  }
  return realMaster ?? inferredMaster ?? exactName;
}
export function resolveNode(index: GraphIndex, nameOrId: string): GraphNode | undefined {
  const exact = resolveNodeExact(index, nameOrId);
  if (exact) return exact;
  // A link is an id, not a name. Do not fuzzy-match the URL text.
  if (/figma\.com\//i.test(nameOrId)) return undefined;
  return searchNodes(index, nameOrId.trim(), { limit: 1 })[0]?.node;
}
