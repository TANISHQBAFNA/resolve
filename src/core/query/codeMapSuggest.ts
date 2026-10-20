import type { GraphNode } from "@/core/model";
import { selectorWords, splitWords, type AngularComponentRecord, type AngularInventory } from "@/adapters/angular";
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
}

export interface CodeTarget {
  fileKey: string;
  id: string;
  name: string;
  node: GraphNode;
}

const STOP = new Set(["acme", "component", "module"]);

function words(raw: string): string[] {
  return [...new Set(splitWords(raw).filter((word) => word && !STOP.has(word)))].sort();
}

function same(left: string[], right: string[]): boolean {
  return left.length > 0 && left.length === right.length && left.every((word, index) => word === right[index]);
}

function codeWords(component: AngularComponentRecord): string[][] {
  return [words(component.component), words(selectorWords(component.selector).join(" "))];
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
    because,
  };
}

/** Pairs only. Nothing here is written as mapped. */
export function suggestPairs(index: GraphIndex, inventory: AngularInventory, targets: CodeTarget[]): SuggestedPair[] {
  const figmaVersion = index.graph.source.version;
  const maps: SuggestedPair[] = [];
  const byFigma = new Map<string, AngularComponentRecord>();
  for (const target of targets) {
    const wanted = words(target.name);
    const hits = inventory.components.filter((component) => codeWords(component).some((set) => same(wanted, set)));
    const ambiguous = hits.length > 1;
    for (const hit of hits) {
      const inputs = ioNames(hit.inputs);
      const fit = ambiguous ? "partial" : coverage(target.node, inputs);
      const because = ambiguous
        ? `more than one code component has the name ${target.name}`
        : fit === "full"
          ? `name matches ${hit.component}; Figma properties match its inputs`
          : `name matches ${hit.component}; some Figma properties have no input`;
      maps.push(toPair(target, hit, inventory, "maps", fit === "full" && !ambiguous ? "suggested" : "partial", because, figmaVersion));
      if (!ambiguous && !byFigma.has(target.node.id)) byFigma.set(target.node.id, hit);
    }
  }
  const composed: SuggestedPair[] = [];
  for (const target of targets) {
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
