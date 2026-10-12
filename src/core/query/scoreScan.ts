import { COMPONENT_DEFINITION_TYPES, type GraphNode } from "@/core/model";
import { sameFamily } from "@/core/rules/family";
import { GENERIC_UI_NOUNS } from "@/core/rules/names";
import type { GraphIndex } from "./GraphIndex";
import { isPrivateMasterName, preferNamedMaster, variantCardName, type RecommendContext } from "./agentSurface";
import type { GoldenCase, ScorePick, ScoreTool, ToolCaseResult, ToolSpec } from "./scoreboard";

export interface BoundCase extends GoldenCase {
  expectedIds: Set<string>;
  acceptIds: Set<string>;
  mustNotIds: Set<string>;
  expectedNode?: GraphNode;
}

export interface GraphVocab {
  ids: Set<string>;
  /** Every node name, including frames. Used for where-used screen labels. */
  names: Set<string>;
  /** COMPONENT_SET / MAIN_COMPONENT / VARIANT names only. */
  componentNames: Set<string>;
  fileKeys: Set<string>;
  byId: Map<string, GraphNode>;
}

function specificTokens(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((part) => part.length > 1 && !GENERIC_UI_NOUNS.has(part)),
  );
}


function isGraphCousin(expected: GraphNode, pick: GraphNode): boolean {
  if (sameFamily(expected, pick)) return false;
  const left = specificTokens(expected.name);
  const right = specificTokens(pick.name);
  for (const token of left) {
    if (right.has(token)) return true;
  }
  return false;
}

function normalizeRole(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s]+/g, "-");
}

/** Exact master name → one node. Missing throws. Same-name stubs yield the populated set. */
export function resolveMasterByName(index: GraphIndex, name: string): GraphNode {
  const needle = name.trim().toLowerCase();
  const hits = index
    .getNodesByType(...COMPONENT_DEFINITION_TYPES)
    .filter((node) => node.name.toLowerCase() === needle);
  if (!hits.length) {
    throw new Error(
      `No master named "${name}" in this graph. Scoreboard will not invent an id. Ingest the library the golden set was written for.`,
    );
  }
  const picked = preferNamedMaster(index, hits);
  if (!picked) {
    throw new Error(
      `No master named "${name}" in this graph. Scoreboard will not invent an id. Ingest the library the golden set was written for.`,
    );
  }
  return picked;
}

export function vocabOf(index: GraphIndex): GraphVocab {
  const ids = new Set<string>();
  const names = new Set<string>();
  const componentNames = new Set<string>();
  const fileKeys = new Set<string>();
  const byId = new Map<string, GraphNode>();
  const masterTypes = new Set<string>(COMPONENT_DEFINITION_TYPES);
  if (index.graph.fileKey) fileKeys.add(index.graph.fileKey);
  for (const node of index.allNodes) {
    ids.add(node.id);
    if (node.figmaNodeId) ids.add(node.figmaNodeId);
    names.add(node.name);
    if (masterTypes.has(node.type)) {
      componentNames.add(node.name);
      if (node.type === "VARIANT") componentNames.add(variantCardName(index, node));
    }
    if (node.fileKey) fileKeys.add(node.fileKey);
    byId.set(node.id, node);
    const key = node.metadata?.["key"];
    if (typeof key === "string" && key.trim()) ids.add(key.trim());
  }
  return { ids, names, componentNames, fileKeys, byId };
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boolOf(value: unknown): boolean {
  return value === true;
}

interface RefBag {
  ids: string[];
  names: string[];
  screenNames: string[];
}

function pushId(bag: RefBag, value: unknown): void {
  const text = stringOf(value);
  if (text) bag.ids.push(text);
}

function pushName(bag: RefBag, value: unknown): void {
  const text = stringOf(value);
  if (text) bag.names.push(text);
}

const FREE_TEXT_KEYS = new Set([
  "hint",
  "why",
  "intent",
  "query",
  "notes",
  "note",
  "nextRecommend",
  "summary",
  "evidence",
  "label",
  "guess",
  "exWhy",
]);

const COMPONENT_NAME_PARENTS = new Set(["component", "master", "candidates", "components", "didYouMean"]);
const LOCATION_NAME_PARENTS = new Set(["whereUsed", "screen", "byScreen", "pages", "page"]);

/** Ids in hint / why, and a frame name only when the text quotes it as a component. */
function scanFreeText(value: unknown, bag: RefBag, known: GraphVocab): void {
  const text = stringOf(value);
  if (!text) return;
  for (const match of text.matchAll(/\bnode:[A-Za-z0-9:_./-]+/g)) bag.ids.push(match[0]);
  for (const match of text.matchAll(/\b\d+:\d+\b/g)) bag.ids.push(match[0]);
  for (const match of text.matchAll(/"([^"]{1,80})"|'([^']{1,80})'/g)) {
    const quoted = (match[1] ?? match[2] ?? "").trim();
    if (!quoted || known.componentNames.has(quoted)) continue;
    if (known.names.has(quoted)) bag.names.push(quoted);
  }
}

/**
 * Ids and component names a card offers. Skips echoed inputs and recipe/pack ids.
 * `screenNames` are where-used labels (frames are allowed). `names` must be masters.
 */
function collectCardRefs(value: unknown, parentKey: string | undefined, bag: RefBag, known: GraphVocab): void {
  if (parentKey === "recipe" || parentKey === "context" || parentKey === "cost") return;
  if (Array.isArray(value)) {
    for (const item of value) collectCardRefs(item, parentKey, bag, known);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  const given = stringOf(record["given"]);
  for (const [key, child] of Object.entries(record)) {
    if (FREE_TEXT_KEYS.has(key)) {
      scanFreeText(child, bag, known);
      continue;
    }
    if (key === "id" || key === "figmaNodeId" || key === "nodeId" || key === "masterId" || key === "componentKey") {
      pushId(bag, child);
      continue;
    }
    if (key === "fileKey") {
      pushId(bag, child);
      continue;
    }
    if (key === "name" || key === "set") {
      const text = stringOf(child);
      if (text && text !== given) {
        const slot = parentKey ?? "";
        if (key === "set" || COMPONENT_NAME_PARENTS.has(slot)) bag.names.push(text);
        else if (LOCATION_NAME_PARENTS.has(slot)) bag.screenNames.push(text);
      }
      continue;
    }
    if (key === "didYouMean") {
      const suggestion = asRecord(child);
      if (suggestion) {
        pushId(bag, suggestion["id"]);
        pushName(bag, suggestion["name"]);
        pushId(bag, suggestion["fileKey"]);
      }
      continue;
    }
    collectCardRefs(child, key, bag, known);
  }
}

export function inventsInCard(card: unknown, index: GraphIndex): string[] {
  const known = vocabOf(index);
  const bag: RefBag = { ids: [], names: [], screenNames: [] };
  collectCardRefs(card, undefined, bag, known);
  const invents: string[] = [];
  for (const id of bag.ids) {
    if (known.ids.has(id) || known.fileKeys.has(id)) continue;
    invents.push(`id ${id}`);
  }
  for (const name of bag.names) {
    if (known.componentNames.has(name)) continue;
    invents.push(`name ${name}`);
  }
  for (const name of bag.screenNames) {
    if (known.names.has(name)) continue;
    invents.push(`name ${name}`);
  }
  return invents;
}

function nodeOf(vocab: GraphVocab, id: string | undefined): GraphNode | undefined {
  if (!id) return undefined;
  return vocab.byId.get(id);
}

function pickFrom(vocab: GraphVocab, raw: Record<string, unknown>): ScorePick | undefined {
  const name = stringOf(raw["name"]);
  const id = stringOf(raw["id"]);
  if (!name && !id) return undefined;
  const node = nodeOf(vocab, id);
  const resolvedName = name ?? node?.name;
  if (!resolvedName) return undefined;
  const deprecated = boolOf(raw["deprecated"]) || raw["status"] === "deprecated" || node?.status === "deprecated";
  const privateName = isPrivateMasterName(resolvedName) || (node ? isPrivateMasterName(node.name) : false);
  return {
    ...(id ? { id } : {}),
    name: resolvedName,
    deprecated,
    private: privateName,
  };
}

function picksFromList(vocab: GraphVocab, value: unknown): ScorePick[] {
  if (!Array.isArray(value)) return [];
  const picks: ScorePick[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const pick = pickFrom(vocab, record);
    if (pick) picks.push(pick);
  }
  return picks;
}

export function recommendPicks(card: unknown, vocab: GraphVocab): ScorePick[] {
  const record = asRecord(card);
  return picksFromList(vocab, record?.["candidates"]);
}

export function resolvePicks(card: unknown, vocab: GraphVocab): ScorePick[] {
  const record = asRecord(card);
  if (!record || record["found"] !== true) return [];
  if (record["kind"] === "component") {
    const component = asRecord(record["component"]);
    const pick = component ? pickFrom(vocab, component) : undefined;
    return pick ? [pick] : [];
  }
  if (record["kind"] === "screen") return picksFromList(vocab, record["components"]);
  return [];
}

export function recipePicks(card: unknown, vocab: GraphVocab, slot?: string): ScorePick[] {
  const record = asRecord(card);
  if (!record || record["found"] !== true) return [];
  const slots = Array.isArray(record["slots"]) ? record["slots"] : [];
  const wanted = slot ? normalizeRole(slot) : undefined;
  const picks: ScorePick[] = [];
  for (const item of slots) {
    const row = asRecord(item);
    if (!row) continue;
    if (wanted && normalizeRole(stringOf(row["role"]) ?? "") !== wanted) continue;
    const status = stringOf(row["status"]);
    if (status !== "bound" && status !== "filled") continue;
    const master = asRecord(row["master"]);
    const pick = master ? pickFrom(vocab, master) : undefined;
    if (pick) picks.push(pick);
  }
  return picks;
}

/** Masters verify approved. Flagged, rejected, and did-you-mean hits are not offers. */
export function verifyApproved(card: unknown, vocab: GraphVocab): ScorePick[] {
  const record = asRecord(card);
  if (!record) return [];
  const blocked = new Set<string>();
  for (const key of ["invents", "deprecated", "unresolved"]) {
    const list = record[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const row = asRecord(item);
      const id = stringOf(row?.["id"]);
      if (id) blocked.add(id);
    }
  }
  const picks: ScorePick[] = [];
  if (!Array.isArray(record["resolved"])) return picks;
  for (const item of record["resolved"]) {
    const row = asRecord(item);
    if (!row) continue;
    const id = stringOf(row["id"]);
    if (!id || blocked.has(id)) continue;
    const pick = pickFrom(vocab, row);
    if (pick) picks.push(pick);
  }
  return picks;
}

/** What verify identified for a name: an approval, a did-you-mean, or a flagged master. */
export function verifyNameHits(card: unknown, vocab: GraphVocab): ScorePick[] {
  const approved = verifyApproved(card, vocab);
  if (approved.length) return approved;
  const record = asRecord(card);
  if (!record) return [];
  const suggestions: ScorePick[] = [];
  if (Array.isArray(record["unresolved"])) {
    for (const item of record["unresolved"]) {
      const suggestion = asRecord(asRecord(item)?.["didYouMean"]);
      const pick = suggestion ? pickFrom(vocab, suggestion) : undefined;
      if (pick) suggestions.push(pick);
    }
  }
  if (suggestions.length) return suggestions;
  const flagged = [
    ...picksFromList(vocab, record["deprecated"]),
    ...picksFromList(vocab, record["invents"]),
  ];
  return flagged.filter((pick) => pick.id && vocab.componentNames.has(pick.name));
}

export function cardChars(card: unknown): number {
  const record = asRecord(card);
  const cost = asRecord(record?.["cost"]);
  const chars = cost?.["chars"];
  if (typeof chars === "number" && Number.isFinite(chars)) return chars;
  return JSON.stringify(card).length;
}

export function contextFor(row: GoldenCase): RecommendContext | undefined {
  if (!row.screenType && !row.journey && !row.slot) return undefined;
  const screenJob = [row.journey, row.screenType].filter(Boolean).join(" ");
  return {
    id: row.screenType || row.journey || row.slot,
    ...(row.screenType ? { domain: row.screenType, screenType: row.screenType } : {}),
    ...(screenJob || row.slot
      ? {
          journey: {
            ...(row.slot ? { step: row.slot } : {}),
            ...(screenJob ? { screenJob } : {}),
          },
        }
      : {}),
  };
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index]!;
}

/** Null when nothing was scored. Callers must print that as n/a, not 0%. */
export function rate(hits: number, total: number): number | null {
  if (total <= 0) return null;
  return hits / total;
}

export function isRecipeCase(row: GoldenCase): boolean {
  if (!row.tools) return false;
  if (Array.isArray(row.tools)) return row.tools.includes("recipe");
  return row.tools.recipe !== undefined;
}

function toolOverride(row: GoldenCase, tool: ScoreTool): ToolSpec | undefined {
  if (!row.tools || Array.isArray(row.tools)) return undefined;
  return row.tools[tool];
}

interface ToolExpectation {
  applicable: boolean;
  expect: "master" | "empty";
  expectedIds: Set<string>;
  acceptIds: Set<string>;
  mustNotIds: Set<string>;
  expectedNode?: GraphNode;
  expectedName?: string;
}

function idsForNames(index: GraphIndex, names: string[]): Set<string> {
  return new Set(names.map((name) => resolveMasterByName(index, name).id));
}

function nameLikeMaster(index: GraphIndex, intent: string): GraphNode | undefined {
  const needle = intent.trim().toLowerCase();
  const hits = index
    .getNodesByType(...COMPONENT_DEFINITION_TYPES)
    .filter((node) => node.name.toLowerCase() === needle);
  if (!hits.length) return undefined;
  return preferNamedMaster(index, hits);
}

export function expectationFor(tool: ScoreTool, row: BoundCase, index: GraphIndex): ToolExpectation {
  const override = toolOverride(row, tool);
  if (override?.expect === "skip") {
    return {
      applicable: false,
      expect: "empty",
      expectedIds: new Set(),
      acceptIds: new Set(),
      mustNotIds: new Set(),
    };
  }
  const named =
    override?.expected !== undefined
      ? resolveMasterByName(index, override.expected)
      : tool === "verify"
        ? nameLikeMaster(index, row.intent)
        : row.expectedNode;
  const expectMode: "master" | "empty" =
    override?.expect === "master" || override?.expect === "empty"
      ? override.expect
      : tool === "verify"
        ? named
          ? "master"
          : "empty"
        : row.expect;
  const inherited = !override?.expected && override?.expect === undefined;
  const acceptIds = idsForNames(index, override?.accept ?? (inherited ? (row.accept ?? []) : []));
  const mustNotIds = idsForNames(index, override?.mustNot ?? (inherited ? (row.mustNot ?? []) : []));
  const applicable = tool === "verify" ? Boolean(override || named) : true;
  return {
    applicable,
    expect: expectMode,
    expectedIds: new Set(named && expectMode === "master" ? [named.id] : []),
    acceptIds,
    mustNotIds,
    ...(named ? { expectedNode: named, expectedName: named.name } : {}),
  };
}

function acceptableIds(spec: ToolExpectation): Set<string> {
  return new Set([...spec.expectedIds, ...spec.acceptIds]);
}

/**
 * A deprecated or private master offered as a pick. The same pick is not also
 * a wrong cousin, and a master the tool was supposed to return is not a leak.
 */
function offeredLeak(picks: ScorePick[], acceptable: Set<string>, wrongCousin: boolean): boolean {
  return picks.some((pick, index) => {
    if (!pick.deprecated && !pick.private) return false;
    if (pick.id && acceptable.has(pick.id)) return false;
    if (wrongCousin && index === 0) return false;
    return true;
  });
}

export function grade(
  tool: ScoreTool,
  spec: ToolExpectation,
  picks: ScorePick[],
  leakPicks: ScorePick[],
  index: GraphIndex,
): Omit<ToolCaseResult, "chars" | "ms" | "picks" | "invents" | "candidates"> {
  if (!spec.applicable) {
    return {
      tool,
      expect: spec.expect,
      top1: false,
      top3: false,
      emptyOk: false,
      wrongCousin: false,
      leaked: false,
      applicable: false,
    };
  }
  const top = picks[0];
  const acceptable = acceptableIds(spec);
  const pickHits = (pick: ScorePick): boolean => {
    if (pick.id && acceptable.has(pick.id)) return true;
    const node = pick.id ? index.getNode(pick.id) : undefined;
    if (!node) return false;
    if (spec.expectedNode && sameFamily(spec.expectedNode, node)) return true;
    for (const id of spec.acceptIds) {
      const accept = index.getNode(id);
      if (accept && sameFamily(accept, node)) return true;
    }
    return false;
  };
  const inTop = (limit: number) => picks.slice(0, limit).some(pickHits);
  const masterCase = spec.expect === "master";
  const acceptedTop = Boolean(spec.expect === "empty" && top?.id && spec.acceptIds.has(top.id));
  const wrongCousin = Boolean(
    masterCase &&
      top?.id &&
      !acceptable.has(top.id) &&
      (spec.mustNotIds.has(top.id) || isCousinPick(spec.expectedNode, top, index)),
  );
  return {
    tool,
    expect: spec.expect,
    top1: masterCase ? inTop(1) : false,
    top3: masterCase ? inTop(3) : false,
    emptyOk: spec.expect === "empty" ? picks.length === 0 || acceptedTop : false,
    wrongCousin,
    leaked: offeredLeak(leakPicks, acceptable, wrongCousin),
    applicable: true,
  };
}

export function isCousinPick(expected: GraphNode | undefined, pick: ScorePick, index: GraphIndex): boolean {
  if (!expected || !pick.id) return false;
  const node = index.getNode(pick.id);
  if (!node) return false;
  return isGraphCousin(expected, node);
}
