/** Screen frames, the parts placed on them, and similar-screen lookup. */
import type { GraphNode } from "@/core/model";
import { isNameInferredMaster } from "@/core/rules/names";
import { briefNode, EXACT_COMPONENT_HINT, LAYER_NAME_GUESS } from "./cardCopy";
import type { GraphIndex } from "./GraphIndex";
import { tokensOf } from "./queryTokens";

/** Stems of a real inflection: plural s/es, -ing, -ed. Not a prefix of an unrelated word. */
export function inflectionStems(word: string): string[] {
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
export const isScreen = (index: GraphIndex, node: GraphNode): boolean => {
  if (node.type !== "FRAME") return false;
  const parent = index.getParent(node.id);
  return parent?.type === "PAGE" || parent?.type === "SECTION" || parent?.type === "FILE";
};
export const overlap = (name: string, tokens: string[]): number => {
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
    }));

  const guessed = [...tally.values()].some((entry) => isNameInferredMaster(entry.component));
  return {
    screen: briefNode(node),
    components,
    unresolvedInstances: unresolved,
    ...(guessed ? { guess: LAYER_NAME_GUESS } : {}),
    hint: guessed
      ? `${LAYER_NAME_GUESS}. ${EXACT_COMPONENT_HINT}. Write from this list. Do not call Figma get_design_context on this FRAME.`
      : "Each component listed once; count is how many times it is placed. Write from this list. Do not call Figma get_design_context on this FRAME.",
  };
}
export const screenOf = (index: GraphIndex, nodeId: string): GraphNode | undefined => {
  const path = index.getHierarchyPath(nodeId);
  return path.find((ancestor) => isScreen(index, ancestor)) ?? path.find((ancestor) => ancestor.type === "FRAME");
};
/** Unique nested component names inside one instance (slot fills). */
export function slotNamesOf(index: GraphIndex, instanceId: string): string[] {
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
