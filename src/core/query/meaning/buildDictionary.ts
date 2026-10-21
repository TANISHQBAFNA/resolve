import type { GraphNode } from "@/core/model";
import { isNameInferredMaster } from "@/core/rules/names";
import { isRetired } from "@/core/rules/retired";
import { setOf } from "@/core/rules/family";
import type { GraphIndex } from "../GraphIndex";
import { MASTER_TYPES, VARIANT_PROP_NAME } from "../masterNames";
import { isPrivateMaster } from "../recommendLexicon";
import { allSynonymGroups, loadSynonymOverlay } from "../recommendContext";
import { tokensOf } from "../queryTokens";
import { inflectionStems } from "../screenInventory";
import acmeDictionary from "@/data/meaning/acme.json";
import materialDictionary from "@/data/meaning/material.json";
import { languageOf } from "./parse";
import type { MeaningAttribute, MeaningDictionary, MeaningEntry, MeaningLanguage } from "./types";

const GENERIC = new Set(["button", "card", "list", "bar", "field", "icon", "menu", "chip", "tab", "row", "item", "input", "text"]);
const KIND_OF = new Map<string, MeaningAttribute["kind"]>([
  ["density", "density"],
  ["size", "size"],
  ["state", "state"],
  ["style", "style"],
  ["type", "style"],
  ["variant", "style"],
  ["appearance", "style"],
]);

const cache = new WeakMap<GraphIndex, MeaningDictionary>();

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "part";
}

function wordForms(lemmas: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const lemma of lemmas) {
    if (lemma.length < 3) continue;
    if (!lemma.endsWith("s")) forms.add(`${lemma}s`);
    if (lemma.endsWith("y") && lemma.length > 3) forms.add(`${lemma.slice(0, -1)}ies`);
    if (GENERIC.has(lemma)) continue;
    const surfaces = lemma.endsWith("e")
      ? [`${lemma.slice(0, -1)}ing`, `${lemma}d`]
      : [`${lemma}ing`, `${lemma}ed`];
    for (const surface of surfaces) {
      if (inflectionStems(surface).includes(lemma)) forms.add(surface);
    }
  }
  return [...forms].sort();
}

function purposeOf(description: string | undefined): string[] {
  if (!description) return [];
  return description
    .split(/[.\n]/)
    .map((line) => line.trim())
    .filter((line) => line.length > 2 && line.length < 140 && !/deprecated|retired|replacedby|legacy|status:/i.test(line))
    .slice(0, 3);
}

function attributeKind(key: string): MeaningAttribute["kind"] | undefined {
  return KIND_OF.get(key.toLowerCase().replace(/[^a-z]/g, ""));
}

function addValue(into: Map<string, MeaningAttribute>, kind: MeaningAttribute["kind"], name: string, value: string): void {
  const cleaned = value.trim().toLowerCase();
  if (!cleaned || cleaned === "true" || cleaned === "false" || cleaned.length > 40) return;
  const key = `${kind}:${name.toLowerCase()}`;
  const existing = into.get(key);
  if (existing) {
    if (!existing.values.includes(cleaned)) existing.values.push(cleaned);
    return;
  }
  into.set(key, { kind, name, values: [cleaned] });
}

function attributesOf(index: GraphIndex, node: GraphNode, nameTokens: string[]): MeaningAttribute[] {
  const into = new Map<string, MeaningAttribute>();
  const family = node.type === "COMPONENT_SET" ? [node, ...index.getChildren(node.id)] : [node];
  for (const item of family) {
    for (const [key, value] of Object.entries(item.variantProperties ?? {})) {
      const kind = attributeKind(key);
      if (kind && value) addValue(into, kind, key, value);
    }
    for (const def of item.propertyDefinitions ?? []) {
      const kind = attributeKind(def.name);
      if (!kind) continue;
      for (const option of def.options ?? []) addValue(into, kind, def.name, option);
      if (def.defaultValue) addValue(into, kind, def.name, def.defaultValue);
    }
    for (const token of tokensOf(item.name)) {
      if (nameTokens.includes(token)) continue;
      if ([...into.values()].some((row) => row.values.includes(token))) continue;
      if (token === "type" || token === "variant" || token === "style" || token === "size" || token === "state" || token === "density") continue;
      if (token === "compact" || token === "comfortable") addValue(into, "density", "density", token);
      else if (token === "small" || token === "large" || token === "mini") addValue(into, "size", "size", token);
      else addValue(into, "style", "variant", token);
    }
  }
  if (nameTokens.includes("compact")) addValue(into, "density", "density", "compact");
  if (nameTokens.includes("comfortable")) addValue(into, "density", "density", "comfortable");
  if (nameTokens.includes("mini")) addValue(into, "size", "size", "mini");
  if (nameTokens.includes("date") || nameTokens.includes("time")) addValue(into, "date", "date", nameTokens.includes("time") ? "time" : "date");
  return [...into.values()].map((row) => ({ ...row, values: [...row.values].sort() }));
}

function synonymsFor(name: string, nameTokens: string[], groups: readonly string[][]): { synonyms: string[]; altNames: string[] } {
  const full = name.toLowerCase();
  const terms = new Set<string>();
  for (const group of groups) {
    if (!group.some((term) => term === full || nameTokens.includes(term))) continue;
    for (const term of group) if (term !== full) terms.add(term);
  }
  const synonyms = [...terms].sort();
  return { synonyms, altNames: synonyms.filter((term) => term.includes(" ")) };
}

function contrasts(entry: MeaningEntry, entries: MeaningEntry[]): string[] {
  const mine = new Set(entry.nameTokens);
  const mineSyn = new Set(entry.synonyms);
  const ranked = entries
    .filter((other) => other.id !== entry.id)
    .map((other) => {
      const sharedTokens = other.nameTokens.filter((token) => mine.has(token)).length;
      const sharedSyn = other.synonyms.some((term) => mineSyn.has(term) || mine.has(term)) || other.nameTokens.some((token) => mineSyn.has(token));
      return { name: other.name, score: sharedTokens * 2 + (sharedSyn ? 1 : 0) };
    })
    .filter((row) => row.score > 0);
  ranked.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const names: string[] = [];
  for (const row of ranked) {
    if (names.length >= 8) break;
    if (!names.includes(row.name)) names.push(row.name);
  }
  return names;
}

/** Build the meaning dictionary from the components actually in this graph. */
export function buildMeaningDictionary(index: GraphIndex, library?: string): MeaningDictionary {
  const groups = allSynonymGroups().map((group) => group.terms.map((term) => term.toLowerCase()).filter(Boolean));
  const families: GraphNode[] = [];
  const seen = new Set<string>();
  for (const node of index.getNodesByType(...MASTER_TYPES)) {
    if (isNameInferredMaster(node) || isPrivateMaster(index, node)) continue;
    if (VARIANT_PROP_NAME.test(node.name)) continue;
    const set = node.componentSetId ? index.getNode(node.componentSetId) : undefined;
    const host = set && !VARIANT_PROP_NAME.test(set.name) ? set : node;
    if (node.componentSetId && host !== node) continue;
    if (seen.has(host.id)) continue;
    seen.add(host.id);
    families.push(host);
  }
  const entries: MeaningEntry[] = families.map((node) => {
    const set = setOf(index, node);
    const name = (set && set.id !== node.id ? set.name : node.name).trim();
    const nameTokens = tokensOf(name);
    const { synonyms, altNames } = synonymsFor(name, nameTokens, groups);
    const retired = isRetired(index, node);
    return {
      id: slug(name),
      name,
      synonyms,
      altNames,
      wordForms: wordForms(nameTokens),
      purpose: purposeOf(node.description ?? set?.description),
      attributes: attributesOf(index, node, nameTokens),
      not: [],
      ...(retired ? { retired: true } : {}),
      nameTokens,
    };
  });
  const seenId = new Set<string>();
  for (const entry of entries) {
    let id = entry.id;
    let n = 2;
    while (seenId.has(id)) {
      id = `${entry.id}-${n}`;
      n += 1;
    }
    entry.id = id;
    seenId.add(id);
  }
  for (const entry of entries) entry.not = contrasts(entry, entries);
  entries.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return {
    version: 1,
    library: library?.trim() || index.graph.fileName || "library",
    language: derivedLanguage(entries),
    synonymGroups: groups.map((group) => [...group].sort()),
    entries,
  };
}

const BUNDLED = [acmeDictionary, materialDictionary] as unknown as MeaningDictionary[];

function derivedLanguage(entries: readonly MeaningEntry[]): MeaningLanguage {
  const density: Record<string, string[]> = {};
  const device = new Set<string>();
  for (const entry of entries) {
    for (const attribute of entry.attributes) {
      if (attribute.kind !== "density") continue;
      for (const value of attribute.values) if (!density[value]) density[value] = [value];
    }
    for (const token of entry.nameTokens) {
      if (token === "compact" || token === "comfortable") density[token] = density[token] ?? [token];
      if (token === "phone" || token === "mobile" || token === "desktop" || token === "tablet") device.add(token);
    }
  }
  return { density, device: [...device].sort(), describes: {} };
}

function matchBundled(built: MeaningDictionary, fileName: string): MeaningDictionary | undefined {
  const names = new Set(built.entries.map((entry) => entry.name.toLowerCase()));
  let best: { dict: MeaningDictionary; score: number } | undefined;
  for (const dict of BUNDLED) {
    const library = dict.library.toLowerCase();
    const named = fileName.toLowerCase().includes(library);
    const overlap = dict.entries.filter((entry) => names.has(entry.name.toLowerCase())).length;
    const ratio = names.size ? overlap / names.size : 0;
    if (!named && ratio < 0.5) continue;
    const score = (named ? 1000 : 0) + ratio;
    if (!best || score > best.score) best = { dict, score };
  }
  return best?.dict;
}

function withBundled(built: MeaningDictionary, bundled: MeaningDictionary): MeaningDictionary {
  const saved = new Map(bundled.entries.map((entry) => [entry.name.toLowerCase(), entry]));
  return {
    ...built,
    library: bundled.library,
    language: languageOf(bundled.language),
    entries: built.entries.map((entry) => {
      const known = saved.get(entry.name.toLowerCase());
      if (!known) return entry;
      return {
        ...entry,
        synonyms: [...new Set([...entry.synonyms, ...known.synonyms])].sort(),
        altNames: [...new Set([...entry.altNames, ...known.altNames])].sort(),
        purpose: known.purpose.length ? known.purpose : entry.purpose,
        not: known.not.length ? known.not : entry.not,
      };
    }),
  };
}

/** Dictionary for this graph. A checked-in library file supplies that library's words. */
export function meaningDictionary(index: GraphIndex): MeaningDictionary {
  const hit = cache.get(index);
  if (hit) return hit;
  loadSynonymOverlay();
  const built = buildMeaningDictionary(index);
  const bundled = matchBundled(built, index.graph.fileName);
  const dictionary = bundled ? withBundled(built, bundled) : built;
  cache.set(index, dictionary);
  return dictionary;
}
