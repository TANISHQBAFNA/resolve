/** Family name from a wrapping frame, plus description, property, and layer text. */
import type { GraphNode } from "@/core/model";
import type { GraphIndex } from "./GraphIndex";
import { VARIANT_PROP_NAME } from "./masterNames";
import { isFigmaSlot } from "./placed";
import modifierFile from "@/data/ui-modifiers.json";
import { tokensOf } from "./queryTokens";
import { allSynonymGroups, SYNONYM_OF } from "./recommendContext";
import { CATEGORY_TAIL, modifierWord, PLAIN_NOUN, purposeTailTokens, setCoversAsk, SLOT_QUALIFIERS, synonymIn, variantValueText } from "./recommendLexicon";
import { inflectionStems } from "./screenInventory";
import { oneSlipFix } from "./typo";

const SKIP_HOST = new Set(["PAGE", "FILE", "DOCUMENT", "CANVAS"]);
const PAGE_BUCKET = new Set(["components", "component", "library", "icons", "icon", "screens", "screen", "patterns", "foundations", "styles", "assets", "documentation", "pages", "symbols", "variants"]);
const LAYER_NOISE = /^(?:frame|group|rectangle|ellipse|line|vector|polygon|star|slice|boolean|section)\s*\d*$/i;

function pageNamesComponent(name: string): boolean {
  const tokens = name.toLowerCase().split(/[^a-z0-9]+/).filter((part) => part.length > 1);
  return tokens.length > 0 && tokens.every((token) => !PAGE_BUCKET.has(token));
}

/**
 * The component set name, or the frame a property-only variant sits in.
 * `Type=Primary, Size=Large` under a frame named Button is the Button family.
 * A page name is not a component.
 */
export function hostFamilyName(index: GraphIndex, node: GraphNode, set?: GraphNode): string {
  const setName = set?.name.trim() ?? "";
  if (setName && !VARIANT_PROP_NAME.test(setName)) return setName;
  if (!VARIANT_PROP_NAME.test(node.name) && node.name.trim()) return "";
  let current = index.getParent(node.id);
  while (current && !SKIP_HOST.has(current.type)) {
    const name = current.name.trim();
    if (
      name &&
      !VARIANT_PROP_NAME.test(name) &&
      (current.type === "FRAME" || current.type === "SECTION" || current.type === "COMPONENT_SET")
    ) {
      return name;
    }
    current = index.getParent(current.id);
  }
  if (current?.type === "PAGE" && pageNamesComponent(current.name)) return current.name.trim();
  return setName;
}

/** Variant values, property names, descriptions, and layer names. Not nested components. */
export function searchDetail(index: GraphIndex, node: GraphNode, set?: GraphNode): { variant: string; describe: string } {
  const variant: string[] = [];
  const describe: string[] = [];
  const seen = new Set<string>();
  const addNode = (item?: GraphNode) => {
    if (!item || seen.has(item.id)) return;
    seen.add(item.id);
    const values = variantValueText(item);
    if (values) variant.push(values);
    const props = item.variantProperties;
    const propNames = [
      ...Object.keys(props ?? {}),
      ...(item.propertyDefinitions ?? []).map((def) => def.name),
    ].filter((name) => !modifierWord(name.toLowerCase()));
    if (propNames.length) variant.push(propNames.join(" "));
    for (const def of item.propertyDefinitions ?? []) {
      if (def.description) describe.push(def.description);
      if (def.options?.length) variant.push(def.options.join(" "));
      const value = def.defaultValue?.trim();
      if (value && value !== "true" && value !== "false" && /[a-z]/i.test(value)) variant.push(value);
    }
    if (item.description) describe.push(item.description);
  };
  addNode(node);
  addNode(set);
  const root = node.type === "COMPONENT_SET" ? node : (set ?? node);
  const walk = (id: string, depth: number) => {
    if (depth > 2) return;
    for (const child of index.getChildren(id)) {
      if (child.type === "VARIANT" || child.type === "COMPONENT_SET") continue;
      const slot = isFigmaSlot(child);
      if (child.type === "COMPONENT_INSTANCE" && !slot) continue;
      const name = child.name.trim();
      if (name && !LAYER_NOISE.test(name) && !VARIANT_PROP_NAME.test(name)) describe.push(name);
      if (child.description) describe.push(child.description);
      if (slot) continue;
      walk(child.id, depth + 1);
    }
  };
  walk(root.id, 0);
  return { variant: variant.join(" "), describe: describe.join(" ") };
}

function familyHas(token: string, family: string): boolean {
  const names = tokensOf(family);
  if (names.some((name) => name === token || name === `${token}s` || token === `${name}s`)) return true;
  if (synonymIn(token, new Set(names)) || (token === "nav" && names.includes("navigation"))) return true;
  // A word of the family's own synonym phrase ("action" in "floating action button" for FAB) is covered.
  const whole = family.toLowerCase();
  const own = allSynonymGroups().filter((group) => group.terms.some((term) => term.toLowerCase() === whole));
  if (own.some((group) => group.terms.some((term) => term.includes(" ") && tokensOf(term).includes(token)))) return true;
  if (token !== "button" && token !== "cta" && token !== "action" && token !== "icon") return false;
  return names.some((name) => name === "button" || name === "cta" || name === "action" || name === "icon");
}

/** A plain noun in the ask that is not a modifier and is not in the family. "banner" on Alert. Not "bar" on Tabs. */
function uncoveredKind(tokens: string[], family: string): boolean {
  return tokens.some(
    (token) =>
      (PLAIN_NOUN.has(token) || CATEGORY_TAIL.has(token)) && !modifierWord(token) && !familyHas(token, family),
  );
}

/** A cousin that leaves a query word unmatched stays in the list and is flagged weak. */
export function flagUncovered<T extends { exactName: boolean; weak?: boolean; askCovered?: number; why?: string[] }>(
  entries: T[],
  ask: string,
  tokens: string[],
  familyOf: (entry: T) => string,
): void {
  for (const entry of entries) {
    if (entry.exactName || entry.weak) continue;
    const family = familyOf(entry);
    const kind = uncoveredKind(tokens, family);
    if (!kind) {
      if (entry.why?.includes("name") || entry.why?.includes("typo") || entry.why?.includes("bind-rule")) continue;
      if (setCoversAsk(ask, family)) continue;
    }
    if (kind) {
      entry.weak = true;
      continue;
    }
    if ((entry.askCovered ?? tokens.length) >= tokens.length) continue;
    // Only a word left over makes it weak: not a purpose tail, a synonym, or a short form of a name word.
    const names = new Set(tokensOf(family));
    const tail = purposeTailTokens(ask);
    const leftover = tokens.filter(
      (token) =>
        !familyHas(token, family) && !synonymIn(token, names) && !tail.has(token) &&
        !(token === "nav" && names.has("navigation")),
    );
    if (leftover.length) entry.weak = true;
  }
}

/**
 * "primarry button" is "primary button": the one misspelled word of an otherwise known ask becomes the known
 * word (a name word, synonym, modifier, or variant word) before ranking, so a typo of primary or information
 * gets the same handling as the real word and cannot land on a decoy named Primary or Icons.
 */
export function fixOneSlip(ask: string, nameSets: readonly Set<string>[]): string {
  const vocab = new Set([...SYNONYM_OF.keys(), ...modifierFile.words.map((row) => row.term.toLowerCase()), ...SLOT_QUALIFIERS, ...nameSets.flatMap((names) => [...names])]);
  const hit = oneSlipFix(tokensOf(ask), (word) => vocab.has(word) || inflectionStems(word).some((stem) => vocab.has(stem)), vocab);
  return hit ? ask.toLowerCase().replace(new RegExp(`\\b${hit.word}\\b`), hit.fix) : ask;
}
