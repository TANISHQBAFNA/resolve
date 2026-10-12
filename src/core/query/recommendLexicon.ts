/** Lexical score, phrase aliases, and icon demotion. */
import type { GraphNode } from "@/core/model";
import { setOf } from "@/core/rules/family";
import { collapsedName, isNameInferredMaster, isPrivateMasterName } from "@/core/rules/names";
import { isRetired } from "@/core/rules/retired";
import modifierFile from "@/data/ui-modifiers.json";
import type { GraphIndex } from "./GraphIndex";
import { familyNameOf, MASTER_TYPES, VARIANT_PROP_NAME, variantCardName } from "./masterNames";
import { GENERIC_NAME_TOKENS, tokensOf } from "./queryTokens";
import { allSynonymGroups, extraSynonym, fromIconLibrary, LABEL_FILLER, SYNONYM_GROUPS, SYNONYM_OF } from "./recommendContext";
import type { RecommendContext } from "./recommendSupport";
import { inflectionStems, isScreen } from "./screenInventory";
import type { WorkspaceManifest } from "./workspace";

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
/**
 * States, sizes, variants, roles, and common UI nouns.
 * A multi-word ask may keep one of these beside a real component word.
 * Reasons live in src/data/ui-modifiers.json.
 */
const UI_MODIFIER = new Set(modifierFile.words.map((word) => word.term.toLowerCase()));
/**
 * A word that only counts when it follows a component word or one of its synonyms.
 * "window" after modal. "mark" after close. Not a free-floating modifier.
 */
const TRAILING_AFTER = new Map<string, ReadonlySet<string>>(
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
export const RETIRED_NAME_TOKENS = new Set(["legacy", "old", "deprecated", "retired"]);
export function synonymIn(token: string, names: Set<string>, allowClip = false): boolean {
  const group = termsFor(token, allowClip);
  if (!group) return false;
  return group.some((word) => word !== token && names.has(word));
}
const CLIP_GROUP = new Map<string, readonly string[] | undefined>();
/**
 * A short token that is a unique prefix of one synonym, with at least four
 * letters left over. "pic" is picture. "head" is not, because it also starts header.
 * Single-word asks do not clip. The caller passes allowClip only for a multi-word ask.
 */
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
function termsFor(token: string, allowClip: boolean): readonly string[] | undefined {
  return extraSynonym.get(token) ?? SYNONYM_OF.get(token) ?? (allowClip ? clippingGroup(token) : undefined);
}
interface TokenHits {
  name: number;
  synonym: number;
  variant: number;
  covered: number;
  /** Name or synonym hits that are not a shared word like button, bar, or field. */
  specific: number;
}
/** Family name only. `Type=Primary` is a variant layer, not a component name. */
export function familyHaystack(node: GraphNode, set: GraphNode | undefined): string {
  if (VARIANT_PROP_NAME.test(node.name)) return set?.name ?? "";
  if (set && set.id !== node.id) return `${set.name} ${node.name}`;
  return node.name;
}
/** Variant values only. Property names (State, Type, Size) are not words. */
export function variantValueText(node: GraphNode): string {
  const props = node.variantProperties;
  if (props && Object.keys(props).length) return Object.values(props).join(" ");
  if (!VARIANT_PROP_NAME.test(node.name)) return "";
  return node.name
    .split(",")
    .map((part) => part.split("=").slice(1).join("=").trim())
    .filter(Boolean)
    .join(" ");
}
/** Set name equals the ask, or the set name is a whole-word/phrase inside the ask. */
export function setCoversAsk(ask: string, setName: string): boolean {
  const askFold = ask.trim().toLowerCase();
  const nameFold = setName.trim().toLowerCase();
  if (!askFold || !nameFold) return false;
  if (askFold === nameFold || collapsedName(askFold) === collapsedName(nameFold)) return true;
  const nameTokens = tokensOf(nameFold);
  const askTokens = tokensOf(askFold);
  return nameTokens.length > 0 && nameTokens.every((token) => askTokens.includes(token));
}
/** Query names this node, not merely its family. */
export function namesThisNode(ask: string, node: GraphNode, index: GraphIndex): boolean {
  const needle = ask.trim().toLowerCase();
  if (!needle) return false;
  if (node.name.toLowerCase() === needle) return true;
  if (collapsedName(node.name) === collapsedName(needle)) return true;
  if (phraseNamesMatch(needle, node.name)) return true;
  return variantCardName(index, node).toLowerCase() === needle;
}
/** Plural s/es or -ing/-ed, either way. "tablet" is not an inflection of "tab". */
function inflectsName(query: string, nameToken: string): boolean {
  if (query === nameToken || query.length < 3 || nameToken.length < 3) return false;
  const [longer, shorter] = query.length >= nameToken.length ? [query, nameToken] : [nameToken, query];
  if (!longer.startsWith(shorter)) return false;
  const rest = longer.slice(shorter.length);
  return rest === "s" || rest === "es" || rest === "ing" || rest === "ed";
}
export function tokenMatchesName(query: string, nameToken: string, allowClip = false): boolean {
  if (query === nameToken || inflectsName(query, nameToken)) return true;
  return synonymIn(query, new Set([nameToken]), allowClip);
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
/** Multi-word synonym phrases, such as "tick box" for Checkbox. Single words stay in SYNONYM_OF. */
export function phraseNamesMatch(ask: string, name: string): boolean {
  const collapsedAsk = collapsedName(ask);
  const collapsedMaster = collapsedName(name);
  if (!collapsedAsk || !collapsedMaster) return false;
  return allSynonymGroups().some((group) => {
    const asked = group.terms.some((term) => term.includes(" ") && collapsedName(term) === collapsedAsk);
    if (!asked) return false;
    return group.terms.some((term) => collapsedName(term) === collapsedMaster);
  });
}
function phraseCoversAsk(ask: string): boolean {
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
    const said = group.terms.filter(
      (term) => term.includes(" ") && tokensOf(term).every((token) => askTokens.has(token)),
    );
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
    const said = group.terms.some(
      (term) => term.includes(" ") && tokensOf(term).every((token) => askTokens.has(token)),
    );
    if (!said) continue;
    const short = group.terms.some((term) => !term.includes(" ") && collapsedName(term) === familyCollapsed);
    if (short) return 500;
  }
  return 0;
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
function keepsCompany(token: string, previous: string | undefined, exempt: ReadonlySet<string>): boolean {
  if (modifierWord(token) || exempt.has(token)) return true;
  if (!previous) return false;
  const after = TRAILING_AFTER.get(token);
  if (!after) return false;
  if (after.has(previous)) return true;
  const group = SYNONYM_OF.get(previous);
  return Boolean(group?.some((word) => after.has(word)));
}
/**
 * One component word plus words that are not the head is not a component ask.
 * The head is the last word, or a component word followed only by UI nouns.
 * "cart badge" keeps Badge. "card game" is empty, because game is the head.
 * "error alert" stays, because error is a status. A scene word is not junk.
 * An unknown word in front of the head is a noun modifier, and the pick is low confidence.
 */
export function askGate(
  ask: string,
  tokens: string[],
  nameSets: readonly Set<string>[],
  exempt: ReadonlySet<string>,
  allowClip: boolean,
): { outOfDomain: boolean; lowConfidence: boolean } {
  const open = { outOfDomain: false, lowConfidence: false };
  if (phraseCoversAsk(ask)) return open;
  const content = tokens.filter((token) => !RETIRED_NAME_TOKENS.has(token));
  if (content.length < 2) return open;
  const hit = content.map((token) =>
    nameSets.some(
      (names) => nameTokenFor(token, names, new Set()) !== undefined || synonymIn(token, names, allowClip),
    ),
  );
  if (hit.filter(Boolean).length !== 1) return open;
  const head = hit.lastIndexOf(true);
  for (let i = head + 1; i < content.length; i += 1) {
    const token = content[i];
    if (!token || !keepsCompany(token, content[i - 1], exempt)) return { outOfDomain: true, lowConfidence: false };
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
/** Query is the master name with one letter missing. */
function oneCharMissing(query: string, name: string): boolean {
  if (query.length + 1 !== name.length) return false;
  let i = 0;
  while (i < query.length && query[i] === name[i]) i += 1;
  return query.slice(i) === name.slice(i + 1);
}
/** Neighbouring letters swapped, and nothing else. */
function adjacentSwap(query: string, name: string): boolean {
  if (query.length !== name.length || query.length < 2) return false;
  let i = 0;
  while (i < query.length && query[i] === name[i]) i += 1;
  if (i >= query.length - 1) return false;
  if (query[i] !== name[i + 1] || query[i + 1] !== name[i]) return false;
  return query.slice(i + 2) === name.slice(i + 2);
}
/**
 * Typo against the whole name, spaces removed. At least 5 letters.
 * A missing letter or a neighbouring swap. Not a substituted letter.
 * Never used while an exact, phrase, or synonym match exists.
 */
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
/**
 * A master that only shares a generic token (bar, button, input, cta, …)
 * drops out when another word names a different component, or when this
 * master still has a specific word the ask did not say.
 * "radio button" drops Button. "primary button" drops Pay CTA.
 * "login field" keeps Text Field.
 */
export function genericOnlyMiss(
  name: string,
  queryTokens: string[],
  allowClip: boolean,
  componentWord: (token: string) => boolean,
): boolean {
  const nameTokens = tokensOf(name);
  if (!nameTokens.length || !queryTokens.length) return false;
  const matched = nameTokens.filter((token) =>
    queryTokens.some((query) => tokenMatchesName(query, token, allowClip)),
  );
  if (!matched.length) return false;
  // "cta" on Pay CTA is a real name token, even though cta is a synonym of button.
  if (matched.some((token) => !GENERIC_NAME_TOKENS.has(token))) return false;
  const uncovered = queryTokens.filter((query) => {
    if (genericQuery(query)) return false;
    return !nameTokens.some((token) => tokenMatchesName(query, token, allowClip));
  });
  if (!uncovered.length) return false;
  if (uncovered.some((query) => componentWord(query))) return true;
  const unknown = uncovered.filter((query) => !modifierWord(query));
  if (!unknown.length) return false;
  return nameTokens.some(
    (token) =>
      !GENERIC_NAME_TOKENS.has(token) &&
      !queryTokens.some((query) => tokenMatchesName(query, token, allowClip)),
  );
}
/**
 * "primary button" drops Pay CTA when a master is actually named primary.
 * A library whose primary control is named Pay CTA keeps it, because primary
 * is only a variant there. Two real component words ("button and row") both stay.
 */
export function withoutGenericCousins<T extends { node: { name: string }; setName?: string }>(
  entries: T[],
  queryTokens: string[],
  allowClip: boolean,
): T[] {
  const familyOf = (entry: T): string => familyNameOf(entry.node.name, entry.setName);
  const modifiers = queryTokens.filter((token) => modifierWord(token) && !GENERIC_NAME_TOKENS.has(token));
  const covered = modifiers.filter((token) =>
    entries.some((entry) => tokensOf(familyOf(entry)).some((name) => name === token || inflectsName(token, name))),
  );
  if (!covered.length) return entries;
  return entries.filter((entry) => {
    const names = tokensOf(familyOf(entry));
    const misses = covered.some((token) => !names.some((name) => name === token || inflectsName(token, name)));
    if (!misses) return true;
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
export function nameTokenFor(token: string, names: Set<string>, used: Set<string>): string | undefined {
  if (names.has(token) && !used.has(token)) return token;
  for (const name of names) {
    if (!used.has(name) && inflectsName(token, name)) return name;
  }
  return undefined;
}
export function tokenHits(nameHaystack: string, variantText: string, tokens: string[], allowClip: boolean): TokenHits {
  const names = new Set(tokensOf(nameHaystack));
  const variants = new Set(tokensOf(variantText));
  const used = new Set<string>();
  let name = 0;
  let synonym = 0;
  let variant = 0;
  let covered = 0;
  let specific = 0;
  const pending: string[] = [];
  for (const token of tokens) {
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
  for (const token of still) {
    const syn = termsFor(token, allowClip);
    const hit = [...variants].find(
      (part) => !used.has(part) && (part === token || Boolean(syn?.includes(part) && part !== token)),
    );
    if (hit) {
      variant += 1;
      covered += 1;
      used.add(hit);
    }
  }
  return { name, synonym, variant, covered, specific };
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
/** Name / synonym / variant. One name token outranks any amount of context. */
export function lexicalScore(hits: TokenHits, exactName: boolean): number {
  if (exactName) return 1_000_000;
  return hits.name * 100 + hits.synonym * 70 + hits.variant * 40;
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
/**
 * "checkout summary with primary button" → scene + the component ask.
 * "field with icon" keeps the field — icon is a modifier, not the role.
 * "phone number input with country code" keeps the whole ask, because the
 * words after "with" are not a component and the words before are.
 */
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
export function isPrivateMaster(index: GraphIndex, node: GraphNode): boolean {
  if (isPrivateMasterName(node.name)) return true;
  const set = setOf(index, node);
  return Boolean(set && isPrivateMasterName(set.name));
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
/** Name heuristic, plus any master from a team-listed icon library. */
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
/** Why a weak /find hit is weak. Ranking is unchanged; only this sentence changes. */
export function weakMatchWhy(intent: string, name: string): string {
  const asked = tokensOf(intent);
  const named = new Set(tokensOf(name));
  const hit = asked.find((token) => named.has(token));
  const word = hit ?? asked[0] ?? "that";
  return `only the word '${word}' matched; no variant or role matched`;
}
