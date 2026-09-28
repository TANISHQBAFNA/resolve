import type { GraphNode } from "@/core/model";
import { COMPONENT_DEFINITION_TYPES } from "@/core/model";
import type { GraphIndex } from "./GraphIndex";
import type { SockState, UsageFact } from "./sock";
import { nodeFileKey } from "./workspaceMerge";

/**
 * Real populated instances already in the graph.
 * Pointers only — never invented nodes, never retired or private masters.
 */

export const CLONE_INSTRUCTION =
  "Clone this instance and replace content; do not start from the default variant.";

export const NO_EXAMPLE =
  "no real example known — ask the designer or open a screen that uses it";

/** Whole-string template copy. Short chrome labels are not in this list. */
const KNOWN_PLACEHOLDERS = new Set([
  "request bank certificate",
  "lorem ipsum",
  "lorem ipsum dolor sit amet",
  "placeholder",
  "placeholder text",
]);

const MASTER_TYPES = new Set<string>(COMPONENT_DEFINITION_TYPES);

export interface ExampleQuery {
  sock?: SockState;
  product?: string;
  journey?: string;
  domain?: string;
  graphFileKey?: string;
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
}

export type ExampleLookup =
  | { found: true; example: RealExample }
  | { found: false; example: typeof NO_EXAMPLE };

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

function textOf(node: GraphNode): string | undefined {
  const meta = node.metadata?.["text"];
  if (typeof meta === "string" && meta.trim()) return meta.trim();
  if (node.type !== "TEXT_LAYER") return undefined;
  const name = node.name.trim();
  if (!name || name === "(unnamed)") return undefined;
  return name;
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

function isPlaceholder(text: string): boolean {
  return KNOWN_PLACEHOLDERS.has(text.trim().toLowerCase());
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

function classify(node: GraphNode): "tab" | "divider" | "row" | undefined {
  const name = node.name.trim();
  if (/tab/i.test(name)) return "tab";
  if (/divider/i.test(name) || /^title$/i.test(name)) return "divider";
  if (/row|information/i.test(name)) return "row";
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
  const texts = new Set(ownTexts(index, main.id).map((text) => text.toLowerCase()));
  const setId = main.type === "COMPONENT_SET" ? main.id : main.componentSetId;
  if (!setId) return texts;
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
  return texts;
}

function describeInstance(index: GraphIndex, instance: GraphNode): Described {
  const parts = collectParts(index, instance);
  const main = index.getMainComponent(instance.id);
  const masterParts = main ? collectParts(index, main) : undefined;
  const texts = ownTexts(index, instance.id);
  const defaults = main ? masterTexts(index, main) : new Set<string>();
  const filledText = texts.some((text) => !defaults.has(text.toLowerCase()) && !isChromeLabel(text));
  const sameStructure = masterParts ? structureKey(parts) === structureKey(masterParts) : false;
  return {
    parts,
    configKey: configKeyOf(parts),
    summary: summaryOf(parts),
    populated: !sameStructure || filledText,
  };
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
  const blob = [screen.name, ...facts.flatMap((fact) => [fact.product, fact.journey, fact.pack, fact.screenName])]
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .toLowerCase();
  let score = 0;
  const product = query.product?.trim().toLowerCase();
  const journey = query.journey?.trim().toLowerCase();
  const domain = query.domain?.trim().toLowerCase();
  if (product && blob.includes(product)) score += 40;
  if (journey && blob.includes(journey)) score += 40;
  if (domain && blob.includes(domain)) score += 20;
  return score;
}

export function getExample(index: GraphIndex, master: GraphNode, query: ExampleQuery = {}): ExampleLookup {
  const none = (): ExampleLookup => ({ found: false, example: NO_EXAMPLE });
  let node = master;
  if (node.type === "COMPONENT_INSTANCE") {
    const main = index.getMainComponent(node.id);
    if (!main) return none();
    node = main;
  }
  if (!MASTER_TYPES.has(node.type) || blocked(index, node)) return none();

  const ids = familyIds(index, node);
  const preferredKey = preferredConfig(query.sock, ids);
  const ranked: Array<{ instance: GraphNode; screen: GraphNode; described: Described; score: number }> = [];

  for (const instance of instancesOfFamily(index, node)) {
    const main = index.getMainComponent(instance.id);
    if (!main || blocked(index, main)) continue;
    if (!instance.figmaNodeId) continue;
    const screen = screenOf(index, instance.id);
    if (!screen) continue;
    const described = describeInstance(index, instance);
    if (!described.populated) continue;
    const fileKey = fileKeyOf(index, screen, query);
    const facts = (query.sock?.facts ?? []).filter(
      (fact) => ids.includes(fact.masterId) && factMatchesScreen(fact, screen, fileKey),
    );
    const verified = facts.some((fact) => fact.countsTowardThreshold !== false && fact.promoted);
    const richness = described.parts.tabs.length + described.parts.dividers.length + described.parts.rows.length;
    let score = contextScore(screen, facts, query) + Math.min(30, richness);
    if (verified) score += 100;
    if (described.parts.sizing === "hug") score += 15;
    if (preferredKey && described.configKey === preferredKey) score += 1000;
    ranked.push({ instance, screen, described, score });
  }

  const pool = preferredKey
    ? ranked.filter((row) => row.described.configKey === preferredKey)
    : ranked;
  const usable = pool.length ? pool : ranked;
  usable.sort(
    (a, b) =>
      b.score - a.score ||
      a.screen.name.localeCompare(b.screen.name) ||
      (a.instance.figmaNodeId ?? "").localeCompare(b.instance.figmaNodeId ?? ""),
  );
  const picked = usable[0];
  if (!picked) return none();
  const fileKey = fileKeyOf(index, picked.instance, query) ?? fileKeyOf(index, picked.screen, query);
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
    },
  };
}

export function examplePointer(
  index: GraphIndex,
  master: GraphNode,
  query: ExampleQuery = {},
  detail: "id" | "screen" = "id",
): string {
  const lookup = getExample(index, master, query);
  if (!lookup.found) return NO_EXAMPLE;
  if (detail === "id") return lookup.example.nodeId;
  const screen = lookup.example.screen.length > 32 ? `${lookup.example.screen.slice(0, 31)}…` : lookup.example.screen;
  return `${lookup.example.nodeId}@${screen}`;
}

/** Populated shape on this frame, for SOCK. Bare defaults are omitted. */
export function exampleFactForMasterOnFrame(
  index: GraphIndex,
  frameId: string,
  masterId: string,
): { configKey: string; exampleNodeId: string } | undefined {
  let best: { configKey: string; exampleNodeId: string; richness: number } | undefined;
  for (const instance of index.getNestedInstances(frameId)) {
    const main = index.getMainComponent(instance.id);
    if (!main) continue;
    if (main.id !== masterId && main.componentSetId !== masterId) continue;
    if (blocked(index, main)) continue;
    const described = describeInstance(index, instance);
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

export function frameContentWarnings(
  index: GraphIndex,
  frameId: string,
): { warnings: ContentWarning[]; blocking: boolean } {
  const warnings: ContentWarning[] = [];
  const instances = index.getNestedInstances(frameId);
  const described = new Map<string, Described>();
  for (const instance of instances) described.set(instance.id, describeInstance(index, instance));

  for (const instance of instances) {
    const main = index.getMainComponent(instance.id);
    if (!main || blocked(index, main)) continue;
    const fileKey = nodeFileKey(instance, index.graph.fileKey);
    const stamp = {
      ...(instance.figmaNodeId ? { figmaNodeId: instance.figmaNodeId } : { id: instance.id }),
      ...(fileKey && fileKey !== index.graph.fileKey ? { fileKey } : {}),
    };
    const texts = ownTexts(index, instance.id);
    const defaults = masterTexts(index, main);
    const placeholders = texts.filter((text) => isPlaceholder(text));
    const leftovers = texts.filter(
      (text) => !isPlaceholder(text) && defaults.has(text.toLowerCase()) && !isChromeLabel(text),
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
    if (!((fixed || mode === "unknown") && clearly) && !againstHug) continue;
    const viaMin = minHeight !== undefined && minHeight >= box && minHeight - content >= 48;
    const reason = viaMin
      ? `Min-height ${Math.round(minHeight!)} exceeds content ${Math.round(content)}.`
      : `Fixed height ${Math.round(used)} exceeds content ${Math.round(content)}.`;
    warnings.push({ ...stamp, kind: "oversized-height", reason });
  }

  return { warnings, blocking: warnings.some((warning) => warning.kind === "placeholder") };
}
