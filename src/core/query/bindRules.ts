import { z } from "zod";
import { COMPONENT_DEFINITION_TYPES, type GraphNode } from "@/core/model";
import type { GraphIndex } from "./GraphIndex";
import { placeReady } from "./placeReady";
import {
  freshnessSummary,
  isRemovedByAbsence,
  patternFor,
  type SociProposal,
  type SockState,
} from "./sock";
import type { WorkspaceManifest } from "./workspace";
import { nodeFileKey } from "./workspaceMerge";

/**
 * Human-authored bind rules. SOCK may propose; only a human writes the file.
 * Never invent a master id.
 */

const MASTER_TYPES = new Set<string>(COMPONENT_DEFINITION_TYPES);

export type BindRuleKind = "require" | "forbid" | "prefer";

export interface RequireBindRule {
  kind: "require";
  id: string;
  screenType?: string;
  slot?: string;
  journey?: string;
  product?: string;
  pack?: string;
  require: string;
  requireId?: string;
  requireName?: string;
}

export interface ForbidBindRule {
  kind: "forbid";
  id: string;
  forbid: string;
}

export interface PreferBindRule {
  kind: "prefer";
  id: string;
  prefer: string;
  over: string;
  preferKey?: string;
  overKey?: string;
}

export type BindRule = RequireBindRule | ForbidBindRule | PreferBindRule;

export interface BindRuleWarning {
  rule: string;
  reason: string;
}

export interface BindRulesFile {
  version: 1;
  rules: BindRule[];
  warnings?: BindRuleWarning[];
}

export interface BindRuleFailure {
  rule: string;
  reason: string;
  expected?: {
    id: string;
    name: string;
    hint: string;
    nodeId?: string;
    figmaNodeId?: string;
    fileKey?: string;
  };
}

export interface WhyFacts {
  usageScreens?: number;
  confidence?: "low" | "strong";
  stale?: boolean;
  deprecated?: boolean;
  removed?: boolean;
  packJourney?: string;
  bindRule?: string;
}

export interface AuditLine {
  who: string;
  when: string;
  proposalId: string;
  action: "approve" | "reject";
  before: BindRule[];
  after: BindRule[];
}

export function emptyBindRules(): BindRulesFile {
  return { version: 1, rules: [] };
}

export function requireHasScope(rule: Pick<RequireBindRule, "screenType" | "slot" | "journey" | "product" | "pack">): boolean {
  return Boolean(rule.screenType || rule.slot || rule.journey || rule.product || rule.pack);
}

export function ruleLabel(rule: BindRule): string {
  switch (rule.kind) {
    case "require": {
      const scope = [rule.screenType, rule.slot, rule.journey, rule.product, rule.pack].filter(Boolean).join("/");
      return scope ? `require ${scope}` : `require ${rule.requireName ?? rule.require}`;
    }
    case "forbid":
      return `forbid ${rule.forbid}`;
    case "prefer":
      return `prefer ${rule.prefer} over ${rule.over}`;
    default: {
      const _exhaustive: never = rule;
      return _exhaustive;
    }
  }
}

function asId(raw: unknown, fallback: string): string {
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return fallback;
}

function splitPrefer(value: string): { prefer: string; over: string } | undefined {
  const match = value.trim().match(/^(.*?)\s+over\s+(.+)$/i);
  if (!match) return undefined;
  const prefer = match[1]!.trim();
  const over = match[2]!.trim();
  if (!prefer || !over) return undefined;
  return { prefer, over };
}

const RequireShape = z.object({
  id: z.string().trim().min(1).optional(),
  screenType: z.string().trim().min(1).optional(),
  slot: z.string().trim().min(1).optional(),
  journey: z.string().trim().min(1).optional(),
  product: z.string().trim().min(1).optional(),
  pack: z.string().trim().min(1).optional(),
  require: z.string().trim().min(1),
});

const ForbidShape = z.object({
  id: z.string().trim().min(1).optional(),
  forbid: z.string().trim().min(1),
});

const PreferPairShape = z.object({
  id: z.string().trim().min(1).optional(),
  prefer: z.string().trim().min(1),
  over: z.string().trim().min(1),
});

const PreferPhraseShape = z.object({
  id: z.string().trim().min(1).optional(),
  prefer: z.string().trim().min(1),
});

export class BindRuleError extends Error {}

function parseOne(raw: unknown, index: number): BindRule {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BindRuleError(`Bind rule ${index + 1} is not an object. Never guessing.`);
  }
  const record = raw as Record<string, unknown>;
  if ("require" in record) {
    const parsed = RequireShape.safeParse(record);
    if (!parsed.success) {
      throw new BindRuleError(
        `Bind rule ${index + 1} require is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}. Never guessing.`,
      );
    }
    const data = parsed.data;
    if (!requireHasScope(data)) {
      throw new BindRuleError(
        `Bind rule ${index + 1} require needs screenType, slot, journey, product, or pack. Unscoped require is invalid. Never guessing.`,
      );
    }
    return {
      kind: "require",
      id: asId(
        data.id,
        `require:${[data.screenType, data.slot, data.journey, data.product, data.pack].filter(Boolean).join("/") || data.require}`,
      ),
      ...(data.screenType ? { screenType: data.screenType } : {}),
      ...(data.slot ? { slot: data.slot } : {}),
      ...(data.journey ? { journey: data.journey } : {}),
      ...(data.product ? { product: data.product } : {}),
      ...(data.pack ? { pack: data.pack } : {}),
      require: data.require,
    };
  }
  if ("forbid" in record) {
    const parsed = ForbidShape.safeParse(record);
    if (!parsed.success) {
      throw new BindRuleError(
        `Bind rule ${index + 1} forbid is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}. Never guessing.`,
      );
    }
    return {
      kind: "forbid",
      id: asId(parsed.data.id, `forbid:${parsed.data.forbid}`),
      forbid: parsed.data.forbid,
    };
  }
  if ("prefer" in record && "over" in record) {
    const parsed = PreferPairShape.safeParse(record);
    if (!parsed.success) {
      throw new BindRuleError(
        `Bind rule ${index + 1} prefer is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}. Never guessing.`,
      );
    }
    return {
      kind: "prefer",
      id: asId(parsed.data.id, `prefer:${parsed.data.prefer}>${parsed.data.over}`),
      prefer: parsed.data.prefer,
      over: parsed.data.over,
    };
  }
  if ("prefer" in record) {
    const parsed = PreferPhraseShape.safeParse(record);
    if (!parsed.success) {
      throw new BindRuleError(
        `Bind rule ${index + 1} prefer is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}. Never guessing.`,
      );
    }
    const split = splitPrefer(parsed.data.prefer);
    if (!split) {
      throw new BindRuleError(
        `Bind rule ${index + 1} prefer must be "{ prefer, over }" or "LibraryA over LibraryB". Never guessing.`,
      );
    }
    return {
      kind: "prefer",
      id: asId(parsed.data.id, `prefer:${split.prefer}>${split.over}`),
      prefer: split.prefer,
      over: split.over,
    };
  }
  throw new BindRuleError(
    `Bind rule ${index + 1} needs require, forbid, or prefer. Never guessing.`,
  );
}

/** Designer JSON in. Throws on bad shape. Does not invent ids. */
export function parseBindRulesFile(raw: unknown): BindRulesFile {
  if (raw == null) return emptyBindRules();
  if (Array.isArray(raw)) {
    return { version: 1, rules: raw.map((item, index) => parseOne(item, index)) };
  }
  if (typeof raw !== "object") {
    throw new BindRuleError("Bind rules file must be a JSON object or array. Never guessing.");
  }
  const record = raw as Record<string, unknown>;
  const list = record["rules"] ?? record["bindRules"];
  if (list == null) return emptyBindRules();
  if (!Array.isArray(list)) {
    throw new BindRuleError("Bind rules `rules` must be an array. Never guessing.");
  }
  return { version: 1, rules: list.map((item, index) => parseOne(item, index)) };
}

function isMaster(node: GraphNode): boolean {
  return MASTER_TYPES.has(node.type);
}

function idVariants(value: string): string[] {
  return [...new Set([value, value.replace(/-/g, ":"), value.replace(/:/g, "-")])];
}

function matchesId(node: GraphNode, raw: string): boolean {
  const needles = new Set(idVariants(raw.trim()));
  if (needles.has(node.id) || idVariants(node.id).some((id) => needles.has(id))) return true;
  const figmaId = node.figmaNodeId;
  if (figmaId && idVariants(figmaId).some((id) => needles.has(id))) return true;
  return false;
}

/** Exact id / Figma id / exact name. Counts masters; never picks a fuzzy hit. */
export function exactMasters(index: GraphIndex, needle: string): GraphNode[] {
  const trimmed = needle.trim();
  if (!trimmed) return [];
  const lower = trimmed.toLowerCase();
  const hits: GraphNode[] = [];
  for (const node of index.allNodes) {
    if (!isMaster(node)) continue;
    if (matchesId(node, trimmed) || node.name.toLowerCase() === lower) hits.push(node);
  }
  return hits;
}

export function resolveRequireMaster(index: GraphIndex, needle: string, ruleLabelText: string): GraphNode {
  const hits = exactMasters(index, needle);
  if (hits.length === 1) return hits[0]!;
  if (hits.length === 0) {
    throw new BindRuleError(
      `${ruleLabelText}: unknown master "${needle}". Not in the graph. Never guessing. Use an exact name or id after ingest.`,
    );
  }
  throw new BindRuleError(
    `${ruleLabelText}: "${needle}" matches ${hits.length} masters (${hits.map((node) => node.name).join(", ")}). Never guessing. Use the exact id.`,
  );
}

function libraryNeedle(workspace: WorkspaceManifest | undefined, name: string): string | undefined {
  const needle = name.trim().toLowerCase();
  if (!needle) return undefined;
  const file = workspace?.files.find(
    (entry) => entry.key.toLowerCase() === needle || (entry.label && entry.label.toLowerCase() === needle),
  );
  return file?.key ?? (workspace ? undefined : name);
}

/**
 * Resolve require names to ids. Unknown ids fail loudly.
 * Prefer/over names fail when a workspace is present and they are not in it.
 */
export function resolveBindRules(
  file: BindRulesFile,
  options: { index?: GraphIndex; workspace?: WorkspaceManifest } = {},
): BindRulesFile {
  const rules = file.rules.map((rule) => {
    switch (rule.kind) {
      case "require": {
        if (!options.index) return rule;
        const master = resolveRequireMaster(options.index, rule.require, `Bind rule ${ruleLabel(rule)}`);
        return {
          ...rule,
          requireId: master.id,
          requireName: master.name,
        };
      }
      case "forbid":
        return rule;
      case "prefer": {
        if (!options.workspace?.files.length) return rule;
        const preferKey = libraryNeedle(options.workspace, rule.prefer);
        const overKey = libraryNeedle(options.workspace, rule.over);
        if (!preferKey) {
          throw new BindRuleError(
            `Bind rule ${ruleLabel(rule)}: unknown library "${rule.prefer}". Not in workspace.json. Never guessing.`,
          );
        }
        if (!overKey) {
          throw new BindRuleError(
            `Bind rule ${ruleLabel(rule)}: unknown library "${rule.over}". Not in workspace.json. Never guessing.`,
          );
        }
        return { ...rule, preferKey, overKey };
      }
      default: {
        const _exhaustive: never = rule;
        return _exhaustive;
      }
    }
  });
  return { version: 1, rules };
}

export function mergeBindRules(base: BindRulesFile, overlay?: BindRulesFile): BindRulesFile {
  if (!overlay?.rules.length) return base;
  return { version: 1, rules: [...base.rules, ...overlay.rules] };
}

function haystackOf(parts: Array<string | undefined>): string {
  return parts
    .filter((part): part is string => Boolean(part?.trim()))
    .join(" ")
    .toLowerCase()
    .replace(/-/g, " ");
}

export function requireRuleApplies(
  rule: RequireBindRule,
  input: {
    intent?: string;
    domain?: string;
    journey?: string;
    product?: string;
    frameName?: string;
    pack?: string;
  },
): boolean {
  if (!requireHasScope(rule)) return false;
  const hay = haystackOf([
    input.intent,
    input.domain,
    input.journey,
    input.product,
    input.frameName,
    input.pack,
  ]);
  if (rule.screenType) {
    const needle = rule.screenType.toLowerCase().replace(/-/g, " ");
    if (!hay.includes(needle)) return false;
  }
  if (rule.slot) {
    const needle = rule.slot.toLowerCase().replace(/-/g, " ");
    const tokens = needle.split(/\s+/).filter(Boolean);
    if (!tokens.some((token) => hay.includes(token))) return false;
  }
  if (rule.journey) {
    const needle = rule.journey.toLowerCase().replace(/-/g, " ");
    if (!hay.includes(needle)) return false;
  }
  if (rule.product) {
    const needle = rule.product.toLowerCase().replace(/-/g, " ");
    if (!hay.includes(needle)) return false;
  }
  if (rule.pack) {
    const needle = rule.pack.toLowerCase().replace(/-/g, " ");
    if (!hay.includes(needle)) return false;
  }
  return true;
}

function forbidMatches(rule: ForbidBindRule, node: GraphNode, sock?: SockState): boolean {
  const needle = rule.forbid.trim().toLowerCase();
  if (needle === "deprecated") return node.status === "deprecated";
  if (needle === "removed") return isRemovedByAbsence(sock, node) || node.metadata?.["removedByAbsence"] === true;
  if (node.id.toLowerCase() === needle) return true;
  if (node.name.toLowerCase() === needle) return true;
  if (node.figmaNodeId && idVariants(node.figmaNodeId).some((id) => id.toLowerCase() === needle)) return true;
  return false;
}

function fileMatchesLibrary(
  node: GraphNode,
  library: string,
  workspace: WorkspaceManifest | undefined,
  graphFileKey?: string,
): boolean {
  const fileKey = nodeFileKey(node, graphFileKey);
  const needle = library.trim().toLowerCase();
  if (fileKey?.toLowerCase() === needle) return true;
  const mapped = libraryNeedle(workspace, library);
  return Boolean(mapped && fileKey && mapped.toLowerCase() === fileKey.toLowerCase());
}

export function bindRuleHit(rules: BindRulesFile, node: GraphNode, options: {
  intent?: string;
  domain?: string;
  journey?: string;
  product?: string;
  frameName?: string;
  pack?: string;
  workspace?: WorkspaceManifest;
  graphFileKey?: string;
  sock?: SockState;
}): string | undefined {
  for (const rule of rules.rules) {
    switch (rule.kind) {
      case "require":
        if (
          requireRuleApplies(rule, options) &&
          (rule.requireId === node.id || rule.require === node.id || rule.require.toLowerCase() === node.name.toLowerCase())
        ) {
          return ruleLabel(rule);
        }
        break;
      case "forbid":
        if (forbidMatches(rule, node, options.sock)) return ruleLabel(rule);
        break;
      case "prefer":
        if (fileMatchesLibrary(node, rule.preferKey ?? rule.prefer, options.workspace, options.graphFileKey)) {
          return ruleLabel(rule);
        }
        break;
      default: {
        const _exhaustive: never = rule;
        return _exhaustive;
      }
    }
  }
  return undefined;
}

export function filterAndScoreByBindRules<T extends { node: GraphNode; score: number }>(
  entries: T[],
  rules: BindRulesFile,
  options: {
    intent?: string;
    domain?: string;
    journey?: string;
    product?: string;
    frameName?: string;
    pack?: string;
    workspace?: WorkspaceManifest;
    graphFileKey?: string;
    sock?: SockState;
    index?: GraphIndex;
    inject?: (node: GraphNode) => T;
  },
): T[] {
  let next = entries.filter((entry) => {
    for (const rule of rules.rules) {
      if (rule.kind === "forbid" && forbidMatches(rule, entry.node, options.sock)) return false;
    }
    return true;
  });

  for (const rule of rules.rules) {
    if (rule.kind !== "prefer") continue;
    next = next.map((entry) => {
      if (fileMatchesLibrary(entry.node, rule.preferKey ?? rule.prefer, options.workspace, options.graphFileKey)) {
        return { ...entry, score: entry.score + 48 };
      }
      if (fileMatchesLibrary(entry.node, rule.overKey ?? rule.over, options.workspace, options.graphFileKey)) {
        return { ...entry, score: entry.score - 48 };
      }
      return entry;
    });
  }

  const requireRules = rules.rules.filter(
    (rule): rule is RequireBindRule => rule.kind === "require" && requireRuleApplies(rule, options),
  );
  if (!requireRules.length || !options.index) return next;

  const required: GraphNode[] = [];
  for (const rule of requireRules) {
    let master: GraphNode | undefined;
    try {
      master = rule.requireId
        ? options.index.getNode(rule.requireId)
        : resolveRequireMaster(options.index, rule.require, `Bind rule ${ruleLabel(rule)}`);
    } catch {
      continue;
    }
    if (master && !required.some((node) => node.id === master!.id)) required.push(master);
  }
  if (!required.length) return next;

  const requiredIds = new Set(required.map((node) => node.id));
  const kept = next.filter((entry) => requiredIds.has(entry.node.id));
  if (kept.length) return kept;
  if (!options.inject) return [];
  return required.map((node) => ({ ...options.inject!(node), score: 10_000 }));
}

export function whyLine(facts: WhyFacts): string {
  const parts: string[] = [];
  if (typeof facts.usageScreens === "number" && facts.usageScreens > 0) {
    const noun = facts.usageScreens === 1 ? "real screen" : "real screens";
    const confidence =
      facts.confidence === "strong" ? ", strong" : facts.confidence === "low" ? ", low confidence" : "";
    parts.push(`used on ${facts.usageScreens} ${noun}${confidence}`);
  }
  if (facts.deprecated) parts.push("deprecated");
  if (facts.removed) parts.push("removed");
  if (facts.stale) parts.push("stale");
  if (facts.packJourney) parts.push(`matches ${facts.packJourney}`);
  if (facts.bindRule) parts.push(`bind rule ${facts.bindRule}`);
  return parts.length ? parts.join("; ") : "no usage yet";
}

export function whyLineForMaster(
  node: GraphNode,
  options: {
    sock?: SockState;
    packJourney?: string;
    bindRule?: string;
    graphFileKey?: string;
  } = {},
): string {
  const pattern = options.sock ? patternFor(options.sock, node.id) : undefined;
  const freshness = options.sock
    ? freshnessSummary(options.sock, nodeFileKey(node, options.graphFileKey))
    : undefined;
  const removed =
    isRemovedByAbsence(options.sock, node) || node.metadata?.["removedByAbsence"] === true;
  return whyLine({
    usageScreens: pattern?.screens.length,
    confidence: pattern?.confidence,
    stale: freshness?.stale,
    deprecated: node.status === "deprecated",
    removed,
    packJourney: options.packJourney,
    bindRule: options.bindRule,
  });
}

export function packJourneyPhrase(context?: {
  product?: { name?: string; id?: string };
  domain?: string;
  journey?: { step?: string; screenJob?: string };
}): string | undefined {
  if (!context) return undefined;
  const bits = [
    context.product?.name || context.product?.id,
    context.domain,
    context.journey?.screenJob || context.journey?.step,
  ].filter((bit): bit is string => Boolean(bit?.trim()));
  return bits.length ? bits.join(" ") : undefined;
}

export function verifyBindRules(
  index: GraphIndex,
  rules: BindRulesFile,
  placed: GraphNode[],
  options: {
    intent?: string;
    domain?: string;
    journey?: string;
    product?: string;
    frameName?: string;
    pack?: string;
    sock?: SockState;
  } = {},
): BindRuleFailure | undefined {
  for (const rule of rules.rules) {
    switch (rule.kind) {
      case "forbid": {
        const hit = placed.find((node) => forbidMatches(rule, node, options.sock));
        if (!hit) break;
        const reason =
          rule.forbid === "deprecated"
            ? "placed a deprecated master"
            : rule.forbid === "removed"
              ? "placed a removed master"
              : `placed forbidden ${hit.name}`;
        return { rule: ruleLabel(rule), reason };
      }
      case "require": {
        if (!requireRuleApplies(rule, options)) break;
        let master: GraphNode | undefined;
        try {
          master = rule.requireId
            ? index.getNode(rule.requireId)
            : resolveRequireMaster(index, rule.require, `Bind rule ${ruleLabel(rule)}`);
        } catch {
          break;
        }
        if (!master) break;
        if (placed.some((node) => node.id === master.id)) break;
        const place = placeReady(master, index.graph.fileKey);
        return {
          rule: ruleLabel(rule),
          reason: `missing required master ${master.name}`,
          expected: {
            id: master.id,
            name: master.name,
            ...(place.figmaNodeId ? { figmaNodeId: place.figmaNodeId, nodeId: place.nodeId } : {}),
            ...(place.fileKey ? { fileKey: place.fileKey } : {}),
            hint: place.published ? "Place fileKey + nodeId + componentKey." : "Place fileKey + nodeId.",
          },
        };
      }
      case "prefer":
        break;
      default: {
        const _exhaustive: never = rule;
        return _exhaustive;
      }
    }
  }
  return undefined;
}

export function suggestedRuleFromPattern(pattern: {
  masterId: string;
  name: string;
  screens: string[];
  screenType?: string;
  slot?: string;
  journey?: string;
  product?: string;
  pack?: string;
}): RequireBindRule {
  if (!requireHasScope(pattern)) {
    throw new BindRuleError(
      `Proposal for ${pattern.name} has no scope from verified frames. Unscoped require is invalid. Never guessing.`,
    );
  }
  const scope = [pattern.screenType, pattern.slot, pattern.journey, pattern.product, pattern.pack]
    .filter(Boolean)
    .join("/");
  return {
    kind: "require",
    id: `require:${scope}/${pattern.masterId}`,
    ...(pattern.screenType ? { screenType: pattern.screenType } : {}),
    ...(pattern.slot ? { slot: pattern.slot } : {}),
    ...(pattern.journey ? { journey: pattern.journey } : {}),
    ...(pattern.product ? { product: pattern.product } : {}),
    ...(pattern.pack ? { pack: pattern.pack } : {}),
    require: pattern.masterId,
    requireId: pattern.masterId,
    requireName: pattern.name,
  };
}

function autoId(rule: BindRule): boolean {
  return rule.id.startsWith("require:") || rule.id.startsWith("forbid:") || rule.id.startsWith("prefer:");
}

export function toHumanRule(rule: BindRule): Record<string, string> {
  switch (rule.kind) {
    case "require": {
      const row: Record<string, string> = {};
      if (rule.id && !autoId(rule)) row.id = rule.id;
      if (rule.screenType) row.screenType = rule.screenType;
      if (rule.slot) row.slot = rule.slot;
      if (rule.journey) row.journey = rule.journey;
      if (rule.product) row.product = rule.product;
      if (rule.pack) row.pack = rule.pack;
      row.require = rule.require;
      return row;
    }
    case "forbid": {
      const row: Record<string, string> = {};
      if (rule.id && !autoId(rule)) row.id = rule.id;
      row.forbid = rule.forbid;
      return row;
    }
    case "prefer": {
      const row: Record<string, string> = {};
      if (rule.id && !autoId(rule)) row.id = rule.id;
      row.prefer = rule.prefer;
      row.over = rule.over;
      return row;
    }
    default: {
      const _exhaustive: never = rule;
      return _exhaustive;
    }
  }
}

export function serializeBindRulesFile(file: BindRulesFile): { version: 1; rules: Array<Record<string, string>> } {
  return {
    version: 1,
    rules: file.rules.map(toHumanRule),
  };
}

export function rulesEquivalent(left: BindRule, right: BindRule): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "require": {
      if (right.kind !== "require") return false;
      const leftNeedle = (left.requireId ?? left.require).toLowerCase();
      const rightNeedle = (right.requireId ?? right.require).toLowerCase();
      const leftName = (left.requireName ?? left.require).toLowerCase();
      const rightName = (right.requireName ?? right.require).toLowerCase();
      const sameTarget =
        leftNeedle === rightNeedle ||
        leftName === rightName ||
        left.require.toLowerCase() === right.require.toLowerCase();
      return (
        sameTarget &&
        (left.screenType ?? "").toLowerCase() === (right.screenType ?? "").toLowerCase() &&
        (left.slot ?? "").toLowerCase() === (right.slot ?? "").toLowerCase() &&
        (left.journey ?? "").toLowerCase() === (right.journey ?? "").toLowerCase() &&
        (left.product ?? "").toLowerCase() === (right.product ?? "").toLowerCase() &&
        (left.pack ?? "").toLowerCase() === (right.pack ?? "").toLowerCase()
      );
    }
    case "forbid":
      return right.kind === "forbid" && left.forbid.toLowerCase() === right.forbid.toLowerCase();
    case "prefer":
      return (
        right.kind === "prefer" &&
        left.prefer.toLowerCase() === right.prefer.toLowerCase() &&
        left.over.toLowerCase() === right.over.toLowerCase()
      );
    default: {
      const _exhaustive: never = left;
      return _exhaustive;
    }
  }
}

export function assertRuleWritable(
  rule: BindRule,
  options: {
    index?: GraphIndex;
    workspace?: WorkspaceManifest;
    sock?: SockState;
    existing?: BindRulesFile;
  } = {},
): BindRule {
  if (options.existing?.rules.some((row) => rulesEquivalent(row, rule))) {
    throw new BindRuleError(`Bind rule ${ruleLabel(rule)}: duplicate rule. Already in bind-rules.json.`);
  }
  switch (rule.kind) {
    case "require": {
      if (!requireHasScope(rule)) {
        throw new BindRuleError(
          `Bind rule ${ruleLabel(rule)}: unscoped require is invalid. Need screenType, slot, journey, product, or pack. Never guessing.`,
        );
      }
      if (!options.index) {
        throw new BindRuleError(
          `Bind rule ${ruleLabel(rule)}: cannot approve without a graph. Ingest first. Never guessing.`,
        );
      }
      const master = resolveRequireMaster(options.index, rule.require, `Bind rule ${ruleLabel(rule)}`);
      if (master.status === "deprecated") {
        throw new BindRuleError(
          `Bind rule ${ruleLabel(rule)}: master "${master.name}" (${master.id}) is deprecated. Never guessing.`,
        );
      }
      if (isRemovedByAbsence(options.sock, master) || master.metadata?.["removedByAbsence"] === true) {
        throw new BindRuleError(
          `Bind rule ${ruleLabel(rule)}: master "${master.name}" (${master.id}) was removed. Never guessing.`,
        );
      }
      return { ...rule, require: rule.require, requireId: master.id, requireName: master.name };
    }
    case "forbid":
      return rule;
    case "prefer": {
      if (!options.workspace?.files.length) return rule;
      return resolveBindRules({ version: 1, rules: [rule] }, { workspace: options.workspace }).rules[0]!;
    }
    default: {
      const _exhaustive: never = rule;
      return _exhaustive;
    }
  }
}

function resolveOneLenient(
  rule: BindRule,
  options: { index?: GraphIndex; workspace?: WorkspaceManifest; sock?: SockState },
): { rule?: BindRule; warning?: BindRuleWarning } {
  try {
    if (rule.kind === "require" && !requireHasScope(rule)) {
      return {
        warning: {
          rule: ruleLabel(rule),
          reason: "unscoped require is invalid. Need screenType, slot, journey, product, or pack.",
        },
      };
    }
    if (rule.kind === "require" && options.index) {
      const master = resolveRequireMaster(options.index, rule.require, `Bind rule ${ruleLabel(rule)}`);
      if (master.status === "deprecated") {
        return {
          warning: {
            rule: ruleLabel(rule),
            reason: `master "${master.name}" (${master.id}) is deprecated`,
          },
        };
      }
      if (isRemovedByAbsence(options.sock, master) || master.metadata?.["removedByAbsence"] === true) {
        return {
          warning: {
            rule: ruleLabel(rule),
            reason: `master "${master.name}" (${master.id}) was removed`,
          },
        };
      }
      return { rule: { ...rule, requireId: master.id, requireName: master.name } };
    }
    if (rule.kind === "prefer" && options.workspace?.files.length) {
      return { rule: resolveBindRules({ version: 1, rules: [rule] }, { workspace: options.workspace }).rules[0] };
    }
    return { rule };
  } catch (error) {
    return {
      warning: {
        rule: ruleLabel(rule),
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** Load-time parse: skip invalid rules, keep the rest, name each skip. */
export function loadBindRulesLenient(
  raw: unknown,
  options: { index?: GraphIndex; workspace?: WorkspaceManifest; sock?: SockState } = {},
): BindRulesFile {
  const warnings: BindRuleWarning[] = [];
  if (raw == null) return emptyBindRules();
  let list: unknown[];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    const rules = record["rules"] ?? record["bindRules"];
    if (rules == null) return emptyBindRules();
    if (!Array.isArray(rules)) {
      return {
        version: 1,
        rules: [],
        warnings: [{ rule: "bind-rules.json", reason: "`rules` must be an array. Never guessing." }],
      };
    }
    list = rules;
  } else {
    return {
      version: 1,
      rules: [],
      warnings: [{ rule: "bind-rules.json", reason: "must be a JSON object or array. Never guessing." }],
    };
  }
  const kept: BindRule[] = [];
  list.forEach((item, index) => {
    try {
      const parsed = parseOne(item, index);
      const resolved = resolveOneLenient(parsed, options);
      if (resolved.warning) warnings.push(resolved.warning);
      if (resolved.rule) kept.push(resolved.rule);
    } catch (error) {
      warnings.push({
        rule: `rule ${index + 1}`,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  });
  return { version: 1, rules: kept, ...(warnings.length ? { warnings } : {}) };
}

export function applyProposalDecision(
  sock: SockState,
  rules: BindRulesFile,
  proposalId: string,
  action: "approve" | "reject",
  who: string,
  when: string,
  options: {
    index?: GraphIndex;
    workspace?: WorkspaceManifest;
  } = {},
): { sock: SockState; rules: BindRulesFile; audit: AuditLine } {
  const proposal = sock.proposals.find((row) => row.id === proposalId);
  if (!proposal) {
    throw new BindRuleError(`Proposal "${proposalId}" not found.`);
  }
  if (proposal.status !== "pending") {
    throw new BindRuleError(`Proposal "${proposalId}" is already ${proposal.status}.`);
  }
  const before = rules.rules;
  let after = before;
  let nextRules = rules;
  if (action === "approve") {
    const suggested = proposal.suggestedRule;
    if (!suggested) {
      throw new BindRuleError(
        `Proposal "${proposalId}" has no suggested rule. Write bind-rules.json by hand.`,
      );
    }
    const parsed = parseBindRulesFile({ rules: [suggested] });
    const written = parsed.rules.map((rule) =>
      assertRuleWritable(rule, {
        index: options.index,
        workspace: options.workspace,
        sock,
        existing: rules,
      }),
    );
    nextRules = mergeBindRules(rules, { version: 1, rules: written });
    after = nextRules.rules;
  }
  const nextProposals: SociProposal[] = sock.proposals.map((row) =>
    row.id === proposalId ? { ...row, status: action === "approve" ? "approved" : "rejected" } : row,
  );
  return {
    sock: { ...sock, proposals: nextProposals },
    rules: nextRules,
    audit: {
      who,
      when,
      proposalId,
      action,
      before,
      after,
    },
  };
}

export function actorName(flag?: string, env: NodeJS.ProcessEnv = process.env): string {
  return flag?.trim() || env["RESOLVE_ACTOR"]?.trim() || env["USER"]?.trim() || "human";
}
