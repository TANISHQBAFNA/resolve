import type { GraphNode } from "@/core/model";
import { selectorAlternatives, splitWords, type AngularComponentRecord, type AngularInventory } from "@/adapters/angular";
import { angularInputFor } from "./componentProperties";
import type { GraphIndex } from "./GraphIndex";
import type { AngularTwin } from "./codeMap";

/**
 * Propose Figma ↔ code pairs from names and from Figma properties ↔ inputs.
 * Every pair is `suggested` or `partial`. Neither is a confirmed twin.
 */

export type SuggestRelation = "maps" | "composed-of";
export type SuggestStatus = "suggested" | "partial";

export interface SuggestedPair {
  fileKey: string;
  id: string;
  name: string;
  component: string;
  importPath: string;
  selector: string;
  module?: string;
  standalone?: true;
  inputs?: string[];
  outputs?: string[];
  relation: SuggestRelation;
  status: SuggestStatus;
  figmaVersion?: string;
  packageVersion: string;
  because: string;
  /** Set when the code class is marked `@deprecated`. */
  codeDeprecated?: string;
}

export interface CodeTarget {
  fileKey: string;
  id: string;
  name: string;
  node: GraphNode;
}

const STOP = new Set(["acme", "component", "directive", "module"]);

/** Ordered words. "Header card" is not "Card header". */
function words(raw: string): string[] {
  return splitWords(raw).filter((word) => word && !STOP.has(word));
}

function same(left: string[], right: string[]): boolean {
  return left.length > 0 && left.length === right.length && left.every((word, index) => word === right[index]);
}

function classWords(component: AngularComponentRecord): string[] {
  return words(component.component);
}

/**
 * A selector alias counts only when the selector list also names the class.
 * `acme-pill` on AcmeBadgeComponent does not match Pill. `acme-dropdown` on AcmeSelectComponent does match Dropdown.
 */
function aliasWords(component: AngularComponentRecord, figma: string[]): boolean {
  const cls = classWords(component);
  const alts = selectorAlternatives(component.selector);
  if (!alts.some((alt) => same(alt, cls))) return false;
  return alts.some((alt) => same(alt, figma));
}

function pluralStem(figma: string[]): string[] | undefined {
  if (figma.length !== 1) return undefined;
  const word = figma[0]!;
  if (word.length > 4 && word.endsWith("s") && !word.endsWith("ss")) return [word.slice(0, -1)];
  return undefined;
}

function ioNames(items: AngularComponentRecord["inputs"]): string[] | undefined {
  const list = items.map((item) => (item.alias && item.alias !== item.name ? `${item.name}: ${item.alias}` : item.name));
  return list.length ? list : undefined;
}

function coverage(node: GraphNode, inputs: string[] | undefined): "full" | "partial" {
  const props = (node.propertyDefinitions ?? []).filter((prop) => prop.type === "VARIANT" || prop.type === "BOOLEAN" || prop.type === "TEXT");
  if (!props.length || !inputs?.length) return props.length && !inputs?.length ? "partial" : "full";
  const angular: AngularTwin = { selector: "x-y", importPath: "@acme/ui", inputs };
  const matched = props.filter((prop) => angularInputFor(prop.name, angular) !== "unmapped").length;
  return matched === props.length ? "full" : "partial";
}

function toPair(
  target: CodeTarget,
  component: AngularComponentRecord,
  inventory: AngularInventory,
  relation: SuggestRelation,
  status: SuggestStatus,
  because: string,
  figmaVersion: string | undefined,
): SuggestedPair {
  const inputs = ioNames(component.inputs);
  const outputs = ioNames(component.outputs);
  return {
    fileKey: target.fileKey,
    id: target.id,
    name: target.name,
    component: component.component,
    importPath: inventory.packageName,
    selector: component.selector,
    ...(component.module ? { module: component.module } : {}),
    ...(component.standalone ? { standalone: true as const } : {}),
    ...(inputs ? { inputs } : {}),
    ...(outputs ? { outputs } : {}),
    relation,
    status,
    ...(figmaVersion ? { figmaVersion } : {}),
    packageVersion: inventory.packageVersion,
    because: component.deprecated ? `${because}; code is @deprecated ${component.deprecated}` : because,
    ...(component.deprecated ? { codeDeprecated: component.deprecated } : {}),
  };
}

type MatchKind = "token" | "partial";

/** Stem, an added suffix, or a shared family prefix. Never a character prefix. Always partial. */
function heuristicHits(wanted: string[], inventory: AngularInventory): AngularComponentRecord[] {
  const found = new Map<string, AngularComponentRecord>();
  const add = (rows: AngularComponentRecord[]) => {
    for (const row of rows) found.set(row.component, row);
  };
  const stem = pluralStem(wanted);
  if (stem) add(inventory.components.filter((component) => same(classWords(component), stem)));
  add(inventory.components.filter((component) => same(classWords(component), [...wanted, "button"])));
  const prefix = wanted.length >= 3 ? wanted.slice(0, -1) : [];
  if (prefix.length >= 2) {
    const family = inventory.components.filter((component) => {
      const cls = classWords(component);
      return cls.length === prefix.length + 1 && prefix.every((word, index) => cls[index] === word);
    });
    if (family.length >= 2) add(family);
  }
  return [...found.values()];
}

/**
 * Whole words only. One exact class or selector alias can be suggested.
 * Two exact matches are both partial, never suggested. A character prefix is never a match.
 */
function matchesFor(wanted: string[], inventory: AngularInventory): { component: AngularComponentRecord; kind: MatchKind }[] {
  if (!wanted.length) return [];
  const exact = inventory.components.filter((component) => same(classWords(component), wanted));
  if (exact.length === 1) return [{ component: exact[0]!, kind: "token" }];
  if (exact.length > 1) return exact.map((component) => ({ component, kind: "partial" }));
  const alias = inventory.components.filter((component) => aliasWords(component, wanted));
  if (alias.length === 1) return [{ component: alias[0]!, kind: "token" }];
  if (alias.length > 1) return [];
  return heuristicHits(wanted, inventory).map((component) => ({ component, kind: "partial" }));
}

export interface SuggestOptions {
  /** Library-retired parts are not suggested. */
  retired?(node: GraphNode): boolean;
}

/** Pairs only. Nothing here is written as mapped. Retired parts are skipped. */
export function suggestPairs(index: GraphIndex, inventory: AngularInventory, targets: CodeTarget[], options: SuggestOptions = {}): SuggestedPair[] {
  const figmaVersion = index.graph.source.version;
  const maps: SuggestedPair[] = [];
  const byFigma = new Map<string, AngularComponentRecord>();
  for (const target of targets) {
    if (options.retired?.(target.node)) continue;
    const wanted = words(target.name);
    const hits = matchesFor(wanted, inventory);
    const tie = hits.length > 1;
    for (const hit of hits) {
      const inputs = ioNames(hit.component.inputs);
      const fit = hit.kind === "partial" || tie ? "partial" : coverage(target.node, inputs);
      const because = tie
        ? `more than one code component has the name ${target.name}`
        : hit.kind === "partial"
          ? `name is only close to ${hit.component}; not a whole-word match`
          : fit === "full"
            ? `name matches ${hit.component}; Figma properties match its inputs`
            : `name matches ${hit.component}; some Figma properties have no input`;
      const status: SuggestStatus = hit.kind === "token" && !tie && fit === "full" ? "suggested" : "partial";
      maps.push(toPair(target, hit.component, inventory, "maps", status, because, figmaVersion));
      if (status === "suggested" && !byFigma.has(target.node.id)) byFigma.set(target.node.id, hit.component);
    }
  }
  const composed: SuggestedPair[] = [];
  for (const target of targets) {
    if (options.retired?.(target.node)) continue;
    const own = byFigma.get(target.node.id)?.component;
    const seen = new Set<string>();
    for (const instance of index.getNestedInstances(target.node.id)) {
      const main = index.getMainComponent(instance.id);
      if (!main) continue;
      const code = byFigma.get(main.id);
      if (!code || code.component === own || seen.has(code.component)) continue;
      seen.add(code.component);
      composed.push(
        toPair(
          target,
          code,
          inventory,
          "composed-of",
          "suggested",
          `${target.name} contains ${main.name}, whose code is ${code.component}`,
          figmaVersion,
        ),
      );
    }
  }
  return [...maps, ...composed].sort(
    (a, b) => a.name.localeCompare(b.name) || a.relation.localeCompare(b.relation) || a.component.localeCompare(b.component),
  );
}

export function suggestionEntries(pairs: SuggestedPair[]): Record<string, unknown>[] {
  return pairs.map((pair) => {
    const code: Record<string, unknown> = {
      framework: "angular",
      import: `import { ${pair.component} } from '${pair.importPath}'`,
      component: pair.component,
      selector: pair.selector,
      ...(pair.module ? { module: pair.module } : {}),
      ...(pair.standalone ? { standalone: true } : {}),
      ...(pair.inputs ? { inputs: pair.inputs } : {}),
      ...(pair.outputs ? { outputs: pair.outputs } : {}),
    };
    return {
      fileKey: pair.fileKey,
      id: pair.id,
      name: pair.name,
      status: pair.status,
      relation: pair.relation,
      ...(pair.figmaVersion ? { figmaVersion: pair.figmaVersion } : {}),
      packageVersion: pair.packageVersion,
      code,
    };
  });
}

export interface AnswerPair {
  figma: string;
  component: string;
  relation: SuggestRelation;
}

export interface SuggestionScore {
  proposed: number;
  labelled: number;
  hits: number;
  precision: number;
  recall: number;
  missed: AnswerPair[];
  extra: AnswerPair[];
}

const pairId = (figma: string, component: string, relation: string) => `${figma}\n${component}\n${relation}`;

/** Precision and recall of proposed pairs against a hand-labelled answer key. */
export function scoreSuggestions(proposed: AnswerPair[], labelled: AnswerPair[]): SuggestionScore {
  const want = new Set(labelled.map((pair) => pairId(pair.figma, pair.component, pair.relation)));
  const got = new Set(proposed.map((pair) => pairId(pair.figma, pair.component, pair.relation)));
  const hits = [...got].filter((id) => want.has(id)).length;
  return {
    proposed: got.size,
    labelled: want.size,
    hits,
    precision: got.size ? hits / got.size : 0,
    recall: want.size ? hits / want.size : 0,
    missed: labelled.filter((pair) => !got.has(pairId(pair.figma, pair.component, pair.relation))),
    extra: proposed.filter((pair) => !want.has(pairId(pair.figma, pair.component, pair.relation))),
  };
}

/** Mapped (and legacy current) links that are not in the answer key. The bar is zero. */
export function wrongMappedLinks(entries: unknown[], labelled: AnswerPair[]): AnswerPair[] {
  const want = new Set(labelled.map((pair) => pairId(pair.figma, pair.component, pair.relation)));
  const wrong: AnswerPair[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const status = typeof row["status"] === "string" ? row["status"] : "current";
    if (status !== "mapped" && status !== "current") continue;
    const code = row["code"];
    const component = code && typeof code === "object" && !Array.isArray(code) && typeof (code as Record<string, unknown>)["component"] === "string"
      ? ((code as Record<string, unknown>)["component"] as string)
      : "";
    const figma = typeof row["name"] === "string" ? row["name"] : "";
    const relation = row["relation"] === "composed-of" ? "composed-of" : "maps";
    if (!component || !figma) continue;
    if (!want.has(pairId(figma, component, relation))) wrong.push({ figma, component, relation });
  }
  return wrong;
}

const HOLD = new Set(["mapped", "current", "retired", "unmapped"]);

function entryKey(entry: unknown): string {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "";
  const row = entry as Record<string, unknown>;
  const code = row["code"];
  const component = code && typeof code === "object" && !Array.isArray(code) ? String((code as Record<string, unknown>)["component"] ?? "") : "";
  const relation = row["relation"] === "composed-of" ? "composed-of" : "maps";
  return `${typeof row["fileKey"] === "string" ? row["fileKey"] : ""}\n${typeof row["id"] === "string" ? row["id"] : ""}\n${component}\n${relation}`;
}

function entryStatus(entry: unknown): string {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "";
  const status = (entry as Record<string, unknown>)["status"];
  return typeof status === "string" ? status : "current";
}

/** Keep confirmed and explicit unmapped rows. Replace earlier suggestions with this scan. A suggestion never becomes mapped. */
export function mergeSuggestions(old: unknown[], suggestions: unknown[]): unknown[] {
  const kept = old.filter((entry) => HOLD.has(entryStatus(entry)));
  const keptKeys = new Set(kept.map(entryKey));
  return [...kept, ...suggestions.filter((entry) => !keptKeys.has(entryKey(entry)))];
}
