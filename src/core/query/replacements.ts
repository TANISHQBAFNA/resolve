/** Retired replacements, code-map hooks, and ingredient cards. */
import type { GraphNode } from "@/core/model";
import { setOf } from "@/core/rules/family";
import { isNameInferredMaster } from "@/core/rules/names";
import { isRetired } from "@/core/rules/retired";
import { codeMapReport, codeMapTargets, codeText, codeView, type Hooks, type Twin } from "./codeMap";
import { propertyBlock } from "./componentProperties";
import { withCost } from "./cost";
import type { GraphIndex } from "./GraphIndex";
import { buildIngredientCard, buildIngredientCoverage, type IngredientHooks, type IngredientOptions } from "./ingredients";
import { missingNodeSentence, readFigmaLink } from "./learnedLink";
import { MASTER_TYPES, masterPopulation, VARIANT_PROP_NAME, variantCardName } from "./masterNames";
import { resolveNode } from "./nodeLookup";
import { tokensOf } from "./queryTokens";
import { isPrivateMaster, looksLikeIcon, replacedByName, RETIRED_NAME_TOKENS } from "./recommendLexicon";

function liveMasters(index: GraphIndex, except: GraphNode, skip?: (node: GraphNode) => boolean): GraphNode[] {
  return index.getNodesByType(...MASTER_TYPES).filter((candidate) => {
    if (candidate.id === except.id) return false;
    if (isRetired(index, candidate) || skip?.(candidate)) return false;
    if (isPrivateMaster(index, candidate)) return false;
    if (isNameInferredMaster(candidate)) return false;
    return true;
  });
}
/**
 * The current part that replaces a retired one: the map's `replacedBy` (name or id, exactly one part),
 * else the library's own guess. A retired replacement is followed (max 3 hops, cycle-safe).
 * Never a retired part: no current part means nothing.
 */
export function replacementFor(index: GraphIndex, node: GraphNode, twinOf?: (n: GraphNode) => Twin | undefined): GraphNode | undefined {
  return replacementOf(index, node, twinOf)?.node;
}
/** The chain walk behind replacementFor; `guess` is true when any hop was the library's name guess, not a named replacedBy. */
export function replacementOf(index: GraphIndex, node: GraphNode, twinOf: (n: GraphNode) => Twin | undefined = () => undefined): { node: GraphNode; guess: boolean } | undefined {
  const old = (n: GraphNode) => isRetired(index, n) || Boolean(twinOf(n)?.retired);
  const seen = new Set<string>();
  let at = node;
  let guess = false;
  for (let hop = 0; hop < 3; hop += 1) {
    seen.add(at.id);
    const ask = twinOf(at)?.replacedBy;
    const next = ask ? lookup(index, ask, old).node : liveReplacement(index, at, old);
    if (!next || seen.has(next.id)) return undefined;
    const named = replacedByName(at);
    if (!ask && !(named && (next.name.toLowerCase() === named.toLowerCase() || next.id === named))) guess = true;
    if (!old(next)) {
      if (looksLikeIcon(index, next, setOf(index, next))) return undefined;
      return { node: next, guess };
    }
    at = next;
  }
  return undefined;
}
/**
 * A replacedBy names a current library set or standalone component (name, node id or Figma id).
 * Variants and empty remote stubs never count; a real set beats a remote stub of the same name.
 */
function lookup(index: GraphIndex, ask: string, old: (n: GraphNode) => boolean): { node?: GraphNode; why?: string } {
  const want = ask.toLowerCase();
  const hits = index
    .getNodesByType(...MASTER_TYPES)
    .filter((n) => !isPrivateMaster(index, n) && !isNameInferredMaster(n) && (n.name.toLowerCase() === want || n.id === ask || n.figmaNodeId === ask));
  const variants = hits.filter((n) => n.type === "VARIANT" || n.componentSetId);
  const stubs = hits.filter((n) => n.isRemote && masterPopulation(index, n) === 0);
  const ok = hits.filter((n) => !variants.includes(n) && !stubs.includes(n));
  const live = ok.filter((n) => !old(n));
  const local = live.filter((n) => !n.isRemote);
  const node = ok.length === 1 ? ok[0] : live.length === 1 ? live[0] : local.length === 1 ? local[0] : undefined;
  if (node) return { node };
  return { why: ok.length ? "is not unique" : variants.length ? "is a variant" : stubs.length ? "is a remote stub" : "matches no component" };
}
/** Hooks for the code map: its retired view and its idea of a real (non-base, non-variant) component. */
const codeHooks = (index: GraphIndex): Hooks => ({
  retired: (node) => isRetired(index, node),
  real: (node) => !isPrivateMaster(index, node) && !isNameInferredMaster(node) && !VARIANT_PROP_NAME.test(node.name),
  use: (node, twinOf) => {
    const found = replacementOf(index, node, twinOf);
    return found && { name: found.node.name, guess: found.guess };
  },
  why: (ask) => lookup(index, ask, (n) => isRetired(index, n)).why,
});
export const codeMapView = (index: GraphIndex) => codeView(index, codeHooks(index));
export const codeMapCard = (getIndex: () => GraphIndex) => codeMapReport(getIndex, codeHooks);
/** Every component the map can name, with its current twin (for the CSV template). */
export const codeMapRows = (index: GraphIndex) => {
  const view = codeMapView(index);
  return codeMapTargets(index, codeHooks(index)).map(({ node, ...row }) => ({ ...row, twin: view?.twin(node) }));
};
/** Hooks for the ingredient card: same retired, private, guess, and code-map rules as every other card. */
function ingredientHooks(index: GraphIndex): IngredientHooks {
  const view = codeMapView(index);
  return {
    retired: (node) => isRetired(index, node) || Boolean(view?.retired(node)),
    internal: (node) => isPrivateMaster(index, node),
    nameGuess: (node) => isNameInferredMaster(node),
    twin: (node) => view?.twin(node),
    codeMap: Boolean(view),
    replacement: (node) => replacementFor(index, node, view?.twin),
    cardName: (node) => variantCardName(index, node),
  };
}
/** Retired check and replacement with the code map applied, the same rules as every card (used by the handoff sheet). */
export function retiredHooks(index: GraphIndex) {
  const view = codeMapView(index);
  return {
    view,
    retired: (node: GraphNode) => isRetired(index, node) || Boolean(view?.retired(node)),
    replacement: (node: GraphNode) => {
      const found = replacementOf(index, node, view?.twin);
      if (!found) return undefined;
      const twin = view?.twin(found.node);
      return { name: found.node.name, guess: found.guess, ...(twin ? { twin } : {}) };
    },
  };
}
/** "What is inside this component?" Parts from NESTS links, each with its code component or none. */
export function ingredientCard(index: GraphIndex, name: string, options: IngredientOptions = {}) {
  const card = buildIngredientCard(index, name, ingredientHooks(index), options);
  if (!card.found || !card.component.id) return withCost(card);
  const node = index.getNode(card.component.id);
  const block = node
    ? propertyBlock(index, node, name, codeMapView(index)?.twin(node)?.angular)
    : undefined;
  return withCost(block ? { ...card, ...block } : card);
}
/**
 * What's on this screen and its code twin. Does not refuse a retired part:
 * retired rows are labelled, with the replacement. Name guesses are left off.
 */
export function screenPartsCard(index: GraphIndex, ask: string) {
  const trimmed = ask.trim();
  const link = readFigmaLink(index, trimmed);
  if (link && !link.ok) return { ok: false as const, message: link.message };
  const frame = trimmed ? resolveNode(index, trimmed) : undefined;
  if (link?.ok && !frame) return { ok: false as const, message: missingNodeSentence(link.fileKey, link.nodeIds[0] ?? "") };
  if (!frame || (frame.type !== "FRAME" && frame.type !== "SECTION")) {
    return { ok: false as const, message: `No frame named "${trimmed}" in the learned files.` };
  }
  const view = codeMapView(index);
  const seen = new Set<string>();
  const parts: Array<{
    name: string;
    fileKey?: string;
    figmaNodeId?: string;
    code: string;
    /** Set when the component lives in a library file that is not learned. Code is "unknown", not "unmapped". */
    status?: "other-library";
    retired?: true;
    replacement?: string;
    replacementCode?: string;
  }> = [];
  for (const instance of index.getNestedInstances(frame.id)) {
    const main = index.getMainComponent(instance.id);
    if (!main || isNameInferredMaster(main)) continue;
    if (seen.has(main.id)) continue;
    seen.add(main.id);
    const retired = isRetired(index, main) || Boolean(view?.retired(main));
    const remote = Boolean(main.isRemote);
    const twin = view?.twin(main);
    const replacement = retired ? replacementOf(index, main, view?.twin) : undefined;
    const useTwin = replacement ? view?.twin(replacement.node) : undefined;
    parts.push({
      name: variantCardName(index, main),
      ...(main.fileKey ? { fileKey: main.fileKey } : {}),
      ...(main.figmaNodeId ? { figmaNodeId: main.figmaNodeId } : {}),
      code: remote ? "unknown" : twin?.line ? codeText(twin) : "unmapped",
      ...(remote ? { status: "other-library" as const } : {}),
      ...(retired
        ? {
            retired: true as const,
            ...(replacement ? { replacement: variantCardName(index, replacement.node) } : {}),
            ...(useTwin?.line ? { replacementCode: codeText(useTwin) } : {}),
          }
        : {}),
    });
  }
  return {
    ok: true as const,
    frame: frame.name,
    ...(frame.figmaNodeId ? { figmaNodeId: frame.figmaNodeId } : {}),
    parts,
  };
}
/** Library-wide ingredient counts: composites, parts, and how many parts link to code. */
export const ingredientCoverage = (index: GraphIndex) => buildIngredientCoverage(index, ingredientHooks(index));
/**
 * Live master a deprecated name should hand back.
 * Explicit replacedBy wins. Otherwise the closest live name that still carries
 * the specific tokens (Legacy Banner → Banner, Old Price → Price).
 */
export function liveReplacement(index: GraphIndex, node: GraphNode, skip?: (node: GraphNode) => boolean): GraphNode | undefined {
  const live = liveMasters(index, node, skip).filter(
    (candidate) => !looksLikeIcon(index, candidate, setOf(index, candidate)),
  );
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
  const wantedSource =
    VARIANT_PROP_NAME.test(node.name) || tokensOf(node.name).every((token) => RETIRED_NAME_TOKENS.has(token))
      ? (setOf(index, node) ?? node)
      : node;
  const wanted = tokensOf(wantedSource.name).filter((token) => !RETIRED_NAME_TOKENS.has(token));
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
