/**
 * SOCK — source of component knowledge beyond the graph:
 * verified usage facts, file freshness, and SOCI rule proposals.
 *
 * Usage facts write themselves. Rules never do.
 */

export const DEFAULT_USAGE_THRESHOLD = 3;

export type UsageConfidence = "low" | "strong";
export type SociStatus = "pending" | "approved" | "rejected";

export interface UsageFact {
  masterId: string;
  name: string;
  fileKey?: string;
  figmaNodeId?: string;
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
}

export interface SociProposal {
  id: string;
  createdAt: string;
  kind: "rule";
  status: SociStatus;
  summary: string;
  evidence: string;
  suggestedRule?: SociSuggestedRule;
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
}

export function emptySock(threshold = DEFAULT_USAGE_THRESHOLD): SockState {
  return { version: 1, threshold, facts: [], freshness: {}, proposals: [] };
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
    }>;
    journey?: string;
    product?: string;
    pack?: string;
    slot?: string;
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
      screenId: input.screenId,
      screenName: input.screenName,
      ...(input.slot ? { slot: input.slot } : {}),
      journey: input.journey,
      product: input.product,
      pack: input.pack,
      deprecated: master.deprecated,
      private: master.private,
      promoted: !blocked,
      countsTowardThreshold,
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

export function proposeRuleChange(
  state: SockState,
  summary: string,
  evidence: string,
  suggestedRule?: SociSuggestedRule,
): SockState {
  const createdAt = new Date().toISOString();
  const id = `soci:${createdAt}:${state.proposals.length + 1}`;
  const proposal: SociProposal = {
    id,
    createdAt,
    kind: "rule",
    status: "pending",
    summary,
    evidence,
    ...(suggestedRule ? { suggestedRule } : {}),
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

function firstToken(name: string): string | undefined {
  const token = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .find((part) => part.length > 2);
  return token;
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
    screenType = screenNames[0];
  } else if (screenNames.length > 1) {
    const tokens = screenNames.map(firstToken).filter((token): token is string => Boolean(token));
    if (tokens.length === screenNames.length && tokens.every((token) => token === tokens[0])) {
      screenType = tokens[0];
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
    if (next.proposals.some((row) => row.summary === summary && row.status === "pending")) continue;
    next = proposeRuleChange(
      next,
      summary,
      `Verified on distinct screens: ${pattern.screens.join(", ") || "(none)"}.`,
      {
        require: pattern.masterId,
        ...scope,
      },
    );
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
  if (!freshness?.stale) return "If stale, learn_library changed frames. Do not Read graph.json.";
  const refetch = (freshness.delta ?? []).filter((item) => item.action === "refetch");
  if (refetch.length) {
    const list = refetch.map((item) => `${item.name} (${item.id})`).join(", ");
    return `Stale. Re-fetch then learn_library: ${list}. Do not Read graph.json.`;
  }
  return "Stale. Re-fetch changed pages/frames then learn_library. Do not Read graph.json.";
}
