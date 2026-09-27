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

const stem = (word: string) =>
  word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;

const tokensOf = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 1 && !STOPWORDS.has(part))
    .map(stem);

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

export function usageCardForComponent(
  index: GraphIndex,
  node: GraphNode,
  options: { budgetChars?: number; sock?: SockState } = {},
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
  const base = {
    component: {
      ...briefNode(node),
      ...(nodeFileKey(node) ? { fileKey: nodeFileKey(node) } : {}),
      variantProperties: node.variantProperties,
      identity: node.metadata?.["identity"],
    },
    instances: usage.instanceCount,
    variants: usage.variantCount,
    riskScore: usage.riskScore,
    pages,
    hint:
      usage.instanceCount === 0
        ? "Master is in the graph with this id even with zero instances. Place this figmaNodeId. Usage is additive."
        : "Instance this figmaNodeId in Figma. Do not get_design_context on a parent FRAME.",
  };
  const place = placeReady(node, index.graph.fileKey);
  Object.assign(base.component, place);
  const publishedHint = place.published
    ? undefined
    : " Unpublished (local-only) — no published component key. Pass search_design_system / get_libraries to learn_library.";
  if (publishedHint) {
    base.hint = `${base.hint}${publishedHint}`;
  }
  const why = whyLineForMaster(node, { sock: options.sock, graphFileKey: index.graph.fileKey });

  let byScreen = toByScreen(includeSlots, limit);
  let payload = { ...base, why, byScreen, truncated };
  // ponytail: drop slots then screens until under budget
  while (JSON.stringify(payload).length > budgetChars && (includeSlots || limit > 1)) {
    truncated = true;
    if (includeSlots) includeSlots = false;
    else limit = Math.max(1, Math.floor(limit / 2));
    byScreen = toByScreen(includeSlots, limit);
    payload = { ...base, why, byScreen, truncated };
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
): GraphNode | undefined {
  const trimmed = name.trim();
  if (!trimmed) return undefined;

  const direct = index.getNode(trimmed);
  if (direct) return asResolvedNode(index, direct);
  for (const node of index.allNodes) {
    if (matchesFigmaId(node, trimmed) || matchesStampedId(node, trimmed, index.graph.fileKey)) {
      return asResolvedNode(index, node);
    }
  }

  // Exact display name, including a deprecated or private master.
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

  const ranked = recommendMasters(index, trimmed, { context, budgetChars: USAGE_CARD_BUDGET });
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
  options: { budgetChars?: number; sock?: SockState; context?: RecommendContext } = {},
) {
  const node = pickResolveTarget(index, name, options.context);
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
            name: replacement.name,
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
  const familyTokens = tokens.filter((token) =>
    definitions.some((node) => node.name.toLowerCase().includes(token)),
  );

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
  return trimmed.startsWith(".") || trimmed.startsWith("_");
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
  for (const node of index.allNodes) {
    if (matchesFigmaId(node, trimmed)) return node;
    if (matchesStampedId(node, trimmed, index.graph.fileKey)) return node;
    if (node.name.toLowerCase() !== lower) continue;
    if (isMasterType(node.type)) return node;
    exactName ??= node;
  }
  return exactName;
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
  return withCost({
    intent,
    use: use ?? null,
    avoid,
    similarScreens: analog.screens,
    hint: use
      ? `Use ${use.set ? `${use.set} / ` : ""}${use.name}. Nested on ${use.on.map((screen) => screen.name).join(", ")}.${
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

const REFRESH_HINT = "If stale, learn_library changed frames. Do not Read graph.json.";

function refreshHintFor(sock?: SockState, fileKey?: string): string {
  if (!sock) return REFRESH_HINT;
  const values = Object.values(sock.freshness);
  const stale = fileKey
    ? sock.freshness[fileKey]
    : values.find((row) => row.stale) ?? values[0];
  return staleRefreshHint(stale);
}

export interface RecommendCandidate {
  id: string;
  name: string;
  why: string;
  /** Present on the place-ready top hit. Omitted on compact alternates. */
  type?: string;
  figmaNodeId?: string;
  nodeId?: string;
  fileKey?: string;
  componentKey?: string;
  published?: boolean;
  publishState?: "published" | "local-only";
  variantProperties?: Record<string, string>;
  set?: string;
  status?: GraphNode["status"];
  deprecated?: boolean;
  instances?: number;
  whereUsed?: Array<{ name: string; count: number }>;
  slots?: string[];
  score?: number;
  /** Present on the place-ready top hit. Omitted on compact alternates. */
  hint?: string;
}

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

/** Everyday words that mean the same component family. Not a cousin map. */
const INTENT_SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ["button", "cta", "action"],
  ["avatar", "user", "profile"],
  ["header", "heading"],
  ["search", "find"],
  ["field", "box"],
  ["price", "cost"],
  ["close", "dismiss"],
  ["tag", "filter"],
  ["empty", "blank"],
  ["alert", "notice"],
];

const SYNONYM_OF = new Map<string, readonly string[]>();
for (const group of INTENT_SYNONYM_GROUPS) {
  for (const word of group) SYNONYM_OF.set(word, group);
}

const RETIRED_NAME_TOKENS = new Set(["legacy", "old", "deprecated", "retired"]);

function synonymIn(token: string, names: Set<string>): boolean {
  const group = SYNONYM_OF.get(token);
  if (!group) return false;
  return group.some((word) => word !== token && names.has(word));
}

interface TokenHits {
  name: number;
  synonym: number;
  variant: number;
  covered: number;
}

function tokenHits(nameHaystack: string, variantText: string, tokens: string[]): TokenHits {
  const names = new Set(tokensOf(nameHaystack));
  const variants = new Set(tokensOf(variantText));
  let name = 0;
  let synonym = 0;
  let variant = 0;
  let covered = 0;
  for (const token of tokens) {
    if (names.has(token)) {
      name += 1;
      covered += 1;
      continue;
    }
    if (synonymIn(token, names)) {
      synonym += 1;
      covered += 1;
      continue;
    }
    if (variants.has(token) || synonymIn(token, variants)) {
      variant += 1;
      covered += 1;
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
  const brief = splitBrief(intent);
  const tokens = tokensOf(brief.role);
  const sceneTokens = tokensOf(brief.scene);
  const placeTokens = [...new Set([...tokens, ...sceneTokens])];
  const nestedByScreen = mastersByScreen(index);
  const ctx = contextTokenGroups(options.context);
  const packRules = options.context?.libraryRules;
  const workspace = options.workspace;
  const graphFileKey = index.graph.fileKey;
  const intentNeedle = intent.trim().toLowerCase();

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
    const exactName =
      Boolean(intentNeedle) &&
      (node.name.toLowerCase() === intentNeedle ||
        (Boolean(set) && set!.name.toLowerCase() === intentNeedle && node.type === "COMPONENT_SET"));
    const nameHaystack = `${node.name} ${set?.name ?? ""}`;
    const hits = tokenHits(nameHaystack, variantHaystack(node), tokens);
    const lexical = lexicalScore(hits, exactName);
    // Context and usage cannot admit a master the words do not name.
    if (lexical === 0) return undefined;

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
    if (hits.name > 0 || exactName) why.push("name");
    if (hits.synonym > 0) why.push("synonym");
    if (hits.variant > 0) why.push("variant");
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
      covered: hits.covered,
    };
  };

  const scored: Scored[] = [];
  const retired: Scored[] = [];
  let privateCovered = 0;
  for (const node of index.getNodesByType(...MASTER_TYPES)) {
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
  if (tokens.length > 0 && privateCovered > publicCovered) {
    scored.length = 0;
    retired.length = 0;
  }

  const asksRetired =
    tokens.some((token) => RETIRED_NAME_TOKENS.has(token)) ||
    retired.some((entry) => entry.exactName);
  let redirect: { id: string; reason: string; covered: number } | undefined;
  for (const entry of retired) {
    const replacement = liveReplacement(index, entry.node);
    if (!replacement) {
      scored.push(entry);
      continue;
    }
    if (asksRetired && entry.covered >= publicCovered) {
      const reason = `replaces ${entry.node.name} (deprecated)`;
      if (!redirect || entry.covered > redirect.covered) {
        redirect = { id: replacement.id, reason, covered: entry.covered };
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
      name: entry.node.name,
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

  const shortReason = (why: string): string => {
    const cut = why.split(";")[0]?.trim() || why;
    return cut.length > 64 ? `${cut.slice(0, 61)}…` : cut;
  };

  const leadCandidate = (entry: Scored): RecommendCandidate => {
    const full = toCandidate(entry, false, 0);
    const next: RecommendCandidate = {
      ...full,
      whereUsed: [],
      hint: full.deprecated ? "Deprecated — do not place." : "Place fileKey + nodeId.",
    };
    delete next.slots;
    if (dropExtras) {
      delete next.score;
      delete next.set;
    }
    return next;
  };

  const altCandidate = (entry: Scored): RecommendCandidate => {
    const why = entry.whyOverride ?? toCandidate(entry, false, 0).why;
    return { id: entry.node.id, name: entry.node.name, why: shortReason(why) };
  };

  const listed = (): RecommendCandidate[] =>
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
  while (JSON.stringify(payload).length > budgetChars && candidates.length > 1) {
    truncated = true;
    limit = candidates.length - 1;
    shrink();
  }
  if (JSON.stringify(payload).length > budgetChars && candidates[0] && "variantProperties" in candidates[0]) {
    truncated = true;
    const lead = { ...candidates[0] };
    delete lead.variantProperties;
    delete lead.set;
    delete lead.score;
    candidates = [lead, ...candidates.slice(1)];
    payload = payloadOf();
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
      name: node.name,
      id: node.id,
      figmaNodeId: node.figmaNodeId,
      ...(fileKey ? { fileKey } : {}),
      ...extra,
    };
  };

  const considerMaster = (master: GraphNode, given: string) => {
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
      if (near) {
        const fileKey = fileOf(near);
        pushUnique(
          unresolved,
          seenUnresolved,
          {
            name: given,
            given,
            reason: "not-exact",
            didYouMean: {
              name: near.name,
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
    const echoed = master ?? node;
    const fileKey = fileOf(echoed);
    resolved.push({
      given,
      name: echoed.name,
      id: echoed.id,
      ...(fileKey ? { fileKey } : {}),
    });
    if (!master) {
      pushUnique(invents, seenInvent, stampHit(node, { reason: "not-a-master", given }), `invent:${node.id}`);
      continue;
    }
    considerMaster(master, given);
  }

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
  const ok = pass && bindPass;
  const bindHint = ruleFailure
    ? `Fail — bind rule ${ruleFailure.rule}: ${ruleFailure.reason}.${
        ruleFailure.expected ? ` Place ${ruleFailure.expected.name} (${ruleFailure.expected.id}).` : ""
      }`
    : undefined;
  const pending = input.sock?.proposals.filter((row) => row.status === "pending").length ?? 0;
  const hint = ok
    ? `Only approved library masters. ${REFRESH_HINT}`
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
  return fitCardAfterCost(base, input.bindRules?.warnings, 600);
}

const WARNING_OVERFLOW = (count: number) => `and ${count} more warnings`;

/** Size the verify card after `cost` is attached so the serialized card stays inside the budget. */
function fitCardAfterCost<T extends object>(
  base: T,
  warnings: BindRuleWarning[] | undefined,
  budgetChars: number,
): T & { cost: AgentCost } {
  const list = warnings ?? [];
  const cardFor = (count: number) => {
    if (count <= 0) {
      if (!list.length) return withCost(base);
      const withNote = withCost({ ...base, warningNote: WARNING_OVERFLOW(list.length) });
      return JSON.stringify(withNote).length <= budgetChars ? withNote : withCost(base);
    }
    const more = list.length - count;
    const fitted =
      more > 0
        ? { bindRuleWarnings: list.slice(0, count), warningNote: WARNING_OVERFLOW(more) }
        : { bindRuleWarnings: list.slice(0, count) };
    return withCost({ ...base, ...fitted });
  };
  for (let count = list.length; count >= 0; count -= 1) {
    const card = cardFor(count);
    if (JSON.stringify(card).length <= budgetChars) return card;
  }
  return withCost(base);
}
