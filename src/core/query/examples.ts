import type { GraphNode } from "@/core/model";
import { COMPONENT_DEFINITION_TYPES } from "@/core/model";
import { TEXT_UNCHECKED_REASON } from "@/core/ingestion/textStamps";
import type { GraphIndex } from "./GraphIndex";
import type { SockState, UsageFact } from "./sock";
import { nodeFileKey } from "./workspaceMerge";

export { TEXT_UNCHECKED_REASON };

/**
 * Real populated instances already in the graph.
 * Pointers only — never invented nodes, never retired or private masters.
 */

export const CLONE_INSTRUCTION =
  "Clone this instance and replace content; do not start from the default variant.";

export const NO_EXAMPLE =
  "no real example known — ask the designer or open a screen that uses it";

/** Short card value. The long sentence stays on get_example. */
export const EX_NONE = "none";

export type ExampleReason =
  | "bare defaults only"
  | "not on any screen"
  | "use the live replacement"
  | "no such component — call recommend";

/** Generic filler only. Team strings live in `.graphify/placeholders.json`. */
const LOREM_EXACT = new Set([
  "lorem",
  "lorem ipsum",
  "lorem ipsum dolor",
  "lorem ipsum dolor sit amet",
  "dolor sit amet",
  "consectetur adipiscing",
  "consectetur adipiscing elit",
  "sample text",
  "your text here",
  "text goes here",
]);

const MASTER_TYPES = new Set<string>(COMPONENT_DEFINITION_TYPES);

export interface ExampleQuery {
  sock?: SockState;
  product?: string;
  journey?: string;
  domain?: string;
  graphFileKey?: string;
  /** Team template strings. Whole-string match. Not built in. */
  placeholders?: string[];
  /** Per-request memo. Same object across budget-shrink passes. */
  cache?: ExampleCache;
}

export interface RealExample {
  fileKey?: string;
  nodeId: string;
  id: string;
  screen: string;
  variant?: Record<string, string>;
  summary: string;
  sizing: "hug" | "fixed" | "fill" | "unknown";
  height?: number;
  preferred: boolean;
  instruction: typeof CLONE_INSTRUCTION;
  exNote?: "other product";
}

export type ExampleLookup =
  | { found: true; example: RealExample }
  | { found: false; reason: ExampleReason };

export interface ExamplePointer {
  ex: string;
  exFileKey?: string;
  exWhy?: ExampleReason;
  exNote?: "other product";
}

export interface ContentWarning {
  figmaNodeId?: string;
  id?: string;
  fileKey?: string;
  kind: "leftover-text" | "placeholder" | "oversized-height";
  reason: string;
}

interface Parts {
  variant?: Record<string, string>;
  tabs: string[];
  dividers: string[];
  rows: string[];
  sizing: RealExample["sizing"];
  height?: number;
}

interface Described {
  parts: Parts;
  configKey: string;
  summary: string;
  populated: boolean;
}

interface ExampleCache {
  described: Map<string, Described>;
  masterText: Map<string, Set<string>>;
  masterParts: Map<string, Parts>;
  definition: Map<string, GraphNode>;
  peerFixed: Map<string, Array<{ id: string; height: number }>>;
  examples: Map<string, ExampleLookup>;
}

/** Sync call stack only. One recommend/verify at a time; no await inside. */
let active: ExampleCache | undefined;
let activeOverlay: ReadonlyMap<string, string> | undefined;
let describeCalls = 0;

export function resetDescribeCalls(): void {
  describeCalls = 0;
}

export function takeDescribeCalls(): number {
  const count = describeCalls;
  describeCalls = 0;
  return count;
}

function createExampleCache(): ExampleCache {
  return {
    described: new Map(),
    masterText: new Map(),
    masterParts: new Map(),
    definition: new Map(),
    peerFixed: new Map(),
    examples: new Map(),
  };
}

function cacheOf(query: ExampleQuery): ExampleCache {
  if (!query.cache) query.cache = createExampleCache();
  return query.cache;
}

function enter(cache: ExampleCache, overlay?: ReadonlyMap<string, string>): () => void {
  const prev = active;
  const prevOverlay = activeOverlay;
  active = cache;
  activeOverlay = overlay;
  return () => {
    active = prev;
    activeOverlay = prevOverlay;
  };
}

function isPrivateName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.startsWith(".") || trimmed.startsWith("_")) return true;
  const variant = trimmed.split(" / ").at(-1)?.trim() ?? "";
  return variant !== trimmed && (variant.startsWith(".") || variant.startsWith("_"));
}

function blocked(index: GraphIndex, node: GraphNode): boolean {
  if (node.status === "deprecated" || isPrivateName(node.name)) return true;
  const set = node.componentSetId ? index.getNode(node.componentSetId) : undefined;
  return Boolean(set && (set.status === "deprecated" || isPrivateName(set.name)));
}

function screenOf(index: GraphIndex, nodeId: string): GraphNode | undefined {
  const path = index.getHierarchyPath(nodeId);
  for (const ancestor of path) {
    if (ancestor.type !== "FRAME") continue;
    const parent = index.getParent(ancestor.id);
    if (!parent || parent.type === "PAGE" || parent.type === "SECTION" || parent.type === "FILE") {
      return ancestor;
    }
  }
  return undefined;
}

function familyIds(index: GraphIndex, master: GraphNode): string[] {
  const ids = new Set<string>([master.id]);
  const setId = master.type === "COMPONENT_SET" ? master.id : master.componentSetId;
  if (setId) {
    ids.add(setId);
    for (const variant of index.getVariantsOf(setId)) ids.add(variant.id);
  }
  return [...ids];
}

function instancesOfFamily(index: GraphIndex, master: GraphNode): GraphNode[] {
  const seen = new Map<string, GraphNode>();
  for (const id of familyIds(index, master)) {
    for (const instance of index.getAllInstancesOf(id)) seen.set(instance.id, instance);
  }
  return [...seen.values()];
}

/** Real characters only. A layer name is not text when the characters attribute is missing. */
function textOf(node: GraphNode): string | undefined {
  const over = activeOverlay?.get(node.id);
  if (typeof over === "string" && over.trim()) return over.trim();
  const meta = node.metadata?.["text"];
  if (typeof meta === "string" && meta.trim()) return meta.trim();
  return undefined;
}

function isInferredMaster(node: GraphNode): boolean {
  if (node.metadata?.["identity"] === "inferred-from-name") return true;
  return `${node.id} ${node.figmaNodeId ?? ""}`.includes("mcp-name:");
}

/** Name-inferred MCP stubs have no default copy. The real master of that name does. */
function definitionFor(index: GraphIndex, main: GraphNode): GraphNode {
  const cached = active?.definition.get(main.id);
  if (cached) return cached;
  let resolved = main;
  if (isInferredMaster(main)) {
    const needle = main.name.trim().toLowerCase();
    const hits = index.getNodesByType("MAIN_COMPONENT", "COMPONENT_SET", "VARIANT").filter((node) => {
      if (node.id === main.id || isInferredMaster(node)) return false;
      return node.name.trim().toLowerCase() === needle;
    });
    if (hits.length === 1 && hits[0]) resolved = hits[0];
  }
  active?.definition.set(main.id, resolved);
  return resolved;
}

function ownTexts(index: GraphIndex, rootId: string): string[] {
  const out: string[] = [];
  const walk = (id: string) => {
    for (const child of index.getChildren(id)) {
      if (child.type === "COMPONENT_INSTANCE") continue;
      const text = textOf(child);
      if (text) out.push(text);
      walk(child.id);
    }
  };
  walk(rootId);
  return out;
}

function isChromeLabel(text: string): boolean {
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  return trimmed.length < 20 && words.length < 3;
}

export function exampleSentence(reason: ExampleReason): string {
  switch (reason) {
    case "bare defaults only":
    case "not on any screen":
      return NO_EXAMPLE;
    case "use the live replacement":
      return "Deprecated. Use the live replacement. Do not clone this master.";
    case "no such component — call recommend":
      return "No such component — call recommend.";
    default: {
      const neverReason: never = reason;
      return neverReason;
    }
  }
}

function normalized(text: string): string {
  return text.trim().toLowerCase().replace(/[.…]+$/g, "").trim();
}

/** Lorem-ipsum family and the same kind of generic filler. Not product copy. */
export function isLoremFiller(text: string): boolean {
  const lower = normalized(text);
  if (!lower) return false;
  if (LOREM_EXACT.has(lower)) return true;
  if (lower.startsWith("lorem ipsum")) return true;
  if (/^x{3,}$/.test(lower) || lower === "todo" || lower === "tbd") return true;
  return false;
}

function isPlaceholderWord(text: string): boolean {
  const lower = normalized(text);
  return lower === "placeholder" || lower === "placeholder text";
}

function isTeamPlaceholder(text: string, team: string[] | undefined): boolean {
  if (!team?.length) return false;
  const lower = text.trim().toLowerCase();
  return team.some((item) => item.trim().toLowerCase() === lower);
}

function isHardPlaceholder(text: string, team: string[] | undefined, defaults: Set<string>): boolean {
  if (isLoremFiller(text)) return true;
  const isDefault = defaults.has(text.trim().toLowerCase());
  if (!isDefault) return false;
  return isTeamPlaceholder(text, team) || isPlaceholderWord(text);
}

function sizingOf(node: GraphNode): RealExample["sizing"] {
  const meta = node.metadata ?? {};
  const layout = typeof meta["layoutMode"] === "string" ? meta["layoutMode"].toUpperCase() : "";
  const vertical = typeof meta["layoutSizingVertical"] === "string" ? meta["layoutSizingVertical"].toUpperCase() : "";
  const horizontal = typeof meta["layoutSizingHorizontal"] === "string" ? meta["layoutSizingHorizontal"].toUpperCase() : "";
  const primary = typeof meta["primaryAxisSizingMode"] === "string" ? meta["primaryAxisSizingMode"].toUpperCase() : "";
  const counter = typeof meta["counterAxisSizingMode"] === "string" ? meta["counterAxisSizingMode"].toUpperCase() : "";
  const pick = layout === "HORIZONTAL" ? horizontal || counter || primary : vertical || primary || horizontal;
  if (pick === "HUG" || pick === "AUTO") return "hug";
  if (pick === "FIXED") return "fixed";
  if (pick === "FILL") return "fill";
  return "unknown";
}

function heightOf(node: GraphNode): number | undefined {
  const min = node.metadata?.["minHeight"];
  const box = node.bounds?.height;
  const minHeight = typeof min === "number" && Number.isFinite(min) ? min : undefined;
  if (box === undefined && minHeight === undefined) return undefined;
  return Math.max(box ?? 0, minHeight ?? 0);
}

function variantOf(index: GraphIndex, instance: GraphNode): Record<string, string> | undefined {
  if (instance.variantProperties && Object.keys(instance.variantProperties).length) {
    return instance.variantProperties;
  }
  const main = index.getMainComponent(instance.id);
  if (main?.variantProperties && Object.keys(main.variantProperties).length) return main.variantProperties;
  return undefined;
}

function hasWord(name: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`, "i").test(name);
}

function classify(node: GraphNode): "tab" | "divider" | "row" | undefined {
  const name = node.name.trim();
  if (hasWord(name, "tab")) return "tab";
  if (hasWord(name, "divider") || /^title$/i.test(name)) return "divider";
  if (hasWord(name, "row") || hasWord(name, "information")) return "row";
  return undefined;
}

function collectParts(index: GraphIndex, root: GraphNode): Parts {
  const tabs: string[] = [];
  const dividers: string[] = [];
  const rows: string[] = [];
  const walk = (id: string, depth: number) => {
    if (depth > 4) return;
    for (const child of index.getChildren(id)) {
      const kind = classify(child);
      if (kind === "tab") tabs.push(child.name.trim());
      else if (kind === "divider") dividers.push(child.name.trim());
      else if (kind === "row") rows.push(child.name.trim());
      if (child.type !== "COMPONENT_INSTANCE") walk(child.id, depth + 1);
    }
  };
  walk(root.id, 0);
  return {
    variant: root.type === "COMPONENT_INSTANCE" ? variantOf(index, root) : root.variantProperties,
    tabs,
    dividers,
    rows,
    sizing: sizingOf(root),
    height: heightOf(root),
  };
}

function countLabel(names: string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1])
    .map(([name, count]) => `${name}×${count}`)
    .join("+");
}

function variantKey(variant?: Record<string, string>): string {
  if (!variant) return "";
  return Object.entries(variant)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
}

function structureKey(parts: Parts): string {
  return [
    `v:${variantKey(parts.variant)}`,
    `tab:${countLabel(parts.tabs)}`,
    `div:${countLabel(parts.dividers)}`,
    `row:${countLabel(parts.rows)}`,
  ].join("|");
}

function configKeyOf(parts: Parts): string {
  return `${structureKey(parts)}|z:${parts.sizing}`;
}

function summaryOf(parts: Parts): string {
  const bits: string[] = [];
  const variant = variantKey(parts.variant);
  if (variant) bits.push(variant);
  if (parts.tabs.length) bits.push(`tabs: ${countLabel(parts.tabs)}`);
  if (parts.dividers.length) bits.push(`dividers: ${countLabel(parts.dividers)}`);
  if (parts.rows.length) bits.push(`rows: ${countLabel(parts.rows)}`);
  const height = parts.height !== undefined ? ` h:${Math.round(parts.height)}` : "";
  bits.push(`sizing: ${parts.sizing}${height}`);
  return bits.join("; ");
}

function masterTexts(index: GraphIndex, main: GraphNode): Set<string> {
  const cached = active?.masterText.get(main.id);
  if (cached) return cached;
  const texts = new Set(ownTexts(index, main.id).map((text) => text.toLowerCase()));
  const setId = main.type === "COMPONENT_SET" ? main.id : main.componentSetId;
  if (setId) {
    const variants = index.getVariantsOf(setId);
    const named = variants.find(
      (variant) =>
        /default/i.test(variant.name) ||
        Object.values(variant.variantProperties ?? {}).some((value) => /default/i.test(value)),
    );
    const fallback = named ?? variants[0];
    if (fallback) {
      for (const text of ownTexts(index, fallback.id)) texts.add(text.toLowerCase());
    }
  }
  active?.masterText.set(main.id, texts);
  return texts;
}

function masterPartsOf(index: GraphIndex, definition: GraphNode): Parts {
  const cached = active?.masterParts.get(definition.id);
  if (cached) return cached;
  const parts = collectParts(index, definition);
  active?.masterParts.set(definition.id, parts);
  return parts;
}

function describeInstance(index: GraphIndex, instance: GraphNode, team: string[] | undefined): Described {
  describeCalls += 1;
  const parts = collectParts(index, instance);
  const main = index.getMainComponent(instance.id);
  const definition = main ? definitionFor(index, main) : undefined;
  const masterParts = definition ? masterPartsOf(index, definition) : undefined;
  const texts = ownTexts(index, instance.id);
  const defaults = definition ? masterTexts(index, definition) : new Set<string>();
  const substantive = texts.filter((text) => !isChromeLabel(text));
  const placeholderText = substantive.some((text) => isHardPlaceholder(text, team, defaults));
  const filledText = substantive.some(
    (text) => !defaults.has(text.toLowerCase()) && !isHardPlaceholder(text, team, defaults),
  );
  const sameStructure = masterParts ? structureKey(parts) === structureKey(masterParts) : false;
  return {
    parts,
    configKey: configKeyOf(parts),
    summary: summaryOf(parts),
    populated: !placeholderText && (!sameStructure || filledText),
  };
}

function describeCached(index: GraphIndex, instance: GraphNode, team: string[] | undefined): Described {
  const hit = active?.described.get(instance.id);
  if (hit) return hit;
  const described = describeInstance(index, instance, team);
  active?.described.set(instance.id, described);
  return described;
}

function isDocsFrame(name: string): boolean {
  return (/\bdocs?\b/i.test(name) && /\busage\b/i.test(name)) || /\bdocumentation\b/i.test(name);
}

function contextBlob(screen: GraphNode, facts: UsageFact[]): string {
  return [screen.name, ...facts.flatMap((fact) => [fact.product, fact.journey, fact.pack, fact.screenName])]
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .toLowerCase();
}

function blobHas(blob: string, needle: string | undefined): boolean {
  const trimmed = needle?.trim().toLowerCase();
  return Boolean(trimmed && blob.includes(trimmed));
}

function fileKeyOf(index: GraphIndex, node: GraphNode, query: ExampleQuery): string | undefined {
  return nodeFileKey(node, query.graphFileKey ?? index.graph.fileKey);
}

function factMatchesScreen(fact: UsageFact, screen: GraphNode, fileKey?: string): boolean {
  if (fact.screenId === screen.id || fact.screenName === screen.name) return true;
  const fig = screen.figmaNodeId;
  if (!fig) return false;
  if (fact.frameId === fig || fact.screenId.endsWith(`:${fig}`)) return true;
  return Boolean(fileKey && fact.screenId === `${fileKey}:${fig}`);
}

function preferredConfig(sock: SockState | undefined, ids: string[]): string | undefined {
  if (!sock) return undefined;
  const family = new Set(ids);
  const screens = new Map<string, Set<string>>();
  for (const fact of sock.facts) {
    if (!family.has(fact.masterId)) continue;
    if (fact.countsTowardThreshold === false || !fact.promoted || fact.deprecated || fact.private) continue;
    if (!fact.configKey) continue;
    let bucket = screens.get(fact.configKey);
    if (!bucket) {
      bucket = new Set();
      screens.set(fact.configKey, bucket);
    }
    bucket.add(fact.screenId);
  }
  let best: { key: string; count: number } | undefined;
  for (const [key, bucket] of screens) {
    if (bucket.size < sock.threshold) continue;
    if (!best || bucket.size > best.count || (bucket.size === best.count && key < best.key)) {
      best = { key, count: bucket.size };
    }
  }
  return best?.key;
}

function contextScore(screen: GraphNode, facts: UsageFact[], query: ExampleQuery): number {
  const blob = contextBlob(screen, facts);
  let score = 0;
  if (blobHas(blob, query.product)) score += 40;
  if (blobHas(blob, query.journey)) score += 40;
  if (blobHas(blob, query.domain)) score += 20;
  return score;
}

function resolveExample(index: GraphIndex, master: GraphNode, query: ExampleQuery): ExampleLookup {
  const miss = (reason: ExampleReason): ExampleLookup => ({ found: false, reason });
  let node = master;
  if (node.type === "COMPONENT_INSTANCE") {
    const main = index.getMainComponent(node.id);
    if (!main) return miss("not on any screen");
    node = main;
  }
  if (!MASTER_TYPES.has(node.type)) return miss("no such component — call recommend");
  if (node.status === "deprecated") return miss("use the live replacement");
  const set = node.componentSetId ? index.getNode(node.componentSetId) : undefined;
  if (set?.status === "deprecated") return miss("use the live replacement");
  if (blocked(index, node)) return miss("not on any screen");

  const variantPick = node.type === "VARIANT";
  const ids = variantPick ? [node.id] : familyIds(index, node);
  const preferredKey = preferredConfig(query.sock, ids);
  const instances = variantPick ? index.getAllInstancesOf(node.id) : instancesOfFamily(index, node);
  const ranked: Array<{
    instance: GraphNode;
    screen: GraphNode;
    described: Described;
    score: number;
    blob: string;
  }> = [];
  let sawInstance = false;
  const cleanCache = new Map<string, boolean>();
  const screenClean = (screenId: string): boolean => {
    const cached = cleanCache.get(screenId);
    if (cached !== undefined) return cached;
    const content = frameContentWarnings(index, screenId, query.placeholders, { cache: active });
    const clean = !content.blocking && content.warnings.length === 0;
    cleanCache.set(screenId, clean);
    return clean;
  };

  for (const instance of instances) {
    const main = index.getMainComponent(instance.id);
    if (!main || blocked(index, main)) continue;
    if (variantPick && main.id !== node.id) continue;
    if (!instance.figmaNodeId) continue;
    const screen = screenOf(index, instance.id);
    if (!screen) continue;
    sawInstance = true;
    const described = describeCached(index, instance, query.placeholders);
    if (!described.populated) continue;
    const fileKey = fileKeyOf(index, screen, query);
    const facts = (query.sock?.facts ?? []).filter(
      (fact) => ids.includes(fact.masterId) && factMatchesScreen(fact, screen, fileKey),
    );
    const verified = facts.some((fact) => fact.countsTowardThreshold !== false && fact.promoted);
    const richness = described.parts.tabs.length + described.parts.dividers.length + described.parts.rows.length;
    let score = contextScore(screen, facts, query) + Math.min(30, richness);
    if (verified) score += 100;
    if (screenClean(screen.id)) score += 80;
    if (described.parts.sizing === "hug") score += 15;
    if (isDocsFrame(screen.name)) score -= 200;
    ranked.push({ instance, screen, described, score, blob: contextBlob(screen, facts) });
  }

  if (!ranked.length) return miss(sawInstance ? "bare defaults only" : "not on any screen");

  let pool = ranked;
  let otherProduct = false;
  if (query.product?.trim()) {
    const matched = pool.filter((row) => blobHas(row.blob, query.product));
    if (matched.length) pool = matched;
    else otherProduct = true;
  }
  if (query.journey?.trim()) {
    const matched = pool.filter((row) => blobHas(row.blob, query.journey));
    if (matched.length) pool = matched;
  }
  const liveScreens = pool.filter((row) => !isDocsFrame(row.screen.name));
  if (liveScreens.length) pool = liveScreens;
  const clean = pool.filter((row) => screenClean(row.screen.id));
  if (clean.length) pool = clean;
  if (preferredKey) {
    const preferred = pool.filter((row) => row.described.configKey === preferredKey);
    if (preferred.length) pool = preferred;
  }
  pool.sort(
    (a, b) =>
      b.score - a.score ||
      a.screen.name.localeCompare(b.screen.name) ||
      (a.instance.figmaNodeId ?? "").localeCompare(b.instance.figmaNodeId ?? ""),
  );
  const picked = pool[0];
  if (!picked) return miss("not on any screen");
  const fileKey = fileKeyOf(index, picked.instance, query) ?? fileKeyOf(index, picked.screen, query);
  const note = otherProduct ? ("other product" as const) : undefined;
  return {
    found: true,
    example: {
      ...(fileKey ? { fileKey } : {}),
      nodeId: picked.instance.figmaNodeId!,
      id: picked.instance.id,
      screen: picked.screen.name,
      ...(picked.described.parts.variant ? { variant: picked.described.parts.variant } : {}),
      summary: picked.described.summary,
      sizing: picked.described.parts.sizing,
      ...(picked.described.parts.height !== undefined ? { height: Math.round(picked.described.parts.height) } : {}),
      preferred: Boolean(preferredKey && picked.described.configKey === preferredKey),
      instruction: CLONE_INSTRUCTION,
      ...(note ? { exNote: note } : {}),
    },
  };
}

export function getExample(index: GraphIndex, master: GraphNode, query: ExampleQuery = {}): ExampleLookup {
  const cache = cacheOf(query);
  const memo = cache.examples.get(master.id);
  if (memo) return memo;
  const leave = enter(cache);
  try {
    const lookup = resolveExample(index, master, query);
    cache.examples.set(master.id, lookup);
    return lookup;
  } finally {
    leave();
  }
}

export function examplePointer(
  index: GraphIndex,
  master: GraphNode,
  query: ExampleQuery = {},
  detail: "id" | "screen" = "id",
): ExamplePointer {
  const lookup = getExample(index, master, query);
  if (!lookup.found) return { ex: EX_NONE, exWhy: lookup.reason };
  const pickFile = fileKeyOf(index, master, query);
  const file = lookup.example.fileKey;
  const cross = Boolean(file && pickFile && file !== pickFile);
  const ref = cross && file ? `${file}:${lookup.example.nodeId}` : lookup.example.nodeId;
  const screen = lookup.example.screen.length > 32 ? `${lookup.example.screen.slice(0, 31)}…` : lookup.example.screen;
  const ex = detail === "id" ? ref : `${ref}@${screen}`;
  return {
    ex,
    ...(cross && file ? { exFileKey: file } : {}),
    ...(lookup.example.exNote ? { exNote: lookup.example.exNote } : {}),
  };
}

/** Populated shape on this frame, for SOCK. Bare defaults are omitted. */
export function exampleFactForMasterOnFrame(
  index: GraphIndex,
  frameId: string,
  masterId: string,
  team?: string[],
): { configKey: string; exampleNodeId: string } | undefined {
  let best: { configKey: string; exampleNodeId: string; richness: number } | undefined;
  for (const instance of index.getNestedInstances(frameId)) {
    const main = index.getMainComponent(instance.id);
    if (!main) continue;
    if (main.id !== masterId && main.componentSetId !== masterId) continue;
    if (blocked(index, main)) continue;
    const described = describeInstance(index, instance, team);
    if (!described.populated) continue;
    const richness = described.summary.length;
    if (!best || richness > best.richness) {
      best = { configKey: described.configKey, exampleNodeId: instance.id, richness };
    }
  }
  if (!best) return undefined;
  return { configKey: best.configKey, exampleNodeId: best.exampleNodeId };
}

function contentExtent(index: GraphIndex, node: GraphNode): number {
  const children = index.getChildren(node.id).filter((child) => child.bounds && child.bounds.height > 0);
  if (!children.length) return 0;
  const layout = typeof node.metadata?.["layoutMode"] === "string" ? node.metadata["layoutMode"].toUpperCase() : "";
  if (layout === "HORIZONTAL") return Math.max(...children.map((child) => child.bounds!.height));
  if (layout === "VERTICAL") return children.reduce((sum, child) => sum + child.bounds!.height, 0);
  if (children.length > 1 && children.every((child) => Number.isFinite(child.bounds!.y))) {
    const top = Math.min(...children.map((child) => child.bounds!.y));
    const bottom = Math.max(...children.map((child) => child.bounds!.y + child.bounds!.height));
    return bottom - top;
  }
  return children.reduce((sum, child) => sum + child.bounds!.height, 0);
}

function quote(text: string): string {
  const shown = text.length > 48 ? `${text.slice(0, 47)}…` : text;
  return shown;
}

interface TextHit {
  text: string;
  layer: string;
}

function textsOf(index: GraphIndex, rootId: string): TextHit[] {
  const out: TextHit[] = [];
  const walk = (id: string) => {
    for (const child of index.getChildren(id)) {
      if (child.type === "COMPONENT_INSTANCE") continue;
      const text = textOf(child);
      if (text) out.push({ text, layer: child.name });
      walk(child.id);
    }
  };
  walk(rootId);
  return out;
}

function isInputish(name: string): boolean {
  return /\b(input|field|search|textarea)\b/i.test(name);
}

function isHintLayer(name: string): boolean {
  return /\b(hint|placeholder)\b/i.test(name);
}

function peersHug(described: Map<string, Described>, instanceId: string, mainId: string, index: GraphIndex): boolean {
  for (const [id, row] of described) {
    if (id === instanceId || !row.populated || row.parts.sizing !== "hug") continue;
    const main = index.getMainComponent(id);
    if (!main) continue;
    if (main.id === mainId || main.componentSetId === mainId || main.id === index.getNode(mainId)?.componentSetId) {
      return true;
    }
    const setId = main.componentSetId;
    const other = index.getNode(mainId);
    if (setId && other && (other.id === setId || other.componentSetId === setId)) return true;
  }
  return false;
}

function peerFixedRows(
  index: GraphIndex,
  mainId: string,
  team: string[] | undefined,
): Array<{ id: string; height: number }> {
  const cached = active?.peerFixed.get(mainId);
  if (cached) return cached;
  const rows: Array<{ id: string; height: number }> = [];
  for (const other of index.getAllInstancesOf(mainId)) {
    const described = describeCached(index, other, team);
    if (!described.populated || described.parts.sizing !== "fixed") continue;
    if (described.parts.height === undefined) continue;
    rows.push({ id: other.id, height: described.parts.height });
  }
  active?.peerFixed.set(mainId, rows);
  return rows;
}

function peersShareFixedHeight(
  index: GraphIndex,
  instance: GraphNode,
  used: number,
  team: string[] | undefined,
): boolean {
  const main = index.getMainComponent(instance.id);
  if (!main) return false;
  for (const row of peerFixedRows(index, main.id, team)) {
    if (row.id === instance.id) continue;
    if (Math.abs(row.height - used) <= 2) return true;
  }
  return false;
}

export function frameContentWarnings(
  index: GraphIndex,
  frameId: string,
  team: string[] | undefined = undefined,
  scope?: { overlay?: ReadonlyMap<string, string>; cache?: ExampleCache },
): { warnings: ContentWarning[]; blocking: boolean; textChecked: boolean; textReason?: string } {
  const cache = scope?.cache ?? active ?? createExampleCache();
  const overlay = scope?.overlay ?? activeOverlay;
  const leave = enter(cache, overlay);
  try {
    return frameContentWarningsInner(index, frameId, team);
  } finally {
    leave();
  }
}

function textCoverage(index: GraphIndex, instances: readonly GraphNode[]): { layers: number; missing: number } {
  let layers = 0;
  let missing = 0;
  const walk = (id: string) => {
    for (const child of index.getChildren(id)) {
      if (child.type === "COMPONENT_INSTANCE") continue;
      if (child.type === "TEXT_LAYER") {
        layers += 1;
        if (!textOf(child)) missing += 1;
      }
      walk(child.id);
    }
  };
  for (const instance of instances) walk(instance.id);
  return { layers, missing };
}

function frameContentWarningsInner(
  index: GraphIndex,
  frameId: string,
  team: string[] | undefined,
): { warnings: ContentWarning[]; blocking: boolean; textChecked: boolean; textReason?: string } {
  const warnings: ContentWarning[] = [];
  const instances = index.getNestedInstances(frameId);
  const described = new Map<string, Described>();
  for (const instance of instances) described.set(instance.id, describeCached(index, instance, team));

  for (const instance of instances) {
    const main = index.getMainComponent(instance.id);
    if (!main || blocked(index, main)) continue;
    const fileKey = nodeFileKey(instance, index.graph.fileKey);
    const stamp = {
      ...(instance.figmaNodeId ? { figmaNodeId: instance.figmaNodeId } : { id: instance.id }),
      ...(fileKey && fileKey !== index.graph.fileKey ? { fileKey } : {}),
    };
    const hits = textsOf(index, instance.id);
    const defaults = masterTexts(index, definitionFor(index, main));
    const inputHint = isInputish(main.name) || isInputish(instance.name);
    const considered = hits.filter((hit) => !(inputHint && isHintLayer(hit.layer)));
    const texts = considered.map((hit) => hit.text);
    const placeholders = texts.filter((text) => isHardPlaceholder(text, team, defaults));
    const leftovers = texts.filter(
      (text) =>
        !isHardPlaceholder(text, team, defaults) && defaults.has(text.toLowerCase()) && !isChromeLabel(text),
    );
    if (placeholders.length) {
      const extra = placeholders.length > 1 ? ` (+${placeholders.length - 1})` : "";
      warnings.push({
        ...stamp,
        kind: "placeholder",
        reason: `Placeholder "${quote(placeholders[0]!)}"${extra} is leftover template text.`,
      });
    }
    if (leftovers.length) {
      const extra = leftovers.length > 1 ? ` (+${leftovers.length - 1})` : "";
      warnings.push({
        ...stamp,
        kind: "leftover-text",
        reason: `Leftover text "${quote(leftovers[0]!)}"${extra} matches the default.`,
      });
    }

    const content = contentExtent(index, instance);
    if (content <= 0) continue;
    const mode = sizingOf(instance);
    const minRaw = instance.metadata?.["minHeight"];
    const minHeight = typeof minRaw === "number" && Number.isFinite(minRaw) ? minRaw : undefined;
    const box = instance.bounds?.height ?? 0;
    const used = Math.max(box, minHeight ?? 0);
    const slack = used - content;
    const fixed = mode === "fixed" || (minHeight !== undefined && minHeight > content + 48);
    const hugPeer = peersHug(described, instance.id, main.id, index);
    const clearly = slack >= 48 && slack > content * 0.35;
    const againstHug = fixed && hugPeer && slack >= 32;
    if (mode === "hug" || mode === "fill") continue;
    if (peersShareFixedHeight(index, instance, used, team)) continue;
    if (!((fixed || mode === "unknown") && clearly) && !againstHug) continue;
    const viaMin = minHeight !== undefined && minHeight >= box && minHeight - content >= 48;
    const reason = viaMin
      ? `Min-height ${Math.round(minHeight!)} exceeds content ${Math.round(content)}.`
      : `Fixed height ${Math.round(used)} exceeds content ${Math.round(content)}.`;
    warnings.push({ ...stamp, kind: "oversized-height", reason });
  }

  const coverage = textCoverage(index, instances);
  const textChecked = coverage.layers > 0 && coverage.missing === 0;
  return {
    warnings,
    blocking: warnings.some((warning) => warning.kind === "placeholder"),
    textChecked,
    ...(textChecked ? {} : { textReason: TEXT_UNCHECKED_REASON }),
  };
}
