import type { GraphNode } from "@/core/model";
import type { GraphIndex } from "./GraphIndex";
import {
  ingredientCard,
  isNameInferredMaster,
  resolveNode,
  resolveNodeExact,
  retiredHooks,
  variantCardName,
  verifyFrame,
} from "./agentSurface";
import type { BindRulesFile } from "./bindRules";
import type { ContextPack } from "./contextPacks";
import { buildHandoff, SCREEN_TYPES, type HandoffDecisionInput, type HandoffHooks, type HandoffPack, type VerifyLike } from "./handoff";
import { realByKey } from "./ingredients";
import { missingNodeSentence, readFigmaLink } from "./learnedLink";
import { fillRecipe, matchRecipe, type Recipe } from "./recipes";
import type { SockState } from "./sock";
import type { WorkspaceManifest } from "./workspace";

export interface HandoffInput {
  draft?: boolean;
  recipe?: string;
  recipes?: Recipe[];
  context?: ContextPack;
  bindRules?: BindRulesFile;
  sock?: SockState;
  workspace?: WorkspaceManifest;
  placeholders?: string[];
  rules?: { allow?: string[]; deny?: string[] };
  decisions?: HandoffDecisionInput[];
  depth?: number;
  maxCharsPerCard?: number;
}

const DEF_OR_COPY = new Set(["COMPONENT_INSTANCE", "MAIN_COMPONENT", "VARIANT", "COMPONENT_SET"]);
/** A frame, or a copy placed as a whole screen (e.g. one page-shell copy shared as the screen): not inside another copy or a component. */
function screenLike(index: GraphIndex, node: GraphNode): boolean {
  if (SCREEN_TYPES.has(node.type)) return true;
  return node.type === "COMPONENT_INSTANCE" && !index.getAncestors(node.id).some((a) => DEF_OR_COPY.has(a.type));
}

/** A screen frame by graph id, Figma id, `fileKey:id`, or exact name (frames first), else the closest frame by search. */
function findFrame(index: GraphIndex, ask: string): { node?: GraphNode; others?: number; notScreen?: GraphNode; fuzzy?: boolean; message?: string } {
  const want = ask.trim();
  if (!want) return {};
  const link = readFigmaLink(index, want);
  if (link && !link.ok) return { message: link.message };
  if (link?.ok && !resolveNodeExact(index, want)) return { message: missingNodeSentence(link.fileKey, link.nodeIds[0] ?? "") };
  const exact = resolveNodeExact(index, want);
  const byId = exact && (/figma\.com\//i.test(want) || exact.id === want || exact.figmaNodeId === want || want.endsWith(exact.figmaNodeId ?? "\u0000"));
  if (exact && byId) return screenLike(index, exact) ? { node: exact } : { notScreen: exact };
  const named = index
    .getNodesByType("FRAME", "SECTION")
    .filter((n) => n.name.trim().toLowerCase() === want.toLowerCase());
  if (named.length) {
    const screens = named.filter((n) => ["PAGE", "SECTION", "FILE"].includes(index.getParent(n.id)?.type ?? ""));
    const pick = (screens.length ? screens : named)[0]!;
    return { node: pick, ...(named.length > 1 ? { others: named.length - 1 } : {}) };
  }
  if (exact) return SCREEN_TYPES.has(exact.type) ? { node: exact } : { notScreen: exact };
  const near = resolveNode(index, want);
  const fuzzy = Boolean(near) && near!.name.trim().toLowerCase() !== want.toLowerCase();
  return near && SCREEN_TYPES.has(near.type) ? { node: near, ...(fuzzy ? { fuzzy } : {}) } : near ? { notScreen: near } : {};
}

/** The handoff sheet for one or more screens. See handoff.ts for the gates and the shape. */
export function handoffSheet(index: GraphIndex, frames: string[], input: HandoffInput = {}): HandoffPack {
  const r = retiredHooks(index);
  const hooks: HandoffHooks = {
    real: realByKey(index),
    retired: r.retired,
    nameGuess: (node) => isNameInferredMaster(node),
    twin: (node) => r.view?.twin(node),
    codeMap: Boolean(r.view),
    replacement: r.replacement,
    cardName: (node) => variantCardName(index, node),
    ingredient: (ask, depth, maxChars) => {
      const card = ingredientCard(index, ask, { depth, ...(maxChars ? { maxChars } : {}) });
      return card.found
        ? {
            found: true,
            parts: card.parts,
            instance: "instance" in card ? (card.instance as { partsFrom?: string }) : undefined,
            summary: card.summary,
            ...("cut" in card && card.cut ? { cut: card.cut as { reason: string } } : {}),
          }
        : { found: false };
    },
    verify: (frameId, components) =>
      verifyFrame(index, {
        ...(components ? { components } : { frame: frameId }),
        ...(input.rules ? { rules: input.rules } : {}),
        ...(input.context ? { context: input.context } : {}),
        ...(input.bindRules ? { bindRules: input.bindRules } : {}),
        ...(input.sock ? { sock: input.sock } : {}),
        ...(input.workspace ? { workspace: input.workspace } : {}),
        ...(input.placeholders ? { placeholders: input.placeholders } : {}),
      }) as unknown as VerifyLike,
    frame: (ask) => findFrame(index, ask),
    fillRecipe: (recipe) => fillRecipe(index, recipe, undefined, input.context, input.workspace, input.sock, input.bindRules, input.placeholders),
  };
  return buildHandoff(index, frames, hooks, {
    draft: input.draft,
    recipe: input.recipe,
    recipes: input.recipes,
    matchRecipe,
    context: input.context,
    decisions: input.decisions,
    depth: input.depth,
    maxCharsPerCard: input.maxCharsPerCard,
  });
}
