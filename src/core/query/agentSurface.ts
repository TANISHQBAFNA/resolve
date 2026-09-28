import { buildAiGraphContext, toMarkdownPrompt } from "@/core/ai";
import { COMPONENT_DEFINITION_TYPES, type GraphNode } from "@/core/model";
import { computeAnalytics, computeComponentUsage, type GraphAnalytics } from "./analytics";
import { detectCommunitiesForIndex } from "./communities";
import type { GraphIndex } from "./GraphIndex";
import { searchNodes } from "./search";
import { extractSubgraph, levelForNode } from "./subgraph";
import { isLibraryFileKey, type WorkspaceManifest } from "./workspace";
import { nodeFileKey } from "./workspaceMerge";
import { placeReady } from "./placeReady";
import synonymFile from "@/data/synonyms.json";
import modifierFile from "@/data/ui-modifiers.json";
import { isRemovedByAbsence, patternFor, staleRefreshHint, type SockState } from "./sock";
import {
  bindRuleHit,
  filterAndScoreByBindRules,
  fitBindRuleWarnings,
  packJourneyPhrase,
  verifyBindRules,
  whyLineForMaster,
  type BindRuleWarning,
  type BindRulesFile,
} from "./bindRules";
import {
  examplePointer,
  frameContentWarnings,
  getExample,
  NO_EXAMPLE,
  type ContentWarning,
  type ExampleQuery,
} from "./examples";

/**
 * Agent-facing graph surface. Graph stays on disk. Agents call resolve /
 * recommend / recipe / verify_frame / check_frame / get_screen_inventory — never Read
 * graph.json. Every MCP payload carries a char cost.
 */

export interface AgentCost {
  chars: number;
  approxTokens: number;
}

export interface OrientBrief {
  file: { name: string; key: string; sourceKind: string };
  totals: GraphAnalytics["totals"];
  godNodes: Array<{ id: string; name: string; type: string; degree: number }>;
  communities: Array<{ name: string; size: number; hub: string }>;
  health: {
    unusedComponents: number;
    unresolvedInstances: number;
    framesWithoutComponents: number;
  };
  askNext: string[];
  hint: string;
}

const briefNode = (node: GraphNode) => ({
  id: node.id,
  name: node.name,
  type: node.type,
  figmaNodeId: node.figmaNodeId,
  status: node.status,
  owner: node.owner,
});

export function costOf(value: unknown): AgentCost {
  const chars = JSON.stringify(value).length;
  return { chars, approxTokens: Math.ceil(chars / 4) };
}

export function withCost<T extends object>(payload: T): T & { cost: AgentCost } {
  return { ...payload, cost: costOf(payload) };
}

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "page",
  "screen",
  "frame",
  "what",
  "which",
  "kind",
  "of",
  "to",
  "for",
  "should",
  "use",
  "uses",
  "using",
  "i",
  "im",
  "am",
  "building",
  "build",
  "requires",
  "require",
  "need",
  "needs",
  "this",
  "that",
  "our",
  "new",
  "and",
  "or",
  "not",
  "how",
  "does",
  "with",
  "from",
  "between",
  "find",
]);

const tokensOf = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 1 && !STOPWORDS.has(part));

/** Stems of a real inflection: plural s/es, -ing, -ed. Not a prefix of an unrelated word. */
function inflectionStems(word: string): string[] {
  const stems: string[] = [];
  if (word.length >= 5 && word.endsWith("es")) stems.push(word.slice(0, -2));
  if (word.length >= 4 && word.endsWith("s")) stems.push(word.slice(0, -1));
  if (word.length >= 6 && word.endsWith("ing")) stems.push(word.slice(0, -3));
  if (word.length >= 5 && word.endsWith("ed")) stems.push(word.slice(0, -2));
  return stems.filter((stem) => stem.length >= 3);
}

function familyKey(token: string, names: readonly string[]): string | undefined {
  if (names.some((name) => name.includes(token))) return token;
  for (const stem of inflectionStems(token)) {
    if (names.some((name) => name.includes(stem))) return stem;
  }
  return undefined;
}

const isScreen = (index: GraphIndex, node: GraphNode): boolean => {
  if (node.type !== "FRAME") return false;
  const parent = index.getParent(node.id);
  return parent?.type === "PAGE" || parent?.type === "SECTION" || parent?.type === "FILE";
};

const overlap = (name: string, tokens: string[]): number => {
  const names = new Set(tokensOf(name));
  return tokens.reduce((count, token) => count + (names.has(token) ? 1 : 0), 0);
};

function inventoryVariants(index: GraphIndex, screenId: string, familyTokens: string[]) {
  const counts = new Map<
    string,
    { component: GraphNode; count: number }
  >();
  for (const instance of index.getNestedInstances(screenId)) {
    const main = index.getMainComponent(instance.id);
    if (!main) continue;
    const set = main.componentSetId ? index.getNode(main.componentSetId) : undefined;
    const haystack = `${main.name} ${set?.name ?? ""}`.toLowerCase();
    if (familyTokens.length && !familyTokens.some((token) => haystack.includes(token))) continue;
    const entry = counts.get(main.id);
    if (entry) entry.count += 1;
    else counts.set(main.id, { component: main, count: 1 });
  }
  return [...counts.values()];
}

/**
 * Unique component definitions on a frame/section, with placement counts.
 * Instances stay in the stored graph (slot trees, blast radius). Agent answers
 * and the atlas collapse them — 12 Heading instances become Heading × 12.
 */
export function screenInventory(index: GraphIndex, nodeId: string) {
  const node = index.getNode(nodeId);
  if (!node) return undefined;

  const tally = new Map<string, { component: GraphNode; count: number }>();
  let unresolved = 0;
  for (const instance of index.getNestedInstances(node.id)) {
    const main = index.getMainComponent(instance.id);
    if (!main) {
      unresolved += 1;
      continue;
    }
    const entry = tally.get(main.id);
    if (entry) entry.count += 1;
    else tally.set(main.id, { component: main, count: 1 });
  }

  const components = [...tally.values()]
    .sort((a, b) => b.count - a.count || a.component.name.localeCompare(b.component.name))
    .map((entry) => ({
      ...briefNode(entry.component),
      count: entry.count,
      identity: entry.component.metadata?.["identity"],
    }));

  return {
    screen: briefNode(node),
    components,
    unresolvedInstances: unresolved,
    hint: "Each component listed once; count is how many times it is placed. Write from this list. Do not call Figma get_design_context on this FRAME.",
  };
}

const USAGE_CARD_BUDGET = 2000;
const RECOMMEND_BUDGET = 600;
const MASTER_TYPES = COMPONENT_DEFINITION_TYPES;

const screenOf = (index: GraphIndex, nodeId: string): GraphNode | undefined => {
  const path = index.getHierarchyPath(nodeId);
  return path.find((ancestor) => isScreen(index, ancestor)) ?? path.find((ancestor) => ancestor.type === "FRAME");
};

/** Unique nested component names inside one instance (slot fills). */
function slotNamesOf(index: GraphIndex, instanceId: string): string[] {
  const names = new Set<string>();
  const add = (id: string) => {
    const main = index.getMainComponent(id);
    if (main) names.add(main.name);
  };
  for (const nested of index.getNestedInstances(instanceId)) add(nested.id);
  for (const child of index.getChildren(instanceId)) {
    add(child.id);
    if (child.type !== "COMPONENT_INSTANCE") {
      for (const grand of index.getChildren(child.id)) add(grand.id);
    }
  }
  return [...names].sort();
}

function exampleQuery(
  index: GraphIndex,
  options: { sock?: SockState; context?: RecommendContext },
): ExampleQuery {
  return {
    sock: options.sock,
    graphFileKey: index.graph.fileKey,
    product: options.context?.product?.name || options.context?.product?.id,
    journey: options.context?.journey?.screenJob || options.context?.journey?.step,
    domain: options.context?.domain || options.context?.screenType,
  };
}

export function usageCardForComponent(
  index: GraphIndex,
  node: GraphNode,
  options: { budgetChars?: number; sock?: SockState; context?: RecommendContext } = {},
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
      ? "Instance name guess. Not a placeable master. Call recommend for a library component."
      : usage.instanceCount === 0
        ? "Master is in the graph with this id even with zero instances. Place this figmaNodeId. Usage is additive."
        : "Instance this figmaNodeId in Figma. Do not get_design_context on a parent FRAME.",
  };
  if (inferred) {
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
  const why = whyLineForMaster(node, { sock: options.sock, graphFileKey: index.graph.fileKey });
  const ex = examplePointer(index, node, exampleQuery(index, options), budgetChars <= RECOMMEND_BUDGET ? "id" : "screen");

  let byScreen = toByScreen(includeSlots, limit);
  let payload = { ...base, why, ex, byScreen, truncated };
  // ponytail: drop slots then screens until under budget
  while (JSON.stringify(payload).length > budgetChars && (includeSlots || limit > 1)) {
    truncated = true;
    if (includeSlots) includeSlots = false;
    else limit = Math.max(1, Math.floor(limit / 2));
    byScreen = toByScreen(includeSlots, limit);
    payload = { ...base, why, ex, byScreen, truncated };
  }

  return withCost(payload);
}

function asResolvedNode(index: GraphIndex, node: GraphNode): GraphNode {
  if (node.type === "COMPONENT_INSTANCE") return index.getMainComponent(node.id) ?? node;
  return node;
}

/** Masters win over a screen that happens to share the name. */
function namedNode(index: GraphIndex, predicate: (node: GraphNode) => boolean): GraphNode | undefined {
  let screen: GraphNode | undefined;
  for (const node of index.allNodes) {
    if (!predicate(node)) continue;
    if (isMasterType(node.type)) return node;
    if (!screen && (node.type === "FRAME" || node.type === "SECTION")) screen = node;
  }
  return screen;
}

function pickResolveTarget(
  index: GraphIndex,
  name: string,
  context?: RecommendContext,
  workspace?: WorkspaceManifest,
): GraphNode | undefined {
  const trimmed = name.trim();
  if (!trimmed) return undefined;

  const direct = index.getNode(trimmed);
  if (direct) return placeableNode(index, asResolvedNode(index, direct), workspace);
  for (const node of index.allNodes) {
    if (matchesFigmaId(node, trimmed) || matchesStampedId(node, trimmed, index.graph.fileKey)) {
      return placeableNode(index, asResolvedNode(index, node), workspace);
    }
  }

  const reals = realMastersNamed(index, trimmed);
  if (reals.length >= 1) {
    const chosen =
      reals.length === 1
        ? reals[0]!
        : placeableMasterByName(index, trimmed, workspace) ??
          [...reals].sort((a, b) => a.id.localeCompare(b.id))[0]!;
    const card = variantCardName(index, chosen);
    const exactCase = chosen.name === trimmed || card === trimmed;
    if (!exactCase && chosen.status === "deprecated" && !isPrivateMaster(index, chosen)) {
      return liveReplacement(index, chosen) ?? chosen;
    }
    return chosen;
  }

  // No real master. An instance-name guess can still describe usage, but the card is not placeable.
  const caseExact = namedNode(index, (node) => node.name === trimmed);
  if (caseExact) return asResolvedNode(index, caseExact);

  // Same letters, different casing: a retired name hands back its live replacement.
  // A private master stays hidden until the caller types the exact name.
  const folded = trimmed.toLowerCase();
  const ciExact = namedNode(index, (node) => node.name.toLowerCase() === folded);
  if (ciExact) {
    const master = asResolvedNode(index, ciExact);
    if (master.type === "FRAME" || master.type === "SECTION") return master;
    if (!isPrivateMaster(index, master)) {
      if (master.status === "deprecated") return liveReplacement(index, master) ?? master;
      return master;
    }
  }

  const ranked = recommendMasters(index, trimmed, {
    context,
    budgetChars: USAGE_CARD_BUDGET,
    workspace,
  });
  const topId = ranked.candidates[0]?.id;
  if (!topId) return undefined;
  const node = index.getNode(topId);
  if (!node || isPrivateMaster(index, node)) return undefined;
  return node;
}

/**
 * Name in, usage card out. FRAME/SECTION names return a screen inventory.
 * Agents call this instead of reading graph.json.
 */
export function componentUsageCard(
  index: GraphIndex,
  name: string,
  options: {
    budgetChars?: number;
    sock?: SockState;
    context?: RecommendContext;
    workspace?: WorkspaceManifest;
  } = {},
) {
  const node = pickResolveTarget(index, name, options.context, options.workspace);
  if (!node) {
    return withCost({
      found: false as const,
      name,
      hint: `Nothing named "${name}" in this graph. Call recommend "<intent>" if you know the job, not the name.`,
    });
  }
  if (node.type === "FRAME" || node.type === "SECTION") {
    const inventory = screenInventory(index, node.id);
    return withCost({
      found: true as const,
      kind: "screen" as const,
      ...inventory,
    });
  }
  const card = usageCardForComponent(index, node, options);
  const { cost, ...body } = card;
  void cost;
  const replacement =
    node.status === "deprecated" ? liveReplacement(index, node) : undefined;
  const place = replacement ? placeReady(replacement, index.graph.fileKey) : undefined;
  const withReplacement = {
    found: true as const,
    kind: "component" as const,
    ...body,
    ...(node.status === "deprecated" ? { deprecated: true as const } : {}),
    ...(replacement && place
      ? {
          replacement: {
            id: replacement.id,
            name: variantCardName(index, replacement),
            ...place,
            why: `replaces ${node.name} (deprecated)`,
          },
        }
      : {}),
  };
  const budget = options.budgetChars ?? USAGE_CARD_BUDGET;
  if (JSON.stringify(withCost(withReplacement)).length <= budget) return withCost(withReplacement);
  const trimmed = { ...withReplacement, byScreen: [] as typeof body.byScreen };
  return withCost(trimmed);
}

/** Full config for the real instance behind a pick's `ex` pointer. */
export function exampleCard(
  index: GraphIndex,
  name: string,
  options: {
    sock?: SockState;
    context?: RecommendContext;
    workspace?: WorkspaceManifest;
  } = {},
) {
  const node = pickResolveTarget(index, name, options.context, options.workspace);
  if (!node || node.type === "FRAME" || node.type === "SECTION") {
    return withCost({ found: false as const, name, example: NO_EXAMPLE });
  }
  const lookup = getExample(index, node, exampleQuery(index, options));
  if (!lookup.found) {
    return withCost({
      found: false as const,
      name: variantCardName(index, node),
      id: node.id,
      example: NO_EXAMPLE,
    });
  }
  const { id: exampleId, ...example } = lookup.example;
  return withCost({
    found: true as const,
    name: variantCardName(index, node),
    id: node.id,
    exampleId,
    ...example,
  });
}

/**
 * "I'm building an approval summary — which button?"
 *
 * The new screen may not exist. Find screens that share name tokens, walk
 * prototype neighbours (the details page next to the summary), count nested
 * variants. Agent gets the tertiary button without dumping the file.
 */
export function similarUsage(index: GraphIndex, question: string) {
  const tokens = tokensOf(question);
  const screens = index.getNodesByType("FRAME").filter((node) => isScreen(index, node));
  const definitions = index.getNodesByType("COMPONENT_SET", "MAIN_COMPONENT", "VARIANT");
  const definitionNames = definitions.map((node) => node.name.toLowerCase());
  const familyTokens = [
    ...new Set(
      tokens
        .map((token) => familyKey(token, definitionNames))
        .filter((token): token is string => Boolean(token)),
    ),
  ];

  const scored = screens
    .map((screen) => ({ screen, score: overlap(screen.name, tokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.screen.name.localeCompare(b.screen.name));

  const related = new Map<string, { screen: GraphNode; score: number; why: string }>();
  for (const entry of scored.slice(0, 8)) {
    related.set(entry.screen.id, { ...entry, why: "name" });
    for (const neighbor of index.getNeighbors(entry.screen.id, {
      direction: "both",
      edgeTypes: ["PROTOTYPES_TO"],
    })) {
      if (!isScreen(index, neighbor) || related.has(neighbor.id)) continue;
      related.set(neighbor.id, { screen: neighbor, score: entry.score * 0.8, why: "prototype" });
    }
    const parent = index.getParent(entry.screen.id);
    if (parent) {
      for (const sibling of index.getChildren(parent.id)) {
        if (!isScreen(index, sibling) || related.has(sibling.id)) continue;
        related.set(sibling.id, { screen: sibling, score: entry.score * 0.5, why: "same-section" });
      }
    }
  }

  const variantHits = new Map<
    string,
    { component: GraphNode; count: number; on: Array<{ id: string; name: string; why: string }> }
  >();
  for (const entry of related.values()) {
    for (const hit of inventoryVariants(index, entry.screen.id, familyTokens)) {
      const current = variantHits.get(hit.component.id);
      const on = { id: entry.screen.id, name: entry.screen.name, why: entry.why };
      const weight = (entry.why === "name" ? 4 : 1) * entry.score;
      if (current) {
        current.count += hit.count * weight;
        current.on.push(on);
      } else {
        variantHits.set(hit.component.id, {
          component: hit.component,
          count: hit.count * weight,
          on: [on],
        });
      }
    }
  }

  const variants = [...variantHits.values()].sort(
    (a, b) => b.count - a.count || a.component.name.localeCompare(b.component.name),
  );

  return {
    tokens,
    familyTokens,
    screens: [...related.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((entry) => ({
        id: entry.screen.id,
        name: entry.screen.name,
        score: entry.score,
        why: entry.why,
      })),
    variants: variants.slice(0, 8).map((entry) => ({
      id: entry.component.id,
      name: entry.component.name,
      variantProperties: entry.component.variantProperties,
      status: entry.component.status,
      set: entry.component.componentSetId
        ? index.getNode(entry.component.componentSetId)?.name
        : undefined,
      count: entry.count,
      on: entry.on,
    })),
  };
}

export function sharedComponents(index: GraphIndex, fromId: string, toId: string) {
  const left = new Map(inventoryVariants(index, fromId, []).map((hit) => [hit.component.id, hit]));
  const shared = [];
  for (const hit of inventoryVariants(index, toId, [])) {
    const other = left.get(hit.component.id);
    if (!other) continue;
    shared.push({
      id: hit.component.id,
      name: hit.component.name,
      variantProperties: hit.component.variantProperties,
      here: other.count,
      there: hit.count,
    });
  }
  return shared.sort((a, b) => b.here + b.there - (a.here + a.there));
}

export function isPrivateMasterName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.startsWith(".") || trimmed.startsWith("_")) return true;
  const variant = trimmed.split(" / ").at(-1)?.trim() ?? "";
  return variant !== trimmed && (variant.startsWith(".") || variant.startsWith("_"));
}

/** Instance layer names guessed by MCP (`mcp-name:`) are not library masters. */
export function isNameInferredMaster(node: GraphNode): boolean {
  if (node.metadata?.["identity"] === "inferred-from-name") return true;
  const id = `${node.id} ${node.figmaNodeId ?? ""}`;
  return id.includes("mcp-name:");
}

function realMastersNamed(index: GraphIndex, name: string): GraphNode[] {
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

/**
 * Real master for a name. Never an `mcp-name:` guess.
 * When several real masters share the name, the library-role file wins.
 * A clash with no library-role master returns undefined (do not guess).
 */
export function placeableMasterByName(
  index: GraphIndex,
  name: string,
  workspace?: WorkspaceManifest,
): GraphNode | undefined {
  const hits = realMastersNamed(index, name);
  if (hits.length === 0) return undefined;
  if (hits.length === 1) return hits[0];
  const library = hits.filter((node) =>
    isLibraryFileKey(workspace, nodeFileKey(node, index.graph.fileKey)),
  );
  if (!library.length) return undefined;
  library.sort((a, b) => a.id.localeCompare(b.id));
  return library[0];
}

/** Id lookup: a guessed main redirects to the real master of that name, or nothing. */
function placeableNode(
  index: GraphIndex,
  node: GraphNode,
  workspace?: WorkspaceManifest,
): GraphNode | undefined {
  if (!isMasterType(node.type) || !isNameInferredMaster(node)) return node;
  return placeableMasterByName(index, node.name, workspace);
}

const VARIANT_PROP_NAME = /^[^,=]+=[^,=]+(?:,\s*[^,=]+=[^,=]+)*$/;

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

function idVariants(value: string): string[] {
  return [...new Set([value, value.replace(/-/g, ":"), value.replace(/:/g, "-")])];
}

function matchesFigmaId(node: GraphNode, raw: string): boolean {
  const figmaId = node.figmaNodeId;
  if (!figmaId) return false;
  const needles = new Set(idVariants(raw));
  return idVariants(figmaId).some((id) => needles.has(id));
}

function matchesStampedId(node: GraphNode, given: string, graphFileKey?: string): boolean {
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
  return resolveNodeExact(index, nameOrId) ?? searchNodes(index, nameOrId.trim(), { limit: 1 })[0]?.node;
}

export function suggestQuestions(index: GraphIndex, analytics: GraphAnalytics): string[] {
  const questions: string[] = [];
  const screens = index.getNodesByType("FRAME").filter((node) => {
    const parent = index.getParent(node.id);
    return parent?.type === "PAGE" || parent?.type === "SECTION" || parent?.type === "FILE";
  });
  const topScreen = screens[0];
  const topComponent = analytics.componentUsage.find((usage) => usage.instanceCount > 0);
  const hub = analytics.mostConnected.find(
    (entry) => entry.node.type === "MAIN_COMPONENT" || entry.node.type === "COMPONENT_SET",
  );

  if (topScreen) questions.push(`What is ${topScreen.name} built from?`);
  if (topComponent) {
    questions.push(
      `Where is ${topComponent.component.name} used, and what breaks if it changes?`,
    );
  }
  if (hub) questions.push(`Why is ${hub.node.name} a hub in this file?`);
  if (analytics.unusedComponents.length) {
    questions.push("Which component definitions have zero instances?");
  }
  if (screens.length >= 2) {
    questions.push(`How is ${screens[0]!.name} related to ${screens[1]!.name}?`);
  }
  return questions.slice(0, 5);
}

export function buildOrientBrief(index: GraphIndex): OrientBrief {
  const analytics = computeAnalytics(index);
  const file = index.getFileNode();
  const communities = detectCommunitiesForIndex(index, { excludeHubs: true })
    .communities.filter((community) => community.size > 1)
    .slice(0, 12);

  return {
    file: {
      name: file?.name ?? index.graph.fileName,
      key: index.graph.fileKey,
      sourceKind: index.graph.source.kind,
    },
    totals: analytics.totals,
    godNodes: analytics.mostConnected.slice(0, 8).map((entry) => ({
      id: entry.node.id,
      name: entry.node.name,
      type: entry.node.type,
      degree: entry.degree,
    })),
    communities: communities.map((community) => ({
      name: community.name,
      size: community.size,
      hub: community.hubId,
    })),
    health: {
      unusedComponents: analytics.unusedComponents.length,
      unresolvedInstances: analytics.unresolvedInstances.length,
      framesWithoutComponents: analytics.framesWithoutComponents.length,
    },
    askNext: suggestQuestions(index, analytics),
    hint:
      "Implementing a screen: optional recipe \"<job>\", recommend unbound slots, Figma on those figmaNodeIds, then verify_frame. Do not Read graph.json.",
  };
}

export function toGraphReportMarkdown(brief: OrientBrief): string {
  const lines = [
    `# ${brief.file.name}`,
    "",
    `${brief.totals.nodes} nodes, ${brief.totals.edges} edges, ${brief.totals.componentDefinitions} components, ${brief.totals.instances} instances. Source: ${brief.file.sourceKind}.`,
    "",
    "Ingested once. Do not Read graph.json.",
    "",
    "## Implement a screen",
    "",
    "1. Optional: `recipe \"<screen job>\"` — pack of masters + slots with `figmaNodeId`s.",
    "2. `recommend \"<intent>\"` — ranked masters for unbound slots (`figmaNodeId`, variants, where-used).",
    "3. Figma (`use_figma` / `get_design_context`) on those `figmaNodeId`s only.",
    "4. `verify_frame` on the new frame or placed names — invents / deprecated / unresolved.",
    "5. `resolve \"<component>\"` when you already know the name (usage card).",
    "6. Do **not** call `get_design_context` on a FRAME or SECTION until recipe/recommend/resolve returns an id.",
    "",
    "## God nodes",
    "",
    ...brief.godNodes.map(
      (node) => `- **${node.name}** (\`${node.type}\`, degree ${node.degree}) \`${node.id}\``,
    ),
    "",
    "## Communities",
    "",
    ...brief.communities.map((community) => `- **${community.name}** — ${community.size} nodes`),
    "",
    "## Health",
    "",
    `- unused components: ${brief.health.unusedComponents}`,
    `- unresolved instances: ${brief.health.unresolvedInstances}`,
    `- frames with no components: ${brief.health.framesWithoutComponents}`,
    "",
    "## Ask next",
    "",
    ...brief.askNext.map((question) => `- ${question}`),
    "",
    brief.hint,
    "",
  ];
  return lines.join("\n");
}

export function queryQuestion(
  index: GraphIndex,
  question: string,
  options: { maxNodes?: number; budgetChars?: number } = {},
) {
  const analog = similarUsage(index, question);
  // Only the analog shortcut when the question names a component family.
  // Empty familyTokens would treat every instance on matching screens as
  // "pick this variant" — 12 Headings, not Heading × 12.
  if (analog.familyTokens.length && analog.variants.length) {
    const use = analog.variants[0]!;
    return withCost({
      question,
      use,
      also: analog.variants.slice(1),
      similarScreens: analog.screens,
      hint: `Use ${use.set ? `${use.set} / ` : ""}${use.name} — nested on ${use.on.map((screen) => screen.name).join(", ")}. Do not pick a variant from an unrelated screen.`,
    });
  }

  let hits = searchNodes(index, question, { limit: 8 });
  if (!hits.length && analog.screens[0]) {
    const screen = index.getNode(analog.screens[0].id);
    if (screen) {
      hits = [{ node: screen, score: analog.screens[0].score, matchedOn: ["name"] }];
    }
  }
  if (!hits.length) {
    const orient = buildOrientBrief(index);
    return withCost({
      question,
      matched: 0,
      similarScreens: analog.screens,
      hint: "No node matched. Use a name from Ask next, or the query language (type:main Button).",
      askNext: orient.askNext,
    });
  }

  const focus =
    hits.find((hit) => hit.node.type === "FRAME" || hit.node.type === "SECTION")?.node ??
    hits[0]!.node;

  if (focus.type === "FRAME" || focus.type === "SECTION") {
    const inventory = screenInventory(index, focus.id);
    return withCost({
      question,
      focus: briefNode(focus),
      matches: hits.map((hit) => ({ ...briefNode(hit.node), matchedOn: hit.matchedOn })),
      ...inventory,
    });
  }
  const budgetChars = options.budgetChars ?? 8000;
  let maxNodes = options.maxNodes ?? 40;
  let subgraph = extractSubgraph(index, {
    focusId: focus.id,
    level: levelForNode(focus),
    viewMode: "dependency",
    maxNodes,
  });
  let payload = {
    question,
    focus: briefNode(focus),
    matches: hits.map((hit) => ({ ...briefNode(hit.node), matchedOn: hit.matchedOn })),
    truncated: subgraph.truncated,
    nodes: subgraph.nodes.map(briefNode),
    edges: subgraph.edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      type: edge.type,
    })),
  };

  // ponytail: shrink neighbourhood until under budget; add paging if agents need more
  while (JSON.stringify(payload).length > budgetChars && maxNodes > 8) {
    maxNodes = Math.floor(maxNodes / 2);
    subgraph = extractSubgraph(index, {
      focusId: focus.id,
      level: levelForNode(focus),
      viewMode: "dependency",
      maxNodes,
    });
    payload = {
      ...payload,
      truncated: true,
      nodes: subgraph.nodes.map(briefNode),
      edges: subgraph.edges.map((edge) => ({
        source: edge.source,
        target: edge.target,
        type: edge.type,
      })),
    };
  }

  return withCost(payload);
}

export function pathBetween(index: GraphIndex, from: string, to: string) {
  const start = resolveNode(index, from);
  const end = resolveNode(index, to);
  if (!start || !end) {
    return withCost({
      connected: false,
      hops: 0,
      path: [],
      hint: `Could not resolve ${!start ? from : to}. Call orient or query for names.`,
    });
  }
  const trace = index.shortestPathTrace(start.id, end.id);
  return withCost({
    connected: trace.nodes.length > 0,
    hops: trace.hops.length,
    distance: trace.distance,
    path: trace.nodes.map(briefNode),
    via: trace.hops,
    shared: sharedComponents(index, start.id, end.id).slice(0, 8),
  });
}

export function explainNode(index: GraphIndex, nameOrId: string, task?: string) {
  const node = resolveNode(index, nameOrId);
  if (!node) {
    return withCost({
      found: false,
      hint: `Nothing named "${nameOrId}". Call orient for god nodes, or query.`,
    });
  }
  if (node.type === "FRAME" || node.type === "SECTION") {
    const inventory = screenInventory(index, node.id);
    return withCost({
      found: true,
      node: briefNode(node),
      ...inventory,
    });
  }

  const context = buildAiGraphContext(index, node.id, { nodeBudget: 40 });
  if (!context) {
    return withCost({ found: false, hint: `Could not build context for ${node.id}.` });
  }
  return withCost({
    found: true,
    node: briefNode(node),
    truncated: context.meta.truncated,
    markdown: toMarkdownPrompt(context, task),
  });
}

/**
 * Thin intelligence: which variant to put on a new screen, given sibling
 * flows — and which ones are deprecated.
 */
export function checkFrame(index: GraphIndex, intent: string) {
  const analog = similarUsage(index, intent);
  const avoid = analog.variants.filter((variant) => index.getNode(variant.id)?.status === "deprecated");
  const use = analog.variants.find((variant) => index.getNode(variant.id)?.status !== "deprecated");
  const useNode = use ? index.getNode(use.id) : undefined;
  const useLabel = useNode ? variantCardName(index, useNode) : use?.name;
  return withCost({
    intent,
    use: use ?? null,
    avoid,
    similarScreens: analog.screens,
    hint: use
      ? `Use ${useLabel}. Nested on ${use.on.map((screen) => screen.name).join(", ")}.${
          avoid.length ? ` Avoid deprecated: ${avoid.map((variant) => variant.name).join(", ")}.` : ""
        }`
      : analog.variants.length
        ? "Similar screens only nest deprecated variants. Do not copy them into a new frame."
        : "No similar screen nested this component family. Call recommend for library-wide ranking, or query / orient for names.",
  });
}

const isMasterType = (type: GraphNode["type"]): boolean =>
  (MASTER_TYPES as readonly string[]).includes(type);

const asMaster = (index: GraphIndex, node: GraphNode): GraphNode | undefined => {
  if (isMasterType(node.type)) return node;
  if (node.type === "COMPONENT_INSTANCE") return index.getMainComponent(node.id);
  return undefined;
};

function whereUsedRows(index: GraphIndex, node: GraphNode, limit: number) {
  const counts = new Map<string, { name: string; count: number }>();
  for (const instance of index.getAllInstancesOf(node.id)) {
    const screen = screenOf(index, instance.id);
    if (!screen) continue;
    const entry = counts.get(screen.id);
    if (entry) entry.count += 1;
    else counts.set(screen.id, { name: screen.name, count: 1 });
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function slotsForComponent(index: GraphIndex, node: GraphNode, sample = 8): string[] {
  const names = new Set<string>();
  for (const instance of index.getAllInstancesOf(node.id).slice(0, sample)) {
    for (const slot of slotNamesOf(index, instance.id)) names.add(slot);
  }
  return [...names].sort();
}

function ruleMatches(index: GraphIndex, node: GraphNode, rule: string): boolean {
  const needle = rule.trim().toLowerCase();
  if (!needle) return false;
  if (node.id.toLowerCase() === needle) return true;
  if (node.name.toLowerCase() === needle) return true;
  const figmaId = node.figmaNodeId?.toLowerCase();
  if (figmaId && (figmaId === needle || figmaId.replace(/:/g, "-") === needle)) return true;
  const set =
    node.type === "COMPONENT_SET"
      ? node
      : node.componentSetId
        ? index.getNode(node.componentSetId)
        : undefined;
  return Boolean(set && set.name.toLowerCase() === needle);
}

export interface LibraryRules {
  allow?: string[];
  deny?: string[];
}

/** Product + journey context mixed into recommend ranking. No Figma node ids. */
export interface RecommendContext {
  id?: string;
  product?: { id?: string; name?: string };
  client?: { id?: string; name?: string };
  domain?: string;
  /** Screen kind, same job as `domain` when a caller says "settings" or "checkout". */
  screenType?: string;
  journey?: { step?: string; screenJob?: string };
  audience?: string;
  constraints?: { density?: string; a11y?: string };
  files?: string[];
  libraryRules?: LibraryRules;
}

export function parseLibraryRules(raw: unknown): LibraryRules {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const list = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    return items.length ? items.map((item) => item.trim()) : undefined;
  };
  return { allow: list(record["allow"]), deny: list(record["deny"]) };
}

const REFRESH_HINT = "If stale, learn_library. Do not Read graph.json.";

function refreshHintFor(sock?: SockState, fileKey?: string): string {
  if (!sock) return REFRESH_HINT;
  const values = Object.values(sock.freshness);
  const stale = fileKey
    ? sock.freshness[fileKey]
    : values.find((row) => row.stale) ?? values[0];
  return staleRefreshHint(stale);
}

/** Place-ready top hit. These fields stay present on candidate 1. */
export interface RecommendCandidate {
  id: string;
  name: string;
  why: string;
  type: string;
  hint: string;
  deprecated: boolean;
  /** Omitted on a tight card so the real-example pointer still fits. */
  instances?: number;
  whereUsed?: Array<{ name: string; count: number }>;
  score: number;
  /** Set when an unknown noun sits in front of the head. Ranking is unchanged. */
  confidence?: "low";
  figmaNodeId?: string;
  nodeId?: string;
  fileKey?: string;
  componentKey?: string;
  published?: boolean;
  publishState?: "published" | "local-only";
  variantProperties?: Record<string, string>;
  set?: string;
  status?: GraphNode["status"];
  slots?: string[];
  /** Real instance node id, or the no-example sentence. Full config is get_example. */
  ex?: string;
}

/** Candidates 2–3. Place with fileKey + figmaNodeId; the rest stays on the top hit. */
export interface RecommendAlternate {
  id: string;
  name: string;
  why: string;
  fileKey?: string;
  figmaNodeId?: string;
  /** Real instance node id when one is known. Omitted when there is no example. */
  ex?: string;
}

export type RecommendHit = RecommendCandidate | RecommendAlternate;

function sameFamily(a: GraphNode, b: GraphNode): boolean {
  if (a.id === b.id) return true;
  if (a.componentSetId && (a.componentSetId === b.id || a.componentSetId === b.componentSetId)) return true;
  if (b.componentSetId && b.componentSetId === a.id) return true;
  return false;
}

function variantHaystack(node: GraphNode): string {
  const props = node.variantProperties;
  if (!props) return "";
  return Object.entries(props)
    .flatMap(([key, value]) => [key, value])
    .join(" ");
}

function setOf(index: GraphIndex, node: GraphNode): GraphNode | undefined {
  if (node.type === "COMPONENT_SET") return node;
  return node.componentSetId ? index.getNode(node.componentSetId) : undefined;
}

/** Unique masters nested on each screen frame. */
function mastersByScreen(index: GraphIndex): Map<string, GraphNode[]> {
  const byScreen = new Map<string, GraphNode[]>();
  for (const frame of index.getNodesByType("FRAME")) {
    if (!isScreen(index, frame)) continue;
    const seen = new Map<string, GraphNode>();
    for (const instance of index.getNestedInstances(frame.id)) {
      const main = index.getMainComponent(instance.id);
      if (main) seen.set(main.id, main);
    }
    byScreen.set(frame.id, [...seen.values()]);
  }
  return byScreen;
}

function screensOfMaster(index: GraphIndex, node: GraphNode): GraphNode[] {
  const seen = new Map<string, GraphNode>();
  for (const instance of index.getAllInstancesOf(node.id)) {
    const screen = screenOf(index, instance.id);
    if (screen) seen.set(screen.id, screen);
  }
  return [...seen.values()];
}

function contextTokenGroups(context?: RecommendContext) {
  if (!context) return undefined;
  return {
    product: tokensOf([context.product?.id, context.product?.name].filter(Boolean).join(" ")),
    client: tokensOf([context.client?.id, context.client?.name].filter(Boolean).join(" ")),
    domain: tokensOf([context.domain, context.screenType].filter(Boolean).join(" ")),
    journey: tokensOf([context.journey?.step, context.journey?.screenJob].filter(Boolean).join(" ")),
  };
}

function appliedRecommendContext(context?: RecommendContext) {
  if (!context?.id) return undefined;
  const product = context.product?.name || context.product?.id;
  const client = context.client?.name || context.client?.id;
  const journey = context.journey?.screenJob || context.journey?.step;
  return {
    id: context.id,
    ...(product ? { product } : {}),
    ...(client ? { client } : {}),
    ...(context.domain ? { domain: context.domain } : {}),
    ...(journey ? { journey } : {}),
    ...(context.files?.length ? { files: context.files } : {}),
  };
}

function deniedByRules(index: GraphIndex, node: GraphNode, rules?: LibraryRules): boolean {
  const deny = rules?.deny;
  if (!deny?.length) return false;
  return deny.some((rule) => ruleMatches(index, node, rule));
}

/** Everyday words that mean the same control. Reasons live in src/data/synonyms.json. */
const SYNONYM_GROUPS: (readonly string[])[] = [];
const SYNONYM_OF = new Map<string, readonly string[]>();
for (const group of synonymFile.groups) {
  const terms = group.terms.map((term) => term.toLowerCase()).filter((term) => !term.includes(" "));
  if (terms.length) SYNONYM_GROUPS.push(terms);
  for (const term of terms) SYNONYM_OF.set(term, terms);
}

/**
 * States, sizes, variants, roles, and common UI nouns.
 * A multi-word ask may keep one of these beside a real component word.
 * Reasons live in src/data/ui-modifiers.json.
 */
const UI_MODIFIER = new Set(modifierFile.words.map((word) => word.term.toLowerCase()));

/**
 * A word that only counts when it follows a component word or one of its synonyms.
 * "window" after modal. "mark" after close. Not a free-floating modifier.
 */
const TRAILING_AFTER = new Map<string, ReadonlySet<string>>(
  modifierFile.trailing.map((row) => [
    row.term.toLowerCase(),
    new Set(row.after.map((word) => word.toLowerCase())),
  ]),
);

/** Slot words that pick a variant, not a different component family. */
const SLOT_QUALIFIERS = new Set(["primary", "secondary", "tertiary", "danger", "ghost"]);

/**
 * Words that mark journey.step as a component slot (primary-cta, input, message).
 * A pack step such as "summary" or "form" stays screen context.
 */
const SLOT_ROLE_TOKENS = new Set([
  "cta",
  "button",
  "message",
  "input",
  "row",
  "card",
  "icon",
  "header",
  "field",
  "chip",
  "badge",
  "label",
  "search",
  "avatar",
  "banner",
  "toast",
  "modal",
  "switch",
]);

function slotIsComponentRole(slotTokens: string[]): boolean {
  return slotTokens.some((token) => SLOT_ROLE_TOKENS.has(token));
}

/** True when the ask already names a public live master, so the slot must not hide it. */
function intentNamesMaster(index: GraphIndex, askedTokens: string[]): boolean {
  if (!askedTokens.length) return false;
  for (const node of index.getNodesByType(...MASTER_TYPES)) {
    if (node.status === "deprecated" || isPrivateMasterName(node.name)) continue;
    const names = new Set(tokensOf(node.name));
    if (askedTokens.some((token) => names.has(token))) return true;
  }
  return false;
}

const RETIRED_NAME_TOKENS = new Set(["legacy", "old", "deprecated", "retired"]);

function synonymIn(token: string, names: Set<string>, allowClip = false): boolean {
  const group = termsFor(token, allowClip);
  if (!group) return false;
  return group.some((word) => word !== token && names.has(word));
}

const CLIP_GROUP = new Map<string, readonly string[] | undefined>();

/**
 * A short token that is a unique prefix of one synonym, with at least four
 * letters left over. "pic" is picture. "head" is not, because it also starts header.
 * Single-word asks do not clip. The caller passes allowClip only for a multi-word ask.
 */
function clippingGroup(token: string): readonly string[] | undefined {
  if (CLIP_GROUP.has(token)) return CLIP_GROUP.get(token);
  let found: readonly string[] | undefined;
  if (token.length >= 3 && !SYNONYM_OF.has(token)) {
    const hits: (readonly string[])[] = [];
    for (const terms of SYNONYM_GROUPS) {
      if (terms.some((term) => term.startsWith(token) && term.length > token.length)) hits.push(terms);
    }
    const only = hits[0];
    if (hits.length === 1 && only?.some((term) => term.length >= token.length + 4)) found = only;
  }
  CLIP_GROUP.set(token, found);
  return found;
}

function termsFor(token: string, allowClip: boolean): readonly string[] | undefined {
  return SYNONYM_OF.get(token) ?? (allowClip ? clippingGroup(token) : undefined);
}

interface TokenHits {
  name: number;
  synonym: number;
  variant: number;
  covered: number;
}

/** Shared UI nouns. One of these alone must not steal a more specific ask. */
const GENERIC_NAME_TOKENS = new Set([
  "button",
  "bar",
  "field",
  "icon",
  "label",
  "box",
  "item",
  "text",
  "row",
  "card",
  "message",
  "input",
]);

function collapsedName(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Plural s/es or -ing/-ed, either way. "tablet" is not an inflection of "tab". */
function inflectsName(query: string, nameToken: string): boolean {
  if (query === nameToken || query.length < 3 || nameToken.length < 3) return false;
  const [longer, shorter] = query.length >= nameToken.length ? [query, nameToken] : [nameToken, query];
  if (!longer.startsWith(shorter)) return false;
  const rest = longer.slice(shorter.length);
  return rest === "s" || rest === "es" || rest === "ing" || rest === "ed";
}

function tokenMatchesName(query: string, nameToken: string, allowClip = false): boolean {
  if (query === nameToken || inflectsName(query, nameToken)) return true;
  return synonymIn(query, new Set([nameToken]), allowClip);
}

/** "x" means close only as the whole ask, or right beside icon/button. "x ray" does not. */
function xMeansClose(text: string): boolean {
  const parts = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (parts.length === 1) return parts[0] === "x";
  if (parts.length !== 2) return false;
  const [left, right] = parts;
  if (!left || !right) return false;
  const mark = left === "x" || right === "x";
  const chrome = left === "icon" || right === "icon" || left === "button" || right === "button";
  return mark && chrome;
}

/** Multi-word synonym phrases, such as "tick box" for Checkbox. Single words stay in SYNONYM_OF. */
function phraseNamesMatch(ask: string, name: string): boolean {
  const collapsedAsk = collapsedName(ask);
  const collapsedMaster = collapsedName(name);
  if (!collapsedAsk || !collapsedMaster) return false;
  return synonymFile.groups.some((group) => {
    const asked = group.terms.some((term) => term.includes(" ") && collapsedName(term) === collapsedAsk);
    if (!asked) return false;
    return group.terms.some((term) => collapsedName(term) === collapsedMaster);
  });
}

function phraseCoversAsk(ask: string): boolean {
  const collapsedAsk = collapsedName(ask);
  return synonymFile.groups.some((group) =>
    group.terms.some((term) => term.includes(" ") && collapsedName(term) === collapsedAsk),
  );
}

function liveNameSets(index: GraphIndex): Set<string>[] {
  const sets: Set<string>[] = [];
  for (const node of index.getNodesByType(...MASTER_TYPES)) {
    if (node.status === "deprecated" || isPrivateMaster(index, node)) continue;
    sets.push(new Set(tokensOf(node.name)));
  }
  return sets;
}

function screenWords(index: GraphIndex): string[] {
  const words: string[] = [];
  for (const node of index.getNodesByType("FRAME")) {
    if (!isScreen(index, node)) continue;
    words.push(...tokensOf(node.name));
  }
  return words;
}

function contextWords(context?: RecommendContext): string[] {
  if (!context) return [];
  return tokensOf(
    [
      context.domain,
      context.screenType,
      context.journey?.step,
      context.journey?.screenJob,
      context.product?.name,
      context.product?.id,
      context.client?.name,
      context.client?.id,
      context.audience,
    ]
      .filter((part): part is string => Boolean(part))
      .join(" "),
  );
}

/** A UI modifier, a scene word, or a trailing UI noun such as "window" after modal. */
function keepsCompany(token: string, previous: string | undefined, exempt: ReadonlySet<string>): boolean {
  if (UI_MODIFIER.has(token) || exempt.has(token)) return true;
  if (!previous) return false;
  const after = TRAILING_AFTER.get(token);
  if (!after) return false;
  if (after.has(previous)) return true;
  const group = SYNONYM_OF.get(previous);
  return Boolean(group?.some((word) => after.has(word)));
}

/**
 * One component word plus words that are not the head is not a component ask.
 * The head is the last word, or a component word followed only by UI nouns.
 * "cart badge" keeps Badge. "card game" is empty, because game is the head.
 * "error alert" stays, because error is a status. A scene word is not junk.
 * An unknown word in front of the head is a noun modifier, and the pick is low confidence.
 */
function askGate(
  ask: string,
  tokens: string[],
  nameSets: readonly Set<string>[],
  exempt: ReadonlySet<string>,
  allowClip: boolean,
): { outOfDomain: boolean; lowConfidence: boolean } {
  const open = { outOfDomain: false, lowConfidence: false };
  if (phraseCoversAsk(ask)) return open;
  const content = tokens.filter((token) => !RETIRED_NAME_TOKENS.has(token));
  if (content.length < 2) return open;
  const hit = content.map((token) =>
    nameSets.some(
      (names) => nameTokenFor(token, names, new Set()) !== undefined || synonymIn(token, names, allowClip),
    ),
  );
  if (hit.filter(Boolean).length !== 1) return open;
  const head = hit.lastIndexOf(true);
  for (let i = head + 1; i < content.length; i += 1) {
    const token = content[i];
    if (!token || !keepsCompany(token, content[i - 1], exempt)) return { outOfDomain: true, lowConfidence: false };
  }
  let unknown = 0;
  for (let i = 0; i < head; i += 1) {
    const token = content[i];
    if (!token || hit[i]) continue;
    if (UI_MODIFIER.has(token) || exempt.has(token)) continue;
    unknown += 1;
  }
  return { outOfDomain: false, lowConfidence: unknown > 0 };
}

/** Query is the master name with one letter missing. */
function oneCharMissing(query: string, name: string): boolean {
  if (query.length + 1 !== name.length) return false;
  let i = 0;
  while (i < query.length && query[i] === name[i]) i += 1;
  return query.slice(i) === name.slice(i + 1);
}

/** Neighbouring letters swapped, and nothing else. */
function adjacentSwap(query: string, name: string): boolean {
  if (query.length !== name.length || query.length < 2) return false;
  let i = 0;
  while (i < query.length && query[i] === name[i]) i += 1;
  if (i >= query.length - 1) return false;
  if (query[i] !== name[i + 1] || query[i + 1] !== name[i]) return false;
  return query.slice(i + 2) === name.slice(i + 2);
}

/**
 * Typo against the whole name, spaces removed. At least 5 letters.
 * A missing letter or a neighbouring swap. Not a substituted letter.
 * Never used while an exact, phrase, or synonym match exists.
 */
function wholeNameTypo(ask: string, name: string): boolean {
  const query = collapsedName(ask);
  const master = collapsedName(name);
  if (query.length < 5 || master.length < 5 || query === master) return false;
  return oneCharMissing(query, master) || adjacentSwap(query, master);
}

/** "button" and "cta"/"action" are the same generic control word. */
function genericQuery(query: string): boolean {
  if (GENERIC_NAME_TOKENS.has(query)) return true;
  const group = SYNONYM_OF.get(query);
  return Boolean(group?.some((word) => word !== query && GENERIC_NAME_TOKENS.has(word)));
}

/**
 * A master that only shares a generic token (bar, button, input, cta, …)
 * drops out when another word names a different component, or when this
 * master still has a specific word the ask did not say.
 * "radio button" drops Button. "primary button" drops Pay CTA.
 * "login field" keeps Text Field.
 */
function genericOnlyMiss(
  name: string,
  queryTokens: string[],
  allowClip: boolean,
  componentWord: (token: string) => boolean,
): boolean {
  const nameTokens = tokensOf(name);
  if (!nameTokens.length || !queryTokens.length) return false;
  const matched = nameTokens.filter((token) =>
    queryTokens.some((query) => tokenMatchesName(query, token, allowClip)),
  );
  if (!matched.length) return false;
  // "cta" on Pay CTA is a real name token, even though cta is a synonym of button.
  if (matched.some((token) => !GENERIC_NAME_TOKENS.has(token))) return false;
  const uncovered = queryTokens.filter((query) => {
    if (genericQuery(query)) return false;
    return !nameTokens.some((token) => tokenMatchesName(query, token, allowClip));
  });
  if (!uncovered.length) return false;
  if (uncovered.some((query) => componentWord(query))) return true;
  const unknown = uncovered.filter((query) => !UI_MODIFIER.has(query));
  if (!unknown.length) return false;
  return nameTokens.some(
    (token) =>
      !GENERIC_NAME_TOKENS.has(token) &&
      !queryTokens.some((query) => tokenMatchesName(query, token, allowClip)),
  );
}

/**
 * "primary button" drops Pay CTA when a master is actually named primary.
 * A library whose primary control is named Pay CTA keeps it, because primary
 * is only a variant there. Two real component words ("button and row") both stay.
 */
function withoutGenericCousins<T extends { node: { name: string } }>(
  entries: T[],
  queryTokens: string[],
  allowClip: boolean,
): T[] {
  const modifiers = queryTokens.filter((token) => UI_MODIFIER.has(token) && !GENERIC_NAME_TOKENS.has(token));
  const covered = modifiers.filter((token) =>
    entries.some((entry) => tokensOf(entry.node.name).some((name) => name === token || inflectsName(token, name))),
  );
  if (!covered.length) return entries;
  return entries.filter((entry) => {
    const names = tokensOf(entry.node.name);
    const misses = covered.some((token) => !names.some((name) => name === token || inflectsName(token, name)));
    if (!misses) return true;
    return names.some((name) => {
      if (GENERIC_NAME_TOKENS.has(name)) return false;
      return queryTokens.some((query) => {
        if (!(query === name || inflectsName(query, name) || tokenMatchesName(query, name, allowClip))) return false;
        if (query === name || inflectsName(query, name)) return true;
        return !genericQuery(query);
      });
    });
  });
}

function nameTokenFor(token: string, names: Set<string>, used: Set<string>): string | undefined {
  if (names.has(token) && !used.has(token)) return token;
  for (const name of names) {
    if (!used.has(name) && inflectsName(token, name)) return name;
  }
  return undefined;
}

function tokenHits(nameHaystack: string, variantText: string, tokens: string[], allowClip: boolean): TokenHits {
  const names = new Set(tokensOf(nameHaystack));
  const variants = new Set(tokensOf(variantText));
  const used = new Set<string>();
  let name = 0;
  let synonym = 0;
  let variant = 0;
  let covered = 0;
  const pending: string[] = [];
  for (const token of tokens) {
    const hit = nameTokenFor(token, names, used);
    if (hit) {
      name += 1;
      covered += 1;
      used.add(hit);
    } else pending.push(token);
  }
  const still: string[] = [];
  for (const token of pending) {
    const group = termsFor(token, allowClip);
    const hit = group?.find((word) => word !== token && names.has(word) && !used.has(word));
    if (hit) {
      synonym += 1;
      covered += 1;
      used.add(hit);
    } else still.push(token);
  }
  for (const token of still) {
    const syn = termsFor(token, allowClip);
    const hit = [...variants].find(
      (part) => !used.has(part) && (part === token || Boolean(syn?.includes(part) && part !== token)),
    );
    if (hit) {
      variant += 1;
      covered += 1;
      used.add(hit);
    }
  }
  return { name, synonym, variant, covered };
}

/** Name / synonym / variant. One name token outranks any amount of context. */
function lexicalScore(hits: TokenHits, exactName: boolean): number {
  if (exactName) return 1_000_000;
  return hits.name * 100 + hits.synonym * 70 + hits.variant * 40;
}

/** "checkout summary with primary button" → scene + the component ask. */
function splitBrief(intent: string): { role: string; scene: string } {
  const parts = intent.split(/\s+with\s+/i);
  if (parts.length < 2) return { role: intent.trim(), scene: "" };
  return { scene: (parts[0] ?? "").trim(), role: parts.slice(1).join(" ").trim() };
}

function replacedByName(node: GraphNode): string | undefined {
  const meta = node.metadata?.["replacedBy"];
  if (typeof meta === "string" && meta.trim()) return meta.trim();
  const description = node.description ?? "";
  for (const line of description.split(/\n/)) {
    const match = line.match(/^\s*replacedBy\s*:\s*(.+?)\s*$/i);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

function isPrivateMaster(index: GraphIndex, node: GraphNode): boolean {
  if (isPrivateMasterName(node.name)) return true;
  const set = setOf(index, node);
  return Boolean(set && isPrivateMasterName(set.name));
}

/**
 * Live master a deprecated name should hand back.
 * Explicit replacedBy wins. Otherwise the closest live name that still carries
 * the specific tokens (Legacy Banner → Banner, Old Price → Price).
 */
function liveReplacement(index: GraphIndex, node: GraphNode): GraphNode | undefined {
  const live = index.getNodesByType(...MASTER_TYPES).filter((candidate) => {
    if (candidate.id === node.id) return false;
    if (candidate.status === "deprecated") return false;
    if (isPrivateMaster(index, candidate)) return false;
    if (isNameInferredMaster(candidate)) return false;
    return true;
  });
  const explicit = replacedByName(node);
  if (explicit) {
    const needle = explicit.toLowerCase();
    const named = live.filter(
      (candidate) => candidate.name.toLowerCase() === needle || candidate.id === explicit,
    );
    const picked = named.sort(
      (a, b) =>
        Number(b.type === "COMPONENT_SET") - Number(a.type === "COMPONENT_SET") ||
        a.name.length - b.name.length ||
        a.name.localeCompare(b.name),
    )[0];
    if (picked) return picked;
  }
  const wanted = tokensOf(node.name).filter((token) => !RETIRED_NAME_TOKENS.has(token));
  if (!wanted.length) return undefined;
  const cousins = live.filter((candidate) => {
    const have = new Set(tokensOf(candidate.name));
    return wanted.every((token) => have.has(token));
  });
  cousins.sort((a, b) => {
    const extra = (candidate: GraphNode) => tokensOf(candidate.name).length - wanted.length;
    return extra(a) - extra(b) || a.name.length - b.name.length || a.name.localeCompare(b.name);
  });
  return cousins[0];
}

/**
 * Brief/intent → ranked library masters. Agent does not need the component
 * name. A strong name, token, or synonym match leads. Screen, journey, and
 * usage only break ties among those matches — they cannot pull in a master
 * the words do not name. Deprecated names resolve to the live replacement.
 * Never invents a component that is not in the graph.
 */
export function recommendMasters(
  index: GraphIndex,
  intent: string,
  options: {
    budgetChars?: number;
    context?: RecommendContext;
    workspace?: WorkspaceManifest;
    sock?: SockState;
    bindRules?: BindRulesFile;
  } = {},
) {
  const budgetChars = options.budgetChars ?? RECOMMEND_BUDGET;
  const analog = similarUsage(index, intent);
  const analogById = new Map(analog.variants.map((variant) => [variant.id, variant]));
  const slotRaw = options.context?.journey?.step?.trim() ?? "";
  const slotTokens = tokensOf(slotRaw.replace(/-/g, " "));
  const slotRole = slotIsComponentRole(slotTokens);
  const brief = splitBrief(intent);
  const askedTokens = tokensOf(brief.role);
  if (xMeansClose(brief.role) && !askedTokens.includes("close")) askedTokens.push("close");
  // Exclusive family only when the slot is a component role and the intent is a
  // screen job ("sign in"). "input chip" and "checkout summary" already name a
  // master, so those tokens stay in the lexical score and context breaks the tie.
  const exclusiveSlot = slotRole && !intentNamesMaster(index, askedTokens);
  const familyTokens = slotTokens.filter((token) => !SLOT_QUALIFIERS.has(token));
  const tokens = exclusiveSlot
    ? familyTokens.length
      ? familyTokens
      : askedTokens
    : [...new Set([...askedTokens, ...(slotRole ? familyTokens : [])])];
  const extraTokens = exclusiveSlot ? askedTokens.filter((token) => !slotTokens.includes(token)) : [];
  const sceneTokens = exclusiveSlot
    ? [...new Set([...tokensOf(brief.scene), ...askedTokens])]
    : tokensOf(brief.scene);
  const placeTokens = [...new Set([...tokens, ...extraTokens, ...sceneTokens, ...slotTokens])];
  const nestedByScreen = mastersByScreen(index);
  const ctx = contextTokenGroups(options.context);
  const packRules = options.context?.libraryRules;
  const workspace = options.workspace;
  const graphFileKey = index.graph.fileKey;
  const intentNeedle = intent.trim().toLowerCase();
  const allowClip = askedTokens.length >= 2;
  const publicNameSets = liveNameSets(index);
  const componentWord = (token: string): boolean =>
    publicNameSets.some(
      (names) => nameTokenFor(token, names, new Set()) !== undefined || synonymIn(token, names, allowClip),
    );

  type Scored = {
    node: GraphNode;
    score: number;
    lexical: number;
    why: string[];
    whyOverride?: string;
    analog: boolean;
    deprecated: boolean;
    instances: number;
    setName?: string;
    exactName: boolean;
    covered: number;
  };

  const scoreNode = (node: GraphNode, set: GraphNode | undefined): Scored | undefined => {
    const collapsedAsk = collapsedName(intentNeedle);
    const exactName =
      Boolean(intentNeedle) &&
      (node.name.toLowerCase() === intentNeedle ||
        collapsedName(node.name) === collapsedAsk ||
        phraseNamesMatch(intentNeedle, node.name) ||
        (Boolean(set) &&
          node.type === "COMPONENT_SET" &&
          (set!.name.toLowerCase() === intentNeedle ||
            collapsedName(set!.name) === collapsedAsk ||
            phraseNamesMatch(intentNeedle, set!.name))));
    const nameHaystack = `${node.name} ${set?.name ?? ""}`;
    const variantText = variantHaystack(node);
    const hits = tokenHits(nameHaystack, variantText, tokens, allowClip);
    const extraHits = extraTokens.length ? tokenHits(nameHaystack, variantText, extraTokens, allowClip) : undefined;
    // A screen-job slot names the family ("sign in" + primary-cta → buttons).
    // When the intent already names a master, that gate stays off.
    let lexical: number;
    if (exactName) {
      lexical = lexicalScore(hits, true);
    } else if (exclusiveSlot) {
      if (hits.name === 0 && hits.synonym === 0 && hits.variant === 0) return undefined;
      const familyLexical = hits.name > 0 || hits.synonym > 0 ? 100 : 40;
      lexical =
        familyLexical +
        (extraHits?.name ?? 0) * 100 +
        (extraHits?.synonym ?? 0) * 70 +
        (extraHits?.variant ?? 0) * 40;
    } else {
      lexical = lexicalScore(hits, false);
      if (lexical === 0) return undefined;
      if (genericOnlyMiss(node.name, tokens, allowClip, componentWord)) return undefined;
      const nameTokens = tokensOf(node.name);
      const matched = nameTokens.filter((token) => tokens.some((query) => tokenMatchesName(query, token))).length;
      if (nameTokens.length > 0 && matched === nameTokens.length) lexical += 25;
    }

    const analogHit = analogById.get(node.id);
    const screens = screensOfMaster(index, node);
    let whereUsedScore = 0;
    for (const screen of screens) whereUsedScore += overlap(screen.name, placeTokens);
    let coOccur = 0;
    for (const screen of screens) {
      for (const sibling of nestedByScreen.get(screen.id) ?? []) {
        if (sameFamily(node, sibling)) continue;
        const siblingSet = setOf(index, sibling);
        const haystack = `${sibling.name} ${siblingSet?.name ?? ""} ${variantHaystack(sibling)}`;
        coOccur += overlap(haystack, tokens);
      }
    }

    let productHit = 0;
    let clientHit = 0;
    let domainHit = 0;
    let journeyHit = 0;
    if (ctx) {
      for (const screen of screens) {
        productHit += overlap(screen.name, ctx.product);
        clientHit += overlap(screen.name, ctx.client);
        domainHit += overlap(screen.name, ctx.domain);
        journeyHit += overlap(screen.name, ctx.journey);
      }
    }
    const libraryHit = isLibraryFileKey(workspace, nodeFileKey(node, graphFileKey));
    const deprecated = node.status === "deprecated";
    const instances = computeComponentUsage(index, node).instanceCount;
    const stale = instances === 0;
    const why: string[] = [];
    if (hits.name > 0 || (extraHits?.name ?? 0) > 0 || exactName) why.push("name");
    if (hits.synonym > 0 || (extraHits?.synonym ?? 0) > 0) why.push("synonym");
    if (hits.variant > 0 || (extraHits?.variant ?? 0) > 0) why.push("variant");
    if (analogHit) why.push("similar-screen");
    if (whereUsedScore > 0) why.push("where-used");
    if (coOccur > 0) why.push("co-occur");
    if (productHit > 0) why.push("product");
    if (clientHit > 0) why.push("client");
    if (domainHit > 0) why.push("domain");
    if (journeyHit > 0) why.push("journey");
    if (libraryHit) why.push("library");
    if (instances > 0) why.push("usage");
    const sockPattern = options.sock ? patternFor(options.sock, node.id) : undefined;
    if (sockPattern?.promoted && sockPattern.confidence === "strong") why.push("sock-usage");
    if (stale) why.push("stale");

    const typeBoost = node.type === "COMPONENT_SET" ? 3 : node.type === "MAIN_COMPONENT" ? 2 : 1;
    const sockBoost = sockPattern?.promoted && sockPattern.confidence === "strong" ? 20 : 0;
    let context =
      Math.min(whereUsedScore, 4) * 40 +
      Math.min(coOccur, 4) * 8 +
      Math.min(productHit, 3) * 24 +
      Math.min(clientHit, 3) * 16 +
      Math.min(domainHit, 4) * 50 +
      Math.min(journeyHit, 4) * 50 +
      (analogHit ? 25 : 0) +
      (libraryHit ? 20 : 0) +
      sockBoost +
      (stale ? 0 : Math.min(36, Math.round(Math.log1p(instances) * 10))) +
      typeBoost;
    if (stale) context -= 30;
    if (slotRole) {
      const names = new Set(tokensOf(nameHaystack));
      const variants = new Set(tokensOf(variantText));
      for (const token of slotTokens) {
        if (!SLOT_QUALIFIERS.has(token)) continue;
        if (names.has(token) || variants.has(token)) context += 40;
      }
    }
    context = Math.max(0, Math.min(context, 999));
    let score = lexical * 1000 + context;
    if (deprecated) score -= 1_000_000;

    return {
      node,
      score,
      lexical,
      why,
      analog: Boolean(analogHit),
      deprecated,
      instances,
      setName: set && set.id !== node.id ? set.name : undefined,
      exactName,
      covered: hits.covered + (extraHits?.covered ?? 0),
    };
  };

  const scored: Scored[] = [];
  const retired: Scored[] = [];
  let privateCovered = 0;
  for (const node of index.getNodesByType(...MASTER_TYPES)) {
    if (isNameInferredMaster(node)) continue;
    const set = setOf(index, node);
    if (deniedByRules(index, node, packRules)) continue;
    if (node.metadata?.["removedByAbsence"] === true) continue;
    if (isRemovedByAbsence(options.sock, node)) continue;
    const entry = scoreNode(node, set);
    if (!entry) continue;
    if (isPrivateMaster(index, node)) {
      privateCovered = Math.max(privateCovered, entry.covered);
      continue;
    }
    if (entry.deprecated) retired.push(entry);
    else scored.push(entry);
  }

  const publicCovered = scored.reduce((best, entry) => Math.max(best, entry.covered), 0);
  let blockedByPrivate = false;
  if (tokens.length > 0 && privateCovered > publicCovered) {
    scored.length = 0;
    retired.length = 0;
    blockedByPrivate = true;
  }

  const asksRetired =
    tokens.some((token) => RETIRED_NAME_TOKENS.has(token)) ||
    retired.some((entry) => entry.exactName);
  const askedSpecific = tokens.filter((token) => !RETIRED_NAME_TOKENS.has(token));
  let redirect: { id: string; reason: string; covered: number } | undefined;
  for (const entry of retired) {
    const replacement = liveReplacement(index, entry.node);
    if (!replacement) {
      scored.push(entry);
      continue;
    }
    const nameSpecific = tokensOf(entry.node.name).filter((token) => !RETIRED_NAME_TOKENS.has(token));
    const specificOverlap = askedSpecific.filter((token) => nameSpecific.includes(token)).length;
    // "legacy" alone may name a retired master. "legacy price" must not follow
    // Legacy Banner just because both names say legacy.
    if (askedSpecific.length > 0 && specificOverlap === 0) continue;
    const rank = askedSpecific.length > 0 ? specificOverlap : entry.covered;
    if (asksRetired && rank > 0 && entry.covered >= publicCovered) {
      const reason = `replaces ${entry.node.name} (deprecated)`;
      if (!redirect || rank > redirect.covered) {
        redirect = { id: replacement.id, reason, covered: rank };
      }
    }
  }
  if (redirect) {
    const existing = scored.find((entry) => entry.node.id === redirect!.id);
    if (existing) {
      existing.whyOverride = redirect.reason;
      existing.score += 500_000;
    } else {
      const node = index.getNode(redirect.id);
      if (node && node.status !== "deprecated" && !isPrivateMaster(index, node)) {
        const set = setOf(index, node);
        const injected = scoreNode(node, set) ?? {
          node,
          score: 0,
          lexical: 0,
          why: [] as string[],
          analog: false,
          deprecated: false,
          instances: computeComponentUsage(index, node).instanceCount,
          setName: set && set.id !== node.id ? set.name : undefined,
          exactName: false,
          covered: 0,
        };
        injected.whyOverride = redirect.reason;
        injected.score += 500_000;
        scored.push(injected);
      }
    }
  }

  const domainExempt = new Set<string>([...contextWords(options.context), ...screenWords(index)]);
  const gate = askGate(brief.role, askedTokens, publicNameSets, domainExempt, allowClip);
  if (gate.outOfDomain) {
    scored.length = 0;
    retired.length = 0;
  }
  const lowConfidence = gate.lowConfidence;

  if (!blockedByPrivate && !gate.outOfDomain && scored.length === 0 && intentNeedle) {
    const winners: GraphNode[] = [];
    for (const node of index.getNodesByType(...MASTER_TYPES)) {
      if (node.status === "deprecated" || isPrivateMaster(index, node)) continue;
      if (isNameInferredMaster(node)) continue;
      if (deniedByRules(index, node, packRules)) continue;
      if (node.metadata?.["removedByAbsence"] === true) continue;
      if (isRemovedByAbsence(options.sock, node)) continue;
      if (!wholeNameTypo(intentNeedle, node.name)) continue;
      winners.push(node);
    }
    const winner = winners.length === 1 ? winners[0] : undefined;
    if (winner) {
      const set = setOf(index, winner);
      scored.push({
        node: winner,
        score: 15_000,
        lexical: 15,
        why: ["typo"],
        analog: false,
        deprecated: false,
        instances: computeComponentUsage(index, winner).instanceCount,
        setName: set && set.id !== winner.id ? set.name : undefined,
        exactName: false,
        covered: 1,
      });
    }
  }

  const analogIds = new Set(analogById.keys());
  const analogSetIds = new Set(
    [...analogById.values()]
      .map((variant) => index.getNode(variant.id)?.componentSetId)
      .filter((id): id is string => Boolean(id)),
  );
  const setIds = new Set(
    scored.filter((entry) => entry.node.type === "COMPONENT_SET").map((entry) => entry.node.id),
  );
  let kept = scored.filter((entry) => {
    if (entry.node.type === "COMPONENT_SET" && analogSetIds.has(entry.node.id) && !entry.exactName) {
      return false;
    }
    if (entry.node.type !== "VARIANT") return true;
    if (entry.exactName || analogIds.has(entry.node.id)) return true;
    if (
      entry.why.includes("name") ||
      entry.why.includes("synonym") ||
      entry.why.includes("variant") ||
      entry.why.includes("typo") ||
      entry.why.includes("where-used") ||
      entry.why.includes("co-occur")
    ) {
      return true;
    }
    return !entry.node.componentSetId || !setIds.has(entry.node.componentSetId);
  });

  kept.sort(
    (a, b) =>
      Number(b.exactName) - Number(a.exactName) ||
      b.score - a.score ||
      Number(a.deprecated) - Number(b.deprecated) ||
      a.node.name.localeCompare(b.node.name),
  );

  if (options.bindRules?.rules.length) {
    kept = filterAndScoreByBindRules(kept, options.bindRules, {
      intent,
      domain: options.context?.domain,
      journey: options.context?.journey?.screenJob || options.context?.journey?.step,
      product: options.context?.product?.name || options.context?.product?.id,
      pack: options.context?.id,
      workspace,
      graphFileKey,
      sock: options.sock,
      index,
      inject: (node) => {
        const set = setOf(index, node);
        return {
          node,
          score: 1_000_000,
          lexical: 1_000,
          why: ["bind-rule"],
          analog: false,
          deprecated: node.status === "deprecated",
          instances: computeComponentUsage(index, node).instanceCount,
          setName: set && set.id !== node.id ? set.name : undefined,
          exactName: false,
          covered: tokens.length,
        };
      },
    });
    kept.sort(
      (a, b) =>
        Number(b.exactName) - Number(a.exactName) ||
        b.score - a.score ||
        Number(a.deprecated) - Number(b.deprecated) ||
        a.node.name.localeCompare(b.node.name),
    );
  }

  kept = withoutGenericCousins(
    kept.filter((entry) => !isNameInferredMaster(entry.node)),
    tokens,
    allowClip,
  );

  const packJourney = packJourneyPhrase(options.context);
  const bindQuery = {
    intent,
    domain: options.context?.domain,
    journey: options.context?.journey?.screenJob || options.context?.journey?.step,
    product: options.context?.product?.name || options.context?.product?.id,
    pack: options.context?.id,
    workspace,
    graphFileKey,
    sock: options.sock,
  };

  const toCandidate = (
    entry: Scored,
    includeSlots: boolean,
    whereLimit: number,
  ): RecommendCandidate => {
    const whereUsed = whereUsedRows(index, entry.node, whereLimit);
    const slots = includeSlots ? slotsForComponent(index, entry.node) : [];
    const place = placeReady(entry.node, graphFileKey);
    const hint = entry.deprecated
      ? "Deprecated — do not place."
      : place.published
        ? "Place fileKey + nodeId + componentKey."
        : "Place fileKey + nodeId. Local-only (no published key).";
    const why =
      entry.whyOverride ??
      whyLineForMaster(entry.node, {
        sock: options.sock,
        packJourney,
        bindRule: options.bindRules
          ? bindRuleHit(options.bindRules, entry.node, bindQuery)
          : undefined,
        graphFileKey,
      });
    return {
      id: entry.node.id,
      name: variantCardName(index, entry.node),
      type: entry.node.type,
      ...place,
      variantProperties: entry.node.variantProperties,
      set: entry.setName,
      status: entry.node.status,
      deprecated: entry.deprecated,
      instances: entry.instances,
      whereUsed,
      ...(slots.length ? { slots } : {}),
      score: entry.score,
      why,
      hint,
    };
  };

  const tight = budgetChars <= RECOMMEND_BUDGET;
  const target = tight ? 3 : 6;
  let limit = Math.min(kept.length, target);
  let truncated = kept.length > limit;
  let dropExtras = false;
  let slimLead = false;
  const exQuery = exampleQuery(index, options);

  const shortReason = (why: string): string => {
    const cut = why.split(";")[0]?.trim() || why;
    return cut.length > 64 ? `${cut.slice(0, 61)}…` : cut;
  };

  const leadCandidate = (entry: Scored): RecommendCandidate => {
    const full = toCandidate(entry, false, 0);
    const pointer = examplePointer(index, entry.node, exQuery, tight ? "id" : "screen");
    const next: RecommendCandidate = {
      ...full,
      whereUsed: [],
      ex: pointer,
      hint: full.deprecated ? "Deprecated — do not place." : "Place fileKey + nodeId.",
    };
    if (lowConfidence) next.confidence = "low";
    delete next.slots;
    if (slimLead) {
      delete next.published;
      delete next.publishState;
      delete next.instances;
      if (!next.whereUsed?.length) delete next.whereUsed;
    }
    if (dropExtras) {
      delete next.set;
    }
    return next;
  };

  const altCandidate = (entry: Scored): RecommendAlternate => {
    const place = placeReady(entry.node, graphFileKey);
    const why = entry.whyOverride ?? toCandidate(entry, false, 0).why;
    return {
      id: entry.node.id,
      name: variantCardName(index, entry.node),
      why: shortReason(why),
      ...(place.fileKey ? { fileKey: place.fileKey } : {}),
      ...(place.figmaNodeId ? { figmaNodeId: place.figmaNodeId } : {}),
    };
  };

  const listed = (): RecommendHit[] =>
    kept.slice(0, limit).map((entry, index) =>
      index === 0 || !tight ? leadCandidate(entry) : altCandidate(entry),
    );

  let candidates = listed();

  const applied = appliedRecommendContext(options.context);
  const payloadOf = () => {
    const base = {
      intent,
      candidates,
      truncated,
      ...(applied ? { context: applied } : {}),
      hint:
        candidates.length === 0
          ? `No master matched. Do not invent. ${refreshHintFor(options.sock, graphFileKey)}`
          : candidates.length > 1 &&
              candidates.slice(1).some((row) => !("fileKey" in row && row.fileKey) || !("figmaNodeId" in row && row.figmaNodeId))
            ? `Place fileKey+nodeId on the top hit. Resolve an alternate by id before placing it. ${refreshHintFor(options.sock, graphFileKey)}`
            : `Place fileKey+nodeId. ${refreshHintFor(options.sock, graphFileKey)}`,
    };
    const fitted = fitBindRuleWarnings(options.bindRules?.warnings, base, budgetChars);
    return { ...base, ...fitted };
  };

  let payload = payloadOf();
  const shrink = () => {
    candidates = listed();
    payload = payloadOf();
  };

  if (JSON.stringify(payload).length > budgetChars && candidates[0] && "confidence" in candidates[0]) {
    const lead = { ...candidates[0] };
    delete lead.confidence;
    candidates = [lead, ...candidates.slice(1)];
    payload = payloadOf();
  }
  if (JSON.stringify(payload).length > budgetChars) {
    truncated = true;
    slimLead = true;
    shrink();
  }
  if (JSON.stringify(payload).length > budgetChars) {
    truncated = true;
    dropExtras = true;
    shrink();
  }
  if (JSON.stringify(payload).length > budgetChars && limit > 2) {
    truncated = true;
    limit = 2;
    shrink();
  }
  if (JSON.stringify(payload).length > budgetChars && candidates[0] && "hint" in candidates[0]) {
    truncated = true;
    const lead = candidates[0];
    candidates = [
      {
        ...lead,
        why: lead.why.length > 72 ? `${lead.why.slice(0, 69)}…` : lead.why,
        hint: "Place fileKey + nodeId.",
      },
      ...candidates.slice(1),
    ];
    payload = payloadOf();
  }
  while (JSON.stringify(payload).length > budgetChars && candidates.length > 2) {
    truncated = true;
    limit = candidates.length - 1;
    shrink();
  }
  if (JSON.stringify(payload).length > budgetChars && candidates[0] && "variantProperties" in candidates[0]) {
    truncated = true;
    const lead = { ...candidates[0] };
    delete lead.variantProperties;
    delete lead.set;
    candidates = [lead, ...candidates.slice(1)];
    payload = payloadOf();
  }
  while (JSON.stringify(payload).length > budgetChars && candidates.length > 1) {
    truncated = true;
    limit = candidates.length - 1;
    shrink();
  }
  const warningsWanted = options.bindRules?.warnings?.length ?? 0;
  const warningMissing = () =>
    warningsWanted > 0 && !payload.bindRuleWarnings?.length && !payload.warningNote;
  if (warningMissing()) {
    truncated = true;
    slimLead = true;
    shrink();
  }
  while (warningMissing() && candidates.length > 1) {
    truncated = true;
    limit = candidates.length - 1;
    shrink();
  }
  if (JSON.stringify(payload).length > budgetChars) {
    shrinkNameFields(payload, budgetChars);
  }
  if (JSON.stringify(payload).length > budgetChars && candidates[0] && "type" in candidates[0]) {
    const lead: RecommendCandidate = { ...candidates[0] };
    delete (lead as { score?: number }).score;
    if (!lead.deprecated) delete (lead as { deprecated?: boolean }).deprecated;
    candidates[0] = lead;
  }

  return withCost(payload);
}

export type VerifyReason = "not-in-graph" | "not-a-master" | "denied" | "private";
export type UnresolvedReason = "unresolved-instance" | "frame-not-in-graph" | "not-exact";

export interface VerifyResolved {
  given: string;
  name?: string;
  id?: string;
  fileKey?: string;
}

export interface VerifyHit {
  name: string;
  given?: string;
  id?: string;
  figmaNodeId?: string;
  fileKey?: string;
  reason?: VerifyReason | UnresolvedReason;
  status?: GraphNode["status"];
  didYouMean?: { name: string; id?: string; fileKey?: string };
}

/**
 * Thin post-draw check. Pass iff every placed component is an approved
 * (in-graph, not deprecated) master. Deterministic — no LLM.
 */
export function verifyFrame(
  index: GraphIndex,
  input: {
    frame?: string;
    components?: string[];
    rules?: LibraryRules;
    context?: RecommendContext;
    bindRules?: BindRulesFile;
    sock?: SockState;
    workspace?: WorkspaceManifest;
  } = {},
) {
  const invents: VerifyHit[] = [];
  const deprecatedHits: VerifyHit[] = [];
  const unresolved: VerifyHit[] = [];
  const resolved: VerifyResolved[] = [];
  const approvedIds = new Set<string>();
  const seenInvent = new Set<string>();
  const seenDeprecated = new Set<string>();
  const seenUnresolved = new Set<string>();

  const mergedRules: LibraryRules = {
    allow: input.rules?.allow ?? input.context?.libraryRules?.allow,
    deny: [
      ...(input.rules?.deny ?? []),
      ...(input.context?.libraryRules?.deny ?? []),
    ].filter((item, pos, list) => item.trim().length > 0 && list.indexOf(item) === pos),
  };
  const allow = mergedRules.allow?.filter((item) => item.trim().length > 0);
  const deny = mergedRules.deny?.filter((item) => item.trim().length > 0);
  const allowList = allow?.length ? allow : undefined;
  const denyList = deny?.length ? deny : undefined;

  const pushUnique = (list: VerifyHit[], seen: Set<string>, hit: VerifyHit, key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    list.push(hit);
  };

  const blockedByRules = (master: GraphNode, given: string): boolean => {
    if (denyList) {
      const denied =
        denyList.some((rule) => ruleMatches(index, master, rule)) ||
        denyList.some((rule) => rule.trim().toLowerCase() === given.trim().toLowerCase());
      if (denied) return true;
    }
    if (allowList) {
      const allowed =
        allowList.some((rule) => ruleMatches(index, master, rule)) ||
        allowList.some((rule) => rule.trim().toLowerCase() === given.trim().toLowerCase());
      if (!allowed) return true;
    }
    return false;
  };

  const fileOf = (node: GraphNode) => nodeFileKey(node, index.graph.fileKey);

  const stampHit = (node: GraphNode, extra: Omit<VerifyHit, "name" | "id" | "figmaNodeId" | "fileKey"> = {}): VerifyHit => {
    const fileKey = fileOf(node);
    return {
      name: variantCardName(index, node),
      id: node.id,
      figmaNodeId: node.figmaNodeId,
      ...(fileKey ? { fileKey } : {}),
      ...extra,
    };
  };

  const realMasterByName = (name: string): GraphNode | undefined =>
    placeableMasterByName(index, name, input.workspace);

  const considerMaster = (master: GraphNode, given: string) => {
    if (isNameInferredMaster(master)) {
      const real = realMasterByName(master.name) ?? realMasterByName(given);
      if (real && real.id !== master.id) {
        considerMaster(real, given);
        return;
      }
      pushUnique(
        invents,
        seenInvent,
        stampHit(master, { reason: "not-a-master", given }),
        `invent:${master.id}`,
      );
      return;
    }
    if (isPrivateMasterName(master.name)) {
      pushUnique(invents, seenInvent, stampHit(master, { reason: "private", given }), `private:${master.id}`);
      return;
    }
    if (blockedByRules(master, given)) {
      pushUnique(invents, seenInvent, stampHit(master, { reason: "denied" }), `denied:${master.id}`);
      return;
    }
    if (master.status === "deprecated") {
      pushUnique(deprecatedHits, seenDeprecated, stampHit(master, { status: "deprecated" }), master.id);
      return;
    }
    approvedIds.add(master.id);
  };

  let frameNode: GraphNode | undefined;
  const frameName = input.frame?.trim();
  if (frameName) {
    frameNode = resolveNode(index, frameName);
    if (!frameNode) {
      pushUnique(
        unresolved,
        seenUnresolved,
        { name: frameName, reason: "frame-not-in-graph" },
        `frame:${frameName}`,
      );
    } else {
      for (const instance of index.getNestedInstances(frameNode.id)) {
        const main = index.getMainComponent(instance.id);
        if (!main) {
          pushUnique(
            unresolved,
            seenUnresolved,
            stampHit(instance, { reason: "unresolved-instance" }),
            instance.id,
          );
          continue;
        }
        considerMaster(main, main.name);
      }
    }
  }

  for (const raw of input.components ?? []) {
    const given = raw.trim();
    if (!given) continue;
    const node = resolveNodeExact(index, given);
    if (!node) {
      resolved.push({ given });
      const near = searchNodes(index, given, { limit: 8 })
        .map((hit) => asMaster(index, hit.node))
        .find((node): node is GraphNode => Boolean(node));
        if (near && !isNameInferredMaster(near)) {
        const fileKey = fileOf(near);
        pushUnique(
          unresolved,
          seenUnresolved,
          {
            name: given,
            given,
            reason: "not-exact",
            didYouMean: {
              name: variantCardName(index, near),
              id: near.id,
              ...(fileKey ? { fileKey } : {}),
            },
          },
          `fuzzy:${given.toLowerCase()}`,
        );
        continue;
      }
      pushUnique(invents, seenInvent, { name: given, given, reason: "not-in-graph" }, `invent:${given.toLowerCase()}`);
      continue;
    }
    const master = asMaster(index, node);
    const preferred =
      placeableMasterByName(index, given, input.workspace) ??
      (master ? placeableMasterByName(index, master.name, input.workspace) : undefined);
    const echoed = preferred ?? master ?? node;
    const fileKey = fileOf(echoed);
    resolved.push({
      given,
      name: variantCardName(index, echoed),
      id: echoed.id,
      ...(fileKey ? { fileKey } : {}),
    });
    if (!master && !preferred) {
      pushUnique(invents, seenInvent, stampHit(node, { reason: "not-a-master", given }), `invent:${node.id}`);
      continue;
    }
    if (!preferred && master && isNameInferredMaster(master)) {
      considerMaster(master, given);
      continue;
    }
    if (preferred) considerMaster(preferred, given);
    else if (master) considerMaster(master, given);
  }

  const content = frameNode ? frameContentWarnings(index, frameNode.id) : { warnings: [], blocking: false };
  const pass = invents.length === 0 && deprecatedHits.length === 0 && unresolved.length === 0;
  const placed: GraphNode[] = [...approvedIds]
    .map((id) => index.getNode(id))
    .filter((node): node is GraphNode => Boolean(node));
  const ruleFailure = input.bindRules?.rules.length
    ? verifyBindRules(index, input.bindRules, placed, {
        domain: input.context?.domain,
        journey: input.context?.journey?.screenJob || input.context?.journey?.step,
        product: input.context?.product?.name || input.context?.product?.id,
        pack: input.context?.id,
        frameName: frameNode?.name ?? input.frame,
        sock: input.sock,
      })
    : undefined;
  const bindPass = !ruleFailure;
  const ok = pass && bindPass && !content.blocking;
  const bindHint = ruleFailure
    ? `Fail — bind rule ${ruleFailure.rule}: ${ruleFailure.reason}.${
        ruleFailure.expected ? ` Place ${ruleFailure.expected.name} (${ruleFailure.expected.id}).` : ""
      }`
    : undefined;
  const pending = input.sock?.proposals.filter((row) => row.status === "pending").length ?? 0;
  const hint = ok
    ? `Only approved library masters. ${REFRESH_HINT}`
    : content.blocking && pass && bindPass
      ? `Fail — placeholder text left in a placed instance. ${REFRESH_HINT}`
      : bindHint ??
        `Fail — invents/deprecated/unresolved listed. Replace invents with recommend() figmaNodeIds. ${REFRESH_HINT}`;
  const pendingHint = pending ? `pending improvements: ${pending}.` : undefined;
  const base = {
    pass: ok,
    approved: approvedIds.size,
    resolved,
    invents,
    deprecated: deprecatedHits,
    unresolved,
    ...(ruleFailure ? { ruleFailure } : {}),
    frame: frameNode
      ? {
          ...briefNode(frameNode),
          ...(fileOf(frameNode) ? { fileKey: fileOf(frameNode) } : {}),
        }
      : undefined,
    builtAt: index.graph.builtAt,
    hint: pendingHint ? `${hint} ${pendingHint}` : hint,
    ...(pending ? { pendingImprovements: pending } : {}),
  };
  return fitCardAfterCost(base, input.bindRules?.warnings, content.warnings, 600);
}

const WARNING_OVERFLOW = (count: number) => `and ${count} more warnings`;

const NAME_FLOOR = 16;
/** Real master names stay intact. Only oversized labels shrink, so a cut never invents a name. */
const COMPONENT_NAME_FLOOR = 80;

/** Drop `given` when it repeats `name`. Only called once a card is already over budget. */
function dropEchoedGiven(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) dropEchoedGiven(item);
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record["given"] === "string" && record["given"] === record["name"]) {
    delete record["given"];
  }
  for (const child of Object.values(record)) dropEchoedGiven(child);
}

function collectNameSlots(
  value: unknown,
  slots: Array<{ parent: Record<string, unknown>; key: string }>,
): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectNameSlots(item, slots);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (key === "hint" || key === "why" || key === "cost" || key === "ex") continue;
    if ((key === "name" || key === "given") && typeof child === "string") slots.push({ parent: record, key });
    else collectNameSlots(child, slots);
  }
}

/** Shorten the longest `name` / `given` fields until `size(payload)` fits. Ids stay intact. */
function shrinkNameFields(
  payload: object,
  budget: number,
  size: (value: object) => number = (value) => JSON.stringify(value).length,
): void {
  let droppedEcho = false;
  let deepNames = false;
  let guard = 0;
  while (size(payload) > budget && guard < 240) {
    guard += 1;
    if (!droppedEcho) {
      dropEchoedGiven(payload);
      droppedEcho = true;
      continue;
    }
    const slots: Array<{ parent: Record<string, unknown>; key: string }> = [];
    collectNameSlots(payload, slots);
    const floorOf = (key: string) =>
      key === "name" ? (deepNames ? NAME_FLOOR : COMPONENT_NAME_FLOOR) : NAME_FLOOR;
    const long = slots
      .filter((slot) => {
        const text = slot.parent[slot.key];
        return typeof text === "string" && text.length > floorOf(slot.key);
      })
      .sort((a, b) => (b.parent[b.key] as string).length - (a.parent[a.key] as string).length)[0];
    if (long) {
      const text = long.parent[long.key] as string;
      const nextLen = Math.max(floorOf(long.key), text.length - 32);
      long.parent[long.key] = `${text.slice(0, nextLen - 1)}…`;
      continue;
    }
    const hinted = payload as { hint?: string };
    if (typeof hinted.hint === "string" && hinted.hint.length > 48) {
      hinted.hint = `${hinted.hint.slice(0, 47)}…`;
      continue;
    }
    if (!deepNames) {
      deepNames = true;
      continue;
    }
    break;
  }
}

/** Size the verify card after `cost` is attached so the serialized card stays inside the budget. */
function fitCardAfterCost<T extends object>(
  base: T,
  bindWarnings: BindRuleWarning[] | undefined,
  contentWarnings: ContentWarning[] | undefined,
  budgetChars: number,
): T & {
  cost: AgentCost;
  warnings?: ContentWarning[];
  bindRuleWarnings?: BindRuleWarning[];
  warningNote?: string;
} {
  shrinkNameFields(base, budgetChars, (value) => JSON.stringify(withCost(value)).length);
  const binds = bindWarnings ?? [];
  const content = contentWarnings ?? [];
  const cardFor = (contentCount: number, bindCount: number) => {
    const more = content.length - contentCount + (binds.length - bindCount);
    const fitted: Record<string, unknown> = {};
    if (contentCount > 0) fitted["warnings"] = content.slice(0, contentCount);
    if (bindCount > 0) fitted["bindRuleWarnings"] = binds.slice(0, bindCount);
    if (more > 0) fitted["warningNote"] = WARNING_OVERFLOW(more);
    if (!contentCount && !bindCount && !more) return withCost(base);
    return withCost({ ...base, ...fitted });
  };
  for (let contentCount = content.length; contentCount >= 0; contentCount -= 1) {
    for (let bindCount = binds.length; bindCount >= 0; bindCount -= 1) {
      const card = cardFor(contentCount, bindCount);
      if (JSON.stringify(card).length <= budgetChars) return card;
    }
  }
  return withCost(base);
}
