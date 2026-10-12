import { existsSync, readFileSync } from "node:fs";
import type { GraphNode } from "@/core/model";
import type { ComponentProperty } from "@/core/model/componentProperties";
import { cleanPropertyName } from "@/core/model/componentProperties";
import { nameIndexFromGraph } from "@/core/ingestion/componentProperties";
import { bindingName, type AngularTwin } from "./codeMap";
import type { GraphIndex } from "./GraphIndex";
import { overlayFile } from "./overlayFile";

/**
 * What the AI is allowed to set on a component, and which words map onto those values.
 * A hint is kept only when the value is already in the allowed list.
 */

export interface PropertyHint {
  says: string;
  value: string;
  /** When set, the hint applies only if the property name contains this word. */
  property?: string;
}

export interface PropertyRow {
  property: string;
  type: ComponentProperty["type"];
  values?: string[];
  defaultUnknown?: true;
  optionsUnknown?: true;
  unresolvedPreferred?: number;
  angular: string;
  designerSays?: string;
  note?: string;
}

export interface PropertyBlock {
  properties: PropertyRow[];
  apply?: string;
}

export interface PropertyFlag {
  property: string;
  value: string;
  allowed: string[];
}

export interface PropertyNote {
  property: string;
  value: string;
  note: string;
}

const ALIASES: Record<string, string[]> = {
  label: ["text", "arialabel"],
  text: ["label"],
  arialabel: ["label", "text"],
  hasicon: ["showicon", "icon"],
  showicon: ["hasicon", "icon"],
  icon: ["iconname", "hasicon"],
  state: ["disabled"],
  disabled: ["state"],
};

/** Built-in words. The first value that is actually allowed wins. */
const BUILTIN: PropertyHint[] = [
  { says: "secondary", value: "Secondary" },
  { says: "outline", value: "Secondary" },
  { says: "outlined", value: "Secondary" },
  { says: "outline", value: "Outline" },
  { says: "outlined", value: "Outlined" },
  { says: "disabled", value: "Disabled" },
  { says: "disabled", value: "Inactive" },
  { says: "greyed out", value: "Disabled" },
  { says: "grayed out", value: "Disabled" },
  { says: "greyed out", value: "Inactive" },
  { says: "grayed out", value: "Inactive" },
  { says: "inactive", value: "Inactive" },
  { says: "inactive", value: "Disabled" },
  { says: "small", value: "Small" },
  { says: "small", value: "Compact" },
  { says: "compact", value: "Small" },
  { says: "compact", value: "Compact" },
  { says: "large", value: "Large" },
  { says: "medium", value: "Medium" },
  { says: "primary", value: "Primary" },
  { says: "tertiary", value: "Tertiary" },
  { says: "ghost", value: "Tertiary" },
  { says: "ghost", value: "Ghost" },
  { says: "danger", value: "Danger" },
  { says: "error", value: "Error" },
  { says: "destructive", value: "Destructive" },
  { says: "danger", value: "Destructive" },
  { says: "with icon", value: "true", property: "icon" },
  { says: "has icon", value: "true", property: "icon" },
  { says: "show icon", value: "true", property: "icon" },
  { says: "disabled", value: "true", property: "disabled" },
  { says: "greyed out", value: "true", property: "disabled" },
  { says: "grayed out", value: "true", property: "disabled" },
  { says: "inactive", value: "true", property: "disabled" },
];

const fold = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Exact binding, then case-insensitive, then a known alias. Otherwise unmapped. */
export function angularInputFor(propertyName: string, angular: AngularTwin | undefined): string {
  const inputs = angular?.inputs?.map(bindingName) ?? [];
  if (!inputs.length) return "unmapped";
  const exact = inputs.find((input) => input === propertyName);
  if (exact) return exact;
  const wanted = fold(propertyName);
  const folded = inputs.find((input) => fold(input) === wanted);
  if (folded) return folded;
  const aliases = ALIASES[wanted] ?? [];
  const alias = inputs.find((input) => aliases.includes(fold(input)));
  return alias ?? "unmapped";
}

function definitionHost(index: GraphIndex, node: GraphNode): GraphNode {
  if (node.propertyDefinitions?.length) return node;
  const set = node.componentSetId ? index.getNode(node.componentSetId) : undefined;
  if (set?.propertyDefinitions?.length) return set;
  return node;
}

function allowed(prop: ComponentProperty): string[] | undefined {
  if (prop.optionsUnknown) return undefined;
  if (prop.type === "BOOLEAN") return ["true", "false"];
  return prop.options?.length ? prop.options : undefined;
}

function valueAllowed(prop: ComponentProperty, value: string): boolean {
  const options = allowed(prop);
  if (!options) return false;
  return options.includes(value);
}

function displayOf(prop: ComponentProperty): Pick<PropertyRow, "values" | "defaultUnknown" | "optionsUnknown" | "unresolvedPreferred"> {
  const unresolved = prop.unresolvedPreferred ? { unresolvedPreferred: prop.unresolvedPreferred } : {};
  if (prop.type === "BOOLEAN" && !prop.optionsUnknown) {
    const fallback = prop.defaultValue === "true" ? "true" : "false";
    const other = fallback === "true" ? "false" : "true";
    return {
      values: prop.defaultUnknown ? [fallback, other] : [`${fallback} (default)`, other],
      ...(prop.defaultUnknown ? { defaultUnknown: true as const } : {}),
    };
  }
  const options = prop.options ?? [];
  if (!options.length) {
    if (prop.defaultValue && !prop.defaultUnknown) return { values: [`${prop.defaultValue} (default)`], ...unresolved };
    return { optionsUnknown: true as const, ...(prop.defaultUnknown ? { defaultUnknown: true as const } : {}), ...unresolved };
  }
  const values = options.map((option) =>
    !prop.defaultUnknown && option === prop.defaultValue ? `${option} (default)` : option,
  );
  return {
    values,
    ...(prop.defaultUnknown ? { defaultUnknown: true as const } : {}),
    ...unresolved,
  };
}

function phraseHits(text: string, says: string): boolean {
  const escaped = says.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return false;
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(text);
}

function propertyOk(prop: ComponentProperty, hint: PropertyHint): boolean {
  if (!hint.property) return true;
  return fold(prop.name).includes(fold(hint.property));
}

export function propertyHintsFrom(raw: unknown): PropertyHint[] {
  if (!Array.isArray(raw)) return [];
  const hints: PropertyHint[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const says = typeof row["says"] === "string" ? row["says"].trim() : "";
    const value = typeof row["value"] === "string" ? row["value"].trim() : "";
    const property = typeof row["property"] === "string" ? row["property"].trim() : "";
    if (!says || !value) continue;
    hints.push({ says, value, ...(property ? { property } : {}) });
  }
  return hints;
}

/** Team file `.resolve/property-hints.json`. A bad file adds nothing. */
export function hintsFromFile(): PropertyHint[] {
  const path = overlayFile("property-hints.json");
  if (!path || !existsSync(path)) return [];
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (Array.isArray(raw)) return propertyHintsFrom(raw);
    if (!raw || typeof raw !== "object") return [];
    return propertyHintsFrom((raw as Record<string, unknown>)["hints"]);
  } catch {
    return [];
  }
}

function matchHint(prop: ComponentProperty, request: string, hints: PropertyHint[]): { says: string; value: string } | undefined {
  let best: { says: string; value: string; rank: number } | undefined;
  hints.forEach((hint, index) => {
    if (!phraseHits(request, hint.says) || !propertyOk(prop, hint) || !valueAllowed(prop, hint.value)) return;
    const rank = hint.says.trim().length * 1000 - index;
    if (!best || rank > best.rank) best = { says: hint.says.trim(), value: hint.value, rank };
  });
  return best ? { says: best.says, value: best.value } : undefined;
}

export function propertyBlock(
  index: GraphIndex,
  node: GraphNode,
  request?: string,
  angular?: AngularTwin,
  extraHints?: PropertyHint[],
): PropertyBlock | undefined {
  const defs = definitionHost(index, node).propertyDefinitions;
  if (!defs?.length) return undefined;
  const hints = [...(extraHints ?? []), ...hintsFromFile(), ...BUILTIN];
  const ask = request?.trim() ?? "";
  const properties: PropertyRow[] = defs.map((prop) => {
    const matched = ask ? matchHint(prop, ask, hints) : undefined;
    const row: PropertyRow = {
      property: prop.name,
      type: prop.type,
      ...displayOf(prop),
      angular: angularInputFor(prop.name, angular),
      ...(matched ? { designerSays: `${matched.says} → ${matched.value}` } : {}),
      ...(prop.rename ? { note: prop.rename } : {}),
    };
    return row;
  });
  const applyBits = properties.flatMap((row) => {
    if (!row.designerSays) return [];
    const value = row.designerSays.split("→")[1]?.trim();
    return value ? [`${row.property}=${value}`] : [];
  });
  return {
    properties,
    ...(applyBits.length ? { apply: `To apply: set ${applyBits.join(", ")}` } : {}),
  };
}

export function formatPropertyLines(rows: PropertyRow[]): string[] {
  return rows.map((row) => {
    const values = row.values?.length ? row.values.join(", ") : "unknown";
    const unknownDefault = row.defaultUnknown ? " · default unknown" : "";
    const unresolved = row.unresolvedPreferred
      ? ` · ${row.unresolvedPreferred} preferred ${row.unresolvedPreferred === 1 ? "value" : "values"} unknown`
      : "";
    const says = row.designerSays ? ` · designer says: ${row.designerSays}` : "";
    const note = row.note ? ` · ${row.note}` : "";
    return `- ${row.property} · ${row.type} · ${values}${unknownDefault}${unresolved} · ${row.angular}${says}${note}`;
  });
}

function seenOnInstance(index: GraphIndex, instance: GraphNode): Map<string, string> {
  const seen = new Map<string, string>();
  for (const [key, value] of Object.entries(instance.variantProperties ?? {})) {
    if (value) seen.set(cleanPropertyName(key).name, value);
  }
  const raw = instance.metadata?.["componentProperties"];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const name = cleanPropertyName(key).name;
      let text: string | undefined;
      if (typeof value === "string" || typeof value === "boolean") text = String(value);
      else if (value && typeof value === "object" && "value" in value) {
        const inner = (value as { value?: unknown }).value;
        if (typeof inner === "string" || typeof inner === "boolean" || typeof inner === "number") text = String(inner);
      }
      if (text) seen.set(name, text);
    }
  }
  for (const child of index.getChildren(instance.id)) {
    if (child.type !== "TEXT_LAYER" && child.metadata?.["figmaType"] !== "TEXT") continue;
    const text = child.metadata?.["text"];
    if (typeof text !== "string" || !text) continue;
    const name = cleanPropertyName(child.name).name;
    if (!seen.has(name)) seen.set(name, text);
  }
  return seen;
}

function valueIsAllowed(prop: ComponentProperty, value: string, names: ReturnType<typeof nameIndexFromGraph>): boolean {
  const options = allowed(prop);
  if (!options) return true;
  if (options.includes(value)) return true;
  if (prop.keys?.includes(value) || prop.defaultId === value) return true;
  const resolved = names.byId.get(value) ?? names.byKey.get(value);
  return Boolean(resolved && options.includes(resolved));
}

export function instancePropertyFindings(
  index: GraphIndex,
  instance: GraphNode,
): { flags: PropertyFlag[]; notes: PropertyNote[] } {
  const main = index.getMainComponent(instance.id) ?? instance;
  const host = definitionHost(index, main);
  const defs = host.propertyDefinitions;
  if (!defs?.length) return { flags: [], notes: [] };
  const names = nameIndexFromGraph(index.graph);
  const seen = seenOnInstance(index, instance);
  const flags: PropertyFlag[] = [];
  const notes: PropertyNote[] = [];
  for (const prop of defs) {
    const value = seen.get(prop.name);
    if (value === undefined) continue;
    const options = allowed(prop);
    if (options && !valueIsAllowed(prop, value, names)) {
      flags.push({ property: prop.name, value, allowed: options });
    }
    if (prop.type === "TEXT" && prop.defaultValue && value === prop.defaultValue) {
      notes.push({
        property: prop.name,
        value,
        note: `${prop.name} is still the default "${prop.defaultValue}".`,
      });
    }
  }
  return { flags, notes };
}

export function framePropertyFindings(
  index: GraphIndex,
  frame: GraphNode,
): { flags: PropertyFlag[]; notes: PropertyNote[] } {
  const instances =
    frame.type === "COMPONENT_INSTANCE"
      ? [frame, ...index.getNestedInstances(frame.id)]
      : index.getNestedInstances(frame.id);
  const flags: PropertyFlag[] = [];
  const notes: PropertyNote[] = [];
  const seenFlag = new Set<string>();
  const seenNote = new Set<string>();
  for (const instance of instances) {
    const found = instancePropertyFindings(index, instance);
    for (const flag of found.flags) {
      const key = `${flag.property}=${flag.value}`;
      if (seenFlag.has(key)) continue;
      seenFlag.add(key);
      flags.push(flag);
    }
    for (const note of found.notes) {
      const key = `${note.property}=${note.value}`;
      if (seenNote.has(key)) continue;
      seenNote.add(key);
      notes.push(note);
    }
  }
  return { flags, notes };
}
