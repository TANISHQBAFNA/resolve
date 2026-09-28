import type { DesignGraph, GraphNode } from "@/core/model";

/**
 * Real text characters from Figma MCP output.
 * `get_metadata` usually has no characters. `get_design_context` (or an
 * explicit `{ nodeId, characters }` list) does. Layer names are never text.
 */

export interface TextStamp {
  nodeId: string;
  characters: string;
}

export const TEXT_UNCHECKED_REASON = "no text characters; fetch design context before verify";
export const TEXT_DEFAULT_UNKNOWN = "default text unknown; pass design context to learn_library";
export const TEXT_NO_FRAME = "no frame";
export const TEXT_NO_LAYERS = "no text layers";
export const TEXT_ENTRY_CAP = 2000;
export const TEXT_CHAR_CAP = 2000;

export class TextInputError extends Error {}

/** Reject oversized agent text before it is applied. */
export function assertVerifyTextInput(raw: unknown, label: string): void {
  if (raw == null) return;
  const stamps = textStampsFrom(raw);
  if (stamps.length > TEXT_ENTRY_CAP) {
    throw new TextInputError(
      `${label} has ${stamps.length} text entries; the maximum is ${TEXT_ENTRY_CAP}.`,
    );
  }
  for (const stamp of stamps) {
    if (stamp.characters.length > TEXT_CHAR_CAP) {
      throw new TextInputError(
        `${label} text for ${stamp.nodeId} is ${stamp.characters.length} characters; the maximum is ${TEXT_CHAR_CAP}.`,
      );
    }
  }
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
};

function decode(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#39);/g, (match) => ENTITIES[match] ?? match);
}

function attr(raw: string, name: string): string | undefined {
  const match = raw.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  const value = match?.[1];
  return value ? decode(value) : undefined;
}

function nodeIdFromAttrs(raw: string): string | undefined {
  return attr(raw, "data-node-id") ?? attr(raw, "id");
}

function cleanLeaf(raw: string): string | undefined {
  let text = decode(raw).trim();
  const wrapped =
    text.match(/^\{`([\s\S]*)`\}$/) ?? text.match(/^\{"([\s\S]*)"\}$/) ?? text.match(/^\{'([\s\S]*)'\}$/);
  if (wrapped?.[1] !== undefined) text = wrapped[1].trim();
  if (!text || text.startsWith("{")) return undefined;
  return text;
}

function collectMarkup(source: string, into: Map<string, string>): void {
  const tags = /<([A-Za-z][\w:-]*)\b([^>]*)>/g;
  let tag = tags.exec(source);
  while (tag) {
    const id = nodeIdFromAttrs(tag[2] ?? "");
    const characters = attr(tag[2] ?? "", "characters");
    if (id && characters?.trim()) into.set(id, characters.trim());
    tag = tags.exec(source);
  }
  const leaves = /<([A-Za-z][\w:-]*)\b([^>]*)>\s*([^<]*?)\s*<\/\1>/g;
  let leaf = leaves.exec(source);
  while (leaf) {
    const id = nodeIdFromAttrs(leaf[2] ?? "");
    const characters = cleanLeaf(leaf[3] ?? "");
    if (id && characters && !into.has(id)) into.set(id, characters);
    leaf = leaves.exec(source);
  }
}

function stringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function walk(value: unknown, into: Map<string, string>, depth: number): void {
  if (depth > 6 || value == null) return;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        walk(JSON.parse(trimmed) as unknown, into, depth + 1);
        return;
      } catch {
        // Markup or prose, not JSON.
      }
    }
    if (
      trimmed.includes("characters=") ||
      trimmed.includes("data-node-id") ||
      trimmed.includes("<text") ||
      trimmed.includes("<p ")
    ) {
      collectMarkup(trimmed, into);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, into, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const entries = Object.entries(record);
  const plainMap =
    entries.length > 0 &&
    entries.every(([, item]) => typeof item === "string") &&
    !("characters" in record) &&
    !("nodeId" in record) &&
    !("figmaNodeId" in record) &&
    !("id" in record) &&
    !("text" in record) &&
    !("texts" in record);
  if (plainMap) {
    for (const [id, item] of entries) {
      if (typeof item !== "string" || !item.trim()) continue;
      if (id.includes(":") && /^[\w.:;-]+$/.test(id)) into.set(id, item.trim());
      else walk(item, into, depth + 1);
    }
    return;
  }
  for (const child of Object.values(record)) walk(child, into, depth + 1);
  const texts = record["texts"];
  if (texts && typeof texts === "object" && !Array.isArray(texts)) {
    for (const [id, item] of Object.entries(texts as Record<string, unknown>)) {
      if (typeof item === "string" && item.trim()) into.set(id, item.trim());
    }
  }
  const id = stringField(record, ["nodeId", "figmaNodeId", "id"]);
  const characters = stringField(record, ["characters"]) ?? stringField(record, ["text"]);
  if (id && characters) into.set(id, characters);
}

/** Characters keyed by Figma node id. Never reads a layer name. */
export function textStampsFrom(raw: unknown): TextStamp[] {
  if (raw == null) return [];
  const into = new Map<string, string>();
  walk(raw, into, 0);
  const stamps: TextStamp[] = [];
  for (const [nodeId, characters] of into) stamps.push({ nodeId, characters });
  return stamps;
}

/** Graph node id → characters, for text layers the payload actually named. */
export function textOverlay(nodes: readonly GraphNode[], stamps: readonly TextStamp[]): Map<string, string> {
  const overlay = new Map<string, string>();
  if (!stamps.length) return overlay;
  const byFig = new Map<string, string[]>();
  const textIds = new Set<string>();
  for (const node of nodes) {
    if (node.type !== "TEXT_LAYER") continue;
    textIds.add(node.id);
    if (!node.figmaNodeId) continue;
    const list = byFig.get(node.figmaNodeId) ?? [];
    list.push(node.id);
    byFig.set(node.figmaNodeId, list);
  }
  for (const stamp of stamps) {
    const characters = stamp.characters.trim();
    if (!characters) continue;
    const ids = byFig.get(stamp.nodeId);
    if (ids) {
      for (const id of ids) overlay.set(id, characters);
    }
    if (textIds.has(stamp.nodeId)) overlay.set(stamp.nodeId, characters);
  }
  return overlay;
}

function storedText(node: GraphNode): string | undefined {
  const meta = node.metadata?.["text"];
  if (typeof meta === "string" && meta.trim()) return meta.trim();
  return undefined;
}

/**
 * Design context may replace stored characters on the layers passed in.
 * A texts map may only fill layers that have none. Callers pass text layers
 * inside the verified frame, never component or variant layers.
 */
export function scopedOverlay(
  layers: readonly GraphNode[],
  designStamps: readonly TextStamp[],
  fillStamps: readonly TextStamp[],
): { overlay: Map<string, string>; textOverrides: number } {
  const overlay = new Map<string, string>();
  const byKey = new Map<string, GraphNode[]>();
  const add = (key: string, layer: GraphNode) => {
    const list = byKey.get(key);
    if (list) list.push(layer);
    else byKey.set(key, [layer]);
  };
  for (const layer of layers) {
    if (layer.type !== "TEXT_LAYER") continue;
    add(layer.id, layer);
    if (layer.figmaNodeId) add(layer.figmaNodeId, layer);
  }
  const targets = (nodeId: string): GraphNode[] => byKey.get(nodeId) ?? [];
  const overridden = new Set<string>();
  let textOverrides = 0;
  for (const stamp of designStamps) {
    const characters = stamp.characters.trim();
    if (!characters) continue;
    for (const layer of targets(stamp.nodeId)) {
      const stored = storedText(layer);
      if (stored && stored !== characters && !overridden.has(layer.id)) {
        overridden.add(layer.id);
        textOverrides += 1;
      }
      overlay.set(layer.id, characters);
    }
  }
  for (const stamp of fillStamps) {
    const characters = stamp.characters.trim();
    if (!characters) continue;
    for (const layer of targets(stamp.nodeId)) {
      if (storedText(layer) || overlay.has(layer.id)) continue;
      overlay.set(layer.id, characters);
    }
  }
  return { overlay, textOverrides };
}

/** Stamp master/default text onto text layers when learn was given real characters. */
export function applyLearnedText(graph: DesignGraph, raw: unknown): number {
  const stamps = textStampsFrom(raw);
  if (!stamps.length) return 0;
  const overlay = textOverlay(graph.nodes, stamps);
  let applied = 0;
  for (const node of graph.nodes) {
    const characters = overlay.get(node.id);
    if (!characters) continue;
    if (node.metadata?.["text"] === characters) continue;
    node.metadata = { ...node.metadata, text: characters };
    applied += 1;
  }
  return applied;
}
