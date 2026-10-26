/** Lexical score, phrase aliases, and icon demotion. */
import type { GraphNode } from "@/core/model";
import { setOf } from "@/core/rules/family";
import { collapsedName, isNameInferredMaster, isPrivateMasterName } from "@/core/rules/names";
import { isRetired } from "@/core/rules/retired";
import modifierFile from "@/data/ui-modifiers.json";
import type { GraphIndex } from "./GraphIndex";
import { familyNameOf, MASTER_TYPES, VARIANT_PROP_NAME, variantCardName } from "./masterNames";
import { tokensOf } from "./queryTokens";
import { adjacentSwap, innerGap, keySlip, wordSlip } from "./typo";
import { allSynonymGroups, DEMOTE_UNASKED, extraSynonym, LABEL_FILLER, synonymEpoch, SYNONYM_GROUPS, SYNONYM_OF } from "./recommendContext";
import type { RecommendContext } from "./recommendSupport";
import { inflectionStems, isScreen } from "./screenInventory";
import { propertyAliases } from "./synonymLayer";

/** Name / synonym / variant / description. One name token outranks any amount of context. */
export const LEXICAL_WEIGHT = { name: 100, synonym: 70, variant: 80, describe: 50 } as const;

export const PLAIN_NOUN = new Set(["button", "cta", "action", "icon", "card", "banner", "dropdown", "nav", "navigation", "field", "input", "bar", "menu", "modal", "dialog", "badge", "tab", "link", "chip", "tag", "switch", "checkbox", "radio", "toast", "alert"]);


export const DESCRIBE_META = new Set(["status", "deprecated", "replacedby", "replaced", "legacy"]);

/** Property row (`Style=Primary`) or `{Set} Primary` — not a named cousin like Pay CTA. */
export function isSetModifierVariant(node: GraphNode, set?: GraphNode): boolean {
  if (VARIANT_PROP_NAME.test(node.name)) return true;
  const setName = set?.name.trim();
  if (!setName) return false;
  const name = node.name.trim();
  if (!name.toLowerCase().startsWith(`${setName.toLowerCase()} `)) return false;
  const rest = tokensOf(name.slice(setName.length));
  return rest.length > 0 && rest.every((token) => modifierWord(token));
}
const UI_MODIFIER = new Set(modifierFile.words.map((word) => word.term.toLowerCase()));
/** Size and accessibility words describe a component. They do not name a different one. */
export const SIZE_OR_A11Y = new Set([
  "large",
  "larger",
  "small",
  "smaller",
  "big",
  "bigger",
  "huge",
  "compact",
  "medium",
  "mini",
  "tiny",
  "xl",
  "xs",
  "screen",
  "reader",
  "accessible",
  "aria",
  "wcag",
  "a11y",
]);
export const TRAILING_AFTER = new Map<string, ReadonlySet<string>>(
  modifierFile.trailing.map((row) => [
    row.term.toLowerCase(),
    new Set(row.after.map((word) => word.toLowerCase())),
  ]),
);
/** Slot words that pick a variant, not a different component family. */
export const SLOT_QUALIFIERS = new Set(["primary", "secondary", "tertiary", "danger", "ghost"]);
/**
 * Words that mark journey.step as a component slot (primary-cta, input, message).
 * A pack step such as "summary" or "form" stays screen context.
 */
const SLOT_ROLE_TOKENS = new Set([
  "cta",
  "button",
  "message",
  "input",
  "row",
  "card",
  "icon",
  "header",
  "field",
  "chip",
  "badge",
  "label",
  "search",
  "avatar",
  "banner",
  "toast",
  "modal",
  "switch",
]);
export function slotIsComponentRole(slotTokens: string[]): boolean {
  return slotTokens.some((token) => SLOT_ROLE_TOKENS.has(token));
}
/** True when the ask already names a public live master, so the slot must not hide it. */
export function intentNamesMaster(index: GraphIndex, askedTokens: string[]): boolean {
  if (!askedTokens.length) return false;
  for (const node of index.getNodesByType(...MASTER_TYPES)) {
    if (isRetired(index, node) || isPrivateMasterName(node.name)) continue;
    const names = new Set(tokensOf(node.name));
    if (askedTokens.some((token) => names.has(token))) return true;
  }
  return false;
}
export const RETIRED_NAME_TOKENS = new Set(["legacy", "old", "deprecated", "retired", "hidden"]);
/** Why a weak /find hit is weak. Ranking is unchanged; only this sentence changes. */
export function weakMatchWhy(intent: string, name: string): string {
  const asked = tokensOf(intent);
  const named = new Set(tokensOf(name));
  const hit = asked.find((token) => named.has(token));
  const word = hit ?? asked[0] ?? "that";
  return `only the word '${word}' matched; no variant or role matched`;
}

/** The why line of a weak lead. Always set, even on a compact card that dropped why. */
export function weakCheckWhy(why: string | undefined, guesses: readonly string[], intent: string, name: string): string {
  if (why?.startsWith("Weak, check") || why?.startsWith("replaces ")) return why;
  if (guesses.length) return `Weak, check: ${guesses.map((word) => `"${word}"`).join(", ")} not in ${name}.`;
  return `Weak, check: ${why ?? weakMatchWhy(intent, name)}`;
}
export function synonymIn(token: string, names: Set<string>, allowClip = false): boolean {
  const group = termsFor(token, allowClip);
  if (!group) return false;
  return group.some((word) => {
    if (word === token) return false;
    if (names.has(word)) return true;
    if (!word.includes(" ")) return false;
    const phrase = tokensOf(word);
    return phrase.length > 1 && phrase.every((part) => names.has(part));
  });
}
const CLIP_GROUP = new Map<string, readonly string[] | undefined>();
/** Unique synonym prefix of at least four leftover letters. Single-word asks do not clip. */
function clippingGroup(token: string): readonly string[] | undefined {
  if (CLIP_GROUP.has(token)) return CLIP_GROUP.get(token);
  let found: readonly string[] | undefined;
  if (token.length >= 3 && !SYNONYM_OF.has(token)) {
    const hits: (readonly string[])[] = [];
    for (const terms of SYNONYM_GROUPS) {
      if (terms.some((term) => term.startsWith(token) && term.length > token.length)) hits.push(terms);
    }
    const only = hits[0];
    if (hits.length === 1 && only?.some((term) => term.length >= token.length + 4)) found = only;
  }
  CLIP_GROUP.set(token, found);
  return found;
}
export function termsFor(token: string, allowClip: boolean): readonly string[] | undefined {
  // A plural reads its stem's group: "side panels" is the panel/sheet group. Only plurals: an -ed or -ing
  // form describes the noun after it ("toggled switch" is a switch). Not for a position, variant, or
  // modifier stem: "bottoms" is not the footer.
  const partStem = (stem: string) =>
    (token === `${stem}s` || token === `${stem}es`) && !DEMOTE_UNASKED.has(stem) && !SLOT_QUALIFIERS.has(stem) && !modifierWord(stem);
  const pluralStemmed = inflectionStems(token).filter(partStem).map((stem) => extraSynonym.get(stem) ?? SYNONYM_OF.get(stem)).find(Boolean);
  // An -ed or -ing word alone describes, it does not name a part ("toggled" is empty). Only an action verb of
  // the button group ("submitting") still reads as the button that does it.
  const actionVerb = token.endsWith("ing") || token.endsWith("ed")
    ? inflectionStems(token).map((stem) => SYNONYM_OF.get(stem)).find((group) => group?.includes("button"))
    : undefined;
  const groups = allSynonymGroups();
  const phraseGroup = extraSynonym.has(token)
    ? [...groups].reverse().find((group) => group.terms.some((term) => term.toLowerCase() === token))?.terms
    : groups.find((group) => group.terms.some((term) => term.toLowerCase() === token))?.terms;
  const base = extraSynonym.get(token) ?? SYNONYM_OF.get(token) ?? pluralStemmed ?? actionVerb ?? phraseGroup ?? (allowClip ? clippingGroup(token) : undefined);
  const alias = propertyAliases(token);
  const merged = phraseGroup && base ? [...new Set([...base, ...phraseGroup])] : base;
  if (!alias) return merged;
  if (!merged) return alias;
  return [...new Set([...merged, ...alias])];
}
/** `base/`, `ingredients/` and `recipes/` are tiers, not part of the component name. */
export function stripTier(name: string): string {
  return name.replace(/^(?:base|ingredients|recipes)\//i, "");
}

export function tierOf(name: string): "base" | "ingredients" | "recipes" | undefined {
  const tier = /^(base|ingredients|recipes)\//i.exec(name.trim())?.[1]?.toLowerCase();
  if (tier === "base" || tier === "ingredients" || tier === "recipes") return tier;
  return undefined;
}

/** Literal-name pick, unless a bind-rule prefer ranks the same part from another file higher. */
export function ruleNamesake(
  picked: GraphNode,
  others: Iterable<GraphNode>,
  ruleBonus?: (node: GraphNode) => number,
): GraphNode {
  if (!ruleBonus) return picked;
  const part = collapsedName(stripTier(picked.name));
  let best = picked;
  let bestBonus = ruleBonus(picked);
  for (const node of others) {
    if (collapsedName(stripTier(node.name)) !== part) continue;
    const bonus = ruleBonus(node);
    if (bonus > bestBonus) {
      best = node;
      bestBonus = bonus;
    }
  }
  return best;
}

/** `ingredients/` and `recipes/` beat `base/` for the same part. An ask that says `base/` keeps the base part. */
export function dropShadowedBaseTier<T>(rows: T[], askedBase: boolean, nameOf: (row: T) => string): T[] {
  if (askedBase || rows.length < 2) return rows;
  const bareKey = (row: T) => collapsedName(stripTier(nameOf(row)));
  const exposed = new Set(
    rows
      .filter((row) => {
        const tier = tierOf(nameOf(row));
        return tier === "ingredients" || tier === "recipes";
      })
      .map(bareKey),
  );
  if (!exposed.size) return rows;
  return rows.filter((row) => tierOf(nameOf(row)) !== "base" || !exposed.has(bareKey(row)));
}

/** Family name only. `Type=Primary` is a variant layer, not a component name. A tier prefix is not part of the name. */
export function familyHaystack(node: GraphNode, set: GraphNode | undefined, host = ""): string {
  const family = host.trim() || (set && !VARIANT_PROP_NAME.test(set.name) ? stripTier(set.name) : "");
  if (VARIANT_PROP_NAME.test(node.name)) return family;
  if (family && family !== node.name) return `${family} ${stripTier(node.name)}`;
  if (set && set.id !== node.id) return `${stripTier(set.name)} ${stripTier(node.name)}`;
  return stripTier(node.name);
}
/** Variant values and property options. Property names (State, Type, Size) are not words. */
export function variantValueText(node: GraphNode): string {
  const props = node.variantProperties;
  const fromProps = props && Object.keys(props).length ? Object.values(props).join(" ") : "";
  const fromName =
    !fromProps && VARIANT_PROP_NAME.test(node.name)
      ? node.name
          .split(",")
          .map((part) => part.split("=").slice(1).join("=").trim())
          .filter(Boolean)
          .join(" ")
      : "";
  const fromDefs = (node.propertyDefinitions ?? []).flatMap((prop) => prop.options ?? []).join(" ");
  return [fromProps, fromName, fromDefs].filter(Boolean).join(" ");
}

/** Variant values, property options, and the description, for one master and its set. */
export function matchHaystack(node: GraphNode, set?: GraphNode): { variant: string; describe: string } {
  const variant = [variantValueText(node), set ? variantValueText(set) : ""].filter(Boolean).join(" ");
  const describe = [node.description, set?.description]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  return { variant, describe };
}
/** Set name, or one path segment of it, is a whole phrase inside the ask. `Controls / Button` covers "button". */
export function setCoversAsk(ask: string, setName: string): boolean {
  const askFold = ask.trim().toLowerCase();
  const nameFold = setName.trim().toLowerCase();
  if (!askFold || !nameFold) return false;
  const askTokens = tokensOf(askFold);
  const covers = (label: string) => {
    if (label === askFold || collapsedName(label) === collapsedName(askFold)) return true;
    const nameTokens = tokensOf(label);
    return nameTokens.length > 0 && nameTokens.every((token) => askTokens.includes(token));
  };
  return nameFold.split("/").some((part) => covers(part.trim()));
}
/** Query names this node, not merely its family. */
export function namesThisNode(ask: string, node: GraphNode, index: GraphIndex): boolean {
  const needle = ask.trim().toLowerCase();
  if (!needle) return false;
  if (node.name.toLowerCase() === needle || stripTier(node.name).toLowerCase() === needle) return true;
  if (collapsedName(node.name) === collapsedName(needle) || collapsedName(stripTier(node.name)) === collapsedName(needle)) return true;
  if (phraseNamesMatch(needle, node.name)) return true;
  return variantCardName(index, node).toLowerCase() === needle;
}
/** Plural s/es/ies or -ing/-ed, either way. "tablet" is not an inflection of "tab". */
export function inflectsName(query: string, nameToken: string): boolean {
  if (query === nameToken || query.length < 3 || nameToken.length < 3) return false;
  const [longer, shorter] = query.length >= nameToken.length ? [query, nameToken] : [nameToken, query];
  if (longer.endsWith("ies") && shorter.endsWith("y") && longer.slice(0, -3) === shorter.slice(0, -1)) return true;
  if (!longer.startsWith(shorter)) return false;
  const rest = longer.slice(shorter.length);
  return rest === "s" || rest === "es" || rest === "ing" || rest === "ed";
}
/** One letter off a core noun, a missing letter, or two neighbours swapped. Not an unrelated extra ending. */
export function tokenTypo(query: string, name: string): boolean {
  if (query.length < 5 || name.length < 5 || query === name) return false;
  const noun = (word: string) => PLAIN_NOUN.has(word);
  if (SLOT_QUALIFIERS.has(name)) return false; // a slip never lands on a variant word like primary
  if (query.length === name.length) {
    if (adjacentSwap(query, name)) return true;
    // A slip that also fits a plain noun means the noun ("botton" is button, not bottom).
    return keySlip(query, name) && (noun(name) || ![...PLAIN_NOUN].some((word) => keySlip(query, word)));
  }
  if (innerGap(query, name)) return true;
  const [shorter, longer] = query.length < name.length ? [query, name] : [name, query];
  return longer.length === shorter.length + 1 && longer.startsWith(shorter) && noun(longer) && !SYNONYM_OF.has(shorter) && !noun(shorter);
}
/** A one-letter slip on a name word. Never onto a variant word like primary. */
export function slipsTo(query: string, nameToken: string): boolean {
  return !SLOT_QUALIFIERS.has(nameToken) && wordSlip(query, nameToken);
}
/** A stopword that is itself a component synonym stays. "find box" keeps find. */
export function withSynonymStopwords(text: string, tokens: string[]): string[] {
  const raw = text.toLowerCase().split(/[^a-z0-9]+/).filter((part) => part.length > 1);
  const extra = raw.filter((part) => !tokens.includes(part) && SYNONYM_OF.has(part));
  return extra.length ? [...new Set([...extra, ...tokens])] : tokens;
}
export function tokenMatchesName(query: string, nameToken: string, allowClip = false): boolean {
  if (query === nameToken || inflectsName(query, nameToken)) return true;
  return synonymIn(query, new Set([nameToken]), allowClip) || slipsTo(query, nameToken) || tokenTypo(query, nameToken);
}
/** "x" means close only as the whole ask, or right beside icon/button. "x ray" does not. */
export function xMeansClose(text: string): boolean {
  const parts = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (parts.length === 1) return parts[0] === "x";
  if (parts.length !== 2) return false;
  const [left, right] = parts;
  if (!left || !right) return false;
  const mark = left === "x" || right === "x";
  const chrome = left === "icon" || right === "icon" || left === "button" || right === "button";
  return mark && chrome;
}
/** A plural's singular form. "boxes" is "box", "queries" is "query". A word that is not a plural stays. */
function stemOf(word: string): string {
  if (word.length >= 5 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length >= 4 && word.endsWith("es")) {
    const stem = word.slice(0, -2);
    if (/(?:s|x|z|ch|sh)$/.test(stem)) return stem;
  }
  if (word.length >= 4 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}
/** Spaces and hyphens removed, no stemming. The citation form of a name or synonym. */
function citationForm(text: string): string {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((part) => part.length > 0).join("");
}

/** Spaces and hyphens removed, last word singular. "top app bars", "top-app-bars", and "topappbars" share one form. */
export function compactForm(text: string): string {
  const parts = text.toLowerCase().split(/[^a-z0-9]+/).filter((part) => part.length > 0);
  if (!parts.length) return "";
  const last = parts.length - 1;
  parts[last] = stemOf(parts[last] ?? "");
  return parts.join("");
}

/** Possible singulars. "closes" is "close" or "clos"; the catalog decides which one exists. */
function stemChoices(word: string): string[] {
  const choices = [word];
  if (word.length >= 5 && word.endsWith("ies")) choices.push(`${word.slice(0, -3)}y`);
  if (word.length >= 4 && word.endsWith("es")) choices.push(word.slice(0, -2));
  if (word.length >= 4 && word.endsWith("s") && !word.endsWith("ss")) choices.push(word.slice(0, -1));
  return [...new Set(choices)];
}

let catalogCache: { epoch: number; names: string; forms: Map<string, string[]>; nameSet: Set<string> } | undefined;

function formCatalog(names?: Iterable<string>): { forms: Map<string, string[]>; nameSet: Set<string> } {
  const nameKey = names ? [...names].join("\n") : "";
  if (catalogCache && catalogCache.epoch === synonymEpoch && catalogCache.names === nameKey) {
    return catalogCache;
  }
  const forms = new Map<string, string[]>();
  const nameSet = new Set<string>();
  const add = (term: string, isName: boolean) => {
    const cleaned = term.trim().toLowerCase();
    if (!cleaned || cleaned.startsWith(".") || cleaned.startsWith("_") || cleaned.includes("=")) return;
    const form = citationForm(cleaned);
    if (form.length < 4) return;
    const list = forms.get(form) ?? [];
    if (!list.includes(cleaned)) list.push(cleaned);
    forms.set(form, list);
    if (isName) nameSet.add(cleaned);
  };
  for (const group of allSynonymGroups()) for (const term of group.terms) add(term, false);
  if (names) for (const name of names) add(name, true);
  catalogCache = { epoch: synonymEpoch, names: nameKey, forms, nameSet };
  return catalogCache;
}

function preferredSurface(options: string[], nameSet: Set<string>): string | undefined {
  if (!options.length) return undefined;
  return options.find((option) => nameSet.has(option)) ?? options.find((option) => option.includes(" ")) ?? options.find((option) => option.includes("-")) ?? options[0];
}

/**
 * The ask the normal matcher should see. A joined, split, or hyphenated spelling, singular or plural,
 * is rewritten to the synonym or component name with the same compacted form.
 */
export function normalizeAsk(text: string, names?: Iterable<string>): string {
  const { forms, nameSet } = formCatalog(names);
  const matches = [...text.matchAll(/[A-Za-z0-9]+/g)];
  const words = matches.map((match) => match[0].toLowerCase());
  const used = new Set<number>();
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  const max = Math.min(4, words.length);
  for (let length = max; length >= 1; length -= 1) {
    for (let start = 0; start + length <= words.length; start += 1) {
      if ([...Array(length).keys()].some((offset) => used.has(start + offset))) continue;
      const slice = words.slice(start, start + length);
      const last = slice[slice.length - 1] ?? "";
      const head = slice.slice(0, -1);
      const asWritten = [...head, last].join("");
      // "tabs" is already the name Tabs. Do not shorten it to Tab.
      const stems = stemChoices(last).filter((stem) => !(DEMOTE_UNASKED.has(stem) && stem !== last));
      const hits = forms.has(asWritten)
        ? [asWritten]
        : stems
            .map((stem) => [...head, stem].join(""))
            .filter((form) => forms.has(form))
            .sort((a, b) => b.length - a.length);
      let form = hits[0];
      if (!form && length >= 2) {
        const stemmed = slice.map((word) => stemOf(word)).join("");
        if (stemmed !== asWritten && forms.has(stemmed)) form = stemmed;
      }
      const surface = form ? preferredSurface(forms.get(form) ?? [], nameSet) : undefined;
      // A plural on the alias itself ("calls to action") rewrites to the phrase, not to a part name.
      if (!surface || (length >= 2 && form && !hits[0] && nameSet.has(surface))) continue;
      const canonical = surface.split(/[^a-z0-9]+/).filter(Boolean).join(" ");
      for (let offset = 0; offset < length; offset += 1) used.add(start + offset);
      if (slice.join(" ") === canonical) continue;
      const first = matches[start];
      const lastMatch = matches[start + length - 1];
      if (first?.index === undefined || !lastMatch) continue;
      replacements.push({ start: first.index, end: lastMatch.index + lastMatch[0].length, text: canonical });
    }
  }
  if (!replacements.length) return text;
  let result = text;
  replacements.sort((a, b) => b.start - a.start);
  for (const replacement of replacements) result = `${result.slice(0, replacement.start)}${replacement.text}${result.slice(replacement.end)}`;
  return result;
}
/** Multi-word synonym phrases, such as "tick box" for Checkbox. Single words stay in SYNONYM_OF. */
export function phraseNamesMatch(ask: string, name: string): boolean {
  const collapsedAsk = collapsedName(ask);
  const collapsedMaster = collapsedName(name);
  if (!collapsedAsk || !collapsedMaster) return false;
  const askWords = ask.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const nameWords = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  // Joined or split spellings share a form. A one-word plural does not swallow a shorter name: "tabs" is not "tab".
  if (compactForm(ask) === compactForm(name) && (askWords.length > 1 || nameWords.length > 1 || askWords.join("") === nameWords.join(""))) return true;
  const askedForm = compactForm(ask);
  return allSynonymGroups().some((group) => {
    const asked = group.terms.some((term) => term.includes(" ") && (collapsedName(term) === collapsedAsk || compactForm(term) === askedForm));
    if (!asked) return false;
    return group.terms.some((term) => collapsedName(term) === collapsedMaster);
  });
}
export function phraseCoversAsk(ask: string): boolean {
  const collapsedAsk = collapsedName(ask);
  return allSynonymGroups().some((group) =>
    group.terms.some((term) => term.includes(" ") && collapsedName(term) === collapsedAsk),
  );
}
/** Ask contains a multi-word synonym, and the family name covers that phrase. */
export function phraseFamilyHit(ask: string, familyName: string): boolean {
  const askTokens = new Set(tokensOf(ask));
  if (askTokens.size < 2 || !familyName.trim()) return false;
  const familyTokens = tokensOf(familyName);
  const familyCollapsed = collapsedName(familyName);
  return allSynonymGroups().some((group) => {
    const said = group.terms.filter((term) => term.includes(" ") && tokensOf(term).every((token) => askTokens.has(token)));
    if (!said.length) return false;
    const familyTerm = group.terms.find((term) => {
      if (collapsedName(term) === familyCollapsed) return true;
      const parts = tokensOf(term);
      return parts.length > 0 && parts.length === familyTokens.length && parts.every((token) => familyTokens.includes(token));
    });
    if (!familyTerm) return false;
    const covered = new Set(tokensOf(familyTerm));
    return said.some((term) => tokensOf(term).every((token) => covered.has(token)));
  });
}
/**
 * A short alias such as FAB for "floating action button".
 * Big enough to beat a generic cousin (Button), small enough to lose to a
 * family that is actually named with the phrase (Text Field, not Input).
 */
export function phraseAliasBonus(ask: string, familyName: string): number {
  const askTokens = new Set(tokensOf(ask));
  if (askTokens.size < 2) return 0;
  const familyTokens = tokensOf(familyName);
  if (familyTokens.length !== 1) return 0;
  const familyCollapsed = collapsedName(familyName);
  for (const group of allSynonymGroups()) {
    const said = group.terms.some((term) => term.includes(" ") && tokensOf(term).every((token) => askTokens.has(token)));
    if (!said) continue;
    const short = group.terms.some((term) => !term.includes(" ") && collapsedName(term) === familyCollapsed);
    if (short) return 500;
  }
  return 0;
}
export function isPrivateMaster(index: GraphIndex, node: GraphNode): boolean {
  if (isPrivateMasterName(node.name)) return true;
  const set = setOf(index, node);
  return Boolean(set && isPrivateMasterName(set.name));
}

export function liveNameSets(index: GraphIndex): Set<string>[] {
  const sets: Set<string>[] = [];
  for (const node of index.getNodesByType(...MASTER_TYPES)) {
    if (isRetired(index, node) || isPrivateMaster(index, node)) continue;
    // A guessed instance name is not a component. "Primary CTA v2" must not
    // turn the variant word "primary" into a component.
    if (isNameInferredMaster(node)) continue;
    if (VARIANT_PROP_NAME.test(node.name)) continue;
    if (node.componentSetId) {
      const set = index.getNode(node.componentSetId);
      sets.push(new Set(tokensOf(set?.name || familyNameOf(node.name, set?.name))));
      continue;
    }
    sets.push(new Set(tokensOf(node.name)));
  }
  return sets;
}
export function screenWords(index: GraphIndex): string[] {
  const words: string[] = [];
  for (const node of index.getNodesByType("FRAME")) {
    if (!isScreen(index, node)) continue;
    words.push(...tokensOf(node.name));
  }
  return words;
}
export function contextWords(context?: RecommendContext): string[] {
  if (!context) return [];
  return tokensOf(
    [
      context.domain,
      context.screenType,
      context.journey?.step,
      context.journey?.screenJob,
      context.product?.name,
      context.product?.id,
      context.client?.name,
      context.client?.id,
    ]
      .filter((part): part is string => Boolean(part))
      .join(" "),
  );
}
/** A UI modifier, a scene word, or a trailing UI noun such as "window" after modal. */
export function modifierWord(token: string): boolean {
  if (UI_MODIFIER.has(token) || LABEL_FILLER.has(token)) return true;
  return inflectionStems(token).some((stem) => UI_MODIFIER.has(stem) || LABEL_FILLER.has(stem));
}

export {
  mastersToRank,
  CATEGORY_TAIL,
  partBeforeLink,
  askGate,
  wholeNameTypo,
  genericOnlyMiss,
  withoutGenericCousins,
  nounBeatsExtras,
  dropUnmatchedWeak,
  headTokenBonus,
  categoryHeadBonus,
  plainNounOverComposite,
  finishRank,
  nameTokenFor,
  tokenHits,
  repeatedSynonym,
  lexicalScore,
  splitBrief,
  replacedByName,
  asksIcon,
  isInternalPart,
  masterLooksLikeIcon,
  looksLikeIcon,
  distinctiveIconName,
  shouldDemoteIcon,
} from "./recommendLexiconRank";
