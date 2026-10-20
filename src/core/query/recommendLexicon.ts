/** Lexical score, phrase aliases, and icon demotion. */
import type { GraphNode } from "@/core/model";
import { setOf } from "@/core/rules/family";
import { collapsedName, isNameInferredMaster, isPrivateMasterName } from "@/core/rules/names";
import { isRetired } from "@/core/rules/retired";
import modifierFile from "@/data/ui-modifiers.json";
import type { GraphIndex } from "./GraphIndex";
import { familyNameOf, MASTER_TYPES, VARIANT_PROP_NAME, variantCardName } from "./masterNames";
import { GENERIC_NAME_TOKENS, tokensOf } from "./queryTokens";
import { allSynonymGroups, extraSynonym, fromIconLibrary, iconShelf, LABEL_FILLER, SYNONYM_GROUPS, SYNONYM_OF } from "./recommendContext";
import type { RecommendContext } from "./recommendSupport";
import { inflectionStems, isScreen } from "./screenInventory";
import { propertyAliases } from "./synonymLayer";
import type { WorkspaceManifest } from "./workspace";
import { componentKeyOf, nodeFileKey } from "./workspaceMerge";

/** Name / synonym / variant / description. One name token outranks any amount of context. */
export const LEXICAL_WEIGHT = { name: 100, synonym: 70, variant: 80, describe: 50 } as const;

const DESCRIBE_META = new Set(["status", "deprecated", "replacedby", "replaced", "legacy"]);

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
const SIZE_OR_A11Y = new Set([
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
const PURPOSE_WORD = new Set(["to", "for", "on", "when"]);

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
function termsFor(token: string, allowClip: boolean): readonly string[] | undefined {
  const stemmed = token.endsWith("ing") || token.endsWith("ed") ? inflectionStems(token).reduce<readonly string[] | undefined>((found, stem) => found ?? SYNONYM_OF.get(stem), undefined) : undefined;
  const base = extraSynonym.get(token) ?? SYNONYM_OF.get(token) ?? stemmed ?? (allowClip ? clippingGroup(token) : undefined);
  const alias = propertyAliases(token);
  if (!alias) return base;
  if (!base) return alias;
  return [...new Set([...base, ...alias])];
}
interface TokenHits {
  name: number;
  synonym: number;
  variant: number;
  describe: number;
  covered: number;
  /** Name or synonym hits that are not a shared word like button, bar, or field. */
  specific: number;
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
function inflectsName(query: string, nameToken: string): boolean {
  if (query === nameToken || query.length < 3 || nameToken.length < 3) return false;
  const [longer, shorter] = query.length >= nameToken.length ? [query, nameToken] : [nameToken, query];
  if (longer.endsWith("ies") && shorter.endsWith("y") && longer.slice(0, -3) === shorter.slice(0, -1)) return true;
  if (!longer.startsWith(shorter)) return false;
  const rest = longer.slice(shorter.length);
  return rest === "s" || rest === "es" || rest === "ing" || rest === "ed";
}
/** One letter off a core noun, a missing letter, or two neighbours swapped. Not an unrelated extra ending. */
function tokenTypo(query: string, name: string): boolean {
  if (query.length < 5 || name.length < 5 || query === name) return false;
  const noun = (word: string) => PLAIN_NOUN.has(word);
  if (query.length === name.length) {
    if (adjacentSwap(query, name)) return true;
    return name === "button" && query[0] === name[0] && [...query].filter((ch, i) => ch !== name[i]).length === 1;
  }
  const [shorter, longer] = query.length < name.length ? [query, name] : [name, query];
  if (shorter.length + 1 !== longer.length) return false;
  let i = 0;
  while (i < shorter.length && shorter[i] === longer[i]) i += 1;
  if (i === 0) return false;
  if (i !== shorter.length) return shorter.slice(i) === longer.slice(i + 1);
  return noun(longer) && !SYNONYM_OF.has(shorter) && !noun(shorter);
}
/** A stopword that is itself a component synonym stays. "find box" keeps find. */
export function withSynonymStopwords(text: string, tokens: string[]): string[] {
  const raw = text.toLowerCase().split(/[^a-z0-9]+/).filter((part) => part.length > 1);
  const extra = raw.filter((part) => !tokens.includes(part) && SYNONYM_OF.has(part));
  return extra.length ? [...new Set([...extra, ...tokens])] : tokens;
}
export function tokenMatchesName(query: string, nameToken: string, allowClip = false): boolean {
  if (query === nameToken || inflectsName(query, nameToken)) return true;
  if (synonymIn(query, new Set([nameToken]), allowClip)) return true;
  return tokenTypo(query, nameToken);
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
/** Words after to/for/on/when are why the part is used, not a different component. */
export function purposeTailTokens(ask: string): Set<string> {
  const parts = ask.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const at = parts.findIndex((part) => PURPOSE_WORD.has(part));
  if (at < 0) return new Set();
  return new Set(tokensOf(parts.slice(at + 1).join(" ")));
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
  const tail = purposeTailTokens(ask);
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
    if (!token || !keepsCompany(token, content[i - 1], exempt)) {
      if (tail.has(token)) continue;
      return { outOfDomain: true, lowConfidence: false };
    }
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
function adjacentSwap(query: string, name: string): boolean {
  if (query.length !== name.length || query.length < 2) return false;
  let i = 0;
  while (i < query.length && query[i] === name[i]) i += 1;
  if (i >= query.length - 1) return false;
  if (query[i] !== name[i + 1] || query[i + 1] !== name[i]) return false;
  return query.slice(i + 2) === name.slice(i + 2);
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
  const bar = nameTokens.some((token) => token === "bar" || token === "header" || token === "footer");
  if (bar && uncovered.every((query) => query === "nav" || query === "navigation")) return false;
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
  if (CONTROL_NOUN.has(token)) return true;
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
      next.push({ ...entry, weak: false });
      continue;
    }
    const control = content.some((token) => controlNoun(token) && nounHit(token, names, allowClip));
    const navBar = unmatched.every((token) => token === "nav" || token === "navigation") && [...names].some((token) => token === "bar" || token === "header" || token === "footer");
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

export const PLAIN_NOUN = new Set(["button", "cta", "action", "icon", "card", "banner", "dropdown", "nav", "navigation", "field", "input", "bar", "menu", "modal", "dialog", "badge", "tab", "link", "chip", "tag", "switch", "checkbox", "radio", "toast", "alert"]);

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
export function plainNounOverComposite<T extends { node: { name: string }; setName?: string }>(
  entries: T[],
  queryTokens: string[],
): T[] {
  const nouns = queryTokens.filter((token) => plainNounToken(token));
  if (nouns.length !== 1 || entries.length < 2) return entries;
  const noun = nouns[0]!;
  const rest = queryTokens.filter((token) => token !== noun);
  if (rest.some((token) => !modifierWord(token) && !SIZE_OR_A11Y.has(token) && !SHAPE_WORD.has(token))) return entries;
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
  ask: string,
  componentWord: (token: string) => boolean,
): T[] {
  const purpose = purposeTailTokens(ask);
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
    if (!used.has(name) && (inflectsName(token, name) || tokenTypo(token, name))) return name;
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
