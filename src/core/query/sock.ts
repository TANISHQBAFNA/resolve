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
  deprecated?: boolean;
  private?: boolean;
  promoted: boolean;
  verifiedAt: string;
}

export interface UsagePattern {
  masterId: string;
  name: string;
  screens: string[];
  confidence: UsageConfidence;
  promoted: boolean;
}

export interface SociProposal {
  id: string;
  createdAt: string;
  kind: "rule";
  status: SociStatus;
  summary: string;
  evidence: string;
}

export interface FileFreshness {
  fileKey: string;
  lastModified?: string;
  version?: string;
  stale: boolean;
  checkedAt: string;
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
    verifiedAt?: string;
  },
): SockState {
  const verifiedAt = input.verifiedAt ?? new Date().toISOString();
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
      slot: inferSlot(master.name) ?? inferSlot(input.screenName),
      journey: input.journey,
      product: input.product,
      deprecated: master.deprecated,
      private: master.private,
      promoted: !blocked,
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
    if (!row.screens.includes(fact.screenId)) row.screens.push(fact.screenId);
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
  files: Array<{ fileKey: string; lastModified?: string; version?: string }>,
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
    freshness[key] = {
      fileKey: key,
      lastModified: file.lastModified ?? prev?.lastModified,
      version: file.version ?? prev?.version,
      stale: versionChanged || modifiedChanged,
      checkedAt,
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

export function proposeRuleChange(state: SockState, summary: string, evidence: string): SockState {
  const createdAt = new Date().toISOString();
  const id = `soci:${createdAt}:${state.proposals.length + 1}`;
  const proposal: SociProposal = {
    id,
    createdAt,
    kind: "rule",
    status: "pending",
    summary,
    evidence,
  };
  return { ...state, proposals: [...state.proposals, proposal] };
}

export function listSoci(state: SockState): SociProposal[] {
  return state.proposals;
}
