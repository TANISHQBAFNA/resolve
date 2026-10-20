import type { GraphIndex } from "./GraphIndex";
import { exactRecipe } from "./recipes";
import type { Recipe } from "./recipes";
import { jobById, jobsInAsk } from "./screenJobs";
import { emptySock, isRemovedByAbsence, screenPatternFor, type SockState, type UsageConfidence } from "./sock";
import { applyProposalDecision, BindRuleError, requirePendingProposal, type BindRulesFile } from "./bindRules";
import type { WorkspaceManifest } from "./workspace";
import { nodeFileKey } from "./workspaceMerge";
import { applyRecipeSlotChange, overlayWithRecipe, proposalTypeOf, type SociDecision } from "./soci";

function refusePending(detail: string): never {
  throw new BindRuleError(`${detail} Left pending.`);
}

function assertCurrentMaster(
  index: GraphIndex | undefined,
  sock: SockState,
  id: string,
  label: string,
): void {
  if (!index) {
    refusePending(`Cannot approve: no graph loaded, so ${label} "${id}" cannot be checked.`);
  }
  const node = index.getNode(id);
  if (!node) {
    refusePending(`Cannot approve: ${label} "${id}" is not in the graph.`);
  }
  if (node.status === "deprecated") {
    refusePending(`Cannot approve: ${label} "${node.name}" (${id}) is deprecated.`);
  }
  if (isRemovedByAbsence(sock, node) || node.metadata?.["removedByAbsence"] === true) {
    refusePending(`Cannot approve: ${label} "${node.name}" (${id}) was removed.`);
  }
}

function ruleDecision(
  sock: SockState,
  rules: BindRulesFile,
  proposalId: string,
  action: "approve" | "reject",
  who: string,
  when: string,
  options: { index?: GraphIndex; workspace?: WorkspaceManifest },
): SociDecision {
  const decided = applyProposalDecision(sock, rules, proposalId, action, who, when, options);
  return { ...decided, writesRules: true, writesRecipes: false };
}

function recordedDecision(
  sock: SockState,
  rules: BindRulesFile,
  proposalId: string,
  action: "approve" | "reject",
  who: string,
  when: string,
  note: string | undefined,
  patch?: {
    writesRecipes: true;
    recipeOverlay: Recipe[];
    /** Absent when approval adds a new recipe. */
    recipeBefore?: Recipe;
    recipeAfter: Recipe;
  },
): SociDecision {
  return {
    sock: markProposal(sock, proposalId, action, note),
    rules,
    audit: {
      who,
      when,
      proposalId,
      action,
      before: rules.rules,
      after: rules.rules,
      ...(patch ? { ...(patch.recipeBefore ? { recipeBefore: patch.recipeBefore } : {}), recipeAfter: patch.recipeAfter } : {}),
    },
    ...(patch ? { recipeOverlay: patch.recipeOverlay } : {}),
    writesRules: false,
    writesRecipes: Boolean(patch),
  };
}

function markProposal(
  sock: SockState,
  proposalId: string,
  action: "approve" | "reject",
  note?: string,
): SockState {
  return {
    ...sock,
    proposals: sock.proposals.map((row) =>
      row.id === proposalId
        ? {
            ...row,
            status: action === "approve" ? "approved" : "rejected",
            ...(note ? { decisionNote: note } : {}),
          }
        : row,
    ),
  };
}

export function applySociDecision(
  sock: SockState, rules: BindRulesFile, proposalId: string,
  action: "approve" | "reject", who: string, when: string,
  options: {
    index?: GraphIndex; workspace?: WorkspaceManifest; recipes?: Recipe[]; overlay?: Recipe[]; note?: string;
  } = {},
): SociDecision {
  const proposal = requirePendingProposal(sock, proposalId);
  const type = proposalTypeOf(proposal);
  const note = options.note?.trim();
  const ruled = () => ruleDecision(sock, rules, proposalId, action, who, when, options);

  switch (type) {
    case "require-rule":
      return ruled();
    case "wrong-cousin": {
      if (action === "approve" && proposal.suggestedRule?.prefer && proposal.suggestedRule.over) {
        const rule = proposal.suggestedRule;
        if (rule.masterId) assertCurrentMaster(options.index, sock, rule.masterId, "preferred master");
        if (rule.overMasterId) assertCurrentMaster(options.index, sock, rule.overMasterId, "cousin");
        return ruled();
      }
      return recordedDecision(sock, rules, proposalId, action, who, when, note ?? proposal.namingFix);
    }
    case "recipe-update": {
      if (action === "reject") {
        return recordedDecision(sock, rules, proposalId, action, who, when, note);
      }
      const added = proposal.suggestedNewRecipe;
      if (added) {
        // A composed recipe: every stored id must still be a live master, and it never replaces a recipe.
        for (const slot of added.slots) {
          if (slot.defaultMasterId) assertCurrentMaster(options.index, sock, slot.defaultMasterId, "recipe master");
        }
        if ((options.recipes ?? []).some((recipe) => recipe.id === added.id)) {
          throw new BindRuleError(`Recipe "${added.id}" already exists. A composed recipe never replaces one.`);
        }
        return recordedDecision(sock, rules, proposalId, action, who, when, note, {
          writesRecipes: true,
          recipeOverlay: overlayWithRecipe(options.overlay ?? [], added),
          recipeAfter: added,
        });
      }
      const change = proposal.suggestedRecipe;
      if (!change) {
        throw new BindRuleError(`Proposal "${proposalId}" has no recipe change. Write recipes.json by hand.`);
      }
      assertCurrentMaster(options.index, sock, change.masterId, "recipe master");
      const recipes = options.recipes ?? [];
      const current = recipes.find((recipe) => recipe.id === change.recipeId);
      if (!current) {
        throw new BindRuleError(
          `Proposal "${proposalId}" recipe "${change.recipeId}" is not in the pack. Never inventing a recipe.`,
        );
      }
      const updated = applyRecipeSlotChange(current, change);
      return recordedDecision(sock, rules, proposalId, action, who, when, note, {
        writesRecipes: true,
        recipeOverlay: overlayWithRecipe(options.overlay ?? [], updated),
        recipeBefore: current,
        recipeAfter: updated,
      });
    }
    case "variant-candidate":
    case "deprecation-candidate": {
      if (action === "approve" && type === "variant-candidate" && proposal.suggestedVariant?.masterId) {
        assertCurrentMaster(options.index, sock, proposal.suggestedVariant.masterId, "variant master");
      }
      if (action === "approve" && type === "deprecation-candidate" && proposal.suggestedDeprecation?.cousinId) {
        assertCurrentMaster(options.index, sock, proposal.suggestedDeprecation.cousinId, "cousin");
      }
      const fallback =
        type === "variant-candidate"
          ? proposal.suggestedVariant?.note ?? "Recorded for the design team. Figma masters were not edited."
          : "Recorded for the design team. Figma masters were not edited.";
      return recordedDecision(sock, rules, proposalId, action, who, when, note ?? fallback);
    }
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}



export interface ScreenApproach {
  job: string;
  meaning: string;
  confidence: UsageConfidence;
  mappedScreens: number;
  masters: Array<{ id: string; name: string; fileKey?: string; figmaNodeId?: string; ex?: string; screens: number }>;
}

/** Example pointer for a fact's instance: its Figma node id, or fileKey:nodeId when it is in another file. */
function exPointer(index: GraphIndex | undefined, exampleNodeId: string | undefined, fileKey?: string): string | undefined {
  if (!index || !exampleNodeId) return undefined;
  const node = index.getNode(exampleNodeId);
  if (!node?.figmaNodeId) return undefined;
  const where = nodeFileKey(node, index.graph.fileKey);
  return where && fileKey && where !== fileKey ? `${where}:${node.figmaNodeId}` : node.figmaNodeId;
}

/**
 * How mapped screens of one job are built: a SOCK read. Never writes recipes.json, never waits for approve.
 * No mapped screen of the job: no masters, nothing invented.
 */
export function approachFor(state: SockState, job: string, index?: GraphIndex): ScreenApproach {
  const pattern = screenPatternFor(state, job);
  return {
    job,
    meaning: jobById(job)?.meaning ?? "",
    confidence: pattern.confidence,
    mappedScreens: pattern.screens,
    masters: pattern.masters.map((row) => {
      const ex = exPointer(index, row.exampleNodeId, row.fileKey);
      return {
        id: row.masterId,
        name: row.name,
        ...(row.fileKey ? { fileKey: row.fileKey } : {}),
        ...(row.figmaNodeId ? { figmaNodeId: row.figmaNodeId } : {}),
        ...(ex ? { ex } : {}),
        screens: row.screens,
      };
    }),
  };
}

/**
 * recommend / recipe on a screen ask ("inquiry screen", "approval summary"): answered from mapped screens in SOCK.
 * Undefined when the ask is not only job words, or when it names two or more jobs and is exactly a recipe
 * id, title or alias ("checkout summary"), so that recipe and component ranking answer as before.
 */
export function screenAskCard(intent: string, options: { sock?: SockState; index?: GraphIndex; recipes?: Recipe[] } = {}) {
  const jobs = jobsInAsk(intent);
  if (!jobs) return undefined;
  if (jobs.length > 1 && options.recipes && exactRecipe(options.recipes, intent)) return undefined;
  const state = options.sock ?? emptySock();
  const approaches = jobs
    .map((job) => approachFor(state, job, options.index))
    .sort((a, b) => b.mappedScreens - a.mappedScreens);
  const missing = approaches.filter((row) => !row.masters.length).map((row) => row.job);
  const hint = missing.length === approaches.length
    ? `No mapped ${missing.join(" or ")} screen yet. Nothing is invented. After verify_frame on a real frame whose name or journey says ${missing.join(" or ")}, this answers from it.`
    : `From mapped screens, most used first. Place fileKey+figmaNodeId in this order.${missing.length ? ` No mapped ${missing.join(" or ")} screen yet.` : ""}`;
  return { intent, approaches, hint };
}
