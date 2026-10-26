/** Phrase tails, icon demotion, and the masters eligible to rank. */
import type { GraphNode } from "@/core/model";
import { setOf } from "@/core/rules/family";
import { collapsedName, isNameInferredMaster, isPrivateMasterName } from "@/core/rules/names";
import type { GraphIndex } from "./GraphIndex";
import { familyNameOf, MASTER_TYPES } from "./masterNames";
import { GENERIC_NAME_TOKENS, navFamily, tokensOf } from "./queryTokens";
import { adjacentSwap, typoHeavy, wordSlip } from "./typo";
import { allSynonymGroups, fromIconLibrary, iconShelf, SYNONYM_OF } from "./recommendContext";
import type { WorkspaceManifest } from "./workspace";
import { componentKeyOf, nodeFileKey } from "./workspaceMerge";
import {
  DESCRIBE_META,
  LEXICAL_WEIGHT,
  modifierWord,
  phraseCoversAsk,
  PLAIN_NOUN,
  RETIRED_NAME_TOKENS,
  SIZE_OR_A11Y,
  SLOT_QUALIFIERS,
  synonymIn,
  termsFor,
  tokenMatchesName,
  TRAILING_AFTER,
  inflectsName,
  slipsTo,
  tokenTypo,
} from "./recommendLexicon";

interface TokenHits {
  name: number;
  synonym: number;
  variant: number;
  describe: number;
  covered: number;
  /** Name or synonym hits that are not a shared word like button, bar, or field. */
  specific: number;
}

function learnedLibrary(node: GraphNode, keys: Set<string> | undefined): boolean {
  if (!keys) return false;
  const key = nodeFileKey(node)?.toLowerCase();
  if (key && keys.has(key)) return true;
  const source = node.metadata?.["sourceFileKey"];
  return typeof source === "string" && keys.has(source.trim().toLowerCase());
}

/** Learned files, including a remote master from one of them when no local twin exists. */
export function mastersToRank(
  index: GraphIndex,
  workspace: WorkspaceManifest | undefined,
  graphFileKey: string,
  ask?: string,
): GraphNode[] {
  const keys =
    workspace && workspace.files.length > 0
      ? new Set(workspace.files.map((file) => file.key.toLowerCase()))
      : undefined;
  const iconAsk = Boolean(ask && asksIcon(tokensOf(ask), ask));
  const nodes = index.getNodesByType(...MASTER_TYPES);
  const localIds = new Set<string>();
  const localKeys = new Set<string>();
  for (const node of nodes) {
    if (node.isRemote || isNameInferredMaster(node)) continue;
    if (node.figmaNodeId) localIds.add(node.figmaNodeId);
    const published = componentKeyOf(node);
    if (published) localKeys.add(published);
  }
  return nodes.filter((node) => {
    if (isNameInferredMaster(node)) return false;
    const icon =
      fromIconLibrary(index, node, workspace) ||
      iconShelf(index, node, workspace) ||
      looksLikeIcon(index, node, setOf(index, node), workspace);
    if (node.isRemote && !icon && !iconAsk) {
      if (!learnedLibrary(node, keys)) return false;
      if (node.figmaNodeId && localIds.has(node.figmaNodeId)) return false;
      const published = componentKeyOf(node);
      if (published && localKeys.has(published)) return false;
    }
    if (!keys || node.isRemote || icon) return true;
    const key = nodeFileKey(node, graphFileKey)?.toLowerCase();
    if (!key || keys.has(key)) return true;
    return learnedLibrary(node, keys);
  });
}

export const CATEGORY_TAIL = new Set(["icon", "glyph", "symbol", "banner", "dropdown", "nav", "navigation"]);
/** The token is the whole component name, or a synonym that covers every word of it. */
function longestCoveredName(token: string, nameSets: readonly Set<string>[]): number {
  let best = 0;
  for (const names of nameSets) {
    if (!names.size) continue;
    const joined = [...names].join("");
    const alias = !names.has(token) && [...names].every((part) => synonymIn(token, new Set([part]), false));
    const whole =
      joined === token ||
      (names.size === 1 && (names.has(token) || synonymIn(token, names, false))) ||
      alias;
    if (whole) best = Math.max(best, joined.length, token.length);
  }
  return best;
}
/** Words that start a description of the part: what it is for, what it holds, where it sits. */
const DESCRIBING_WORD = new Set(["for", "to", "with", "when", "while", "on", "at", "under", "above", "below", "after", "before", "showing", "holding"]);
type NameSets = readonly Set<string>[];
const namedIn = (names: Set<string>, token: string, allowClip: boolean) =>
  nameTokenFor(token, names, new Set()) !== undefined || synonymIn(token, names, allowClip);
/**
 * Where the first describing word sits. "slider for volume": volume says what the slider is for.
 * "of" describes only before a plural, and only after a part's whole name: "list of contacts" with a List.
 * "badge of honor" and "a list of quasars" (Card List is not just "list") stay phrases of their own.
 */
function describingSplit(ask: string, nameSets: NameSets, allowClip: boolean): { words: string[]; at: number } {
  const words = ask.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const wholePart = (end: number) => {
    const lead = tokensOf(words.slice(0, end).join(" "));
    return nameSets.some((names) => [...names].every((name) => lead.some((token) => namedIn(new Set([name]), token, allowClip))));
  };
  const at = words.findIndex(
    (word, i) => DESCRIBING_WORD.has(word) || (word === "of" && /[^s]s$/.test(words[i + 1] ?? "") && wholePart(i)),
  );
  return { words, at };
}
function describingTail(ask: string, nameSets: NameSets, allowClip: boolean): Set<string> {
  const { words, at } = describingSplit(ask, nameSets, allowClip);
  // The describing word itself is part of the tail: "holding" in "toolbar holding other items" is not junk.
  return new Set(at < 1 ? [] : words.slice(at));
}
/**
 * The part named before the first describing word wins: "button to open the dialog" is a Button.
 * A later word that names a different part is dropped; one that sharpens the same part stays
 * ("nav bar on mobile" keeps mobile, for Mobile Nav).
 * Undefined when nothing before that word names a part, or it names a screen ("dashboard with a button").
 */
export function partBeforeLink(ask: string, nameSets: NameSets, allowClip: boolean, screens: readonly string[]): string | undefined {
  const { words, at } = describingSplit(ask, nameSets, allowClip);
  if (at < 1) return undefined;
  const lead = tokensOf(words.slice(0, at).join(" "));
  // "checkout summary with primary button": the lead is a screen, so the part after the link is the ask.
  if (lead.every((token) => screens.includes(token))) return undefined;
  const leadSets = nameSets.filter((names) => lead.some((token) => namedIn(names, token, allowClip)));
  if (!leadSets.length) return undefined;
  const tail = tokensOf(words.slice(at + 1).join(" ")).filter(
    (token) =>
      token === "row" ||
      token === "rows" ||
      !nameSets.some((names) => namedIn(names, token, allowClip)) ||
      leadSets.some((names) => namedIn(names, token, allowClip)),
  );
  return [...lead, words[at]!, ...tail].join(" ");
}

function keepsCompany(token: string, previous: string | undefined, exempt: ReadonlySet<string>): boolean {
  if (modifierWord(token) || exempt.has(token) || CATEGORY_TAIL.has(token)) return true;
  if (!previous) return false;
  const after = TRAILING_AFTER.get(token);
  if (!after) return false;
  if (after.has(previous)) return true;
  const group = SYNONYM_OF.get(previous);
  return Boolean(group?.some((word) => after.has(word)));
}
/** One component word, then a word that is not a UI noun, is not a component ask. */
export function askGate(
  ask: string,
  tokens: string[],
  nameSets: readonly Set<string>[],
  exempt: ReadonlySet<string>,
  allowClip: boolean,
): { outOfDomain: boolean; lowConfidence: boolean } {
  const open = { outOfDomain: false, lowConfidence: false };
  if (phraseCoversAsk(ask)) return open;
  const describe = describingTail(ask, nameSets, allowClip);
  const content = tokens.filter((token) => !RETIRED_NAME_TOKENS.has(token));
  if (content.length < 2) return open;
  const exact = (token: string) => nameSets.some((names) => names.has(token) || [...names].some((name) => inflectsName(token, name)) || synonymIn(token, names, allowClip));
  const slips = (token: string) => nameSets.some((names) => [...names].some((name) => wordSlip(token, name)));
  if (typoHeavy(content, exact, slips, (token) => modifierWord(token) || exempt.has(token) || describe.has(token))) {
    return { outOfDomain: true, lowConfidence: false };
  }
  const hit = content.map((token) =>
    nameSets.some(
      (names) => nameTokenFor(token, names, new Set()) !== undefined || synonymIn(token, names, allowClip),
    ),
  );
  if (hit.filter(Boolean).length !== 1) return open;
  const head = hit.lastIndexOf(true);
  let trailingJunk = false;
  for (let i = head + 1; i < content.length; i += 1) {
    const token = content[i];
    if (token && describe.has(token)) continue;
    if (!token || !keepsCompany(token, content[i - 1], exempt)) trailingJunk = true;
  }
  // A long whole name ("snackbar", "datepicker") stays a match when one extra word follows.
  // Short names ("chip shop", "divider wall") stay empty: the extra word is the subject.
  if (trailingJunk) {
    const headToken = content[head] ?? "";
    if (longestCoveredName(headToken, nameSets) >= 8) return { outOfDomain: false, lowConfidence: true };
    return { outOfDomain: true, lowConfidence: false };
  }
  let unknown = 0;
  for (let i = 0; i < head; i += 1) {
    const token = content[i];
    if (!token || hit[i]) continue;
    if (modifierWord(token) || exempt.has(token)) continue;
    unknown += 1;
  }
  return { outOfDomain: false, lowConfidence: unknown > 0 };
}
function oneCharMissing(query: string, name: string): boolean {
  if (query.length + 1 !== name.length) return false;
  let i = 0;
  while (i < query.length && query[i] === name[i]) i += 1;
  return query.slice(i) === name.slice(i + 1);
}
/** Whole name, spaces removed, at least 5 letters: one missing letter or a neighbour swap. */
export function wholeNameTypo(ask: string, name: string): boolean {
  const query = collapsedName(ask);
  const master = collapsedName(name);
  if (query.length < 5 || master.length < 5 || query === master) return false;
  return oneCharMissing(query, master) || adjacentSwap(query, master);
}
/** "button" and "cta"/"action" are the same generic control word. */
function genericQuery(query: string): boolean {
  if (GENERIC_NAME_TOKENS.has(query)) return true;
  const group = SYNONYM_OF.get(query);
  return Boolean(group?.some((word) => word !== query && GENERIC_NAME_TOKENS.has(word)));
}
/** Generic-only overlap drops when another word names a different part. */
export function genericOnlyMiss(
  name: string,
  queryTokens: string[],
  allowClip: boolean,
  componentWord: (token: string) => boolean,
  synonymWord: (token: string) => boolean = () => false,
): boolean {
  const nameTokens = tokensOf(name);
  if (!nameTokens.length || !queryTokens.length) return false;
  const matched = nameTokens.filter((token) =>
    queryTokens.some((query) => tokenMatchesName(query, token, allowClip)),
  );
  if (!matched.length) return false;
  if (matched.some((token) => !GENERIC_NAME_TOKENS.has(token))) return false;
  const uncovered = queryTokens.filter((query) => {
    if (genericQuery(query) || query === "primary" || query === "main" || query === "submit") return false;
    return !nameTokens.some((token) => tokenMatchesName(query, token, allowClip));
  });
  if (!uncovered.length) return false;
  if (navFamily(nameTokens, queryTokens) && uncovered.every((query) => query === "nav" || query === "navigation")) return false;
  if (uncovered.some((query) => {
    if (SIZE_OR_A11Y.has(query) || !componentWord(query)) return false;
    return !modifierWord(query) || synonymWord(query);
  })) return true;
  const unknown = uncovered.filter((query) => !modifierWord(query));
  if (!unknown.length) return false;
  return nameTokens.some(
    (token) =>
      !GENERIC_NAME_TOKENS.has(token) &&
      !queryTokens.some((query) => tokenMatchesName(query, token, allowClip)),
  );
}
/** A named modifier drops a generic cousin. The plain noun itself stays. */
export function withoutGenericCousins<T extends { node: { name: string }; setName?: string }>(
  entries: T[],
  queryTokens: string[],
  allowClip: boolean,
): T[] {
  const familyOf = (entry: T): string => familyNameOf(entry.node.name, entry.setName);
  const modifiers = queryTokens.filter(
    (token) => modifierWord(token) && !GENERIC_NAME_TOKENS.has(token) && !SIZE_OR_A11Y.has(token),
  );
  const covered = modifiers.filter((token) =>
    entries.some((entry) => tokensOf(familyOf(entry)).some((name) => name === token || inflectsName(token, name))),
  );
  if (!covered.length) return entries;
  return entries.filter((entry) => {
    const names = tokensOf(familyOf(entry));
    const misses = covered.some((token) => !names.some((name) => name === token || inflectsName(token, name)));
    if (!misses) return true;
    const tail = tokensOf(familyOf(entry).split("/").pop() ?? "");
    const noun = queryTokens.find((token) => PLAIN_NOUN.has(token) || SYNONYM_OF.get(token)?.some((word) => PLAIN_NOUN.has(word)) || [...PLAIN_NOUN].some((word) => tokenTypo(token, word)));
    if (noun && tail.length === 1 && tail[0] && (tail[0] === noun || inflectsName(noun, tail[0]) || tokenMatchesName(noun, tail[0], allowClip))) return true;
    return names.some((name) => {
      if (GENERIC_NAME_TOKENS.has(name)) return false;
      return queryTokens.some((query) => {
        if (!(query === name || inflectsName(query, name) || tokenMatchesName(query, name, allowClip))) return false;
        if (query === name || inflectsName(query, name)) return true;
        return !genericQuery(query);
      });
    });
  });
}

function familyNames(entry: { node: { name: string }; setName?: string }): Set<string> {
  const names = new Set(tokensOf(familyNameOf(entry.node.name, entry.setName)));
  if (entry.setName) for (const token of tokensOf(entry.setName)) names.add(token);
  return names;
}

function nounHit(noun: string, names: Set<string>, allowClip: boolean): boolean {
  if (nameTokenFor(noun, names, new Set())) return true;
  if ([...names].some((name) => name === noun)) return true;
  return synonymIn(noun, names, allowClip);
}

/** The component noun wins. A synonym counts. Cousins are already gone. */
const CONTROL_NOUN = new Set(["button", "cta", "action", "icon"]);

function controlNoun(token: string): boolean {
  if (CONTROL_NOUN.has(token) || [...CONTROL_NOUN].some((word) => tokenTypo(token, word))) return true;
  const group = SYNONYM_OF.get(token);
  return Boolean(group?.some((word) => CONTROL_NOUN.has(word)));
}

export function nounBeatsExtras<T extends { node: { name: string }; setName?: string }>(
  entries: T[],
  queryTokens: string[],
  allowClip: boolean,
): T[] {
  const nouns = queryTokens.filter((token) => controlNoun(token));
  if (!nouns.length || entries.length < 2) return entries;
  const iconOnly = nouns.every((token) => token === "icon" || token === "glyph" || token === "symbol");
  if (iconOnly) {
    const named = entries.filter((entry) =>
      queryTokens.some((token) => token !== "icon" && token !== "glyph" && token !== "symbol" && !SIZE_OR_A11Y.has(token) && nounHit(token, familyNames(entry), allowClip)),
    );
    if (named.length) return named;
  }
  const other = queryTokens.some((token) => !controlNoun(token) && !modifierWord(token) && !SIZE_OR_A11Y.has(token));
  // "radio button" and "payment row" name another part. A lone "large button" does not.
  if (other) return entries;
  const hits = entries.filter((entry) => nouns.some((noun) => nounHit(noun, familyNames(entry), allowClip)));
  return hits.length ? hits : entries;
}

/** A weak pick that leaves a real word unmatched is not an offer. Purpose tails stay. */
export function dropUnmatchedWeak<T extends { node: { name: string }; setName?: string; weak?: boolean }>(
  entries: T[],
  queryTokens: string[],
  allowClip: boolean,
  purpose: ReadonlySet<string>,
  componentWord: (token: string) => boolean,
): T[] {
  const content = queryTokens.filter((token) => !modifierWord(token) && !SIZE_OR_A11Y.has(token) && !purpose.has(token));
  if (!content.length) return entries;
  const next: T[] = [];
  for (const entry of entries) {
    if (!entry.weak) {
      next.push(entry);
      continue;
    }
    const names = familyNames(entry);
    const unmatched = content.filter((token) => !nounHit(token, names, allowClip));
    if (!unmatched.length) {
      // A lone generic word ("picker") fits several parts: it stays weak.
      next.push(content.every((token) => GENERIC_NAME_TOKENS.has(token)) ? entry : { ...entry, weak: false });
      continue;
    }
    const control = content.some((token) => controlNoun(token) && nounHit(token, names, allowClip));
    const navBar = unmatched.every((token) => token === "nav" || token === "navigation") && navFamily(names, queryTokens);
    if (control || navBar || unmatched.every((token) => !componentWord(token))) next.push(entry);
  }
  return next;
}

export function headTokenBonus(familyName: string, tokens: string[], allowClip: boolean, exactName: boolean): number {
  if (exactName) return 0;
  const names = new Set(tokensOf(familyName));
  const nav = tokens.includes("nav") || tokens.includes("navigation");
  const bottom = tokens.some((token) => token === "bottom" || token === "footer");
  if (nav && !bottom && names.has("header")) return 25;
  const head = [...tokens].reverse().find((token) => !modifierWord(token) && !SIZE_OR_A11Y.has(token));
  if (!head || !nounHit(head, names, allowClip)) return 0;
  const sided = bottom || tokens.some((token) => token === "top" || token === "header");
  if (sided && (head === "nav" || head === "navigation") && !names.has(bottom ? "footer" : "header")) return 0;
  return 15;
}

/** Last word is the kind of part. A family of that kind that also says the specific word gets a small lift. */
export function categoryHeadBonus(familyName: string, tokens: string[], allowClip: boolean): number {
  if (tokens.length < 2) return 0;
  const tail = tokens[tokens.length - 1];
  if (!tail || !CATEGORY_TAIL.has(tail)) return 0;
  const names = new Set(tokensOf(familyName));
  const tailHit = [...names].some((name) => name === tail || inflectsName(tail, name)) || synonymIn(tail, names, allowClip);
  if (!tailHit) return 0;
  const specific = tokens.slice(0, -1).filter((token) => token !== tail && !modifierWord(token) && !SIZE_OR_A11Y.has(token));
  if (!specific.length || !specific.some((token) => nounHit(token, names, allowClip))) return 0;
  return 40;
}

function plainNounToken(token: string): boolean {
  if (PLAIN_NOUN.has(token)) return true;
  const group = SYNONYM_OF.get(token);
  return Boolean(group?.some((word) => PLAIN_NOUN.has(word)));
}

const SHAPE_WORD = new Set(["group"]);

/** Last path segment. `Controls / Button` is Button. */
function bareSegment(label: string): string {
  return label.split("/").map((part) => part.trim()).filter(Boolean).pop() ?? label;
}

/** "primary button" stays Button. "card" stays Card. "radio group" stays Radio, not a button group. */
function absorbedAlias(tokens: readonly string[]): { noun: string; rest: string[] } | undefined {
  for (const group of allSynonymGroups()) {
    const phrase = group.terms.find((term) => term.includes(" ") && tokensOf(term).every((part) => tokens.includes(part)));
    if (!phrase) continue;
    const noun = group.terms.find((term) => !term.includes(" ") && PLAIN_NOUN.has(term));
    if (!noun) continue;
    const covered = new Set(tokensOf(phrase));
    for (const term of group.terms) if (!term.includes(" ")) covered.add(term);
    return { noun, rest: tokens.filter((token) => !covered.has(token)) };
  }
  return undefined;
}

export function plainNounOverComposite<T extends { node: { name: string }; setName?: string }>(
  entries: T[],
  queryTokens: string[],
): T[] {
  const alias = absorbedAlias(queryTokens);
  const nouns = alias ? [alias.noun] : queryTokens.filter((token) => plainNounToken(token));
  if (nouns.length !== 1 || entries.length < 2) return entries;
  const noun = nouns[0]!;
  const rest = alias ? alias.rest : queryTokens.filter((token) => token !== noun);
  if (rest.some((token) => !modifierWord(token) && !SIZE_OR_A11Y.has(token) && !SHAPE_WORD.has(token))) return entries;
  // "save button": a family named by another asked word (not a variant or size word) that is this control is more specific.
  const specific = entries.filter((entry) => nounHit(noun, familyNames(entry), false) && rest.some((token) => !SLOT_QUALIFIERS.has(token) && !SIZE_OR_A11Y.has(token) && familyNames(entry).has(token)));
  if (specific.length) return [...specific, ...entries.filter((entry) => !specific.includes(entry))];
  const plainLabel = (label: string): boolean => {
    const names = new Set(tokensOf(bareSegment(label)));
    if (![...names].some((name) => name === noun || inflectsName(noun, name))) return false;
    for (const name of names) {
      if (name === noun || inflectsName(noun, name)) continue;
      // "save" is a modifier, but "cta" did not ask for it. Save CTA is not the plain control.
      if (queryTokens.includes(name) && (modifierWord(name) || SIZE_OR_A11Y.has(name) || SHAPE_WORD.has(name))) continue;
      return false;
    }
    return names.size > 0;
  };
  const literal = entries.filter((entry) => {
    const labels = [familyNameOf(entry.node.name, entry.setName)];
    if (entry.setName) labels.push(entry.setName);
    return labels.some((label) => plainLabel(label));
  });
  if (!literal.length || literal.length === entries.length) return entries;
  const chosen = new Set(literal);
  return [...literal, ...entries.filter((entry) => !chosen.has(entry))];
}

/** Cousin filter, then the noun, then the plain name, then drop a weak pick that leaves a real word unmatched. */
export function finishRank<T extends { node: { name: string }; setName?: string; weak?: boolean }>(
  entries: T[],
  queryTokens: string[],
  allowClip: boolean,
  purpose: ReadonlySet<string>,
  componentWord: (token: string) => boolean,
): T[] {
  const cousins = withoutGenericCousins(
    entries,
    queryTokens.filter((token) => !purpose.has(token)),
    allowClip,
  );
  const nouns = nounBeatsExtras(cousins, queryTokens, allowClip);
  const plain = plainNounOverComposite(nouns, queryTokens);
  return dropUnmatchedWeak(plain, queryTokens, allowClip, purpose, componentWord);
}

export function nameTokenFor(token: string, names: Set<string>, used: Set<string>): string | undefined {
  if (names.has(token) && !used.has(token)) return token;
  for (const name of names) {
    if (!used.has(name) && (inflectsName(token, name) || slipsTo(token, name) || tokenTypo(token, name))) return name;
  }
  return undefined;
}
export function tokenHits(
  nameHaystack: string,
  variantText: string,
  tokens: string[],
  allowClip: boolean,
  describeText = "",
): TokenHits {
  const names = new Set(tokensOf(nameHaystack));
  const variants = new Set(tokensOf(variantText));
  const described = new Set(tokensOf(describeText).filter((token) => !DESCRIBE_META.has(token) && !GENERIC_NAME_TOKENS.has(token)));
  const used = new Set<string>();
  let name = 0;
  let synonym = 0;
  let variant = 0;
  let describe = 0;
  let covered = 0;
  let specific = 0;
  const coveredQuery = new Set<string>();
  for (const group of allSynonymGroups()) {
    const said = group.terms.filter(
      (term) => term.includes(" ") && tokensOf(term).every((token) => tokens.includes(token)),
    );
    if (!said.length) continue;
    const phraseTokens = [...new Set(said.flatMap((term) => tokensOf(term)))];
    if (phraseTokens.some((token) => names.has(token))) continue;
    const familyWord = group.terms.find((term) => !term.includes(" ") && names.has(term) && !used.has(term));
    if (!familyWord) continue;
    used.add(familyWord);
    synonym += 1;
    covered += 1;
    if (!GENERIC_NAME_TOKENS.has(familyWord)) specific += 1;
    for (const token of phraseTokens) coveredQuery.add(token);
  }
  const pending: string[] = [];
  for (const token of tokens) {
    if (coveredQuery.has(token)) continue;
    const hit = nameTokenFor(token, names, used);
    if (hit) {
      name += 1;
      covered += 1;
      if (!GENERIC_NAME_TOKENS.has(hit)) specific += 1;
      used.add(hit);
    } else pending.push(token);
  }
  const still: string[] = [];
  for (const token of pending) {
    const group = termsFor(token, allowClip);
    const hit = group?.find((word) => word !== token && names.has(word) && !used.has(word));
    if (hit) {
      synonym += 1;
      covered += 1;
      if (!GENERIC_NAME_TOKENS.has(hit) && !genericQuery(token)) specific += 1;
      used.add(hit);
    } else still.push(token);
  }
  const afterVariant: string[] = [];
  for (const token of still) {
    const syn = termsFor(token, allowClip);
    const hit = [...variants].find(
      (part) => !used.has(part) && (part === token || Boolean(syn?.includes(part) && part !== token)),
    );
    if (hit) {
      variant += 1;
      covered += 1;
      used.add(hit);
    } else afterVariant.push(token);
  }
  for (const token of afterVariant) {
    const syn = termsFor(token, allowClip);
    const hit = [...described].find(
      (part) => !used.has(part) && (part === token || Boolean(syn?.includes(part) && part !== token)),
    );
    if (hit) {
      describe += 1;
      covered += 1;
      used.add(hit);
    }
  }
  return { name, synonym, variant, describe, covered, specific };
}
/** "header title" restates header. A second word for a name already matched still counts. */
export function repeatedSynonym(nameHaystack: string, tokens: string[], allowClip: boolean): number {
  const names = new Set(tokensOf(nameHaystack));
  const used = new Set<string>();
  let extra = 0;
  for (const token of tokens) {
    const hit = nameTokenFor(token, names, used);
    if (hit) {
      used.add(hit);
      continue;
    }
    const group = termsFor(token, allowClip);
    if (group?.some((word) => word !== token && used.has(word))) extra += 1;
  }
  return extra;
}
/** Name / synonym / variant / description. One name token outranks any amount of context. */
export function lexicalScore(hits: TokenHits, exactName: boolean): number {
  if (exactName) return 1_000_000;
  return (
    hits.name * LEXICAL_WEIGHT.name +
    hits.synonym * LEXICAL_WEIGHT.synonym +
    hits.variant * LEXICAL_WEIGHT.variant +
    hits.describe * LEXICAL_WEIGHT.describe
  );
}
function iconOnlyTail(role: string): boolean {
  const tokens = role
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token && token !== "a" && token !== "an" && token !== "the");
  return (
    tokens.length > 0 && tokens.every((token) => token === "icon" || token === "glyph" || token === "symbol")
  );
}
/** Words after "with" are the role, unless they are only a modifier. */
export function splitBrief(
  intent: string,
  componentWord?: (token: string) => boolean,
): { role: string; scene: string } {
  const parts = intent.split(/\s+with\s+/i);
  if (parts.length < 2) return { role: intent.trim(), scene: "" };
  const scene = (parts[0] ?? "").trim();
  const role = parts.slice(1).join(" ").trim();
  if (scene && iconOnlyTail(role)) return { role: scene, scene: "" };
  if (componentWord) {
    const roleHits = tokensOf(role).some(componentWord);
    const sceneHits = tokensOf(scene).some(componentWord);
    if (!roleHits && sceneHits) return { role: intent.trim(), scene: "" };
  }
  return { scene, role };
}
export function replacedByName(node: GraphNode): string | undefined {
  const meta = node.metadata?.["replacedBy"];
  if (typeof meta === "string" && meta.trim()) return meta.trim();
  const description = node.description ?? "";
  for (const line of description.split(/\n/)) {
    const match = line.match(/^\s*replacedBy\s*:\s*(.+?)\s*$/i);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}
/** Coded icon names: `glyph-24-search` and hyphenated categories like `acme-pay-56-mark`. */
const ICON_CODE_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-\d{2,}-[a-z]/i;
const ICON_WORD = /^(?:icon|glyph|symbol)(?:\b|[-_\s])|(?:^|[-_\s])(?:icon|glyph|symbol)$/i;
export function asksIcon(tokens: string[], rawAsk?: string): boolean {
  const parts = (rawAsk ?? tokens.join(" "))
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const iconAt = parts.findIndex(
    (token) => token === "icon" || token === "glyph" || token === "symbol",
  );
  if (iconAt < 0) return false;
  const before = parts[iconAt - 1];
  if (before === "with" || before === "and" || before === "plus") return false;
  const after = parts.slice(iconAt + 1);
  if (after.some((token) => GENERIC_NAME_TOKENS.has(token) && token !== "icon")) return false;
  return true;
}
function internalPartName(name: string): boolean {
  const trimmed = name.trim();
  if (isPrivateMasterName(trimmed)) return true;
  return trimmed.toLowerCase().startsWith("base/");
}
export function isInternalPart(index: GraphIndex, node: GraphNode): boolean {
  if (internalPartName(node.name)) return true;
  const set = setOf(index, node);
  return Boolean(set && internalPartName(set.name));
}
function masterNames(node: GraphNode, set?: GraphNode): string[] {
  return [node.name, set?.name].filter((value): value is string => Boolean(value));
}
function codedIconName(name: string): boolean {
  return ICON_CODE_NAME.test(name.trim());
}
function iconWordName(name: string): boolean {
  return ICON_WORD.test(name.trim().toLowerCase().replace(/[_/]+/g, " "));
}
export function masterLooksLikeIcon(
  index: GraphIndex,
  node: GraphNode,
  workspace?: WorkspaceManifest,
): boolean {
  return looksLikeIcon(index, node, setOf(index, node), workspace);
}
/** Name heuristic, plus any master from a team-listed icon library. */
export function looksLikeIcon(
  index: GraphIndex,
  node: GraphNode,
  set: GraphNode | undefined,
  workspace?: WorkspaceManifest,
): boolean {
  if (fromIconLibrary(index, node, workspace)) return true;
  return masterNames(node, set).some((name) => codedIconName(name) || iconWordName(name));
}
export function distinctiveIconName(name: string): boolean {
  const trimmed = name.trim();
  if (codedIconName(trimmed) || iconWordName(trimmed)) return true;
  if (/[-/]/.test(trimmed)) return true;
  return tokensOf(trimmed).length >= 2;
}
/** Listed icon library always, unless the ask is for an icon or an exact distinctive name. Else M1 name heuristic. */
export function shouldDemoteIcon(
  index: GraphIndex,
  node: GraphNode,
  set: GraphNode | undefined,
  tokens: string[],
  askedExact: boolean,
  workspace?: WorkspaceManifest,
  rawAsk?: string,
): boolean {
  if (asksIcon(tokens, rawAsk)) return false;
  const names = masterNames(node, set);
  const distinctive = names.some((name) => distinctiveIconName(name));
  if (fromIconLibrary(index, node, workspace)) {
    if (askedExact && distinctive) return false;
    return true;
  }
  if (askedExact) return false;
  if (names.some((name) => codedIconName(name))) return true;
  if (!names.some((name) => iconWordName(name))) return false;
  const extra = tokensOf(names.join(" ")).filter(
    (token) => token !== "icon" && token !== "glyph" && token !== "symbol",
  );
  return !extra.some((token) => tokens.includes(token));
}
