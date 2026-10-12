/** Master names, private names, and which master is placeable. */
import { COMPONENT_DEFINITION_TYPES, type GraphNode } from "@/core/model";
import { collapsedName, isNameInferredMaster, isPrivateMasterName } from "@/core/rules/names";
import { computeComponentUsage } from "./analytics";
import type { GraphIndex } from "./GraphIndex";
import { GENERIC_NAME_TOKENS, tokensOf } from "./queryTokens";
import { isLibraryFileKey, type WorkspaceManifest } from "./workspace";
import { nodeFileKey } from "./workspaceMerge";

export const USAGE_CARD_BUDGET = 2000;
export const RECOMMEND_BUDGET = 600;
export const MASTER_TYPES = COMPONENT_DEFINITION_TYPES;
export function realMastersNamed(index: GraphIndex, name: string): GraphNode[] {
  const needle = name.trim().toLowerCase();
  if (!needle) return [];
  const hits: GraphNode[] = [];
  for (const node of index.getNodesByType(...MASTER_TYPES)) {
    if (isNameInferredMaster(node)) continue;
    const raw = node.name.trim().toLowerCase();
    const card = variantCardName(index, node).trim().toLowerCase();
    if (raw !== needle && card !== needle) continue;
    hits.push(node);
  }
  return hits;
}
/** Variants in a set, else direct children. Empty stub scores 0. */
export function masterPopulation(index: GraphIndex, node: GraphNode): number {
  if (node.type === "COMPONENT_SET") {
    const variants = index.getVariantsOf(node.id).length;
    if (variants) return variants;
  }
  return index.getChildren(node.id).length;
}
function askedStyleHits(index: GraphIndex, node: GraphNode, ask?: string): number {
  if (!ask?.trim()) return 0;
  const nameTokens = new Set(tokensOf(node.name));
  const asked = tokensOf(ask).filter(
    (token) => !nameTokens.has(token) && !GENERIC_NAME_TOKENS.has(token),
  );
  if (!asked.length) return 0;
  const variants = node.type === "COMPONENT_SET" ? index.getVariantsOf(node.id) : [];
  const rows = variants.length ? variants : [node];
  let hits = 0;
  for (const row of rows) {
    const blob = new Set(
      tokensOf(
        [
          row.name,
          ...Object.keys(row.variantProperties ?? {}),
          ...Object.values(row.variantProperties ?? {}),
        ].join(" "),
      ),
    );
    if (asked.some((token) => blob.has(token))) hits += 1;
  }
  return hits;
}
function isEmptyNameStub(index: GraphIndex, node: GraphNode): boolean {
  if (node.type === "COMPONENT_SET") return masterPopulation(index, node) === 0;
  return Boolean(node.isRemote) && masterPopulation(index, node) === 0;
}
/** Empty, or a remote with fewer variants than the winner — not a cousin to list. */
export function isWeakerNameStub(index: GraphIndex, node: GraphNode, picked: GraphNode): boolean {
  if (isEmptyNameStub(index, node)) return true;
  if (!node.isRemote) return false;
  return masterPopulation(index, node) < masterPopulation(index, picked);
}
/**
 * Same-name masters: asked-style variant hits, then more variants, then usage.
 * Populated local set beats a thin external stub. Library-role file breaks remaining ties.
 */
export function preferNamedMaster(
  index: GraphIndex,
  hits: readonly GraphNode[],
  workspace?: WorkspaceManifest,
  ask?: string,
): GraphNode | undefined {
  if (!hits.length) return undefined;
  if (hits.length === 1) return hits[0];
  const graphFileKey = index.graph.fileKey;
  const ranked = [...hits].sort((a, b) => {
    const aStyle = askedStyleHits(index, a, ask);
    const bStyle = askedStyleHits(index, b, ask);
    if (bStyle !== aStyle) return bStyle - aStyle;
    const aPop = masterPopulation(index, a);
    const bPop = masterPopulation(index, b);
    const aFilled = aPop > 0 ? 1 : 0;
    const bFilled = bPop > 0 ? 1 : 0;
    if (bFilled !== aFilled) return bFilled - aFilled;
    if (bPop !== aPop) return bPop - aPop;
    const aUse = computeComponentUsage(index, a).instanceCount;
    const bUse = computeComponentUsage(index, b).instanceCount;
    if (bUse !== aUse) return bUse - aUse;
    const aLocal = a.isRemote ? 0 : 1;
    const bLocal = b.isRemote ? 0 : 1;
    if (bLocal !== aLocal) return bLocal - aLocal;
    const aLib = isLibraryFileKey(workspace, nodeFileKey(a, graphFileKey)) ? 1 : 0;
    const bLib = isLibraryFileKey(workspace, nodeFileKey(b, graphFileKey)) ? 1 : 0;
    if (bLib !== aLib) return bLib - aLib;
    const aSet = a.type === "COMPONENT_SET" ? 1 : 0;
    const bSet = b.type === "COMPONENT_SET" ? 1 : 0;
    if (bSet !== aSet) return bSet - aSet;
    return a.id.localeCompare(b.id);
  });
  return ranked[0];
}
/** Other populated masters that still share the name after stub-prefer. */
export function otherNamedMasters(
  index: GraphIndex,
  hits: readonly GraphNode[],
  picked: GraphNode,
): GraphNode[] {
  return hits.filter((node) => node.id !== picked.id && !isWeakerNameStub(index, node, picked));
}
export function sameNameNote(
  index: GraphIndex,
  hits: readonly GraphNode[],
  picked: GraphNode,
): string | undefined {
  const stubs = hits.filter((node) => node.id !== picked.id && isWeakerNameStub(index, node, picked));
  const others = otherNamedMasters(index, hits, picked);
  const populatedPick = !isEmptyNameStub(index, picked) && stubs.length > 0;
  if (others.length && populatedPick) {
    return `Same name as ${others.length} other master${others.length === 1 ? "" : "s"}. Picked the populated local set.`;
  }
  if (populatedPick) return "Picked the populated local set.";
  if (others.length) {
    return `Same name as ${others.length} other master${others.length === 1 ? "" : "s"}.`;
  }
  return undefined;
}
export function substitutionNote(index: GraphIndex, ask: string, picked?: GraphNode): string | undefined {
  const trimmed = ask.trim();
  if (!trimmed) return undefined;
  const collapsed = collapsedName(trimmed);
  for (const node of index.getNodesByType(...MASTER_TYPES)) {
    if (!isPrivateMasterName(node.name)) continue;
    const same =
      collapsedName(node.name) === collapsed || node.name.toLowerCase() === trimmed.toLowerCase();
    if (!same) continue;
    if (picked && node.id === picked.id) continue;
    if (!picked || isPrivateMasterName(picked.name)) continue;
    return `substituted "${node.name}" → "${variantCardName(index, picked)}"`;
  }
  return undefined;
}
/**
 * Real master for a name. Never an `mcp-name:` guess.
 * When several real masters share the name, the populated local set wins.
 */
export function placeableMasterByName(
  index: GraphIndex,
  name: string,
  workspace?: WorkspaceManifest,
): GraphNode | undefined {
  const hits = realMastersNamed(index, name);
  return preferNamedMaster(index, hits, workspace, name);
}
/** Id lookup: a guessed main redirects to the real master of that name, or nothing. */
export function placeableNode(
  index: GraphIndex,
  node: GraphNode,
  workspace?: WorkspaceManifest,
): GraphNode | undefined {
  if (!isMasterType(node.type) || !isNameInferredMaster(node)) return node;
  return placeableMasterByName(index, node.name, workspace);
}
export const VARIANT_PROP_NAME = /^[^,=]+=[^,=]+(?:,\s*[^,=]+=[^,=]+)*$/;
/** Family name only. `Button Primary` and `Button / Style=Primary` are the Button family. A variant named `Primary` keeps that name. */
export function familyNameOf(name: string, setName?: string): string {
  if (VARIANT_PROP_NAME.test(name)) return setName ?? "";
  const set = setName?.trim();
  if (!set) return name;
  if (name === set) return name;
  if (name.startsWith(`${set} / `) || name.startsWith(`${set} `)) return set;
  return name;
}
function variantLabel(node: GraphNode): string {
  const name = node.name.trim();
  if (VARIANT_PROP_NAME.test(name)) return name;
  const props = node.variantProperties;
  if (props) {
    const parts = Object.entries(props)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)
      .map(([key, value]) => `${key}=${value}`);
    if (parts.length) return parts.join(", ");
  }
  return name;
}
/** Card label for a variant: `Button / Type=Primary`. Other nodes keep their name. */
export function variantCardName(index: GraphIndex, node: GraphNode): string {
  if (node.type !== "VARIANT") return node.name;
  const set = node.componentSetId ? index.getNode(node.componentSetId) : undefined;
  const setName = set?.name.trim();
  if (!setName) return node.name;
  const label = variantLabel(node);
  if (!label || label === setName) return node.name;
  return `${setName} / ${label}`;
}
export const isMasterType = (type: GraphNode["type"]): boolean =>
  (MASTER_TYPES as readonly string[]).includes(type);
