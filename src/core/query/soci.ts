import { COMPONENT_DEFINITION_TYPES, type GraphNode } from "@/core/model";
import type { GraphIndex } from "./GraphIndex";
import type { Recipe } from "./recipes";
import { exactRecipe, matchRecipe } from "./recipes";
import { jobById, jobsInAsk } from "./screenJobs";
import {
  emptySock,
  inferSlot,
  isRemovedByAbsence,
  screenPatternFor,
  patternsOf,
  proposeStrongPatterns,
  scopeFromUsageFacts,
  type CousinCorrection,
  type SociEvidenceItem,
  type SociProposal,
  type SociProposalType,
  type SociScope,
  type SociSuggestedDeprecation,
  type SociSuggestedRecipe,
  type SociSuggestedVariant,
  type SockState,
  type UsageConfidence,
  type UsageFact,
  type UsagePattern,
} from "./sock";
import {
  applyProposalDecision,
  BindRuleError,
  type AuditLine,
  type BindRulesFile,
} from "./bindRules";
import type { WorkspaceManifest } from "./workspace";
import { designerPlacedInstances } from "./placed";
import { nodeFileKey } from "./workspaceMerge";

/**
 * SOCI — loop engineer. Turns verified-frame usage into human-approved
 * proposals. Never auto-applies. Never invents node ids.
 */

export const SOCI_PROPOSAL_TYPES = [
  "require-rule",
  "recipe-update",
  "variant-candidate",
  "deprecation-candidate",
  "wrong-cousin",
] as const satisfies readonly SociProposalType[];

export const SOCI_TYPE_LABELS: Record<SociProposalType, string> = {
  "require-rule": "Require rules",
  "recipe-update": "Recipe updates",
  "variant-candidate": "Variant candidates",
  "deprecation-candidate": "Deprecation candidates",
  "wrong-cousin": "Wrong-cousin hotspots",
};

export const DEFAULT_SOCI_CAP = 12;
export const SOCI_EVIDENCE_CAP = 8;
export const SOCI_CORRECTION_CAP = 200;

const GENERIC_NAME_TOKENS = new Set([
  "button",
  "btn",
  "cta",
  "input",
  "field",
  "card",
  "row",
  "icon",
  "avatar",
  "banner",
  "text",
  "label",
  "header",
  "title",
  "primary",
  "secondary",
  "tertiary",
]);

const MASTER_TYPES = new Set<string>(COMPONENT_DEFINITION_TYPES);

export interface SociDraft {
  type: SociProposalType;
  fingerprint: string;
  scope?: SociScope;
  summary: string;
  evidence: SociEvidenceItem[];
  confidence: "low" | "strong";
  suggestedRule?: SociProposal["suggestedRule"];
  suggestedRecipe?: SociSuggestedRecipe;
  suggestedVariant?: SociSuggestedVariant;
  suggestedDeprecation?: SociSuggestedDeprecation;
  namingFix?: string;
}

function tokensOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 1);
}

function nameOverlap(a: string, b: string): { shared: string[]; specific: string[] } {
  const left = new Set(tokensOf(a));
  const right = new Set(tokensOf(b));
  const shared = [...left].filter((token) => right.has(token));
  return { shared, specific: shared.filter((token) => !GENERIC_NAME_TOKENS.has(token)) };
}

function uniqueKey(value: string): string {
  return value.trim().toLowerCase();
}

export function proposalTypeOf(proposal: SociProposal): SociProposalType {
  if (proposal.type && (SOCI_PROPOSAL_TYPES as readonly string[]).includes(proposal.type)) {
    return proposal.type;
  }
  return "require-rule";
}

export function asEvidenceList(evidence: SociProposal["evidence"] | undefined): SociEvidenceItem[] {
  if (Array.isArray(evidence)) {
    return evidence.filter((item) => item && typeof item === "object");
  }
  if (typeof evidence === "string" && evidence.trim()) {
    return [{ note: evidence.trim() }];
  }
  return [];
}

export function normalizeProposal(raw: SociProposal): SociProposal {
  const type = proposalTypeOf(raw);
  const evidence = asEvidenceList(raw.evidence).slice(0, SOCI_EVIDENCE_CAP);
  return {
    ...raw,
    type,
    kind: type === "require-rule" ? "rule" : raw.kind,
    evidence,
    confidence: raw.confidence === "strong" || raw.confidence === "low" ? raw.confidence : "low",
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt ?? raw.createdAt,
    status: raw.status,
    summary: raw.summary,
  };
}

export function pendingImprovementCount(sock?: SockState): number {
  if (!sock) return 0;
  return sock.proposals.filter((row) => row.status === "pending").length;
}

export function withPendingImprovements<T extends object>(payload: T, sock?: SockState): T {
  const n = pendingImprovementCount(sock);
  if (!n) return payload;
  return { ...payload, pendingImprovements: n };
}

function sanitizeFingerprint(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 96) || "item"
  );
}

export function proposalIdFor(type: SociProposalType, fingerprint: string): string {
  return `soci:${type}:${sanitizeFingerprint(fingerprint)}`;
}

function countedFacts(state: SockState): UsageFact[] {
  return state.facts.filter((fact) => fact.countsTowardThreshold !== false);
}

function evidenceFromFacts(facts: UsageFact[], note?: string): SociEvidenceItem[] {
  const byScreen = new Map<string, SociEvidenceItem>();
  for (const fact of facts) {
    const key = fact.screenId;
    const existing = byScreen.get(key);
    if (existing) {
      existing.count = (existing.count ?? 1) + 1;
      continue;
    }
    byScreen.set(key, {
      frameId: fact.frameId ?? fact.screenId,
      screenId: fact.screenId,
      screenName: fact.screenName,
      ...(fact.fileKey ? { fileKey: fact.fileKey } : {}),
      count: 1,
      ...(note ? { note } : {}),
    });
  }
  return [...byScreen.values()].slice(0, SOCI_EVIDENCE_CAP);
}

function mergeEvidence(left: SociEvidenceItem[], right: SociEvidenceItem[]): SociEvidenceItem[] {
  const byKey = new Map<string, SociEvidenceItem>();
  for (const item of [...left, ...right]) {
    const key = uniqueKey(item.screenId || item.frameId || item.note || JSON.stringify(item));
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...item, count: item.count ?? 1 });
      continue;
    }
    existing.count = (existing.count ?? 1) + (item.count ?? 0);
    if (!existing.frameId && item.frameId) existing.frameId = item.frameId;
    if (!existing.fileKey && item.fileKey) existing.fileKey = item.fileKey;
    if (!existing.screenName && item.screenName) existing.screenName = item.screenName;
    if (!existing.note && item.note) existing.note = item.note;
  }
  return [...byKey.values()]
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
    .slice(0, SOCI_EVIDENCE_CAP);
}

function upsertDraft(state: SockState, draft: SociDraft, now: string): SockState {
  const id = proposalIdFor(draft.type, draft.fingerprint);
  const existing = state.proposals.find((row) => row.id === id);
  if (existing && existing.status !== "pending") return state;
  if (existing) {
    const merged = mergeEvidence(asEvidenceList(existing.evidence), draft.evidence);
    const next: SociProposal = {
      ...existing,
      type: draft.type,
      kind: draft.type === "require-rule" ? "rule" : existing.kind,
      scope: draft.scope ?? existing.scope,
      summary: draft.summary,
      evidence: merged,
      confidence: draft.confidence,
      updatedAt: now,
      ...(draft.suggestedRule ? { suggestedRule: draft.suggestedRule } : {}),
      ...(draft.suggestedRecipe ? { suggestedRecipe: draft.suggestedRecipe } : {}),
      ...(draft.suggestedVariant ? { suggestedVariant: draft.suggestedVariant } : {}),
      ...(draft.suggestedDeprecation ? { suggestedDeprecation: draft.suggestedDeprecation } : {}),
      ...(draft.namingFix ? { namingFix: draft.namingFix } : {}),
    };
    return {
      ...state,
      proposals: state.proposals.map((row) => (row.id === id ? next : row)),
    };
  }
  const created: SociProposal = {
    id,
    createdAt: now,
    updatedAt: now,
    type: draft.type,
    kind: draft.type === "require-rule" ? "rule" : undefined,
    status: "pending",
    summary: draft.summary,
    evidence: draft.evidence.slice(0, SOCI_EVIDENCE_CAP),
    confidence: draft.confidence,
    ...(draft.scope ? { scope: draft.scope } : {}),
    ...(draft.suggestedRule ? { suggestedRule: draft.suggestedRule } : {}),
    ...(draft.suggestedRecipe ? { suggestedRecipe: draft.suggestedRecipe } : {}),
    ...(draft.suggestedVariant ? { suggestedVariant: draft.suggestedVariant } : {}),
    ...(draft.suggestedDeprecation ? { suggestedDeprecation: draft.suggestedDeprecation } : {}),
    ...(draft.namingFix ? { namingFix: draft.namingFix } : {}),
  };
  return { ...state, proposals: [...state.proposals, created] };
}

const TYPE_RANK: Record<SociProposalType, number> = {
  "wrong-cousin": 0,
  "recipe-update": 1,
  "require-rule": 2,
  "deprecation-candidate": 3,
  "variant-candidate": 4,
};

function evidenceScreens(proposal: SociProposal): number {
  const items = asEvidenceList(proposal.evidence);
  const screens = new Set(
    items.map((item) => item.screenId || item.frameId || item.note).filter((value): value is string => Boolean(value)),
  );
  return screens.size || items.length;
}

export function capSociProposals(state: SockState, cap = DEFAULT_SOCI_CAP): SockState {
  const pending = state.proposals.filter((row) => row.status === "pending");
  const settled = state.proposals.filter((row) => row.status !== "pending");
  if (pending.length <= cap) return state;
  const ranked = pending.slice().sort((a, b) => {
    const conf = (b.confidence === "strong" ? 1 : 0) - (a.confidence === "strong" ? 1 : 0);
    if (conf) return conf;
    const screens = evidenceScreens(b) - evidenceScreens(a);
    if (screens) return screens;
    return TYPE_RANK[proposalTypeOf(a)] - TYPE_RANK[proposalTypeOf(b)] || a.id.localeCompare(b.id);
  });
  return { ...state, proposals: [...settled, ...ranked.slice(0, cap)] };
}

function recipeForScreen(recipes: Recipe[], fact: UsageFact): Recipe | undefined {
  if (fact.pack) {
    const byPack = recipes.find((recipe) => recipe.contextPackId === fact.pack);
    if (byPack) return byPack;
  }
  if (fact.journey) {
    const byJourney = matchRecipe(recipes, fact.journey);
    if (byJourney) return byJourney;
  }
  return matchRecipe(recipes, fact.screenName);
}

function recipeAlreadyHasMaster(recipe: Recipe, masterId: string, masterName: string, slotRole?: string): boolean {
  return recipe.slots.some((slot) => {
    if (slotRole && slot.role.toLowerCase() !== slotRole.toLowerCase()) return false;
    return slot.defaultMasterId === masterId || slot.defaultMasterId === masterName;
  });
}

interface RecipeSlotCandidate {
  recipe: Recipe;
  slotRole: string;
  masterId: string;
  masterName: string;
  facts: UsageFact[];
}

/**
 * One proposal per recipe + slot: the master on the most distinct screens.
 * A tie emits nothing. `closedSlots` maps `recipeId::slot` to the winning
 * fingerprint, or null when the slot should keep no pending proposal.
 */
function detectRecipeUpdates(
  state: SockState,
  recipes: Recipe[],
): { drafts: SociDraft[]; closedSlots: Map<string, string | null> } {
  const drafts: SociDraft[] = [];
  const closedSlots = new Map<string, string | null>();
  if (!recipes.length) return { drafts, closedSlots };
  const counted = countedFacts(state);
  const byMaster = new Map<string, RecipeSlotCandidate>();
  for (const fact of counted) {
    if (!fact.promoted || fact.deprecated || fact.private) continue;
    const recipe = recipeForScreen(recipes, fact);
    if (!recipe) continue;
    const slotRole = fact.slot ?? inferSlot(fact.name) ?? inferSlot(recipe.title);
    if (!slotRole) continue;
    const key = `${recipe.id}::${slotRole.toLowerCase()}::${fact.masterId}`;
    const row = byMaster.get(key);
    if (row) {
      if (!row.facts.some((item) => item.screenId === fact.screenId)) row.facts.push(fact);
    } else {
      byMaster.set(key, {
        recipe,
        slotRole,
        masterId: fact.masterId,
        masterName: fact.name,
        facts: [fact],
      });
    }
  }
  const bySlot = new Map<string, RecipeSlotCandidate[]>();
  for (const row of byMaster.values()) {
    const slotKey = `${row.recipe.id}::${row.slotRole.toLowerCase()}`;
    const list = bySlot.get(slotKey);
    if (list) list.push(row);
    else bySlot.set(slotKey, [row]);
  }
  for (const [slotKey, rows] of bySlot) {
    const ranked = [...rows].sort((a, b) => {
      const screens = new Set(b.facts.map((fact) => fact.screenId)).size - new Set(a.facts.map((fact) => fact.screenId)).size;
      return screens || a.masterId.localeCompare(b.masterId);
    });
    const winner = ranked[0];
    if (!winner) continue;
    const winnerScreens = new Set(winner.facts.map((fact) => fact.screenId)).size;
    const runnerUp = ranked[1];
    const runnerScreens = runnerUp ? new Set(runnerUp.facts.map((fact) => fact.screenId)).size : -1;
    if (runnerScreens === winnerScreens || winnerScreens < state.threshold) {
      closedSlots.set(slotKey, null);
      continue;
    }
    if (recipeAlreadyHasMaster(winner.recipe, winner.masterId, winner.masterName, winner.slotRole)) {
      closedSlots.set(slotKey, null);
      continue;
    }
    const fingerprint = `${winner.recipe.id}:${winner.slotRole}:${winner.masterId}`;
    closedSlots.set(slotKey, fingerprint);
    const existingSlot = winner.recipe.slots.find((slot) => slot.role.toLowerCase() === winner.slotRole.toLowerCase());
    const action: "add-slot" | "rebind" = existingSlot ? "rebind" : "add-slot";
    const summary =
      action === "rebind"
        ? `${winner.recipe.title}: set ${winner.slotRole} to ${winner.masterName} (strong on ${winnerScreens} screens)`
        : `${winner.recipe.title} screens use ${winner.masterName} in ${winner.slotRole}; recipe has no matching slot`;
    drafts.push({
      type: "recipe-update",
      fingerprint,
      scope: {
        recipeId: winner.recipe.id,
        slot: winner.slotRole,
        screenType: winner.recipe.title,
        masterId: winner.masterId,
      },
      summary,
      evidence: evidenceFromFacts(winner.facts),
      confidence: "strong",
      suggestedRecipe: {
        recipeId: winner.recipe.id,
        slotRole: winner.slotRole,
        action,
        masterId: winner.masterId,
        masterName: winner.masterName,
        hints: existingSlot?.hints ?? [winner.slotRole, ...tokensOf(winner.masterName).slice(0, 3)],
        required: existingSlot?.required ?? false,
      },
    });
  }
  return { drafts, closedSlots };
}

/** Masters the designer placed on the frame, including instances sitting in a component slot. Hidden instances and a component's own parts are not included. */
export function topLevelMasterIds(index: GraphIndex, frameId: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const instance of designerPlacedInstances(index, frameId)) {
    const main = index.getMainComponent(instance.id);
    if (!main || seen.has(main.id)) continue;
    seen.add(main.id);
    ids.push(main.id);
  }
  return ids;
}

function instanceNodesUnder(index: GraphIndex, rootId: string): GraphNode[] {
  const out: GraphNode[] = [];
  const stack = [...index.getChildren(rootId)];
  const seen = new Set<string>();
  while (stack.length) {
    const node = stack.pop();
    if (!node || seen.has(node.id)) continue;
    seen.add(node.id);
    if (node.type === "COMPONENT_INSTANCE") out.push(node);
    stack.push(...index.getChildren(node.id));
  }
  return out;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

/**
 * Override / extra-nested signals from REST (`overrides`, `componentProperties`
 * with a defaultValue to compare) or the ingested instance tree.
 *
 * Gaps (skipped, never guessed):
 * - Figma MCP `get_metadata` XML has no override / componentProperty payload.
 * - Plugin-only `detachedInfo` is not on REST InstanceNode or MCP metadata, so
 *   detach-from-master proposals are not emitted.
 */
export function overrideKeysOnInstance(index: GraphIndex, instance: GraphNode): string[] {
  const keys: string[] = [];
  const overrides = instance.metadata?.["overrides"];
  if (Array.isArray(overrides)) {
    for (const row of overrides) {
      if (!row || typeof row !== "object") continue;
      const fields = stringList((row as { overriddenFields?: unknown }).overriddenFields);
      for (const field of fields) keys.push(`field:${field}`);
    }
  }
  const props = instance.metadata?.["componentProperties"];
  if (props && typeof props === "object" && !Array.isArray(props)) {
    for (const [name, raw] of Object.entries(props as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const rec = raw as Record<string, unknown>;
      if (!("value" in rec) || !("defaultValue" in rec)) continue;
      if (rec["value"] === rec["defaultValue"]) continue;
      keys.push(`prop:${name}=${String(rec["value"])}`);
    }
  }
  const master = index.getMainComponent(instance.id);
  if (master) {
    const nestedInMaster = new Set(
      index
        .getNestedInstances(master.id)
        .map((node) => index.getMainComponent(node.id)?.id)
        .filter((id): id is string => Boolean(id)),
    );
    nestedInMaster.add(master.id);
    for (const nested of instanceNodesUnder(index, instance.id)) {
      const nestedMain = index.getMainComponent(nested.id);
      if (!nestedMain || nestedInMaster.has(nestedMain.id)) continue;
      keys.push(`nested:${nestedMain.name}`);
    }
  }
  return [...new Set(keys)];
}

export function harvestOverrideKeysForFrame(index: GraphIndex, frameId: string): Map<string, string[]> {
  const byMaster = new Map<string, string[]>();
  for (const instance of index.getNestedInstances(frameId)) {
    const master = index.getMainComponent(instance.id);
    if (!master) continue;
    const keys = overrideKeysOnInstance(index, instance);
    if (!keys.length) continue;
    const existing = byMaster.get(master.id) ?? [];
    byMaster.set(master.id, [...new Set([...existing, ...keys])]);
  }
  return byMaster;
}

function detectVariantCandidates(state: SockState): SociDraft[] {
  const counted = countedFacts(state);
  const byKey = new Map<string, { masterId: string; masterName: string; overrideKey: string; facts: UsageFact[] }>();
  for (const fact of counted) {
    for (const overrideKey of fact.overrideKeys ?? []) {
      const mapKey = `${fact.masterId}::${overrideKey}`;
      const row = byKey.get(mapKey);
      if (row) {
        if (!row.facts.some((item) => item.screenId === fact.screenId)) row.facts.push(fact);
      } else {
        byKey.set(mapKey, {
          masterId: fact.masterId,
          masterName: fact.name,
          overrideKey,
          facts: [fact],
        });
      }
    }
  }
  const drafts: SociDraft[] = [];
  for (const row of byKey.values()) {
    const screens = new Set(row.facts.map((fact) => fact.screenId));
    if (screens.size < state.threshold) continue;
    const nested = row.overrideKey.startsWith("nested:")
      ? row.overrideKey.slice("nested:".length)
      : row.overrideKey.replace(/^(field|prop):/, "");
    drafts.push({
      type: "variant-candidate",
      fingerprint: `${row.masterId}:${row.overrideKey}`,
      scope: { masterId: row.masterId },
      summary: `Consider an official variant of ${row.masterName} for ${nested} (${screens.size} verified screens)`,
      evidence: evidenceFromFacts(row.facts, row.overrideKey),
      confidence: "strong",
      suggestedVariant: {
        masterId: row.masterId,
        masterName: row.masterName,
        overrideKey: row.overrideKey,
        note: "Proposal only. Resolve never edits Figma masters or variants.",
      },
    });
  }
  return drafts;
}

function detectDeprecations(state: SockState, index?: GraphIndex): SociDraft[] {
  if (!index) return [];
  const patterns = patternsOf(state);
  const strong = patterns.filter((row) => row.confidence === "strong" && row.promoted);
  if (!strong.length) return [];
  const used = new Set(countedFacts(state).map((fact) => fact.masterId));
  const drafts: SociDraft[] = [];
  for (const node of index.getNodesByType(...COMPONENT_DEFINITION_TYPES)) {
    if (!MASTER_TYPES.has(node.type)) continue;
    if (used.has(node.id)) continue;
    if (node.status === "deprecated") continue;
    if (node.name.startsWith(".") || node.name.startsWith("_")) continue;
    let best: { pattern: UsagePattern; specific: number } | undefined;
    for (const pattern of strong) {
      if (pattern.masterId === node.id) continue;
      const cousin = index.getNode(pattern.masterId);
      if (!cousin) continue;
      if (node.componentSetId && node.componentSetId === cousin.componentSetId) continue;
      const overlap = nameOverlap(
        `${node.name} ${node.componentSetId ?? ""}`,
        `${cousin.name} ${cousin.componentSetId ?? ""}`,
      );
      if (overlap.specific.length === 0) continue;
      const score = overlap.specific.length;
      if (!best || score > best.specific) best = { pattern, specific: score };
    }
    if (!best) continue;
    const cousinNode = index.getNode(best.pattern.masterId);
    const cousinFacts = countedFacts(state).filter((fact) => fact.masterId === best.pattern.masterId);
    drafts.push({
      type: "deprecation-candidate",
      fingerprint: `${node.id}:${best.pattern.masterId}`,
      scope: { masterId: node.id },
      summary: `Review deprecating ${node.name} — zero verified usage while cousin ${best.pattern.name} is strong on ${best.pattern.screens.length} screens`,
      evidence: evidenceFromFacts(cousinFacts, `unused:${node.id}`),
      confidence: "strong",
      suggestedDeprecation: {
        masterId: node.id,
        masterName: node.name,
        cousinId: best.pattern.masterId,
        cousinName: cousinNode?.name ?? best.pattern.name,
      },
    });
  }
  return drafts;
}

function detectWrongCousins(state: SockState, workspace?: WorkspaceManifest): SociDraft[] {
  const byPair = new Map<
    string,
    {
      fromId: string;
      fromName: string;
      fromFileKey?: string;
      toId: string;
      toName: string;
      toFileKey?: string;
      rows: CousinCorrection[];
    }
  >();
  for (const row of state.corrections ?? []) {
    const key = `${row.fromId}::${row.toId}`;
    const existing = byPair.get(key);
    if (existing) {
      if (!existing.rows.some((item) => item.screenId === row.screenId)) existing.rows.push(row);
    } else {
      byPair.set(key, {
        fromId: row.fromId,
        fromName: row.fromName,
        fromFileKey: row.fromFileKey,
        toId: row.toId,
        toName: row.toName,
        toFileKey: row.toFileKey,
        rows: [row],
      });
    }
  }
  const drafts: SociDraft[] = [];
  for (const pair of byPair.values()) {
    const screens = new Set(pair.rows.map((row) => row.screenId));
    if (screens.size < state.threshold) continue;
    const evidence: SociEvidenceItem[] = pair.rows.slice(0, SOCI_EVIDENCE_CAP).map((row) => ({
      frameId: row.frameId ?? row.screenId,
      screenId: row.screenId,
      screenName: row.screenName,
      ...(row.fileKey ? { fileKey: row.fileKey } : {}),
      count: 1,
      note: `${pair.fromName} → ${pair.toName}`,
    }));
    const differentFiles = Boolean(
      pair.fromFileKey && pair.toFileKey && pair.fromFileKey.toLowerCase() !== pair.toFileKey.toLowerCase(),
    );
    const preferFile = differentFiles
      ? workspace?.files.find((file) => file.key.toLowerCase() === pair.toFileKey!.toLowerCase())
      : undefined;
    const overFile = differentFiles
      ? workspace?.files.find((file) => file.key.toLowerCase() === pair.fromFileKey!.toLowerCase())
      : undefined;
    const scope = scopeFromUsageFacts(
      pair.rows.map((row) => ({
        masterId: pair.toId,
        name: pair.toName,
        screenId: row.screenId,
        screenName: row.screenName,
        promoted: true,
        countsTowardThreshold: true,
        verifiedAt: row.verifiedAt,
      })),
    );
    const scopeBits = [scope.screenType, scope.slot].filter((part): part is string => Boolean(part));
    const writesRule = Boolean(scopeBits.length && preferFile && overFile);
    const scopeLabel = scopeBits.join("/");
    drafts.push({
      type: "wrong-cousin",
      fingerprint: `${pair.fromId}:${pair.toId}`,
      scope: {
        masterId: pair.toId,
        ...(scope.screenType ? { screenType: scope.screenType } : {}),
        ...(scope.slot ? { slot: scope.slot } : {}),
      },
      summary: writesRule
        ? `Prefer ${pair.toName} over ${pair.fromName} for ${scopeLabel} (corrected on ${screens.size} screens)`
        : `Naming fix: agents keep placing ${pair.fromName} where ${pair.toName} is expected (${screens.size} screens)`,
      evidence,
      confidence: "strong",
      ...(writesRule
        ? {
            suggestedRule: {
              prefer: preferFile!.label || preferFile!.key,
              over: overFile!.label || overFile!.key,
              masterId: pair.toId,
              overMasterId: pair.fromId,
              ...(scope.screenType ? { screenType: scope.screenType } : {}),
              ...(scope.slot ? { slot: scope.slot } : {}),
            },
          }
        : {}),
      namingFix: `Rename ${pair.fromName} toward ${pair.toName}, or bind agents to ${pair.toName}.`,
    });
  }
  return drafts;
}

export function recordCousinCorrections(
  state: SockState,
  input: {
    screenId: string;
    screenName: string;
    frameId?: string;
    fileKey?: string;
    hits: Array<{
      fromId: string;
      fromName: string;
      fromFileKey?: string;
      toId: string;
      toName: string;
      toFileKey?: string;
    }>;
    verifiedAt?: string;
  },
): SockState {
  if (!input.hits.length) return state;
  const verifiedAt = input.verifiedAt ?? new Date().toISOString();
  const next = [...(state.corrections ?? [])];
  for (const hit of input.hits) {
    const already = next.some(
      (row) => row.fromId === hit.fromId && row.toId === hit.toId && row.screenId === input.screenId,
    );
    if (already) continue;
    next.push({
      fromId: hit.fromId,
      fromName: hit.fromName,
      fromFileKey: hit.fromFileKey,
      toId: hit.toId,
      toName: hit.toName,
      toFileKey: hit.toFileKey,
      screenId: input.screenId,
      screenName: input.screenName,
      ...(input.frameId ? { frameId: input.frameId } : {}),
      ...(input.fileKey ? { fileKey: input.fileKey } : {}),
      verifiedAt,
    });
  }
  const corrections = next.length > SOCI_CORRECTION_CAP ? next.slice(-SOCI_CORRECTION_CAP) : next;
  return { ...state, corrections };
}

export interface AdvanceSociOptions {
  recipes?: Recipe[];
  index?: GraphIndex;
  workspace?: WorkspaceManifest;
  alreadyEncoded?: (pattern: UsagePattern) => boolean;
  cap?: number;
  now?: string;
}

export function advanceSoci(state: SockState, options: AdvanceSociOptions = {}): SockState {
  const now = options.now ?? new Date().toISOString();
  const alreadyEncoded = options.alreadyEncoded ?? (() => false);
  const strong = patternsOf(state).filter((row) => row.confidence === "strong" && row.promoted);
  let next = proposeStrongPatterns(state, strong, alreadyEncoded);
  const recipeScan = detectRecipeUpdates(next, options.recipes ?? []);
  const drafts: SociDraft[] = [
    ...recipeScan.drafts,
    ...detectVariantCandidates(next),
    ...detectDeprecations(next, options.index),
    ...detectWrongCousins(next, options.workspace),
  ];
  for (const draft of drafts) {
    next = upsertDraft(next, draft, now);
  }
  next = {
    ...next,
    proposals: next.proposals
      .filter((row) => {
        if (row.status !== "pending" || proposalTypeOf(row) !== "recipe-update") return true;
        const recipeId = row.scope?.recipeId ?? row.suggestedRecipe?.recipeId;
        const slot = row.scope?.slot ?? row.suggestedRecipe?.slotRole;
        if (!recipeId || !slot) return true;
        const key = `${recipeId}::${slot.toLowerCase()}`;
        if (!recipeScan.closedSlots.has(key)) return true;
        const winner = recipeScan.closedSlots.get(key);
        if (!winner) return false;
        return row.id === proposalIdFor("recipe-update", winner);
      })
      .map((row) => normalizeProposal(row)),
  };
  return capSociProposals(next, options.cap ?? next.proposalCap ?? DEFAULT_SOCI_CAP);
}

/** Apply a human-approved recipe slot change. Never invents a master id. */
export function applyRecipeSlotChange(recipe: Recipe, change: SociSuggestedRecipe): Recipe {
  const role = change.slotRole.trim();
  if (!role) return recipe;
  const hints = [...new Set([...(change.hints ?? []), ...tokensOf(change.masterName)])].filter(Boolean);
  const slots = recipe.slots.map((slot) => ({ ...slot, hints: [...slot.hints] }));
  const index = slots.findIndex((slot) => slot.role.toLowerCase() === role.toLowerCase());
  if (index >= 0) {
    const existing = slots[index]!;
    slots[index] = {
      ...existing,
      defaultMasterId: change.masterId,
      hints: [...new Set([...existing.hints, ...hints])],
    };
  } else {
    slots.push({
      role,
      required: change.required ?? false,
      hints: hints.length ? hints : [role],
      defaultMasterId: change.masterId,
    });
  }
  return { ...recipe, slots };
}

export function overlayWithRecipe(overlay: Recipe[], updated: Recipe): Recipe[] {
  return [...overlay.filter((recipe) => recipe.id !== updated.id), updated];
}

export function groupSociProposals(
  proposals: SociProposal[],
): Array<{ type: SociProposalType; label: string; proposals: SociProposal[] }> {
  const byType = new Map<SociProposalType, SociProposal[]>();
  for (const type of SOCI_PROPOSAL_TYPES) byType.set(type, []);
  for (const proposal of proposals) {
    const type = proposalTypeOf(proposal);
    byType.get(type)!.push(normalizeProposal(proposal));
  }
  return SOCI_PROPOSAL_TYPES.map((type) => ({
    type,
    label: SOCI_TYPE_LABELS[type],
    proposals: byType.get(type) ?? [],
  })).filter((group) => group.proposals.length > 0);
}

export function stampFileKeyOf(node: GraphNode, fallback?: string): string | undefined {
  return nodeFileKey(node, fallback);
}

export interface SociDecision {
  sock: SockState;
  rules: BindRulesFile;
  audit: AuditLine;
  recipeOverlay?: Recipe[];
  writesRules: boolean;
  writesRecipes: boolean;
}

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
  sock: SockState,
  rules: BindRulesFile,
  proposalId: string,
  action: "approve" | "reject",
  who: string,
  when: string,
  options: {
    index?: GraphIndex;
    workspace?: WorkspaceManifest;
    recipes?: Recipe[];
    overlay?: Recipe[];
    note?: string;
  } = {},
): SociDecision {
  const proposal = sock.proposals.find((row) => row.id === proposalId);
  if (!proposal) {
    throw new BindRuleError(`Proposal "${proposalId}" not found.`);
  }
  if (proposal.status !== "pending") {
    throw new BindRuleError(`Proposal "${proposalId}" is already ${proposal.status}.`);
  }
  const type = proposalTypeOf(proposal);
  const note = options.note?.trim();

  switch (type) {
    case "require-rule": {
      const decided = applyProposalDecision(sock, rules, proposalId, action, who, when, {
        index: options.index,
        workspace: options.workspace,
      });
      return { ...decided, writesRules: true, writesRecipes: false };
    }
    case "wrong-cousin": {
      if (action === "approve" && proposal.suggestedRule?.prefer && proposal.suggestedRule.over) {
        const rule = proposal.suggestedRule;
        if (rule.masterId) assertCurrentMaster(options.index, sock, rule.masterId, "preferred master");
        if (rule.overMasterId) assertCurrentMaster(options.index, sock, rule.overMasterId, "cousin");
        const decided = applyProposalDecision(sock, rules, proposalId, action, who, when, {
          index: options.index,
          workspace: options.workspace,
        });
        return { ...decided, writesRules: true, writesRecipes: false };
      }
      const nextSock = markProposal(sock, proposalId, action, note ?? proposal.namingFix);
      return {
        sock: nextSock,
        rules,
        audit: { who, when, proposalId, action, before: rules.rules, after: rules.rules },
        writesRules: false,
        writesRecipes: false,
      };
    }
    case "recipe-update": {
      if (action === "reject") {
        const nextSock = markProposal(sock, proposalId, action, note);
        return {
          sock: nextSock,
          rules,
          audit: { who, when, proposalId, action, before: rules.rules, after: rules.rules },
          writesRules: false,
          writesRecipes: false,
        };
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
      const overlay = overlayWithRecipe(options.overlay ?? [], updated);
      const nextSock = markProposal(sock, proposalId, action, note);
      return {
        sock: nextSock,
        rules,
        audit: {
          who,
          when,
          proposalId,
          action,
          before: rules.rules,
          after: rules.rules,
          recipeBefore: current,
          recipeAfter: updated,
        },
        recipeOverlay: overlay,
        writesRules: false,
        writesRecipes: true,
      };
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
      const nextSock = markProposal(sock, proposalId, action, note ?? fallback);
      return {
        sock: nextSock,
        rules,
        audit: { who, when, proposalId, action, before: rules.rules, after: rules.rules },
        writesRules: false,
        writesRecipes: false,
      };
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
