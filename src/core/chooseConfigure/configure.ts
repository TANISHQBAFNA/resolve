import type { GraphIndex } from "@/core/read/GraphIndex";
import type { GraphNode } from "@/core/model";
import type { ComponentProperty } from "@/core/model/componentProperties";
import { cleanPropertyName } from "@/core/model/componentProperties";
import { propertyBlock, type PropertyRow } from "@/core/read/componentProperties";
import { recommendMasters } from "@/core/recommend/recommendMasters";
import { intentClauses } from "@/core/recommend/recommendLexicon";
import { tokensOf } from "@/core/read/queryTokens";
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

const CONJUNCTION = new Set(["and", "or", "with", "plus", "then", "a", "an", "the", "to", "of", "in"]);
const ON_WORD = new Set(["on", "yes", "true", "shown", "show", "switched", "checked", "enabled"]);
const OFF_WORD = new Set(["off", "no", "false", "hidden", "hide", "unchecked", "disabled"]);

interface Atom {
  raw: string;
  norm: string;
}

interface PropertyHit {
  def: ComponentProperty;
  at: number;
  end: number;
}

/** Assignments the request states, checked against this component's own properties. A library default is not a request. */
function applyAsked(
  ask: string,
  rows: PropertyRow[],
  defs: ComponentProperty[],
  componentName: string,
): { rows: ConfigureProperty[]; warnings: ConfigureWarning[] } {
  const warnings: ConfigureWarning[] = [];
  const live = defs.filter((def) => def.type !== "SLOT");
  const atoms = atomsOf(ask);
  const hits = propertyHits(atoms, live);
  const componentWords = new Set(nameTokens(componentName));
  const covered = new Set<number>();
  for (const hit of hits) for (let index = hit.at; index < hit.end; index += 1) covered.add(index);
  const picks = new Map<string, Array<{ raw: string; explicit: boolean }>>();
  const add = (def: ComponentProperty, raw: string, explicit: boolean) => {
    const list = picks.get(def.name) ?? [];
    list.push({ raw, explicit });
    picks.set(def.name, list);
  };

  const consumed = new Set<string>();
  for (const hit of hits) {
    const written = explicitRaw(atoms, hit, hits);
    if (written !== undefined) {
      add(hit.def, written, true);
      consumed.add(normOf(written));
      continue;
    }
    const near = valueBeside(atoms, hit, componentWords, live);
    if (near) {
      add(hit.def, near, false);
      consumed.add(normOf(near));
    } else if (hit.def.type === "BOOLEAN") {
      const reading = readingBeside(atoms, hit);
      if (reading) add(hit.def, reading, false);
      else if (!atoms.some((atom) => OFF_WORD.has(atom.norm))) add(hit.def, "true", false);
    }
    if (hit.def.type === "VARIANT") {
      for (const option of hit.def.options ?? []) {
        if (atoms.some((atom) => atom.norm === option.toLowerCase() && !componentWords.has(atom.norm))) add(hit.def, option, false);
      }
    }
  }

  for (const def of live) {
    if (def.type !== "VARIANT" || !def.options?.length || picks.has(def.name)) continue;
    const seen = def.options.filter((option) => {
      const norm = option.toLowerCase();
      if (consumed.has(norm) || componentWords.has(norm)) return false;
      if (!atoms.some((atom) => atom.norm === norm)) return false;
      const owners = live.filter((other) => other.type === "VARIANT" && other.options?.some((item) => item.toLowerCase() === norm));
      return owners.length === 1;
    });
    for (const option of seen) add(def, option, false);
  }

  for (const count of intentClauses(ask).counts) {
    const listed = live.filter((def) => (def.options ?? []).some((option) => option.toLowerCase() === count));
    if (listed.length === 1 && !picks.has(listed[0]!.name)) {
      add(listed[0]!, count, false);
      continue;
    }
    if (listed.length > 0) continue;
    const stepProp = live.filter((def) => tokensOf(def.name).some((token) => token === "step" || token === "steps" || token === "count"));
    if (stepProp.length === 1 && !picks.has(stepProp[0]!.name)) add(stepProp[0]!, count, false);
    else if (stepProp.length === 0) {
      warnings.push({
        warning: `${componentName} cannot apply "${count}".`,
        next: `${componentName} has no step count that takes ${count}.`,
      });
    }
  }

  const namedBoolean = hits.some((hit) => hit.def.type === "BOOLEAN");
  if (!namedBoolean) {
    const booleans = live.filter((def) => def.type === "BOOLEAN" && !def.optionsUnknown);
    const reading = loneReading(atoms);
    if (reading === "conflict") {
      warnings.push({
        warning: `${componentName} is asked both on and off.`,
        next: booleans.length ? `Say which of ${booleans.map((def) => def.name).join(", ")} to set.` : "Say whether it is on or off.",
      });
    } else if (reading && booleans.length > 1) {
      warnings.push({
        warning: `${componentName} has more than one switch.`,
        next: `Name which one: ${booleans.map((def) => def.name).join(", ")}.`,
      });
    } else if ((reading === "true" || reading === "false") && booleans.length === 0) {
      warnings.push({
        warning: `${componentName} has no switch property, so ${reading === "true" ? "on" : "off"} cannot be set.`,
        next: "Leave the switch unset. This component does not show a boolean that can turn it on or off.",
      });
    }
  }

  for (const key of unknownKeys(atoms, hits)) {
    warnings.push({
      warning: `${componentName} has no property ${key}.`,
      next: live.length ? `${componentName} has ${live.map((def) => def.name).join(", ")}.` : "This component lists no properties.",
    });
  }

  const asked = new Map<string, AskedValue>();
  const blocked = new Set<string>();
  for (const def of live) {
    const list = picks.get(def.name);
    if (!list?.length) continue;
    const explicit = list.filter((pick) => pick.explicit);
    const use = explicit.length ? explicit : list;
    const distinct = [...new Map(use.map((pick) => [pick.raw.trim().toLowerCase(), pick.raw])).values()];
    if (distinct.length > 1) {
      blocked.add(def.name);
      warnings.push({
        warning: `${def.name} is asked as both ${distinct.join(" and ")}.`,
        next: `Say which ${def.name} to use. ${def.name} allows ${allowedText(def)}.`,
      });
      continue;
    }
    const raw = distinct[0] ?? "";
    const match = matchValue(def, raw);
    asked.set(def.name, match);
    if (match.invalid) warnings.push(invalidValue(def, raw));
  }

  const unit = new Set(["percent", "percentage", "px", "pt", "rem", "em"]);
  for (let index = 0; index < atoms.length; index += 1) {
    const atom = atoms[index];
    if (!atom || !/^\d+$/.test(atom.norm)) continue;
    const trailing = index === atoms.length - 1 || unit.has(atoms[index + 1]?.norm ?? "");
    if (!trailing) continue;
    const used = [...picks.values()].some((list) => list.some((pick) => normOf(pick.raw) === atom.norm));
    if (used) continue;
    warnings.push({
      warning: `${componentName} cannot apply "${atom.raw}".`,
      next: `Name the property that takes ${atom.raw}, or pick a component that has one.`,
    });
  }

  const out = rows.map((row) => {
    const match = asked.get(row.property);
    const base = publicProperty(row);
    if (blocked.has(row.property)) return unset(base);
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

function atomsOf(ask: string): Atom[] {
  const atoms: Atom[] = [];
  for (const part of ask.split(/(\s+|=)/)) {
    if (!part || /^\s+$/.test(part)) continue;
    if (part === "=") {
      atoms.push({ raw: "=", norm: "=" });
      continue;
    }
    const raw = part.replace(/^[("']+|[)"',;]+$/g, "");
    if (!raw) continue;
    atoms.push({ raw, norm: raw.toLowerCase().replace(/[^a-z0-9]+/g, "") });
  }
  return atoms.filter((atom) => atom.norm.length > 0);
}

function nameTokens(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 0);
}

function propertyHits(atoms: Atom[], defs: ComponentProperty[]): PropertyHit[] {
  const words = atoms.map((atom, index) => ({ atom, index })).filter((row) => row.atom.norm !== "=");
  const ordered = [...defs].sort((a, b) => nameTokens(b.name).length - nameTokens(a.name).length || b.name.length - a.name.length);
  const used = new Set<number>();
  const hits: PropertyHit[] = [];
  for (const def of ordered) {
    const tokens = nameTokens(def.name);
    if (!tokens.length) continue;
    let found = false;
    for (let i = 0; i <= words.length - tokens.length; i += 1) {
      const span = words.slice(i, i + tokens.length);
      if (span.some((row) => used.has(row.index))) continue;
      if (!span.every((row, offset) => row.atom.norm === tokens[offset])) continue;
      for (const row of span) used.add(row.index);
      hits.push({ def, at: span[0]!.index, end: span[span.length - 1]!.index + 1 });
      found = true;
      break;
    }
    if (found || def.type !== "BOOLEAN") continue;
    const distinctive = [...tokens].sort((a, b) => b.length - a.length)[0];
    if (!distinctive || distinctive.length < 4) continue;
    const at = words.find((row) => !used.has(row.index) && row.atom.norm === distinctive);
    if (!at) continue;
    const reading = words.some((row) => Math.abs(row.index - at.index) <= 3 && (ON_WORD.has(row.atom.norm) || OFF_WORD.has(row.atom.norm) || row.atom.norm === "shown" || row.atom.norm === "with"));
    if (!reading) continue;
    used.add(at.index);
    hits.push({ def, at: at.index, end: at.index + 1 });
  }
  return hits;
}

function explicitRaw(atoms: Atom[], hit: PropertyHit, hits: PropertyHit[]): string | undefined {
  const next = atoms[hit.end];
  if (next?.norm !== "=") return undefined;
  const stop = Math.min(...hits.filter((other) => other.at > hit.end).map((other) => other.at), atoms.length);
  const raw: string[] = [];
  for (let index = hit.end + 1; index < stop; index += 1) {
    const atom = atoms[index];
    if (!atom || atom.norm === "=" || CONJUNCTION.has(atom.norm)) break;
    raw.push(atom.raw);
  }
  const value = raw.join(" ").trim();
  return value || undefined;
}

function normOf(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function valueBeside(atoms: Atom[], hit: PropertyHit, componentWords: Set<string>, defs: ComponentProperty[]): string | undefined {
  const skip = (atom: Atom | undefined) => !atom || atom.norm === "=" || CONJUNCTION.has(atom.norm) || atom.norm === "at" || atom.norm === "beside" || componentWords.has(atom.norm);
  const otherProperty = (atom: Atom) => defs.some((def) => def.name !== hit.def.name && nameTokens(def.name).includes(atom.norm));
  for (let index = hit.end; index < atoms.length; index += 1) {
    const atom = atoms[index];
    if (!atom || atom.norm === "=") break;
    if (skip(atom)) continue;
    if (atom.norm === "show" || atom.norm === "showing") continue;
    if (otherProperty(atom)) break;
    if (hit.def.type === "BOOLEAN" && (ON_WORD.has(atom.norm) || OFF_WORD.has(atom.norm) || atom.norm === "shown")) break;
    if (hit.def.type === "BOOLEAN") continue;
    return atom.raw;
  }
  if (hit.def.type === "TEXT") return undefined;
  const previous = atoms[hit.at - 1];
  if (!previous || skip(previous) || otherProperty(previous)) return undefined;
  const allowed = hit.def.options?.some((option) => option.toLowerCase() === previous.norm) || /^\d+$/.test(previous.norm);
  return allowed ? previous.raw : undefined;
}

function readingBeside(atoms: Atom[], hit: PropertyHit): string | undefined {
  const around = [atoms[hit.at - 1], atoms[hit.end], atoms[hit.end + 1]].filter((atom): atom is Atom => Boolean(atom));
  const on = around.some((atom) => ON_WORD.has(atom.norm) || atom.norm === "shown");
  const off = around.some((atom) => OFF_WORD.has(atom.norm));
  if (on && off) return undefined;
  if (off) return "false";
  if (on || hit.def.type === "BOOLEAN") return "true";
  return undefined;
}

function loneReading(atoms: Atom[]): "true" | "false" | "conflict" | undefined {
  const on = atoms.some((atom) => ON_WORD.has(atom.norm));
  const off = atoms.some((atom) => OFF_WORD.has(atom.norm));
  if (on && off) return "conflict";
  if (on) return "true";
  if (off) return "false";
  return undefined;
}

function unknownKeys(atoms: Atom[], hits: PropertyHit[]): string[] {
  const ends = new Set(hits.map((hit) => hit.end - 1));
  const found: string[] = [];
  for (let index = 0; index < atoms.length - 1; index += 1) {
    const atom = atoms[index];
    if (!atom || atoms[index + 1]?.norm !== "=" || atom.norm === "=") continue;
    if (ends.has(index)) continue;
    found.push(atom.raw);
  }
  return found;
}

function allowedText(def: ComponentProperty): string {
  if (def.type === "BOOLEAN") return "true or false";
  if (def.options?.length) return def.options.join(", ");
  return "the values listed for this property";
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
  if (def.type === "TEXT" && !def.options?.length) return { value: raw.trim(), raw: raw.trim(), invalid: false };
  const hit = def.options?.find((option) => option.toLowerCase() === needle);
  if (hit) return { value: hit, raw, invalid: false };
  return { value: "", raw, invalid: true };
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
