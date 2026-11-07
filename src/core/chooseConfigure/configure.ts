import type { GraphIndex } from "@/core/read/GraphIndex";
import type { GraphNode } from "@/core/model";
import type { ComponentProperty } from "@/core/model/componentProperties";
import { cleanPropertyName } from "@/core/model/componentProperties";
import { propertyBlock, type PropertyRow } from "@/core/read/componentProperties";
import { recommendMasters } from "@/core/recommend/recommendMasters";
import { controllingFromReferences } from "@/core/screenMap/capture";

export interface ConfigureWarning {
  warning: string;
  next: string;
}

export type ConfigureBasis = "library-rule" | "unverified" | "stale" | "usage";

export interface ConfigureChoice {
  id: string;
  name: string;
  fileKey?: string;
  figmaNodeId?: string;
  why: string;
  basis: ConfigureBasis;
}

export interface ConfigureProperty {
  property: string;
  type: string;
  values?: string[];
  set?: string;
  evidence: "request" | "unset";
}

export interface ControlledChild {
  child: string;
  property: string;
  type: string;
  hidden?: true;
  overridden?: true;
  value: true | false | "missing";
}

export type ConfigureVisibility =
  | { state: "unknown"; reason: string }
  | { state: "controlled"; children: ControlledChild[]; ignored?: string };

const VISIBILITY_ABSENT = "This graph does not name which property shows or hides a child.";

export interface ConfigureReport {
  ask: string;
  choice: ConfigureChoice | null;
  configuration: ConfigureProperty[];
  slots: string[];
  visibility: ConfigureVisibility;
  alternatives: Array<{ id: string; name: string; why: string }>;
  warnings: ConfigureWarning[];
  next: string;
}

const PLACE = "Place fileKey and figmaNodeId. Leave unset properties unset.";

/** Choose one real component and the properties the request may set. Gaps are warnings. */
export function configureChoice(
  index: GraphIndex,
  ask: string,
  context?: { journey?: string; screenType?: string },
): ConfigureReport {
  const journey = context?.journey?.trim();
  const screenType = context?.screenType?.trim();
  const card = recommendMasters(index, ask, {
    ...(journey || screenType
      ? {
          context: {
            ...(screenType ? { id: screenType, screenType, domain: screenType } : {}),
            ...(journey ? { id: journey, journey: { screenJob: journey, step: journey } } : {}),
          },
        }
      : {}),
  });
  const lead = card.candidates[0];
  const full = lead && "instances" in lead ? lead : undefined;
  const warnings: ConfigureWarning[] = [];
  if (!lead) {
    warnings.push({
      warning: "No component in the learned library matched.",
      next: "Name a component that is in the library, or learn the library. Do not invent one.",
    });
    return finish(ask, null, [], [], [], warnings, { state: "unknown", reason: VISIBILITY_ABSENT });
  }
  if (card.match === "weak match") {
    warnings.push({ warning: "Weak match. The name is not a clear hit.", next: "Check the name before placing it." });
  }
  if (full?.deprecated) {
    warnings.push({ warning: `${lead.name} is deprecated.`, next: "Do not place it. Pick another candidate." });
  }
  const why = lead.why;
  const parts = why.split("; ").map((part) => part.trim());
  if (parts.includes("stale")) {
    warnings.push({ warning: "Usage for this component is stale.", next: "Treat the count as out of date." });
  }
  if (parts.some((part) => part.startsWith("not verified")) || (full?.instances ?? 0) === 0) {
    warnings.push({
      warning: "No confirmed usage on a learned screen.",
      next: "Use it only when the name and the allowed values match the request.",
    });
  }
  if (card.note) warnings.push({ warning: card.note, next: "Resolve the name clash before placing." });
  const visibility = visibilityFor(index, lead.id);
  if (visibility.state === "unknown") {
    warnings.push({ warning: visibility.reason, next: "Leave visibility unset." });
  } else if (visibility.ignored) {
    warnings.push({ warning: visibility.ignored, next: "Leave that child unset." });
  }
  const node = index.getNode(lead.id);
  const block = node ? propertyBlock(index, node, ask) : undefined;
  const defs = node ? hostDefinitions(index, node) : [];
  const applied = applyAsked(ask, block?.properties ?? [], defs, lead.name);
  const variants = applied.rows.length || !node ? undefined : variantConfiguration(index, node, ask);
  if (applied.warnings.length) warnings.push(...applied.warnings);
  if (variants?.warnings.length) warnings.push(...variants.warnings);
  const rows = applied.rows.length ? applied.rows : (variants?.rows ?? []);
  return finish(
    ask,
    {
      id: lead.id,
      name: lead.name,
      ...(lead.fileKey ? { fileKey: lead.fileKey } : {}),
      ...(lead.figmaNodeId ? { figmaNodeId: lead.figmaNodeId } : {}),
      why,
      basis: basisOf(parts),
    },
    rows,
    full?.slots ?? [],
    card.candidates.slice(1, 4).map((row) => ({ id: row.id, name: row.name, why: row.why })),
    warnings,
    visibility,
  );
}

/** A gap before ranking: empty request, or no learned library. */
export function configureGap(ask: string, warning: string, next: string): ConfigureReport {
  return finish(ask, null, [], [], [], [{ warning, next }], { state: "unknown", reason: warning });
}

function basisOf(parts: string[]): ConfigureBasis {
  if (parts.some((part) => part.startsWith("bind rule"))) return "library-rule";
  if (parts.includes("stale")) return "stale";
  if (parts.some((part) => part.startsWith("not verified"))) return "unverified";
  return "usage";
}

function publicProperty(row: PropertyRow): ConfigureProperty {
  const set = row.designerSays?.split("→")[1]?.trim();
  return {
    property: row.property,
    type: row.type,
    ...(row.values?.length ? { values: row.values } : {}),
    ...(set ? { set, evidence: "request" as const } : { evidence: "unset" as const }),
  };
}

interface AskedValue {
  value: string;
  raw: string;
  invalid: boolean;
}

/** Assignments the request states, checked against this component's own properties. A library default is not a request. */
function applyAsked(
  ask: string,
  rows: PropertyRow[],
  defs: ComponentProperty[],
  componentName: string,
): { rows: ConfigureProperty[]; warnings: ConfigureWarning[] } {
  const warnings: ConfigureWarning[] = [];
  const asked = new Map<string, AskedValue>();
  for (const def of defs) {
    if (def.type === "SLOT") continue;
    const explicit = explicitValue(def.name, ask);
    if (explicit === undefined) continue;
    const match = matchValue(def, explicit);
    asked.set(def.name, match);
    if (match.invalid) warnings.push(invalidValue(def, explicit));
  }
  for (const key of unknownKeys(ask, defs)) {
    warnings.push({
      warning: `${componentName} has no property ${key}.`,
      next: defs.length ? `${componentName} has ${defs.map((def) => def.name).join(", ")}.` : "This component lists no properties.",
    });
  }
  const claimed = new Set(asked.keys());
  const componentWords = new Set(wordsOf(componentName));
  for (const def of defs) {
    if (def.type === "SLOT" || claimed.has(def.name)) continue;
    const named = nameInAsk(def.name, ask);
    const following = named ? valueAfter(def.name, ask, defs) : undefined;
    if (following) {
      const match = matchValue(def, following);
      asked.set(def.name, match);
      if (match.invalid) warnings.push(invalidValue(def, following));
      continue;
    }
    const option = uniqueOption(def, ask, defs, componentWords);
    if (option) asked.set(def.name, { value: option, raw: option, invalid: false });
  }
  const out = rows.map((row) => {
    const match = asked.get(row.property);
    const base = publicProperty(row);
    if (!match) return base;
    if (match.invalid) return unset(base);
    return { ...base, set: match.value, evidence: "request" as const };
  });
  return { rows: out, warnings };
}

function unset(row: ConfigureProperty): ConfigureProperty {
  const { set: _set, ...rest } = row;
  return { ...rest, evidence: "unset" };
}

function invalidValue(def: ComponentProperty, raw: string): ConfigureWarning {
  const allowed = def.type === "BOOLEAN" ? "true or false" : def.options?.length ? def.options.join(", ") : "the values listed for this property";
  return { warning: `${def.name} does not allow "${raw}".`, next: `${def.name} allows ${allowed}.` };
}

function explicitValue(name: string, ask: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = ask.match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*([^,;\\n]+?)(?=\\s+[A-Za-z][\\w-]*\\s*=|$)`, "i"));
  return match?.[1]?.trim() || undefined;
}

function unknownKeys(ask: string, defs: ComponentProperty[]): string[] {
  const known = new Set(defs.map((def) => def.name.toLowerCase()));
  const found: string[] = [];
  for (const match of ask.matchAll(/(?:^|\s)([A-Za-z][\w-]*)\s*=/g)) {
    const key = match[1] ?? "";
    if (!key || known.has(key.toLowerCase())) continue;
    found.push(key);
  }
  return found;
}

function nameInAsk(name: string, ask: string): boolean {
  const tokens = wordsOf(name);
  if (!tokens.length) return false;
  const words = wordsOf(ask);
  return tokens.every((token) => words.includes(token));
}

function valueAfter(name: string, ask: string, defs: ComponentProperty[]): string | undefined {
  const tokens = wordsOf(name);
  const words = wordsOf(ask);
  const at = words.findIndex((_, index) => tokens.every((token, offset) => words[index + offset] === token));
  const next = at >= 0 ? words[at + tokens.length] : undefined;
  if (!next || next === "with") return undefined;
  if (defs.some((def) => def.name !== name && wordsOf(def.name).includes(next))) return undefined;
  return next;
}

function uniqueOption(def: ComponentProperty, ask: string, defs: ComponentProperty[], componentWords: Set<string>): string | undefined {
  if (def.type !== "VARIANT" || !def.options?.length) return undefined;
  const words = new Set(wordsOf(ask));
  const hits = def.options.filter((option) => words.has(option.toLowerCase()) && !componentWords.has(option.toLowerCase()));
  if (hits.length !== 1) return undefined;
  const value = hits[0];
  if (!value) return undefined;
  const elsewhere = defs.some((other) => other.name !== def.name && other.options?.some((option) => option.toLowerCase() === value.toLowerCase()));
  return elsewhere ? undefined : value;
}

function matchValue(def: ComponentProperty, raw: string): AskedValue {
  const needle = raw.trim().toLowerCase();
  if (def.type === "BOOLEAN" && !def.optionsUnknown) {
    const options = new Set((def.options?.length ? def.options : ["true", "false"]).map((option) => option.toLowerCase()));
    if (options.has("true") && options.has("false")) {
      if (needle === "true" || needle === "on" || needle === "yes") return { value: "true", raw, invalid: false };
      if (needle === "false" || needle === "off" || needle === "no") return { value: "false", raw, invalid: false };
    }
    const hit = [...options].find((option) => option === needle);
    return hit ? { value: hit, raw, invalid: false } : { value: "", raw, invalid: true };
  }
  if (def.type === "TEXT" && !def.options?.length) return { value: raw.trim(), raw, invalid: false };
  const hit = def.options?.find((option) => option.toLowerCase() === needle);
  if (hit) return { value: hit, raw, invalid: false };
  return { value: "", raw, invalid: true };
}

function wordsOf(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 0);
}

/** Variant values live on the set's children when the component has no property definitions. */
function variantConfiguration(
  index: GraphIndex,
  node: GraphNode,
  ask: string,
): { rows: ConfigureProperty[]; warnings: ConfigureWarning[] } {
  const values = new Map<string, string[]>();
  for (const child of index.getChildren(node.id)) {
    for (const [key, value] of Object.entries(child.variantProperties ?? {})) {
      if (!value) continue;
      const list = values.get(key) ?? [];
      if (!list.includes(value)) list.push(value);
      values.set(key, list);
    }
  }
  const defs: ComponentProperty[] = [...values].map(([name, options]) => ({ name, type: "VARIANT", options }));
  const rows: PropertyRow[] = defs.map((def) => ({ property: def.name, type: def.type, values: def.options, angular: "" }));
  return applyAsked(ask, rows, defs, node.name);
}

function finish(
  ask: string,
  choice: ConfigureChoice | null,
  configuration: ConfigureProperty[],
  slots: string[],
  alternatives: ConfigureReport["alternatives"],
  warnings: ConfigureWarning[],
  visibility: ConfigureVisibility,
): ConfigureReport {
  return {
    ask,
    choice,
    configuration,
    slots,
    visibility,
    alternatives,
    warnings,
    next: warnings[0]?.next ?? PLACE,
  };
}

function hostDefinitions(index: GraphIndex, node: GraphNode): ComponentProperty[] {
  const set = node.componentSetId ? index.getNode(node.componentSetId) : undefined;
  const host = set?.propertyDefinitions?.length ? set : node;
  return host.propertyDefinitions ?? [];
}

function definitionsOf(index: GraphIndex, node: GraphNode): Array<{ name: string; type: string }> {
  return hostDefinitions(index, node).map((row) => ({ name: row.name, type: row.type }));
}

function descendants(index: GraphIndex, id: string): GraphNode[] {
  const out: GraphNode[] = [];
  for (const child of index.getChildren(id)) out.push(child, ...descendants(index, child.id));
  return out;
}

function booleanValue(node: GraphNode, property: string): true | false | "missing" {
  const raw = node.metadata?.["componentProperties"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "missing";
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (cleanPropertyName(key).name !== property) continue;
    const inner = value && typeof value === "object" && "value" in value ? (value as { value: unknown }).value : value;
    if (inner === true || inner === false) return inner;
    return "missing";
  }
  return "missing";
}

/** A child is controlled only when its captured visible reference names a real property. */
export function visibilityFor(index: GraphIndex, nodeId: string): ConfigureVisibility {
  const lead = index.getNode(nodeId);
  if (!lead) return { state: "unknown", reason: VISIBILITY_ABSENT };
  const definitions = definitionsOf(index, lead);
  const children: ControlledChild[] = [];
  let guessed = false;
  let unmatched = false;
  for (const child of descendants(index, lead.id)) {
    const raw = child.metadata?.["componentPropertyReferences"];
    const visible = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>)["visible"] : undefined;
    if (typeof visible !== "string" || !visible.trim()) continue;
    if (child.metadata?.["identity"] === "inferred-from-name") {
      guessed = true;
      continue;
    }
    const control = controllingFromReferences({ visible }, definitions);
    if (!control || !definitions.some((row) => row.name === control.property && row.type === control.type)) {
      unmatched = true;
      continue;
    }
    const hidden = child.metadata?.["hidden"] === true;
    const overrides = child.metadata?.["overrides"];
    const overridden = Array.isArray(overrides) && overrides.length > 0;
    children.push({
      child: child.name,
      property: control.property,
      type: control.type,
      ...(hidden ? { hidden: true } : {}),
      ...(overridden ? { overridden: true } : {}),
      value: booleanValue(child, control.property),
    });
  }
  if (children.length) {
    return {
      state: "controlled",
      children,
      ...(unmatched ? { ignored: "A visible reference does not match a property on this component." } : {}),
    };
  }
  if (guessed) return { state: "unknown", reason: "The visible reference is on a guessed layer, so it is not a property." };
  if (unmatched) return { state: "unknown", reason: "The visible reference does not match a property on this component." };
  return { state: "unknown", reason: VISIBILITY_ABSENT };
}
