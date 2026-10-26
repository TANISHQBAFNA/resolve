/** Resolve a name to a node, then build the usage or example card. */
import type { GraphNode } from "@/core/model";
import { isNameInferredMaster } from "@/core/rules/names";
import { isRetired } from "@/core/rules/retired";
import { type BindRulesFile, preferDelta } from "./bindRules";
import { propertyBlock } from "./componentProperties";
import { withCost } from "./cost";
import { type ExampleReason, exampleSentence, getExample } from "./examples";
import type { GraphIndex } from "./GraphIndex";
import { isMasterType, MASTER_TYPES, otherNamedMasters, placeableNode, preferNamedMaster, realMastersNamed, sameNameNote, substitutionNote, USAGE_CARD_BUDGET, variantCardName } from "./masterNames";
import { matchesFigmaId, matchesStampedId } from "./nodeLookup";
import { placeReady } from "./placeReady";
import { emitIconLibraryWarningsOnce, iconLibraryWarnings } from "./recommendContext";
import { isPrivateMaster, ruleNamesake } from "./recommendLexicon";
import { recommendMasters } from "./recommendMasters";
import type { RecommendContext } from "./recommendSupport";
import { codeMapView, liveReplacement, replacementFor } from "./replacements";
import { screenInventory } from "./screenInventory";
import type { SockState } from "./sock";
import { asResolvedNode, exampleQuery, namedNode, usageCardForComponent } from "./usageCard";
import type { WorkspaceManifest } from "./workspace";
import { nodeFileKey } from "./workspaceMerge";

function pickResolveTarget(
  index: GraphIndex,
  name: string,
  context?: RecommendContext,
  workspace?: WorkspaceManifest,
  bindRules?: BindRulesFile,
): GraphNode | undefined {
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  const graphFileKey = index.graph.fileKey;
  const ruleBonus = bindRules?.rules.length
    ? (node: GraphNode) => preferDelta(bindRules, node, { intent: trimmed, workspace, graphFileKey })
    : undefined;

  const direct = index.getNode(trimmed);
  if (direct) return placeableNode(index, asResolvedNode(index, direct), workspace);
  for (const node of index.allNodes) {
    if (matchesFigmaId(node, trimmed) || matchesStampedId(node, trimmed, index.graph.fileKey)) {
      return placeableNode(index, asResolvedNode(index, node), workspace);
    }
  }

  const caseHits = realMastersNamed(index, trimmed).filter((node) => node.name === trimmed);
  const privateHit = caseHits.find((node) => isPrivateMaster(index, node));
  if (privateHit) return privateHit;
  const view = codeMapView(index);
  const retiredHits = caseHits.filter(
    (node) => (isRetired(index, node) || Boolean(view?.retired(node))) && !isPrivateMaster(index, node),
  );
  if (retiredHits.length) return preferNamedMaster(index, retiredHits, workspace, trimmed, ruleBonus) ?? retiredHits[0];

  const foldedName = trimmed.toLowerCase();
  const frameHit = namedNode(
    index,
    (node) =>
      (node.type === "FRAME" || node.type === "SECTION") && node.name.toLowerCase() === foldedName,
  );
  const namedMasters = realMastersNamed(index, trimmed).filter((node) => !isPrivateMaster(index, node));
  // A same-named frame is a screen only when no component owns the name.
  // Name-inferred masters (mcp-name:) still count; they are what usage cards describe.
  const anyMaster = namedNode(index, (node) => {
    if (!isMasterType(node.type)) return false;
    if (node.name.trim().toLowerCase() === foldedName) return true;
    return variantCardName(index, node).trim().toLowerCase() === foldedName;
  });
  if (frameHit && namedMasters.length === 0 && !anyMaster) return frameHit;

  // Exact name (letter case ignored) wins before fuzzy ranking.
  // "acme-mark" stays that master even when "Acme Mark" would rank higher.
  const liveExact = namedMasters.filter(
    (node) => !isRetired(index, node) && !view?.retired(node),
  );
  if (liveExact.length) {
    const picked = preferNamedMaster(index, liveExact, workspace, trimmed, ruleBonus) ?? liveExact[0]!;
    if (!ruleBonus) return picked;
    const live = index
      .getNodesByType(...MASTER_TYPES)
      .filter(
        (node) =>
          !isNameInferredMaster(node) && !isPrivateMaster(index, node) && !isRetired(index, node) && !view?.retired(node),
      );
    return ruleNamesake(picked, live, ruleBonus);
  }

  const ranked = recommendMasters(index, trimmed, {
    context,
    budgetChars: USAGE_CARD_BUDGET,
    workspace,
  });
  const rankedId = ranked.candidates[0]?.id;
  if (rankedId) {
    const rankedNode = index.getNode(rankedId);
    if (rankedNode && !isPrivateMaster(index, rankedNode)) return rankedNode;
  }

  const reals = realMastersNamed(index, trimmed);
  if (reals.length >= 1) {
    const chosen = preferNamedMaster(index, reals, workspace, trimmed, ruleBonus) ?? reals[0]!;
    const card = variantCardName(index, chosen);
    const exactCase = chosen.name === trimmed || card === trimmed;
    if (!exactCase && isRetired(index, chosen) && !isPrivateMaster(index, chosen)) {
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
      if (isRetired(index, master)) return liveReplacement(index, master) ?? master;
      return master;
    }
  }

  return undefined;
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
    placeholders?: string[];
    bindRules?: BindRulesFile;
  } = {},
) {
  const libraryWarnings = iconLibraryWarnings(index, options.workspace);
  emitIconLibraryWarningsOnce(libraryWarnings);
  const node = pickResolveTarget(index, name, options.context, options.workspace, options.bindRules);
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
  const view = codeMapView(index);
  const twin = view?.twin(node);
  const retired = isRetired(index, node) || Boolean(twin?.retired);
  const replacement = retired ? replacementFor(index, node, view?.twin) : undefined;
  const place = replacement ? placeReady(replacement, index.graph.fileKey) : undefined;
  const clashes = otherNamedMasters(
    index,
    realMastersNamed(index, node.name),
    node,
  ).filter((other) => other.type === node.type || other.type === "COMPONENT_SET" || node.type === "COMPONENT_SET");
  const noteParts = [
    sameNameNote(index, realMastersNamed(index, node.name), node),
    substitutionNote(index, name, node),
  ].filter((part): part is string => Boolean(part));
  const block = propertyBlock(index, node, name, twin?.angular, options.context?.propertyHints);
  const withReplacement = {
    found: true as const,
    kind: "component" as const,
    ...body,
    ...(block ?? {}),
    ...(retired ? { deprecated: true as const } : {}),
    ...(clashes.length
      ? {
          also: clashes.slice(0, 3).map((other) => ({
            id: other.id,
            name: variantCardName(index, other),
            ...(nodeFileKey(other, index.graph.fileKey)
              ? { fileKey: nodeFileKey(other, index.graph.fileKey) }
              : {}),
          })),
        }
      : {}),
    ...(noteParts.length ? { note: noteParts.join(" ") } : {}),
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
  const fitted =
    JSON.stringify(withCost(withReplacement)).length <= budget
      ? withReplacement
      : { ...withReplacement, byScreen: [] as typeof body.byScreen };
  // The code line is for a live part only; a retired part's mapping is read through verify.
  const coded = twin && !retired ? { ...fitted, code: twin.line } : undefined;
  // Selector fields ride with the code line when they fit. A line that does not fit shows (cut) when that marker fits.
  const angular = coded && twin?.angular ? { ...coded, angular: twin.angular } : undefined;
  const fits = (card: object | undefined) => Boolean(card) && JSON.stringify(withCost(card!)).length <= budget;
  if (fits(angular)) return withCost(angular!);
  if (fits(coded)) {
    const marked = twin?.angular ? { ...coded!, angular: "(cut)" } : coded;
    return withCost(fits(marked) ? marked! : coded!);
  }
  if (twin && !retired) {
    const marked = { ...fitted, code: "(cut)" };
    if (fits(marked)) return withCost(marked);
  }
  return withCost(fitted);
}
/** Full config for the real instance behind a pick's `ex` pointer. */
export function exampleCard(
  index: GraphIndex,
  name: string,
  options: {
    sock?: SockState;
    context?: RecommendContext;
    workspace?: WorkspaceManifest;
    placeholders?: string[];
  } = {},
) {
  const node = pickResolveTarget(index, name, options.context, options.workspace);
  const unknown: ExampleReason = "no such component — call recommend";
  if (!node || node.type === "FRAME" || node.type === "SECTION") {
    return withCost({
      found: false as const,
      name,
      exWhy: unknown,
      example: exampleSentence(unknown),
    });
  }
  const lookup = getExample(index, node, exampleQuery(index, options));
  if (!lookup.found) {
    return withCost({
      found: false as const,
      name: variantCardName(index, node),
      id: node.id,
      exWhy: lookup.reason,
      example: exampleSentence(lookup.reason),
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
