/** Recommend card types, library rules, and where-used rows. */
import type { GraphNode } from "@/core/model";
import type { PlaceFields } from "./placeReady";
import type { PropertyHint, PropertyRow } from "./componentProperties";
import type { ExampleReason } from "./examples";
import type { GraphIndex } from "./GraphIndex";
import { isMasterType } from "./masterNames";
import { screenOf, slotNamesOf } from "./screenInventory";
import { type SockState, staleRefreshHint } from "./sock";

export const asMaster = (index: GraphIndex, node: GraphNode): GraphNode | undefined => {
  if (isMasterType(node.type)) return node;
  if (node.type === "COMPONENT_INSTANCE") return index.getMainComponent(node.id);
  return undefined;
};
export function whereUsedRows(index: GraphIndex, node: GraphNode, limit: number) {
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
export function slotsForComponent(index: GraphIndex, node: GraphNode, sample = 8): string[] {
  const names = new Set<string>();
  for (const instance of index.getAllInstancesOf(node.id).slice(0, sample)) {
    for (const slot of slotNamesOf(index, instance.id)) names.add(slot);
  }
  return [...names].sort();
}
export function ruleMatches(index: GraphIndex, node: GraphNode, rule: string): boolean {
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
  /** Designer words mapped onto real property values. Ranking ignores these. */
  propertyHints?: PropertyHint[];
  /** Echo labels. Ranking ignores these. */
  sources?: {
    product?: string;
    client?: string;
    domain?: string;
    journey?: string;
    audience?: string;
    a11y?: string;
  };
  warning?: string;
}
export function trimmedStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return items.length ? items.map((item) => item.trim()) : undefined;
}

export function parseLibraryRules(raw: unknown): LibraryRules {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  return { allow: trimmedStrings(record["allow"]), deny: trimmedStrings(record["deny"]) };
}
export const REFRESH_HINT = "If stale, learn_library. Do not Read graph.json.";
export function refreshHintFor(sock?: SockState, fileKey?: string): string {
  if (!sock) return REFRESH_HINT;
  const values = Object.values(sock.freshness);
  const stale = fileKey
    ? sock.freshness[fileKey]
    : values.find((row) => row.stale) ?? values[0];
  return staleRefreshHint(stale);
}
/** Place-ready top hit. These fields stay present on candidate 1. */
export interface RecommendCandidate extends PlaceFields {
  id: string;
  name: string;
  why: string;
  type: string;
  hint: string;
  deprecated: boolean;
  instances?: number;
  whereUsed?: Array<{ name: string; count: number }>;
  score: number;
  /** Set when an unknown noun sits in front of the head, or the match is only a label. Ranking is unchanged. */
  confidence?: "low";
  /** Set when the only words that matched are shared (button, bar, field, picker). */
  weak?: true;
  /** Compact set settings, e.g. `3 variants · Style, Size`. */
  settings?: string;
  set?: string;
  status?: GraphNode["status"];
  slots?: string[];
  /** Top pick only. Allowed values, the Angular input, and designer-word hints. */
  properties?: PropertyRow[];
  /** Top pick only. `To apply: set X=Y` when the request names an allowed value. */
  apply?: string;
  /** Top pick only. Node id, or `fileKey:nodeId` when the example file differs. Omitted when none. */
  ex?: string;
  exFileKey?: string;
  exWhy?: ExampleReason;
  exNote?: "other product";
}
/** Candidates 2–3. Place with fileKey + figmaNodeId; the rest stays on the top hit. */
export interface RecommendAlternate {
  id: string;
  name: string;
  why: string;
  fileKey?: string;
  figmaNodeId?: string;
  /** Real instance node id when one is known. Omitted when there is no example. */
  ex?: string;
}
export type RecommendHit = RecommendCandidate | RecommendAlternate;
