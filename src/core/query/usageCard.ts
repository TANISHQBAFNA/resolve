/** Usage card body for one component. Does not rank an intent. */
import type { GraphNode } from "@/core/model";
import { isNameInferredMaster } from "@/core/rules/names";
import { computeComponentUsage } from "./analytics";
import { whyLineForMaster } from "./bindRules";
import { briefNode, EXACT_COMPONENT_HINT, LAYER_NAME_GUESS } from "./cardCopy";
import { withCost } from "./cost";
import { examplePointer, type ExampleQuery } from "./examples";
import type { GraphIndex } from "./GraphIndex";
import { isMasterType, RECOMMEND_BUDGET, USAGE_CARD_BUDGET, variantCardName } from "./masterNames";
import { placeReady } from "./placeReady";
import type { RecommendContext } from "./recommendSupport";
import { screenOf, slotNamesOf } from "./screenInventory";
import type { SockState } from "./sock";
import { nodeFileKey } from "./workspaceMerge";

export function exampleQuery(
  index: GraphIndex,
  options: { sock?: SockState; context?: RecommendContext; placeholders?: string[] },
): ExampleQuery {
  return {
    sock: options.sock,
    graphFileKey: index.graph.fileKey,
    product: options.context?.product?.name || options.context?.product?.id,
    journey: options.context?.journey?.screenJob || options.context?.journey?.step,
    domain: options.context?.domain || options.context?.screenType,
    placeholders: options.placeholders,
  };
}
export function usageCardForComponent(
  index: GraphIndex,
  node: GraphNode,
  options: {
    budgetChars?: number;
    sock?: SockState;
    context?: RecommendContext;
    placeholders?: string[];
  } = {},
) {
  const budgetChars = options.budgetChars ?? USAGE_CARD_BUDGET;
  const usage = computeComponentUsage(index, node);
  const byScreenMap = new Map<
    string,
    { screen: GraphNode; count: number; slots: Set<string> }
  >();

  for (const instance of index.getAllInstancesOf(node.id)) {
    const screen = screenOf(index, instance.id);
    if (!screen) continue;
    let entry = byScreenMap.get(screen.id);
    if (!entry) {
      entry = { screen, count: 0, slots: new Set() };
      byScreenMap.set(screen.id, entry);
    }
    entry.count += 1;
    for (const slot of slotNamesOf(index, instance.id)) entry.slots.add(slot);
  }

  const pages = usage.pageIds
    .map((id) => index.getNode(id))
    .filter((page): page is GraphNode => Boolean(page))
    .map((page) => ({ name: page.name, figmaNodeId: page.figmaNodeId }));

  const toByScreen = (includeSlots: boolean, limit: number) =>
    [...byScreenMap.values()]
      .sort((a, b) => b.count - a.count || a.screen.name.localeCompare(b.screen.name))
      .slice(0, limit)
      .map((entry) => ({
        name: entry.screen.name,
        type: entry.screen.type,
        figmaNodeId: entry.screen.figmaNodeId,
        count: entry.count,
        ...(includeSlots && entry.slots.size ? { slots: [...entry.slots].sort() } : {}),
      }));

  let includeSlots = true;
  let limit = Math.max(byScreenMap.size, 1);
  let truncated = false;
  const inferred = isNameInferredMaster(node);
  const base = {
    component: {
      ...briefNode(node),
      name: variantCardName(index, node),
      ...(!inferred && nodeFileKey(node) ? { fileKey: nodeFileKey(node) } : {}),
      variantProperties: node.variantProperties,
      identity: node.metadata?.["identity"],
    },
    instances: usage.instanceCount,
    variants: usage.variantCount,
    riskScore: usage.riskScore,
    pages,
    hint: inferred
      ? `${LAYER_NAME_GUESS}. ${EXACT_COMPONENT_HINT}. Call recommend for a library component.`
      : usage.instanceCount === 0
        ? "Master is in the graph with this id even with zero instances. Place this figmaNodeId. Usage is additive."
        : "Instance this figmaNodeId in Figma. Do not get_design_context on a parent FRAME.",
  };
  if (inferred) {
    Object.assign(base.component, { guess: LAYER_NAME_GUESS });
    delete base.component.figmaNodeId;
    const component = base.component as { id?: string };
    if (component.id?.includes("mcp-name:")) delete component.id;
  } else {
    const place = placeReady(node, index.graph.fileKey);
    Object.assign(base.component, place);
    if (!place.published) {
      base.hint = `${base.hint} Unpublished (local-only) — no published component key. Pass search_design_system / get_libraries to learn_library.`;
    }
  }
  const why = whyLineForMaster(node, {
    sock: options.sock,
    graphFileKey: index.graph.fileKey,
    instances: usage.instanceCount,
  });
  const ex = examplePointer(index, node, exampleQuery(index, options), budgetChars <= RECOMMEND_BUDGET ? "id" : "screen");

  let byScreen = toByScreen(includeSlots, limit);
  let payload = { ...base, why, ...ex, byScreen, truncated };
  // ponytail: drop slots then screens until under budget
  while (JSON.stringify(payload).length > budgetChars && (includeSlots || limit > 1)) {
    truncated = true;
    if (includeSlots) includeSlots = false;
    else limit = Math.max(1, Math.floor(limit / 2));
    byScreen = toByScreen(includeSlots, limit);
    payload = { ...base, why, ...ex, byScreen, truncated };
  }

  return withCost(payload);
}
export function asResolvedNode(index: GraphIndex, node: GraphNode): GraphNode {
  if (node.type === "COMPONENT_INSTANCE") return index.getMainComponent(node.id) ?? node;
  return node;
}
/** Masters win over a screen that happens to share the name. */
export function namedNode(index: GraphIndex, predicate: (node: GraphNode) => boolean): GraphNode | undefined {
  let screen: GraphNode | undefined;
  for (const node of index.allNodes) {
    if (!predicate(node)) continue;
    if (isMasterType(node.type)) return node;
    if (!screen && (node.type === "FRAME" || node.type === "SECTION")) screen = node;
  }
  return screen;
}
