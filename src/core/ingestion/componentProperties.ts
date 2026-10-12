import type { DesignGraph } from "@/core/model";
import {
  cleanPropertyName,
  type ComponentProperty,
  type ComponentPropertyType,
} from "@/core/model/componentProperties";

/**
 * Read Figma `componentPropertyDefinitions`.
 * REST fills every field the payload has. MCP fills only what it can see
 * and marks the rest unknown. Nothing here is invented.
 */

export interface ComponentNameIndex {
  byKey: Map<string, string>;
  byId: Map<string, string>;
}

export type PropertySource = "rest" | "mcp";

const KNOWN_TYPES = new Set<ComponentPropertyType>(["VARIANT", "BOOLEAN", "TEXT", "INSTANCE_SWAP"]);

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const looksLikeNodeId = (value: string): boolean => /^\d+:\d+$/.test(value);

export function emptyNameIndex(): ComponentNameIndex {
  return { byKey: new Map(), byId: new Map() };
}

export function componentNameIndex(
  components: Record<string, unknown> | undefined,
  componentSets: Record<string, unknown> | undefined,
): ComponentNameIndex {
  const names = emptyNameIndex();
  const take = (id: string, raw: unknown) => {
    const record = asRecord(raw);
    const name = asString(record["name"]);
    const key = asString(record["key"]);
    if (name) names.byId.set(id, name);
    if (key && name) names.byKey.set(key, name);
  };
  for (const [id, raw] of Object.entries(components ?? {})) take(id, raw);
  for (const [id, raw] of Object.entries(componentSets ?? {})) take(id, raw);
  return names;
}

export function nameIndexFromGraph(graph: DesignGraph): ComponentNameIndex {
  const names = emptyNameIndex();
  for (const node of graph.nodes) {
    if (node.type !== "COMPONENT_SET" && node.type !== "MAIN_COMPONENT" && node.type !== "VARIANT") continue;
    if (node.figmaNodeId) names.byId.set(node.figmaNodeId, node.name);
    const key = node.metadata?.["key"];
    if (typeof key === "string" && key) names.byKey.set(key, node.name);
  }
  return names;
}

function knownType(raw: unknown): ComponentPropertyType | undefined {
  return typeof raw === "string" && KNOWN_TYPES.has(raw as ComponentPropertyType)
    ? (raw as ComponentPropertyType)
    : undefined;
}

function stringList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const items = raw.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return items.length ? items : undefined;
}

function resolveSwap(
  raw: unknown,
  names: ComponentNameIndex,
): { display: string[]; keys: string[]; unresolved: number } {
  if (!Array.isArray(raw)) return { display: [], keys: [], unresolved: 0 };
  const display: string[] = [];
  const keys: string[] = [];
  let unresolved = 0;
  for (const item of raw) {
    const record = asRecord(item);
    const key = asString(record["key"]);
    const given = asString(record["name"]);
    if (key) keys.push(key);
    const resolved = (key ? names.byKey.get(key) : undefined) ?? (given && !looksLikeNodeId(given) ? given : undefined);
    if (resolved) display.push(resolved);
    else unresolved += 1;
  }
  return { display, keys, unresolved };
}

function resolveDefault(
  raw: unknown,
  type: ComponentPropertyType,
  names: ComponentNameIndex,
): { defaultValue?: string; defaultId?: string; defaultUnknown?: true } {
  if (raw === undefined || raw === null) return { defaultUnknown: true };
  if (typeof raw === "boolean") return { defaultValue: raw ? "true" : "false" };
  if (typeof raw !== "string") return { defaultUnknown: true };
  const text = raw.trim();
  if (!text) return { defaultUnknown: true };
  if (type !== "INSTANCE_SWAP") return { defaultValue: text };
  const resolved = names.byId.get(text) ?? names.byKey.get(text);
  if (resolved) return { defaultValue: resolved, defaultId: text };
  if (looksLikeNodeId(text)) return { defaultUnknown: true, defaultId: text };
  return { defaultValue: text };
}

function parseOne(
  rawName: string,
  raw: unknown,
  names: ComponentNameIndex,
  source: PropertySource,
): ComponentProperty | undefined {
  const cleaned = cleanPropertyName(rawName);
  if (!cleaned.name) return undefined;
  const record = asRecord(raw);
  const typed = knownType(record["type"]);
  const type: ComponentPropertyType = typed ?? "UNKNOWN";
  const prop: ComponentProperty = {
    name: cleaned.name,
    type,
    ...(cleaned.rename ? { rename: cleaned.rename } : {}),
  };
  if (!typed) {
    prop.defaultUnknown = true;
    prop.optionsUnknown = true;
    if (source === "mcp") prop.descriptionUnknown = true;
    return prop;
  }

  const fallback = resolveDefault(record["defaultValue"], type, names);
  if (fallback.defaultValue !== undefined) prop.defaultValue = fallback.defaultValue;
  if (fallback.defaultId) prop.defaultId = fallback.defaultId;
  if (fallback.defaultUnknown) prop.defaultUnknown = true;

  if (type === "BOOLEAN") {
    prop.options = ["true", "false"];
  } else if (type === "VARIANT") {
    const options = stringList(record["variantOptions"]);
    if (options) prop.options = options;
    else prop.optionsUnknown = true;
  } else if (type === "INSTANCE_SWAP") {
    const preferred = resolveSwap(record["preferredValues"], names);
    if (preferred.display.length) prop.options = preferred.display;
    else prop.optionsUnknown = true;
    if (preferred.keys.length) prop.keys = preferred.keys;
    if (preferred.unresolved) prop.unresolvedPreferred = preferred.unresolved;
  }

  const description = asString(record["description"])?.trim();
  if (description) prop.description = description;
  else if (source === "mcp") prop.descriptionUnknown = true;

  return prop;
}

/** Parsed definitions, or undefined when the payload has none. */
export function parseComponentPropertyDefinitions(
  raw: unknown,
  names: ComponentNameIndex = emptyNameIndex(),
  source: PropertySource = "rest",
): ComponentProperty[] | undefined {
  const record = asRecord(raw);
  const props: ComponentProperty[] = [];
  for (const [name, value] of Object.entries(record)) {
    const parsed = parseOne(name, value, names, source);
    if (parsed) props.push(parsed);
  }
  return props.length ? props : undefined;
}

/**
 * Variant axes visible in MCP layer names (`Variant=Primary, Size=Small`).
 * The default and the description are not in the metadata, so they stay unknown.
 * Boolean, text, and instance-swap properties are not guessed.
 */
export function variantPropertiesFromNames(names: string[]): ComponentProperty[] {
  const grouped = new Map<string, string[]>();
  for (const name of names) {
    if (!name.includes("=")) continue;
    for (const part of name.split(",")) {
      const idx = part.indexOf("=");
      if (idx <= 0) continue;
      const key = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (!key || !value) continue;
      const list = grouped.get(key) ?? [];
      if (!list.includes(value)) list.push(value);
      grouped.set(key, list);
    }
  }
  if (!grouped.size) return [];
  return [...grouped.entries()].map(([name, options]) => {
    const cleaned = cleanPropertyName(name);
    return {
      name: cleaned.name,
      type: "VARIANT" as const,
      options,
      defaultUnknown: true as const,
      descriptionUnknown: true as const,
      ...(cleaned.rename ? { rename: cleaned.rename } : {}),
    };
  });
}

/** Stamp definitions found in a design-context payload. Missing fields stay unknown. */
export function applyLearnedProperties(graph: DesignGraph, raw: unknown): number {
  const names = nameIndexFromGraph(graph);
  let applied = 0;
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = value as Record<string, unknown>;
    const id = asString(record["id"]);
    const defs = record["componentPropertyDefinitions"];
    if (id && defs && typeof defs === "object") {
      const parsed = parseComponentPropertyDefinitions(defs, names, "mcp");
      if (parsed?.length) {
        const node = graph.nodes.find((candidate) => candidate.figmaNodeId === id || candidate.id === `node:${id}`);
        if (node) {
          node.propertyDefinitions = parsed;
          applied += 1;
        }
      }
    }
    for (const child of Object.values(record)) {
      if (child && typeof child === "object") visit(child);
    }
  };
  visit(raw);
  return applied;
}
