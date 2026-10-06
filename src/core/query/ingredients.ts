import type { GraphNode } from "@/core/model";
import type { GraphIndex } from "./GraphIndex";
import { nodeFileKey } from "./workspaceMerge";
import { angularText, codeText, type AngularTwin } from "./codeMap";

/**
 * Ingredient card: "what is inside this component?"
 *
 * A composite (a payee picker, a list row) is built from other library parts. The graph already
 * records them as `NESTS` links from each component definition to the instances inside it. This
 * file reads those links, keeps only the parts that sit directly inside (not the parts inside a
 * part), follows the variant actually used, and puts the code component from the code map next to
 * each part. A missing code link is shown as missing. A part known only by its layer name is
 * labelled as a guess. Nothing here ranks, guesses a name, or invents a node.
 */

/** What the host (agentSurface) knows about a master. Kept as hooks so this file has no cycle. */
export interface IngredientHooks {
  retired(node: GraphNode): boolean;
  /** Private part (name starts with `_` or `.`, or its set's name does). */
  internal(node: GraphNode): boolean;
  /** Known only from an instance layer name, not from a real component id. */
  nameGuess(node: GraphNode): boolean;
  /** Code component line (`Button from '@acme/ui'`) for a live part; retired is reported separately. */
  twin(node: GraphNode): { line: string; retired: boolean; angular?: AngularTwin } | undefined;
  /** True when a code map file with usable entries is loaded. */
  codeMap: boolean;
  /** Current part that replaces a retired one, if the library or the code map names one. */
  replacement(node: GraphNode): GraphNode | undefined;
  /** Card label: `Button / Size=Medium` for a variant, the plain name otherwise. */
  cardName(node: GraphNode): string;
}

export type PartStatus = "current" | "retired" | "unconfirmed" | "other-library" | "not-found";

export const PART_GUESS = "guess from layer name, not confirmed";
export const NO_CODE_LINK = "no code link yet";
const NOT_FOUND_WHY = "this part's component is not in the learned files";
const OTHER_LIBRARY_WHY = "lives in another library file that is not learned, so its code link and insides are unknown";
const OTHER_LIBRARY_CODE_WHY = "lives in another library file that is not learned, so its code link is unknown";
/** Where a part's insides were read from when its own copy did not have them (placed on a screen, or anywhere else). */
export const FROM_MAIN_SCREEN = "from the main component, not checked on this screen";
export const FROM_MAIN = "from the main component, not checked on the copy inside this component";
type FromMain = typeof FROM_MAIN | typeof FROM_MAIN_SCREEN;

export interface IngredientPart {
  name: string;
  id?: string;
  figmaNodeId?: string;
  fileKey?: string;
  /** How many times this part sits directly inside. */
  count: number;
  status: PartStatus;
  /** Code component from the code map. `null` = no code link (never guessed). On a retired part this is its old code. */
  code: string | null;
  identity?: typeof PART_GUESS;
  internal?: true;
  /** Every copy of this part is hidden by default (an optional slot). */
  hidden?: true;
  /** Current replacement for a retired part, and its code when the map has it. */
  use?: string;
  useCode?: string;
  /** Angular fields from the code map (selector, module or standalone, import path, inputs, outputs). */
  angular?: AngularTwin;
  useAngular?: AngularTwin;
  /** On a line split off because copies hold different insides: how many copies of this component sit at this level. */
  of?: number;
  /** Copies of this part on the same level hold different insides, so each kind is listed on its own. */
  insidesDiffer?: true;
  /** Set when this part's insides come from its main component because this copy's own insides were not learned. */
  insideFrom?: FromMain;
  why?: string;
  /** Number of parts directly inside this part. Ask for this part to see them. */
  inside?: number;
  /** Names of those parts (first 3), given when copies of this part hold different insides. */
  insideNames?: string[];
  parts?: IngredientPart[];
}

export interface IngredientSummary {
  /** Lines listed. Copies of one component that hold different insides get a line each. */
  parts: number;
  /** Set only when lower than `parts`: how many different components those lines are. */
  differentComponents?: number;
  linkedToCode: number;
  missingCode: number;
  retired: number;
  nameGuessed: number;
  otherLibrary: number;
  notFound: number;
}

export interface IngredientOptions {
  /** `Size=Medium, State=Default` or a variant's own name. Only for a component with variants. */
  variant?: string;
  /** Levels of parts to show. 1 = parts directly inside (default). Max 3. */
  depth?: number;
  /** Size guard (JSON characters). Over it, the card is shown less deep, then with fewer parts, and says so. */
  maxChars?: number;
  /** Parts listed per level. Default 40. */
  limit?: number;
}

const MAX_DEPTH = 3;
const DEFAULT_LIMIT = 40;
const DEF_TYPES = new Set(["COMPONENT_SET", "MAIN_COMPONENT", "VARIANT"]);

const clean = (s: string) => s.replace(/\p{Cc}|[\u2028\u2029]/gu, " ").trim();
const idForms = (value: string) => [...new Set([value, value.replace(/-/g, ":"), value.replace(/:/g, "-")])];

function matchesId(index: GraphIndex, node: GraphNode, raw: string): boolean {
  const forms = new Set(idForms(raw));
  if (node.figmaNodeId && idForms(node.figmaNodeId).some((id) => forms.has(id))) return true;
  const fileKey = nodeFileKey(node, index.graph.fileKey);
  if (!fileKey || !raw.startsWith(fileKey) || raw.length <= fileKey.length + 1) return false;
  const sep = raw[fileKey.length];
  if (sep !== ":" && sep !== "-") return false;
  const rest = raw.slice(fileKey.length + 1);
  return Boolean(node.figmaNodeId && idForms(node.figmaNodeId).some((id) => idForms(rest).includes(id)));
}

type Found =
  | { node: GraphNode }
  | { ambiguous: GraphNode[]; byId: boolean }
  | { screen: GraphNode }
  | undefined;

/** Exact id, Figma id, fileKey:nodeId, or exact name (letter case ignored). Never a fuzzy match. */
function findTarget(index: GraphIndex, ask: string, hooks: IngredientHooks): Found {
  const usable = (n: GraphNode) => DEF_TYPES.has(n.type) || n.type === "COMPONENT_INSTANCE" || n.type === "FRAME" || n.type === "SECTION";
  const direct = index.getNode(ask);
  // A bare node id can exist in two learned files; that is listed, never picked.
  const byIds = direct && usable(direct) ? [direct] : direct ? [] : index.allNodes.filter((n) => usable(n) && matchesId(index, n, ask));
  if (byIds.length > 1) return { ambiguous: byIds, byId: true };
  const byId = byIds[0] ?? direct;
  if (byId) {
    if (DEF_TYPES.has(byId.type) || byId.type === "COMPONENT_INSTANCE") return { node: byId };
    if (byId.type === "FRAME" || byId.type === "SECTION") return { screen: byId };
    return undefined;
  }
  const want = ask.toLowerCase();
  const named = index.allNodes.filter(
    (n) => DEF_TYPES.has(n.type) && (n.name.trim().toLowerCase() === want || hooks.cardName(n).trim().toLowerCase() === want),
  );
  if (!named.length) {
    const screen = index.allNodes.find((n) => (n.type === "FRAME" || n.type === "SECTION") && n.name.trim().toLowerCase() === want);
    return screen ? { screen } : undefined;
  }
  const real = named.filter((n) => !hooks.nameGuess(n));
  const pool = real.length ? real : named;
  // A set or a standalone component wins over a variant that happens to share its name.
  const tops = pool.filter((n) => n.type !== "VARIANT" && !n.componentSetId);
  const picks = tops.length ? tops : pool;
  if (picks.length === 1) return { node: picks[0]! };
  // Same name twice: a single live, local one is the answer; anything else is reported, not guessed.
  const local = picks.filter((n) => !n.isRemote && !hooks.retired(n));
  if (local.length === 1) return { node: local[0]! };
  return { ambiguous: picks, byId: false };
}

function isHiddenUnder(index: GraphIndex, node: GraphNode, stopId: string): boolean {
  let at: GraphNode | undefined = node;
  while (at && at.id !== stopId) {
    if (at.metadata?.["hidden"] === true) return true;
    at = at.parentId ? index.getNode(at.parentId) : undefined;
  }
  return false;
}

/**
 * Instances directly inside a component definition, read from its `NESTS` links.
 * An instance inside another instance belongs to that part, not to this one.
 */
export function directPartInstances(index: GraphIndex, defId: string): GraphNode[] {
  return index.getNestedInstances(defId).filter((instance) => {
    let at = instance.parentId ? index.getNode(instance.parentId) : undefined;
    while (at && at.id !== defId) {
      if (at.type === "COMPONENT_INSTANCE") return false;
      at = at.parentId ? index.getNode(at.parentId) : undefined;
    }
    return Boolean(at);
  });
}

/** Instances directly inside one copy (its own swaps and overrides), by walking its children. */
function instanceChildParts(index: GraphIndex, instanceId: string): GraphNode[] {
  const out: GraphNode[] = [];
  const stack = [...index.getChildren(instanceId)];
  while (stack.length) {
    const node = stack.shift()!;
    if (node.type === "COMPONENT_INSTANCE") out.push(node);
    else stack.push(...index.getChildren(node.id));
  }
  return out;
}

/** A copy's own parts, or undefined when its children were not learned (the source had none for it). */
function copyParts(index: GraphIndex, copy: GraphNode): GraphNode[] | undefined {
  return index.getChildren(copy.id).length ? instanceChildParts(index, copy.id) : undefined;
}

/** The node whose insides describe a set: the asked variant, else the default (first) variant. */
function variantsOf(index: GraphIndex, set: GraphNode): GraphNode[] {
  const ordered = index.getChildren(set.id).filter((n) => n.type === "VARIANT");
  const rest = index.getVariantsOf(set.id).filter((n) => !ordered.includes(n));
  return [...ordered, ...rest];
}

function parseProps(raw: string): Map<string, string> | undefined {
  const pairs = raw.split(",").map((p) => p.split("="));
  if (!pairs.length || pairs.some((p) => p.length !== 2 || !p[0]!.trim() || !p[1]!.trim())) return undefined;
  return new Map(pairs.map(([k, v]) => [k!.trim().toLowerCase(), v!.trim().toLowerCase()]));
}

function propsOf(node: GraphNode): Map<string, string> {
  const props = node.variantProperties && Object.keys(node.variantProperties).length
    ? Object.entries(node.variantProperties)
    : (parseProps(node.name) ? [...parseProps(node.name)!.entries()] : []);
  return new Map(props.map(([k, v]) => [k.trim().toLowerCase(), v.trim().toLowerCase()]));
}

function pickVariant(variants: GraphNode[], ask: string, hooks: IngredientHooks): GraphNode[] {
  const want = ask.trim().toLowerCase();
  const byName = variants.filter((v) => v.name.trim().toLowerCase() === want || hooks.cardName(v).trim().toLowerCase() === want);
  if (byName.length) return byName;
  const asked = parseProps(ask);
  if (!asked) return [];
  return variants.filter((v) => {
    const have = propsOf(v);
    return [...asked].every(([k, val]) => have.get(k) === val);
  });
}

interface Walk {
  index: GraphIndex;
  hooks: IngredientHooks;
  depth: number;
  limit: number;
  real: (node: GraphNode) => GraphNode;
  /** Label for insides read from a main component because the copy's own were not learned. */
  fromMain?: FromMain;
  /** Inside-signature cache: `${instanceId}|${levels}`. */
  sigs?: Map<string, string>;
}

/**
 * A copy of a library part seen from another file is a stub with no insides. When the library itself is
 * learned, the same published component key finds the real part (exact key, one match only; never a name).
 */
function realByKey(index: GraphIndex): (node: GraphNode) => GraphNode {
  let byKey: Map<string, GraphNode | null> | undefined;
  return (node) => {
    if (!node.isRemote) return node;
    const key = node.metadata?.["key"];
    if (typeof key !== "string" || !key.trim()) return node;
    if (!byKey) {
      byKey = new Map();
      for (const n of index.allNodes) {
        const k = n.metadata?.["key"];
        if (!DEF_TYPES.has(n.type) || n.isRemote || typeof k !== "string" || !k.trim()) continue;
        byKey.set(k, byKey.has(k) ? null : n);
      }
    }
    return byKey.get(key) ?? node;
  };
}

function mainKey(index: GraphIndex, real: (n: GraphNode) => GraphNode, instance: GraphNode): { key: string; main?: GraphNode } {
  const seen = index.getMainComponent(instance.id);
  const main = seen ? real(seen) : undefined;
  if (main) return { key: main.id, main };
  const missing = instance.metadata?.["unresolvedMainComponentId"];
  return { key: `missing:${typeof missing === "string" ? missing : instance.name}` };
}

/** Where a part's insides come from: its own copy when learned, else its main component (labelled). */
interface Insides {
  instances: GraphNode[];
  ownerId: string;
  fromMain: boolean;
}

function insidesOf(walk: Walk, main: GraphNode, copy?: GraphNode): Insides {
  const own = copy ? copyParts(walk.index, copy) : undefined;
  if (own && copy) return { instances: own, ownerId: copy.id, fromMain: false };
  const fromDef = directPartInstances(walk.index, main.id);
  return { instances: fromDef, ownerId: main.id, fromMain: Boolean(copy) && fromDef.length > 0 };
}

/** What a copy holds, `levels` deep. Two copies of one part group together only when this matches. */
function insideSig(walk: Walk, instance: GraphNode, levels: number): string {
  if (levels <= 0) return "";
  const cacheKey = `${instance.id}|${levels}`;
  const cached = walk.sigs?.get(cacheKey);
  if (cached !== undefined) return cached;
  const sig = computeSig(walk, instance, levels);
  (walk.sigs ??= new Map()).set(cacheKey, sig);
  return sig;
}

function computeSig(walk: Walk, instance: GraphNode, levels: number): string {
  const { main } = mainKey(walk.index, walk.real, instance);
  if (!main) return "";
  const ins = insidesOf(walk, main, instance);
  const keys = ins.instances.map((i) => `${mainKey(walk.index, walk.real, i).key}(${insideSig(walk, i, levels - 1)})`);
  return `${ins.fromMain ? "main:" : ""}${keys.sort().join(",")}`;
}

interface Group {
  key: string;
  main?: GraphNode;
  layer: string;
  count: number;
  hiddenCount: number;
  /** The copies behind this line; the first one is read for insides (they all hold the same). */
  copies: GraphNode[];
  insidesDiffer?: true;
  /** Copies of this component at this level, across every line it is split into. */
  of?: number;
}

/**
 * Group copies by their component and, `levels` deep, by what they hold.
 * `levels` covers every level the card shows or counts below this one, so one line never hides two kinds of insides.
 */
function groupParts(walk: Walk, instances: GraphNode[], ownerId: string, levels: number): Group[] {
  const groups = new Map<string, Group>();
  for (const instance of instances) {
    const { key: base, main } = mainKey(walk.index, walk.real, instance);
    const key = levels > 0 && main ? `${base}|${insideSig(walk, instance, levels)}` : base;
    const group = groups.get(key) ?? { key, ...(main ? { main } : {}), layer: instance.name, count: 0, hiddenCount: 0, copies: [] };
    group.count += 1;
    group.copies.push(instance);
    if (isHiddenUnder(walk.index, instance, ownerId)) group.hiddenCount += 1;
    groups.set(key, group);
  }
  const list = [...groups.values()];
  const perMain = new Map<string, number>();
  for (const g of list) if (g.main) perMain.set(g.main.id, (perMain.get(g.main.id) ?? 0) + 1);
  const copiesPerMain = new Map<string, number>();
  for (const g of list) if (g.main) copiesPerMain.set(g.main.id, (copiesPerMain.get(g.main.id) ?? 0) + g.count);
  for (const g of list) {
    if (g.main && (perMain.get(g.main.id) ?? 0) > 1) {
      g.insidesDiffer = true;
      g.of = copiesPerMain.get(g.main.id);
    }
  }
  return list;
}

function describePart(walk: Walk, group: Group, level: number, seen: Set<string>): IngredientPart {
  const { index, hooks } = walk;
  const main = group.main;
  const base = {
    count: group.count,
    ...(group.hiddenCount === group.count ? { hidden: true as const } : {}),
    ...(group.insidesDiffer ? { insidesDiffer: true as const, ...(group.of ? { of: group.of } : {}) } : {}),
  };
  if (!main) {
    return { name: clean(group.layer), ...base, status: "not-found", code: null, why: NOT_FOUND_WHY };
  }
  const where = {
    ...(main.figmaNodeId ? { figmaNodeId: main.figmaNodeId } : {}),
    ...(nodeFileKey(main, index.graph.fileKey) ? { fileKey: nodeFileKey(main, index.graph.fileKey) } : {}),
  };
  const name = clean(hooks.cardName(main));
  if (hooks.nameGuess(main)) {
    return { name, ...base, status: "unconfirmed", code: null, identity: PART_GUESS };
  }
  const internal = hooks.internal(main) ? { internal: true as const } : {};
  const ins = insidesOf(walk, main, group.copies[0]);
  let part: IngredientPart;
  if (main.isRemote) {
    if (!ins.instances.length) {
      return { name, id: main.id, ...where, ...base, status: "other-library", code: null, ...internal, why: OTHER_LIBRARY_WHY };
    }
    part = { name, id: main.id, ...where, ...base, status: "other-library", code: null, ...internal, why: OTHER_LIBRARY_CODE_WHY };
  } else {
    const twin = hooks.twin(main);
    const retired = hooks.retired(main) || Boolean(twin?.retired);
    const use = retired ? hooks.replacement(main) : undefined;
    const useTwin = use ? hooks.twin(use) : undefined;
    part = {
      name,
      id: main.id,
      ...where,
      ...base,
      status: retired ? "retired" : "current",
      code: twin ? twin.line : null,
      ...(twin?.angular ? { angular: twin.angular } : {}),
      ...internal,
      ...(use ? { use: clean(hooks.cardName(use)) } : {}),
      ...(useTwin && !useTwin.retired ? { useCode: useTwin.line, ...(useTwin.angular ? { useAngular: useTwin.angular } : {}) } : {}),
    };
  }
  if (ins.instances.length) {
    if (ins.fromMain) part.insideFrom = walk.fromMain ?? FROM_MAIN;
    if (level < walk.depth && !seen.has(main.id)) {
      const next = new Set(seen).add(main.id);
      const groups = groupParts(walk, ins.instances, ins.ownerId, walk.depth - level);
      part.parts = groups.slice(0, walk.limit).map((g) => describePart(walk, g, level + 1, next));
    } else {
      const inner = groupParts(walk, ins.instances, ins.ownerId, 0);
      part.inside = inner.length;
      // Lines that differ only one level down would look the same; name what each one holds.
      if (group.insidesDiffer) {
        part.insideNames = inner.slice(0, 3).map((g) => clean(g.main ? hooks.cardName(g.main) : g.layer));
      }
    }
  }
  return part;
}

function summarize(parts: IngredientPart[]): IngredientSummary {
  const s: IngredientSummary = { parts: parts.length, linkedToCode: 0, missingCode: 0, retired: 0, nameGuessed: 0, otherLibrary: 0, notFound: 0 };
  for (const p of parts) {
    if (p.status === "current") s[p.code ? "linkedToCode" : "missingCode"] += 1;
    else if (p.status === "retired") s.retired += 1;
    else if (p.status === "unconfirmed") s.nameGuessed += 1;
    else if (p.status === "other-library") s.otherLibrary += 1;
    else s.notFound += 1;
  }
  return s;
}

/** Which part families sit inside a variant. A different size of the same part is the same family. */
function signature(walk: Walk, defId: string): string {
  const families = directPartInstances(walk.index, defId).map((i) => {
    const { key, main } = mainKey(walk.index, walk.real, i);
    return main?.componentSetId ?? key;
  });
  return [...new Set(families)].sort().join("|");
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Names often hold commas (`Size=M, State=Default`), so lists use a bar. */
const listed = (names: string[], total: number) => `${names.join(" | ")}${total > names.length ? ` | and ${total - names.length} more` : ""}`;

function noteFor(name: string, s: IngredientSummary, codeMap: boolean, isVariant: boolean, othersHaveParts: boolean): string {
  if (!s.parts) {
    if (isVariant && othersHaveParts) return "This variant has no other library parts inside it.";
    return `${name} has no other library parts inside it. It is a base part.`;
  }
  const bits = [
    s.differentComponents
      ? `${name} is built from ${plural(s.parts, "part")} (${plural(s.differentComponents, "different component")}; some copies hold different insides).`
      : `${name} is built from ${plural(s.parts, "part")}.`,
  ];
  if (codeMap) bits.push(`${s.linkedToCode} linked to code, ${s.missingCode} with ${NO_CODE_LINK}.`);
  else bits.push("No code map yet, so no part has a code link.");
  if (s.retired) bits.push(`${plural(s.retired, "part")} retired.`);
  if (s.nameGuessed) bits.push(`${plural(s.nameGuessed, "part")} known only from a layer name.`);
  if (s.otherLibrary) bits.push(`${plural(s.otherLibrary, "part")} from a library that is not learned.`);
  if (s.notFound) bits.push(`${plural(s.notFound, "part")} not found.`);
  return bits.join(" ");
}

export const INGREDIENTS_NOT_FOUND_HINT = 'Use the exact component name or id. Call recommend "<what you need>" to find the name first.';
const VARIANT_LIST = 8;

type How = "asked" | "used on a screen" | "used inside a component" | "default, first in the set";

export interface IngredientCut {
  maxChars: number;
  depth: number;
  askedDepth: number;
  /** Set when parts per level were also cut. */
  partsPerLevel?: number;
  reason: string;
}

/**
 * Ingredient card for one component, variant, or placed instance. With `maxChars`, a card that is too big is
 * shown one level less deep at a time, then with fewer parts per level, and says what was cut.
 */
export function buildIngredientCard(index: GraphIndex, ask: string, hooks: IngredientHooks, options: IngredientOptions = {}) {
  type Card = ReturnType<typeof buildCardOnce> & { cut?: IngredientCut };
  const first: Card = buildCardOnce(index, ask, hooks, options);
  const max = options.maxChars;
  if (!max || !first.found || JSON.stringify(first).length <= max) return first;
  const asked = Math.min(Math.max(Math.floor(options.depth ?? 1), 1), MAX_DEPTH);
  const fullLimit = Math.max(1, Math.floor(options.limit ?? DEFAULT_LIMIT));
  let depth = asked;
  let limit = fullLimit;
  let card: Card = first;
  while (card.found && JSON.stringify(card).length > max) {
    const wide = widest(card.parts);
    if (depth > 1) depth -= 1;
    else if (wide > 5) limit = Math.max(5, Math.floor(Math.min(limit, wide) / 2));
    else break;
    card = buildCardOnce(index, ask, hooks, { ...options, depth, limit });
  }
  if (!card.found) return card;
  const shown = [depth < asked ? `${depth === 1 ? "only the parts directly inside" : `${depth} levels`} (asked for ${asked})` : "", limit < fullLimit ? `at most ${limit} parts per level` : ""]
    .filter(Boolean)
    .join(", ");
  const still = JSON.stringify(card).length > max;
  const reason = `the full card is over ${max.toLocaleString("en-US")} characters, so it shows ${shown || "what fits"}${still ? " (still over the limit at its smallest)" : ""}. Ask a part by its name or id for its own card${depth > 1 ? `, or ask with depth ${depth}` : ""}.`;
  return {
    ...card,
    cut: { maxChars: max, depth, askedDepth: asked, ...(limit < fullLimit ? { partsPerLevel: limit } : {}), reason },
    note: `${card.note} Cut to stay small: ${reason}`,
  };
}

/** Most parts listed at any one level. */
function widest(parts: IngredientPart[]): number {
  return Math.max(parts.length, ...parts.map((p) => widest(p.parts ?? [])));
}

function buildCardOnce(index: GraphIndex, ask: string, hooks: IngredientHooks, options: IngredientOptions = {}) {
  const name = ask.trim();
  const depth = Math.min(Math.max(Math.floor(options.depth ?? 1), 1), MAX_DEPTH);
  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_LIMIT));
  const walk: Walk = { index, hooks, depth, limit, real: realByKey(index) };
  const where = (n: GraphNode) =>
    hooks.nameGuess(n)
      ? {}
      : {
          ...(n.figmaNodeId ? { figmaNodeId: n.figmaNodeId } : {}),
          ...(nodeFileKey(n, index.graph.fileKey) ? { fileKey: nodeFileKey(n, index.graph.fileKey) } : {}),
        };
  if (!name) return { found: false as const, name, hint: INGREDIENTS_NOT_FOUND_HINT };
  const hit = findTarget(index, name, hooks);
  if (!hit) return { found: false as const, name, hint: `Nothing named "${clean(name)}". ${INGREDIENTS_NOT_FOUND_HINT}` };
  if ("screen" in hit) {
    return { found: false as const, name, hint: `"${clean(hit.screen.name)}" is a screen, not a component. Use resolve on the screen to list what is on it.` };
  }
  if ("ambiguous" in hit) {
    return {
      found: false as const,
      name,
      ambiguous: hit.ambiguous.slice(0, 5).map((n) => ({ name: clean(hooks.cardName(n)), ...where(n) })),
      ...(hit.ambiguous.length > 5 ? { more: hit.ambiguous.length - 5 } : {}),
      hint: hit.byId
        ? "This node id is in more than one learned file. Ask again with fileKey:nodeId."
        : "More than one component has this name. Ask again with its fileKey:nodeId.",
    };
  }

  let target = walk.real(hit.node);
  let instance: GraphNode | undefined;
  let how: How | undefined;
  if (target.type === "COMPONENT_INSTANCE") {
    const main = index.getMainComponent(target.id);
    if (!main) return { found: false as const, name, hint: `That instance's component is not in the learned files. ${INGREDIENTS_NOT_FOUND_HINT}` };
    if (options.variant?.trim()) {
      return {
        found: false as const,
        name,
        hint: `A placed copy always uses its own variant (${clean(hooks.cardName(walk.real(main)))}). Ask without --variant, or ask for the component by name with --variant.`,
      };
    }
    instance = target;
    target = walk.real(main);
    how = index.getOwningComponent(instance.id) ? "used inside a component" : "used on a screen";
    walk.fromMain = how === "used on a screen" ? FROM_MAIN_SCREEN : FROM_MAIN;
  }
  const set = target.type === "COMPONENT_SET" ? target : target.componentSetId ? index.getNode(target.componentSetId) : undefined;
  let variant: GraphNode | undefined = target.type === "VARIANT" || (target.componentSetId && set) ? target : undefined;
  if (variant && !how) how = "asked";
  let otherVariants: { total: number; sameParts: number; differentParts: number; examples: string[]; withParts: number } | undefined;

  if (target.type === "COMPONENT_SET") {
    const variants = variantsOf(index, target);
    if (options.variant?.trim()) {
      const picks = pickVariant(variants, options.variant, hooks);
      if (picks.length !== 1) {
        const shown = (picks.length ? picks : variants);
        return {
          found: false as const,
          name,
          hint: picks.length
            ? `"${clean(options.variant)}" matches ${picks.length} variants. Add more properties, for example ${clean(picks[0]!.name)}.`
            : `No variant of ${clean(target.name)} matches "${clean(options.variant)}".`,
          variants: shown.slice(0, VARIANT_LIST).map((v) => clean(v.name)),
          ...(shown.length > VARIANT_LIST ? { more: shown.length - VARIANT_LIST } : {}),
        };
      }
      variant = picks[0];
      how = "asked";
    } else if (variants.length) {
      variant = variants[0];
      how = "default, first in the set";
    }
    if (variant && variants.length > 1) {
      const mine = signature(walk, variant.id);
      const others = variants.filter((v) => v.id !== variant!.id);
      const differ = others.filter((v) => signature(walk, v.id) !== mine);
      otherVariants = {
        total: others.length,
        sameParts: others.length - differ.length,
        differentParts: differ.length,
        examples: differ.slice(0, 3).map((v) => clean(v.name)),
        withParts: others.filter((v) => directPartInstances(index, v.id).length > 0).length,
      };
    }
  } else if (options.variant?.trim() && !variant) {
    return { found: false as const, name, hint: `${clean(target.name)} has no variants. Ask without --variant.` };
  }

  const owner = set ?? target;
  const scope = variant ?? target;
  const ins: Insides = instance ? insidesOf(walk, scope, instance) : { instances: directPartInstances(index, scope.id), ownerId: scope.id, fromMain: false };
  // Lines group by component and by what each copy holds down to the last level shown or counted.
  const groups = groupParts(walk, ins.instances, ins.ownerId, depth);
  const all = groups.map((g) => describePart(walk, g, 1, new Set([scope.id])));
  const parts = all.slice(0, limit);
  const summary = summarize(all);
  const kinds = new Set(groups.map((g) => g.main?.id ?? g.key)).size;
  if (kinds < summary.parts) summary.differentComponents = kinds;
  const twin = hooks.twin(scope);
  const retired = hooks.retired(scope) || Boolean(twin?.retired);
  const guessed = hooks.nameGuess(scope);
  const remoteStub = scope.isRemote && !groups.length;
  const label = clean(hooks.cardName(owner));
  const ownUse = retired ? hooks.replacement(scope) : undefined;
  const ownUseTwin = ownUse ? hooks.twin(ownUse) : undefined;
  const useCode = ownUseTwin && !ownUseTwin.retired ? ownUseTwin.line : undefined;
  const useAngular = useCode ? ownUseTwin?.angular : undefined;

  const hints: string[] = [];
  if (retired) {
    hints.push(
      `${label} is retired${ownUse ? `. Use ${clean(hooks.cardName(ownUse))} instead${useCode ? ` (code: ${codeText({ line: useCode, angular: useAngular })})` : ""}` : ". There is no current replacement"}.`,
    );
  }
  const readCopy = Boolean(instance) && groups.length > 0 && !ins.fromMain;
  if (guessed && readCopy) {
    hints.push(`${label} itself is a ${PART_GUESS}.`);
    hints.push(noteFor(label, summary, hooks.codeMap, Boolean(variant), Boolean(otherVariants?.withParts)));
  } else if (guessed) hints.push(`${label} itself is a ${PART_GUESS}, so its parts are unknown.`);
  else if (remoteStub) hints.push(`${label} ${OTHER_LIBRARY_WHY}. Learn that library to see its parts.`);
  else hints.push(noteFor(label, summary, hooks.codeMap, Boolean(variant), Boolean(otherVariants?.withParts)));
  if (otherVariants?.differentParts) {
    const n = otherVariants.differentParts;
    hints.push(
      `${plural(n, "other variant")} ${n === 1 ? "uses" : "use"} a different set of parts: ${listed(otherVariants.examples, n)}. Ask with --variant to see one.`,
    );
  }
  // Only say where the parts were read when there are parts to read (a guess or a stub has none).
  if (instance && groups.length) {
    hints.push(
      ins.fromMain
        ? `This copy's own parts were not learned, so these are the main component's parts, not checked on this ${how === "used on a screen" ? "screen" : "copy"}.`
        : "Parts read from this placed copy at every level shown, so swaps made on it are included.",
    );
  }
  if (all.some(function fromMain(p: IngredientPart): boolean { return Boolean(p.insideFrom) || (p.parts ?? []).some(fromMain); })) {
    hints.push(`A part marked "${walk.fromMain ?? FROM_MAIN}" had no insides learned for that copy.`);
  }
  if (all.length > parts.length) hints.push(`${all.length - parts.length} more parts not listed.`);

  return {
    found: true as const,
    component: {
      name: label,
      ...(guessed ? {} : { id: owner.id }),
      ...where(owner),
      type: owner.type,
      status: guessed ? ("unconfirmed" as const) : retired ? ("retired" as const) : remoteStub ? ("other-library" as const) : ("current" as const),
      ...(guessed ? { identity: PART_GUESS } : {}),
      ...(hooks.internal(owner) ? { internal: true as const } : {}),
      ...(ownUse ? { use: clean(hooks.cardName(ownUse)) } : {}),
      ...(useCode ? { useCode } : {}),
      ...(useAngular ? { useAngular } : {}),
    },
    ...(variant && how
      ? { variant: { name: clean(hooks.cardName(variant)), id: variant.id, ...where(variant), how } }
      : {}),
    ...(instance
      ? { instance: { name: clean(instance.name), id: instance.id, ...where(instance), how: how!, ...(ins.fromMain ? { partsFrom: walk.fromMain ?? FROM_MAIN } : {}) } }
      : {}),
    code: twin ? twin.line : null,
    ...(twin?.angular ? { angular: twin.angular } : {}),
    codeMap: hooks.codeMap,
    parts,
    summary,
    ...(otherVariants ? { otherVariants } : {}),
    note: hints.join(" "),
  };
}

export type IngredientCard = ReturnType<typeof buildIngredientCard>;

/* ------------------------------------------------------------------ */

export interface IngredientCoverage {
  codeMap: boolean;
  /** Real, non-private library components (sets and standalone components). */
  components: number;
  /** Components with at least one library part inside any variant. */
  composites: number;
  /** Composites where every part is a known component (no layer-name guess, nothing missing). */
  compositesFullyIdentified: number;
  /** Composite → part links, counted once per composite and part. */
  ingredients: number;
  linkedToCode: number;
  missingCode: number;
  retired: number;
  nameGuessed: number;
  otherLibrary: number;
  notFound: number;
  internal: number;
  /** Distinct part components used inside composites. */
  distinctParts: number;
  distinctPartsLinkedToCode: number;
}

/** Library-wide view of the same cards: how many composites, how many parts, how many linked to code. */
export function buildIngredientCoverage(index: GraphIndex, hooks: IngredientHooks): IngredientCoverage {
  const walk: Walk = { index, hooks, depth: 1, limit: Number.MAX_SAFE_INTEGER, real: realByKey(index) };
  const tops = index.allNodes.filter(
    (n) =>
      (n.type === "COMPONENT_SET" || (n.type === "MAIN_COMPONENT" && !n.componentSetId)) &&
      !n.isRemote &&
      !hooks.nameGuess(n) &&
      !hooks.internal(n),
  );
  const out: IngredientCoverage = {
    codeMap: hooks.codeMap,
    components: tops.length,
    composites: 0,
    compositesFullyIdentified: 0,
    ingredients: 0,
    linkedToCode: 0,
    missingCode: 0,
    retired: 0,
    nameGuessed: 0,
    otherLibrary: 0,
    notFound: 0,
    internal: 0,
    distinctParts: 0,
    distinctPartsLinkedToCode: 0,
  };
  const distinct = new Map<string, boolean>();
  for (const top of tops) {
    const defs = top.type === "COMPONENT_SET" ? variantsOf(index, top) : [top];
    const groups = new Map<string, Group>();
    for (const def of defs) {
      for (const g of groupParts(walk, directPartInstances(index, def.id), def.id, 0)) {
        if (!groups.has(g.key)) groups.set(g.key, g);
      }
    }
    if (!groups.size) continue;
    out.composites += 1;
    const parts = [...groups.values()].map((g) => describePart(walk, g, 1, new Set([top.id])));
    const s = summarize(parts);
    out.ingredients += s.parts;
    out.linkedToCode += s.linkedToCode;
    out.missingCode += s.missingCode;
    out.retired += s.retired;
    out.nameGuessed += s.nameGuessed;
    out.otherLibrary += s.otherLibrary;
    out.notFound += s.notFound;
    out.internal += parts.filter((p) => p.internal).length;
    if (!s.nameGuessed && !s.notFound) out.compositesFullyIdentified += 1;
    for (const [i, g] of [...groups.values()].entries()) {
      const p = parts[i]!;
      const linked = p.status === "current" && Boolean(p.code);
      distinct.set(g.key, (distinct.get(g.key) ?? false) || linked);
    }
  }
  out.distinctParts = distinct.size;
  out.distinctPartsLinkedToCode = [...distinct.values()].filter(Boolean).length;
  return out;
}

/* ------------------------------------------------------------------ */

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "n/a");

function partLine(p: IngredientPart, indent: string, headKey?: string): string[] {
  const code = p.code ? `code: ${codeText({ line: p.code, angular: p.angular })}` : `code: ${NO_CODE_LINK}`;
  const useCode = p.useCode ? ` (code: ${codeText({ line: p.useCode, angular: p.useAngular })})` : "";
  const tags = [
    p.of ? `${p.count} of ${plural(p.of, "copy", "copies")}` : p.count > 1 ? `x${p.count}` : "",
    p.status === "current" ? code : "",
    p.status === "retired"
      ? `retired, ${code}${p.use ? `; use ${p.use}${useCode}` : "; no current replacement"}`
      : "",
    p.status === "unconfirmed" ? PART_GUESS : "",
    p.status === "other-library" ? "from a library that is not learned" : "",
    p.status === "not-found" ? "component not found" : "",
    p.internal ? "internal part" : "",
    p.hidden ? "hidden by default" : "",
    p.insidesDiffer ? "insides differ between copies" : "",
    p.inside
      ? `has ${plural(p.inside, "part")} inside${p.insideNames?.length ? `: ${listed(p.insideNames, p.inside)}` : ""}`
      : "",
    p.insideFrom ? `parts ${p.insideFrom}` : "",
  ].filter(Boolean);
  const at = [p.fileKey && p.fileKey !== headKey ? p.fileKey : "", p.figmaNodeId ?? ""].filter(Boolean).join(" ");
  const head = `${indent}- ${p.name}${at ? ` [${at}]` : ""}${tags.length ? ` (${tags.join("; ")})` : ""}`;
  return [head, ...(p.parts ?? []).flatMap((c) => partLine(c, `${indent}  `, headKey))];
}

const where = (fileKey?: string, id?: string) => {
  const at = [fileKey ?? "", id ?? ""].filter(Boolean).join(" ");
  return at ? ` [${at}]` : "";
};

/** Plain text for the CLI. JSON stays the source of truth. */
export function formatIngredientCard(card: IngredientCard): string {
  if (!card.found) {
    const extra = [
      ...("ambiguous" in card && card.ambiguous ? card.ambiguous.map((a) => `  - ${a.name}${where(a.fileKey, a.figmaNodeId)}`) : []),
      ...("variants" in card && card.variants ? card.variants.map((v) => `  - ${v}`) : []),
      ...("more" in card && card.more ? [`  + ${card.more} more`] : []),
    ];
    return [card.hint, ...extra].join("\n");
  }
  const c = card.component;
  const code = card.code ?? (card.codeMap ? NO_CODE_LINK : "no code map yet");
  const lines = [
    `${c.name}${where(c.fileKey, c.figmaNodeId)}${c.status !== "current" ? ` (${c.status === "unconfirmed" ? PART_GUESS : c.status})` : ""}`,
  ];
  if (card.variant) lines.push(`Variant: ${card.variant.name} (${card.variant.how})`);
  if (card.instance) {
    const i = card.instance;
    lines.push(`Placed copy: ${i.name}${where(i.fileKey && i.fileKey !== c.fileKey ? i.fileKey : undefined, i.figmaNodeId ?? i.id)} (${i.how})`);
  }
  lines.push(
    c.status === "retired"
      ? `Code: ${code} (retired${c.use ? `; use ${c.use}${c.useCode ? `, code: ${codeText({ line: c.useCode, angular: c.useAngular })}` : ""}` : ""})`
      : `Code: ${code}`,
  );
  if (card.angular) lines.push(`Angular: ${angularText(card.angular, true)}`);
  if (card.parts.length) {
    lines.push("Inside it:");
    for (const p of card.parts) lines.push(...partLine(p, "  ", c.fileKey));
  }
  lines.push(card.note);
  return lines.join("\n");
}

export function formatIngredientCoverage(c: IngredientCoverage): string {
  if (!c.composites) {
    return [
      `Ingredients across the library: no component is built from other parts (${plural(c.components, "component")} checked).`,
      c.codeMap ? "" : "No code map yet, so no part has a code link. Add .resolve/code-map.json.",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    `Ingredients across the library: ${c.composites} of ${c.components} components are built from other parts.`,
    `${pct(c.compositesFullyIdentified, c.composites)} of those (${c.compositesFullyIdentified}) have every part identified by its real component.`,
    `${c.ingredients} parts inside them: ${c.linkedToCode} linked to code (${pct(c.linkedToCode, c.ingredients)}), ${c.missingCode} with ${NO_CODE_LINK}, ${c.retired} retired, ${c.nameGuessed} known only from a layer name, ${c.otherLibrary} from a library that is not learned, ${c.notFound} not found.`,
    `${c.distinctParts} different parts in all, ${c.distinctPartsLinkedToCode} linked to code (${pct(c.distinctPartsLinkedToCode, c.distinctParts)}). Internal parts (name starts with _ or .) inside composites: ${c.internal}.`,
    c.codeMap ? "" : "No code map yet, so no part has a code link. Add .resolve/code-map.json.",
  ]
    .filter(Boolean)
    .join("\n");
}
