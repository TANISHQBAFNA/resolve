import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { COMPONENT_DEFINITION_TYPES, type GraphNode } from "@/core/model";
import type { GraphIndex } from "./GraphIndex";
import {
  componentUsageCard,
  isPrivateMasterName,
  recommendMasters,
  verifyFrame,
  type RecommendContext,
} from "./agentSurface";
import type { BindRulesFile } from "./bindRules";
import { recipeCard, starterRecipes, type Recipe } from "./recipes";
import type { SockState } from "./sock";
import type { WorkspaceManifest } from "./workspace";

/**
 * Accuracy scoreboard. Scores recommend / resolve / recipe / verify cards
 * against a golden set. Expected masters are names, resolved to ids in the
 * current graph. Never invents an id. No Figma calls.
 */

export const SCORE_TOOLS = ["recommend", "resolve", "recipe", "verify"] as const;
export type ScoreTool = (typeof SCORE_TOOLS)[number];

/** Char budgets the agent cards must stay inside. A breach fails the run. */
export const SCORE_BUDGETS: Record<ScoreTool, number> = {
  recommend: 600,
  verify: 600,
  resolve: 2000,
  recipe: 2000,
};

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

const ToolSpecSchema = z.object({
  expect: z.enum(["master", "empty", "skip"]).optional(),
  expected: z.string().trim().min(1).optional(),
  accept: z.array(z.string().trim().min(1)).optional(),
  mustNot: z.array(z.string().trim().min(1)).optional(),
});

const CaseSchema = z.object({
  id: z.string().trim().min(1),
  intent: z.string().trim().min(1),
  screenType: z.string().trim().min(1).optional(),
  journey: z.string().trim().min(1).optional(),
  slot: z.string().trim().min(1).optional(),
  expected: z.string().trim().min(1).optional(),
  accept: z.array(z.string().trim().min(1)).optional(),
  mustNot: z.array(z.string().trim().min(1)).optional(),
  expect: z.enum(["master", "empty"]).optional(),
  note: z.string().optional(),
  tools: z
    .object({
      recommend: ToolSpecSchema.optional(),
      resolve: ToolSpecSchema.optional(),
      recipe: ToolSpecSchema.optional(),
      verify: ToolSpecSchema.optional(),
    })
    .optional(),
});

const FileSchema = z.object({
  version: z.literal(1).optional(),
  cases: z.array(CaseSchema).min(1),
});

export interface ToolSpec {
  expect?: "master" | "empty" | "skip";
  expected?: string;
  accept?: string[];
  mustNot?: string[];
}

export interface GoldenCase {
  id: string;
  intent: string;
  screenType?: string;
  journey?: string;
  slot?: string;
  expected?: string;
  accept?: string[];
  mustNot?: string[];
  expect: "master" | "empty";
  /** Per-tool override. Resolve of an exact deprecated or private name is not a recommend miss. */
  tools?: Partial<Record<ScoreTool, ToolSpec>>;
  note?: string;
}

export interface ScorePick {
  id?: string;
  name: string;
  deprecated: boolean;
  private: boolean;
}

export interface ToolCaseResult {
  tool: ScoreTool;
  picks: ScorePick[];
  /** How many masters the card actually offered. One candidate makes top-3 meaningless. */
  candidates: number;
  chars: number;
  ms: number;
  expect: "master" | "empty";
  top1: boolean;
  top3: boolean;
  emptyOk: boolean;
  wrongCousin: boolean;
  leaked: boolean;
  invents: string[];
  applicable: boolean;
}

export interface ToolRollup {
  tool: ScoreTool;
  cases: number;
  scored: number;
  top1: number;
  top3: number;
  emptyWhenWeak: number;
  wrongCousinRate: number;
  leakRate: number;
  top1Count: number;
  /** False when scored cards never hold three candidates. */
  top3Applicable: boolean;
  candidatesP50: number;
  candidatesMax: number;
  sizeP50: number;
  sizeMax: number;
  budget: number;
  overBudget: boolean;
}

export interface ScoreMiss {
  id: string;
  tool: ScoreTool;
  kind: "top1" | "empty" | "cousin" | "leak" | "invent";
  detail: string;
}

export interface ScoreReport {
  version: 1;
  at: string;
  workspace: string;
  golden: string;
  /** Hash of the golden files. Deltas compare only the same hash and workspace. */
  goldenHash?: string;
  storePath?: string;
  fileName?: string;
  builtAt?: string;
  cases: number;
  pass: boolean;
  inventRate: number;
  inventCount: number;
  wrongCousinRate: number;
  top1: number;
  top3: number;
  emptyWhenWeak: number;
  leakRate: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  budgetBreach: boolean;
  tools: ToolRollup[];
  invents: ScoreMiss[];
  misses: ScoreMiss[];
}

export interface ScoreDelta {
  hasPrevious: boolean;
  previousAt?: string;
  top1: number;
  top3: number;
  inventRate: number;
  wrongCousinRate: number;
  emptyWhenWeak: number;
  leakRate: number;
}

interface BoundCase extends GoldenCase {
  expectedIds: Set<string>;
  acceptIds: Set<string>;
  mustNotIds: Set<string>;
  expectedNode?: GraphNode;
}

interface GraphVocab {
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
      .filter((part) => part.length > 1 && !GENERIC_NAME_TOKENS.has(part)),
  );
}

function sameFamily(a: GraphNode, b: GraphNode): boolean {
  if (a.id === b.id) return true;
  if (a.componentSetId && (a.componentSetId === b.id || a.componentSetId === b.componentSetId)) {
    return true;
  }
  if (b.componentSetId && b.componentSetId === a.id) return true;
  return false;
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

/** Exact master name → one node. Missing or ambiguous throws. Never invents an id. */
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
  const rank = (node: GraphNode) =>
    node.type === "COMPONENT_SET" ? 3 : node.type === "MAIN_COMPONENT" ? 2 : 1;
  hits.sort((a, b) => rank(b) - rank(a) || a.id.localeCompare(b.id));
  const top = hits[0]!;
  const tied = hits.filter((node) => node.id !== top.id && rank(node) === rank(top) && node.type === top.type);
  if (tied.length) {
    throw new Error(
      `More than one master is named "${name}" (${[top, ...tied].map((node) => node.id).join(", ")}). Scoreboard will not guess.`,
    );
  }
  return top;
}

function vocabOf(index: GraphIndex): GraphVocab {
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
    if (masterTypes.has(node.type)) componentNames.add(node.name);
    if (node.fileKey) fileKeys.add(node.fileKey);
    byId.set(node.id, node);
    const key = node.metadata?.["key"];
    if (typeof key === "string" && key.trim()) ids.add(key.trim());
  }
  return { ids, names, componentNames, fileKeys, byId };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
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

function recommendPicks(card: unknown, vocab: GraphVocab): ScorePick[] {
  const record = asRecord(card);
  return picksFromList(vocab, record?.["candidates"]);
}

function resolvePicks(card: unknown, vocab: GraphVocab): ScorePick[] {
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

function recipePicks(card: unknown, vocab: GraphVocab, slot?: string): ScorePick[] {
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
function verifyApproved(card: unknown, vocab: GraphVocab): ScorePick[] {
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
function verifyNameHits(card: unknown, vocab: GraphVocab): ScorePick[] {
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

function cardChars(card: unknown): number {
  const record = asRecord(card);
  const cost = asRecord(record?.["cost"]);
  const chars = cost?.["chars"];
  if (typeof chars === "number" && Number.isFinite(chars)) return chars;
  return JSON.stringify(card).length;
}

function contextFor(row: GoldenCase): RecommendContext | undefined {
  if (!row.screenType && !row.journey && !row.slot) return undefined;
  const screenJob = [row.journey, row.screenType].filter(Boolean).join(" ");
  return {
    id: row.screenType || row.journey || row.slot,
    ...(row.screenType ? { domain: row.screenType } : {}),
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

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index]!;
}

function rate(hits: number, total: number): number {
  if (total <= 0) return 0;
  return hits / total;
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
  const rank = (node: GraphNode) =>
    node.type === "COMPONENT_SET" ? 3 : node.type === "MAIN_COMPONENT" ? 2 : 1;
  hits.sort((a, b) => rank(b) - rank(a) || a.id.localeCompare(b.id));
  const top = hits[0]!;
  const tied = hits.filter((node) => node.id !== top.id && rank(node) === rank(top) && node.type === top.type);
  if (tied.length) return undefined;
  return top;
}

function expectationFor(tool: ScoreTool, row: BoundCase, index: GraphIndex): ToolExpectation {
  const override = row.tools?.[tool];
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

function grade(
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
  const inTop = (limit: number) => picks.slice(0, limit).some((pick) => pick.id && acceptable.has(pick.id));
  const masterCase = spec.expect === "master";
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
    emptyOk: spec.expect === "empty" ? picks.length === 0 : false,
    wrongCousin,
    leaked: offeredLeak(leakPicks, acceptable, wrongCousin),
    applicable: true,
  };
}

function isCousinPick(expected: GraphNode | undefined, pick: ScorePick, index: GraphIndex): boolean {
  if (!expected || !pick.id) return false;
  const node = index.getNode(pick.id);
  if (!node) return false;
  return isGraphCousin(expected, node);
}

export function loadGoldenCases(path: string): GoldenCase[] {
  const stat = statSync(path);
  const files = stat.isDirectory()
    ? readdirSync(path)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => join(path, name))
    : [path];
  if (!files.length) throw new Error(`No golden JSON in ${path}.`);
  const cases: GoldenCase[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const parsed = FileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!parsed.success) {
      throw new Error(`Golden file ${file} is not valid. ${parsed.error.issues[0]?.message ?? "Check the shape."}`);
    }
    for (const row of parsed.data.cases) {
      if (seen.has(row.id)) throw new Error(`Duplicate golden case id "${row.id}".`);
      seen.add(row.id);
      const expect = row.expect ?? (row.expected ? "master" : "empty");
      if (expect === "master" && !row.expected) {
        throw new Error(`Golden case "${row.id}" expects a master but has no expected name.`);
      }
      if (expect === "empty" && row.expected) {
        throw new Error(`Golden case "${row.id}" expects an empty card but also names ${row.expected}.`);
      }
      cases.push({
        id: row.id,
        intent: row.intent,
        ...(row.screenType ? { screenType: row.screenType } : {}),
        ...(row.journey ? { journey: row.journey } : {}),
        ...(row.slot ? { slot: row.slot } : {}),
        ...(row.expected ? { expected: row.expected } : {}),
        ...(row.accept?.length ? { accept: row.accept } : {}),
        ...(row.mustNot?.length ? { mustNot: row.mustNot } : {}),
        ...(row.tools ? { tools: row.tools } : {}),
        expect,
        ...(row.note ? { note: row.note } : {}),
      });
    }
  }
  return cases;
}

function bindCases(index: GraphIndex, cases: GoldenCase[]): BoundCase[] {
  return cases.map((row) => {
    const expectedNode = row.expected ? resolveMasterByName(index, row.expected) : undefined;
    const acceptNodes = (row.accept ?? []).map((name) => resolveMasterByName(index, name));
    const mustNotNodes = (row.mustNot ?? []).map((name) => resolveMasterByName(index, name));
    return {
      ...row,
      expectedNode,
      expectedIds: new Set(expectedNode ? [expectedNode.id] : []),
      acceptIds: new Set(acceptNodes.map((node) => node.id)),
      mustNotIds: new Set(mustNotNodes.map((node) => node.id)),
    };
  });
}

export interface ScoreRunOptions {
  recipes?: Recipe[];
  sock?: SockState;
  bindRules?: BindRulesFile;
  workspace?: WorkspaceManifest;
  at?: string;
  workspaceName?: string;
  golden?: string;
  storePath?: string;
}

function leakPicksFor(
  tool: ScoreTool,
  card: unknown,
  vocab: GraphVocab,
  row: BoundCase,
): ScorePick[] {
  switch (tool) {
    case "recommend":
      return recommendPicks(card, vocab);
    case "resolve":
      return resolvePicks(card, vocab);
    case "recipe":
      return row.slot ? recipePicks(card, vocab, row.slot) : [];
    case "verify":
      return verifyApproved(card, vocab);
    default: {
      const _exhaustive: never = tool;
      return _exhaustive;
    }
  }
}

function candidateCount(tool: ScoreTool, card: unknown, picks: ScorePick[]): number {
  if (tool === "recommend") {
    const list = asRecord(card)?.["candidates"];
    return Array.isArray(list) ? list.length : picks.length;
  }
  return picks.length;
}

function picksFor(
  tool: ScoreTool,
  card: unknown,
  vocab: GraphVocab,
  row: BoundCase,
): ScorePick[] {
  switch (tool) {
    case "recommend":
      return recommendPicks(card, vocab);
    case "resolve":
      return resolvePicks(card, vocab);
    case "recipe":
      return recipePicks(card, vocab, row.slot);
    case "verify":
      return verifyNameHits(card, vocab);
    default: {
      const _exhaustive: never = tool;
      return _exhaustive;
    }
  }
}

function runTool(
  tool: ScoreTool,
  index: GraphIndex,
  row: BoundCase,
  options: ScoreRunOptions,
): unknown {
  const context = contextFor(row);
  const recipes = options.recipes ?? starterRecipes();
  switch (tool) {
    case "recommend":
      return recommendMasters(index, row.intent, {
        ...(context ? { context } : {}),
        ...(options.workspace ? { workspace: options.workspace } : {}),
        ...(options.sock ? { sock: options.sock } : {}),
        ...(options.bindRules ? { bindRules: options.bindRules } : {}),
      });
    case "resolve":
      return componentUsageCard(index, row.intent, {
        ...(options.sock ? { sock: options.sock } : {}),
      });
    case "recipe":
      return recipeCard(
        recipes,
        row.intent,
        index,
        undefined,
        context
          ? {
              packs: [],
              ...(row.screenType ? { domain: row.screenType } : {}),
              ...(row.journey ? { journey: row.journey } : {}),
              ...(options.workspace ? { workspace: options.workspace } : {}),
            }
          : options.workspace
            ? { packs: [], workspace: options.workspace }
            : undefined,
        options.sock,
        options.bindRules,
      );
    case "verify":
      return verifyFrame(index, {
        components: [row.intent],
        ...(context ? { context } : {}),
        ...(options.bindRules ? { bindRules: options.bindRules } : {}),
        ...(options.sock ? { sock: options.sock } : {}),
      });
    default: {
      const _exhaustive: never = tool;
      return _exhaustive;
    }
  }
}

export function hashGoldenSet(path: string): string {
  const stat = statSync(path);
  const files = stat.isDirectory()
    ? readdirSync(path)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => join(path, name))
    : [path];
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(basename(file));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

export function scoreGraph(index: GraphIndex, cases: GoldenCase[], options: ScoreRunOptions = {}): ScoreReport {
  const bound = bindCases(index, cases);
  const vocab = vocabOf(index);
  const results: ToolCaseResult[] = [];
  const invents: ScoreMiss[] = [];
  const misses: ScoreMiss[] = [];
  const goldenHash = options.golden ? hashGoldenSet(options.golden) : undefined;

  for (const row of bound) {
    for (const tool of SCORE_TOOLS) {
      const started = performance.now();
      const card = runTool(tool, index, row, options);
      const ms = performance.now() - started;
      const cardInvents = inventsInCard(card, index);
      let spec = expectationFor(tool, row, index);
      if (tool === "recipe" && spec.applicable) {
        const found = asRecord(card)?.["found"] === true;
        spec = { ...spec, applicable: found && Boolean(row.slot) };
      }
      const picks = spec.applicable ? picksFor(tool, card, vocab, row) : [];
      const leaks = spec.applicable ? leakPicksFor(tool, card, vocab, row) : [];
      const graded = grade(tool, spec, picks, leaks, index);
      const candidates = candidateCount(tool, card, picks);
      results.push({ ...graded, picks, candidates, chars: cardChars(card), ms, invents: cardInvents });
      for (const detail of cardInvents) {
        invents.push({ id: row.id, tool, kind: "invent", detail });
      }
      if (!graded.applicable) continue;
      const expectedName = spec.expectedName ?? row.expected ?? "a master";
      if (spec.expect === "master" && !graded.top1) {
        const got = picks[0] ? picks[0].name : "empty card";
        misses.push({
          id: row.id,
          tool,
          kind: "top1",
          detail: `expected ${expectedName}, top pick ${got}`,
        });
      }
      if (spec.expect === "empty" && !graded.emptyOk) {
        misses.push({
          id: row.id,
          tool,
          kind: "empty",
          detail: `guessed ${picks.map((pick) => pick.name).join(", ")}`,
        });
      }
      if (graded.wrongCousin && picks[0]) {
        misses.push({ id: row.id, tool, kind: "cousin", detail: `top pick ${picks[0].name}` });
      }
      if (graded.leaked) {
        misses.push({
          id: row.id,
          tool,
          kind: "leak",
          detail: "deprecated or private master offered as a pick",
        });
      }
    }
  }

  const tools = SCORE_TOOLS.map((tool) => rollup(tool, results.filter((row) => row.tool === tool)));
  const applicable = results.filter((row) => row.applicable);
  const masterResults = applicable.filter((row) => row.expect === "master");
  const emptyResults = applicable.filter((row) => row.expect === "empty");
  const top3Base = masterResults.filter((row) => row.candidates >= 3);
  const cousinBase = masterResults.filter((row) => row.picks.length > 0);
  const latency = results.map((row) => row.ms);
  const budgetBreach = tools.some((tool) => tool.overBudget);
  const inventCount = invents.length;

  return {
    version: 1,
    at: options.at ?? new Date().toISOString(),
    workspace: options.workspaceName ?? "default",
    golden: options.golden ?? "",
    ...(goldenHash ? { goldenHash } : {}),
    ...(options.storePath ? { storePath: options.storePath } : {}),
    ...(index.graph.fileName ? { fileName: index.graph.fileName } : {}),
    ...(index.graph.builtAt ? { builtAt: index.graph.builtAt } : {}),
    cases: cases.length,
    pass: inventCount === 0 && !budgetBreach,
    inventRate: rate(results.filter((row) => row.invents.length > 0).length, results.length),
    inventCount,
    wrongCousinRate: rate(cousinBase.filter((row) => row.wrongCousin).length, cousinBase.length),
    top1: rate(masterResults.filter((row) => row.top1).length, masterResults.length),
    top3: rate(top3Base.filter((row) => row.top3).length, top3Base.length),
    emptyWhenWeak: rate(emptyResults.filter((row) => row.emptyOk).length, emptyResults.length),
    leakRate: rate(applicable.filter((row) => row.leaked).length, applicable.length),
    latencyP50Ms: percentile(latency, 0.5),
    latencyP95Ms: percentile(latency, 0.95),
    budgetBreach,
    tools,
    invents,
    misses,
  };
}

function rollup(tool: ScoreTool, rows: ToolCaseResult[]): ToolRollup {
  const applicable = rows.filter((row) => row.applicable);
  const master = applicable.filter((row) => row.expect === "master");
  const empty = applicable.filter((row) => row.expect === "empty");
  const withPick = master.filter((row) => row.picks.length > 0);
  const sizes = rows.map((row) => row.chars);
  const sizeMax = sizes.length ? Math.max(...sizes) : 0;
  const budget = SCORE_BUDGETS[tool];
  const candidateCounts = applicable.map((row) => row.candidates);
  const candidatesMax = candidateCounts.length ? Math.max(...candidateCounts) : 0;
  const top1Count = master.filter((row) => row.top1).length;
  return {
    tool,
    cases: rows.length,
    scored: master.length,
    top1: rate(top1Count, master.length),
    top1Count,
    top3: rate(master.filter((row) => row.top3).length, master.length),
    top3Applicable: master.some((row) => row.candidates >= 3),
    candidatesP50: Math.round(percentile(candidateCounts, 0.5)),
    candidatesMax,
    emptyWhenWeak: rate(empty.filter((row) => row.emptyOk).length, empty.length),
    wrongCousinRate: rate(withPick.filter((row) => row.wrongCousin).length, withPick.length),
    leakRate: rate(applicable.filter((row) => row.leaked).length, applicable.length),
    sizeP50: Math.round(percentile(sizes, 0.5)),
    sizeMax,
    budget,
    overBudget: sizeMax > budget,
  };
}

export function scoreExitCode(report: Pick<ScoreReport, "inventCount" | "budgetBreach">): 0 | 1 {
  return report.inventCount > 0 || report.budgetBreach ? 1 : 0;
}

export function deltaAgainst(
  current: ScoreReport,
  previous?: Pick<
    ScoreReport,
    "at" | "top1" | "top3" | "inventRate" | "wrongCousinRate" | "emptyWhenWeak" | "leakRate" | "goldenHash" | "workspace"
  >,
): ScoreDelta {
  const sameSet =
    Boolean(previous?.goldenHash) &&
    previous?.goldenHash === current.goldenHash &&
    previous?.workspace === current.workspace;
  if (!previous || !sameSet) {
    return {
      hasPrevious: false,
      top1: 0,
      top3: 0,
      inventRate: 0,
      wrongCousinRate: 0,
      emptyWhenWeak: 0,
      leakRate: 0,
    };
  }
  return {
    hasPrevious: true,
    previousAt: previous.at,
    top1: current.top1 - previous.top1,
    top3: current.top3 - previous.top3,
    inventRate: current.inventRate - previous.inventRate,
    wrongCousinRate: current.wrongCousinRate - previous.wrongCousinRate,
    emptyWhenWeak: current.emptyWhenWeak - previous.emptyWhenWeak,
    leakRate: current.leakRate - previous.leakRate,
  };
}

function pct(rateValue: number): string {
  return `${Math.round(rateValue * 100)}%`;
}

function points(delta: number): string {
  const rounded = Math.round(delta * 100);
  if (rounded === 0) return "0";
  return rounded > 0 ? `+${rounded}` : `${rounded}`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
}

function top1Cell(tool: ToolRollup): string {
  if (tool.tool === "recipe") return tool.scored ? `${tool.top1Count}/${tool.scored}` : "n/a";
  if (tool.tool === "verify") return tool.scored ? pct(tool.top1) : "n/a";
  return pct(tool.top1);
}

function top3Cell(tool: ToolRollup): string {
  if (!tool.top3Applicable) {
    const count = tool.candidatesMax || tool.candidatesP50;
    return count ? `n/a (${count} candidate${count === 1 ? "" : "s"})` : "n/a";
  }
  return pct(tool.top3);
}

export function formatScoreTable(report: ScoreReport, delta?: ScoreDelta): string {
  const header = [
    pad("Tool", 12),
    pad("Top-1", 10),
    pad("Top-3", 20),
    pad("Empty ok", 10),
    pad("Wrong cousin", 14),
    pad("Leak", 8),
    pad("Cands", 8),
    pad("Size p50", 10),
    pad("Size max", 10),
    "Budget",
  ].join("");
  const lines = report.tools.map((tool) =>
    [
      pad(tool.tool, 12),
      pad(top1Cell(tool), 10),
      pad(top3Cell(tool), 20),
      pad(pct(tool.emptyWhenWeak), 10),
      pad(pct(tool.wrongCousinRate), 14),
      pad(pct(tool.leakRate), 8),
      pad(String(tool.candidatesP50), 8),
      pad(String(tool.sizeP50), 10),
      pad(String(tool.sizeMax), 10),
      tool.overBudget ? `${tool.budget} over` : String(tool.budget),
    ].join(""),
  );
  const recipe = report.tools.find((tool) => tool.tool === "recipe");
  const library = report.fileName ? ` — ${report.fileName}` : "";
  const result = report.pass ? "pass" : "fail";
  const compared = !delta?.hasPrevious
    ? "No earlier run to compare."
    : `Compared with ${delta.previousAt}: top-1 ${points(delta.top1)}, top-3 ${points(delta.top3)}, invent ${points(delta.inventRate)}, wrong cousin ${points(delta.wrongCousinRate)}, empty-ok ${points(delta.emptyWhenWeak)}, leak ${points(delta.leakRate)} (points).`;
  const notes = [
    recipe
      ? `Recipe: ${recipe.top1Count}/${recipe.scored} on screen cases.`
      : "",
    "Verify top-1 is a did-you-mean hit, scored only on name-like intents.",
    "Top-3 is n/a when a card holds fewer than three candidates.",
  ].filter(Boolean);
  return [
    `Scoreboard — ${report.cases} cases${library}`,
    "",
    header,
    ...lines,
    "",
    ...notes,
    `Invent rate: ${pct(report.inventRate)} (target 0). Anything above 0 fails this run.`,
    `Latency: p50 ${report.latencyP50Ms.toFixed(1)} ms, p95 ${report.latencyP95Ms.toFixed(1)} ms.`,
    `Result: ${result}.`,
    compared,
  ].join("\n");
}
