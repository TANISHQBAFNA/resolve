/**
 * SOCK — source of component knowledge beyond the graph:
 * verified usage facts, file freshness, and SOCI rule proposals.
 *
 * Usage facts write themselves. Rules never do.
 */

export const DEFAULT_USAGE_THRESHOLD = 3;

export type UsageConfidence = "low" | "strong";
export type SociStatus = "pending" | "approved" | "rejected";
export type SociProposalType =
  | "require-rule"
  | "recipe-update"
  | "variant-candidate"
  | "deprecation-candidate"
  | "wrong-cousin";

export interface SociEvidenceItem {
  frameId?: string;
  screenId?: string;
  screenName?: string;
  fileKey?: string;
  count?: number;
  note?: string;
}

export interface SociScope {
  screenType?: string;
  slot?: string;
  journey?: string;
  product?: string;
  pack?: string;
  recipeId?: string;
  masterId?: string;
}

export interface UsageFact {
  masterId: string;
  name: string;
  fileKey?: string;
  figmaNodeId?: string;
  /** Verified frame node id when this fact came from a real frame. */
  frameId?: string;
  screenId: string;
  screenName: string;
  slot?: string;
  journey?: string;
  product?: string;
  pack?: string;
  deprecated?: boolean;
  private?: boolean;
  promoted: boolean;
  /** False for component-list-only verifies. Only real frames count toward N=3. */
  countsTowardThreshold: boolean;
  /** REST/MCP-derived override keys (never guessed). */
  overrideKeys?: string[];
  verifiedAt: string;
}

export interface UsagePattern {
  masterId: string;
  name: string;
  screens: string[];
  confidence: UsageConfidence;
  promoted: boolean;
}

export interface SociSuggestedRule {
  id?: string;
  screenType?: string;
  slot?: string;
  journey?: string;
  product?: string;
  pack?: string;
  require?: string;
  forbid?: string;
  prefer?: string;
  over?: string;
  /** Preferred master. Required for a scoped prefer; absent on a file-wide prefer. */
  masterId?: string;
  /** Cousin to demote. Scoped prefer only. */
  overMasterId?: string;
}

export interface SociSuggestedRecipe {
  recipeId: string;
  slotRole: string;
  action: "add-slot" | "rebind";
  masterId: string;
  masterName: string;
  hints?: string[];
  required?: boolean;
}

export interface SociSuggestedVariant {
  masterId: string;
  masterName: string;
  overrideKey: string;
  note: string;
}

export interface SociSuggestedDeprecation {
  masterId: string;
  masterName: string;
  cousinId: string;
  cousinName: string;
}

export interface CousinCorrection {
  fromId: string;
  fromName: string;
  fromFileKey?: string;
  toId: string;
  toName: string;
  toFileKey?: string;
  screenId: string;
  screenName: string;
  frameId?: string;
  fileKey?: string;
  verifiedAt: string;
}

export interface SociProposal {
  id: string;
  createdAt: string;
  updatedAt?: string;
  /** @deprecated Use `type`. Kept so existing require-rule rows still load. */
  kind?: "rule";
  type?: SociProposalType;
  scope?: SociScope;
  status: SociStatus;
  summary: string;
  evidence: string | SociEvidenceItem[];
  confidence?: UsageConfidence;
  suggestedRule?: SociSuggestedRule;
  suggestedRecipe?: SociSuggestedRecipe;
  suggestedVariant?: SociSuggestedVariant;
  suggestedDeprecation?: SociSuggestedDeprecation;
  namingFix?: string;
  decisionNote?: string;
}

export interface FreshnessDeltaItem {
  id: string;
  name: string;
  kind: "page" | "frame";
  action: "refetch" | "removed";
}

export interface RemovedMaster {
  id: string;
  name: string;
  figmaNodeId?: string;
  reason: "deprecated-by-absence";
}

export interface FreshnessOutlineUnit {
  id: string;
  name: string;
  kind: "page" | "frame";
}

export interface FileFreshness {
  fileKey: string;
  lastModified?: string;
  version?: string;
  stale: boolean;
  checkedAt: string;
  outline?: FreshnessOutlineUnit[];
  delta?: FreshnessDeltaItem[];
  removed?: RemovedMaster[];
}

export interface SockState {
  version: 1;
  threshold: number;
  facts: UsageFact[];
  freshness: Record<string, FileFreshness>;
  proposals: SociProposal[];
  corrections?: CousinCorrection[];
  proposalCap?: number;
  /** Load-time notes. Not written back to sock.json. */
  warnings?: string[];
}

export function emptySock(threshold = DEFAULT_USAGE_THRESHOLD): SockState {
  return { version: 1, threshold, facts: [], freshness: {}, proposals: [], corrections: [] };
}

export function inferSlot(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (/(^|[^a-z])(header|top.?bar|app.?bar|nav)([^a-z]|$)/.test(lower)) return "header";
  if (/(^|[^a-z])(footer|bottom.?bar)([^a-z]|$)/.test(lower)) return "footer";
  if (/(^|[^a-z])(body|content|main)([^a-z]|$)/.test(lower)) return "body";
  return undefined;
}

export function isRealVerifiedFrame(frame?: {
  fileKey?: string;
  figmaNodeId?: string;
  nodeId?: string;
}): boolean {
  const nodeId = frame?.figmaNodeId?.trim() || frame?.nodeId?.trim();
  return Boolean(frame?.fileKey?.trim() && nodeId);
}

export function recordVerifiedUsage(
  state: SockState,
  input: {
    screenId: string;
    screenName: string;
    masters: Array<{
      id: string;
      name: string;
      fileKey?: string;
      figmaNodeId?: string;
      deprecated?: boolean;
      private?: boolean;
      overrideKeys?: string[];
      /** Wins over the shared input.slot. Omit both to record no slot. */
      slot?: string;
    }>;
    journey?: string;
    product?: string;
    pack?: string;
    slot?: string;
    frameId?: string;
    verifiedAt?: string;
    /** Default true so unit tests can simulate real screens. Tools must pass false for list-only. */
    countsTowardThreshold?: boolean;
  },
): SockState {
  const verifiedAt = input.verifiedAt ?? new Date().toISOString();
  const countsTowardThreshold = input.countsTowardThreshold !== false;
  const nextFacts = [...state.facts];
  for (const master of input.masters) {
    const blocked = Boolean(master.deprecated || master.private);
    const already = nextFacts.some(
      (fact) => fact.masterId === master.id && fact.screenId === input.screenId,
    );
    if (already) continue;
    nextFacts.push({
      masterId: master.id,
      name: master.name,
      fileKey: master.fileKey,
      figmaNodeId: master.figmaNodeId,
      ...(input.frameId ? { frameId: input.frameId } : {}),
      screenId: input.screenId,
      screenName: input.screenName,
      ...((master.slot ?? input.slot) ? { slot: master.slot ?? input.slot } : {}),
      journey: input.journey,
      product: input.product,
      pack: input.pack,
      deprecated: master.deprecated,
      private: master.private,
      promoted: !blocked,
      countsTowardThreshold,
      ...(master.overrideKeys?.length ? { overrideKeys: master.overrideKeys } : {}),
      verifiedAt,
    });
  }
  return { ...state, facts: nextFacts };
}

export function patternsOf(state: SockState): UsagePattern[] {
  const byMaster = new Map<string, UsagePattern>();
  for (const fact of state.facts) {
    let row = byMaster.get(fact.masterId);
    if (!row) {
      row = {
        masterId: fact.masterId,
        name: fact.name,
        screens: [],
        confidence: "low",
        promoted: false,
      };
      byMaster.set(fact.masterId, row);
    }
    if (fact.countsTowardThreshold !== false && !row.screens.includes(fact.screenId)) {
      row.screens.push(fact.screenId);
    }
    if (fact.promoted) row.promoted = true;
    if (fact.deprecated || fact.private) row.promoted = false;
  }
  for (const row of byMaster.values()) {
    row.confidence = row.screens.length >= state.threshold ? "strong" : "low";
    if (!row.promoted) row.confidence = "low";
  }
  return [...byMaster.values()];
}

export function patternFor(state: SockState, masterId: string): UsagePattern | undefined {
  return patternsOf(state).find((row) => row.masterId === masterId);
}

/** Singletons never drive recipes. Graph where-used (instances > 0) still may. */
export function usageAllowsRecipeFill(
  state: SockState | undefined,
  masterId: string,
  instances: number,
): boolean {
  if (!state) return true;
  const pattern = patternFor(state, masterId);
  if (!pattern) return true;
  if (!pattern.promoted) return false;
  if (pattern.confidence === "strong") return true;
  return instances > 0;
}

export function applyFreshness(
  state: SockState,
  files: Array<{
    fileKey: string;
    lastModified?: string;
    version?: string;
    outline?: FreshnessOutlineUnit[];
    removed?: RemovedMaster[];
    stale?: boolean;
  }>,
  checkedAt = new Date().toISOString(),
): SockState {
  const freshness = { ...state.freshness };
  for (const file of files) {
    const key = file.fileKey.trim();
    if (!key) continue;
    const prev = freshness[key];
    const versionChanged = Boolean(file.version && prev?.version && file.version !== prev.version);
    const modifiedChanged = Boolean(
      file.lastModified && prev?.lastModified && file.lastModified !== prev.lastModified,
    );
    const stale = file.stale === false ? false : Boolean(file.stale) || versionChanged || modifiedChanged;
    const outline = file.outline ?? prev?.outline;
    const delta: FreshnessDeltaItem[] | undefined = stale
      ? (outline ?? []).map((unit) => ({
          id: unit.id,
          name: unit.name,
          kind: unit.kind,
          action: "refetch" as const,
        }))
      : [];
    freshness[key] = {
      fileKey: key,
      lastModified: file.lastModified ?? prev?.lastModified,
      version: file.version ?? prev?.version,
      stale,
      checkedAt,
      ...(outline?.length ? { outline } : {}),
      ...(delta?.length ? { delta } : {}),
      removed: file.removed ?? prev?.removed,
    };
  }
  return { ...state, freshness };
}

export function freshnessSummary(state: SockState, fileKey?: string): FileFreshness | undefined {
  if (fileKey) return state.freshness[fileKey];
  const values = Object.values(state.freshness);
  if (!values.length) return undefined;
  if (values.some((row) => row.stale)) return values.find((row) => row.stale);
  return values[0];
}

function evidenceList(evidence: string | SociEvidenceItem[]): SociEvidenceItem[] {
  if (Array.isArray(evidence)) return evidence;
  if (evidence.trim()) return [{ note: evidence.trim() }];
  return [];
}

function requireRuleId(summary: string, suggestedRule?: SociSuggestedRule): string {
  const key = [
    suggestedRule?.require,
    suggestedRule?.screenType,
    suggestedRule?.slot,
    suggestedRule?.journey,
    suggestedRule?.product,
    suggestedRule?.pack,
    summary,
  ]
    .filter(Boolean)
    .join(":")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 96);
  return `soci:require-rule:${key || "rule"}`;
}

export function proposeRuleChange(
  state: SockState,
  summary: string,
  evidence: string | SociEvidenceItem[],
  suggestedRule?: SociSuggestedRule,
): SockState {
  const createdAt = new Date().toISOString();
  const id = requireRuleId(summary, suggestedRule);
  const existing = state.proposals.find((row) => row.id === id);
  const items = evidenceList(evidence);
  if (existing) {
    if (existing.status !== "pending") return state;
    const prev = Array.isArray(existing.evidence) ? existing.evidence : evidenceList(existing.evidence);
    const seen = new Set(prev.map((item) => `${item.screenId ?? ""}:${item.frameId ?? ""}:${item.note ?? ""}`));
    const merged = [...prev];
    for (const item of items) {
      const key = `${item.screenId ?? ""}:${item.frameId ?? ""}:${item.note ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
    return {
      ...state,
      proposals: state.proposals.map((row) =>
        row.id === id
          ? {
              ...row,
              type: "require-rule" as const,
              kind: "rule" as const,
              summary,
              evidence: merged.slice(0, 8),
              updatedAt: createdAt,
              ...(suggestedRule ? { suggestedRule } : {}),
            }
          : row,
      ),
    };
  }
  const proposal: SociProposal = {
    id,
    createdAt,
    updatedAt: createdAt,
    kind: "rule",
    type: "require-rule",
    status: "pending",
    summary,
    evidence: items,
    confidence: "strong",
    ...(suggestedRule
      ? {
          scope: {
            ...(suggestedRule.screenType ? { screenType: suggestedRule.screenType } : {}),
            ...(suggestedRule.slot ? { slot: suggestedRule.slot } : {}),
            ...(suggestedRule.journey ? { journey: suggestedRule.journey } : {}),
            ...(suggestedRule.product ? { product: suggestedRule.product } : {}),
            ...(suggestedRule.pack ? { pack: suggestedRule.pack } : {}),
            ...(suggestedRule.require ? { masterId: suggestedRule.require } : {}),
          },
          suggestedRule,
        }
      : {}),
  };
  return { ...state, proposals: [...state.proposals, proposal] };
}

export function listSoci(state: SockState): SociProposal[] {
  return state.proposals;
}

export function newlyStrongPatterns(before: SockState, after: SockState): UsagePattern[] {
  const prev = new Set(
    patternsOf(before)
      .filter((row) => row.confidence === "strong")
      .map((row) => row.masterId),
  );
  return patternsOf(after).filter(
    (row) => row.confidence === "strong" && row.promoted && !prev.has(row.masterId),
  );
}

function uniqueTrimmed(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/** Words that never identify a screen type on their own. */
const GENERIC_SCREEN_WORDS = new Set([
  "screen",
  "page",
  "frame",
  "view",
  "untitled",
  "copy",
  "artboard",
  "section",
  "canvas",
  "layer",
  "default",
  "draft",
  "wip",
  "temp",
  "tmp",
  "final",
  "component",
  "group",
  "variant",
  "master",
  "instance",
  "node",
]);

function isGenericScreenToken(token: string): boolean {
  if (GENERIC_SCREEN_WORDS.has(token)) return true;
  return /^v\d+$/.test(token);
}

/** Specific words left after generic screen words (and v1/v2) are removed. */
function meaningfulScreenTokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 2 && !isGenericScreenToken(part));
}

/** Scope a require proposal from verified frames — never a global require. */
export function scopeFromUsageFacts(facts: UsageFact[]): {
  screenType?: string;
  slot?: string;
  journey?: string;
  product?: string;
  pack?: string;
} {
  const counted = facts.filter((fact) => fact.countsTowardThreshold !== false);
  const screenNames = uniqueTrimmed(counted.map((fact) => fact.screenName));
  const slots = uniqueTrimmed(counted.map((fact) => fact.slot));
  const journeys = uniqueTrimmed(counted.map((fact) => fact.journey));
  const products = uniqueTrimmed(counted.map((fact) => fact.product));
  const packs = uniqueTrimmed(counted.map((fact) => fact.pack));
  let screenType: string | undefined;
  if (screenNames.length === 1) {
    const only = screenNames[0]!;
    if (meaningfulScreenTokens(only).length) screenType = only;
  } else if (screenNames.length > 1) {
    const tokenLists = screenNames.map(meaningfulScreenTokens);
    if (tokenLists.every((list) => list.length > 0)) {
      const firsts = tokenLists.map((list) => list[0]!);
      if (firsts.every((token) => token === firsts[0])) screenType = firsts[0];
    }
  }
  return {
    ...(screenType ? { screenType } : {}),
    ...(slots.length === 1 ? { slot: slots[0] } : {}),
    ...(journeys.length === 1 ? { journey: journeys[0] } : {}),
    ...(products.length === 1 ? { product: products[0] } : {}),
    ...(packs.length === 1 ? { pack: packs[0] } : {}),
  };
}

export function proposeStrongPatterns(
  state: SockState,
  patterns: UsagePattern[],
  alreadyEncoded: (pattern: UsagePattern) => boolean,
): SockState {
  let next = state;
  for (const pattern of patterns) {
    if (alreadyEncoded(pattern)) continue;
    const facts = next.facts.filter((fact) => fact.masterId === pattern.masterId);
    const scope = scopeFromUsageFacts(facts);
    if (!scope.screenType && !scope.slot && !scope.journey && !scope.product && !scope.pack) continue;
    const scopeLabel = [scope.screenType, scope.slot, scope.journey, scope.product, scope.pack]
      .filter(Boolean)
      .join("/");
    const summary = `Promote ${pattern.name} for ${scopeLabel} (strong on ${pattern.screens.length} screens)`;
    const evidence = facts
      .filter((fact) => fact.countsTowardThreshold !== false)
      .map((fact) => ({
        frameId: fact.frameId ?? fact.screenId,
        screenId: fact.screenId,
        screenName: fact.screenName,
        ...(fact.fileKey ? { fileKey: fact.fileKey } : {}),
        count: 1,
      }));
    next = proposeRuleChange(next, summary, evidence.length ? evidence : `Verified on distinct screens: ${pattern.screens.join(", ") || "(none)"}.`, {
      require: pattern.masterId,
      ...scope,
    });
  }
  return next;
}

export function isRemovedByAbsence(state: SockState | undefined, node: { id: string; figmaNodeId?: string }): boolean {
  if (!state) return false;
  for (const row of Object.values(state.freshness)) {
    if (
      row.removed?.some(
        (item) => item.id === node.id || (item.figmaNodeId && item.figmaNodeId === node.figmaNodeId),
      )
    ) {
      return true;
    }
  }
  return false;
}

export function staleRefreshHint(freshness?: FileFreshness): string {
  if (!freshness?.stale) return "If stale, learn_library. Do not Read graph.json.";
  const refetch = (freshness.delta ?? []).filter((item) => item.action === "refetch");
  if (refetch.length) {
    const list = refetch.map((item) => `${item.name} (${item.id})`).join(", ");
    return `Stale. Re-fetch then learn_library: ${list}. Do not Read graph.json.`;
  }
  return "Stale. Re-fetch changed pages/frames then learn_library. Do not Read graph.json.";
}
