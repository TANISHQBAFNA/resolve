import type { GraphNode } from "@/core/model";
import type { GraphIndex } from "./GraphIndex";
import { angularText, bindingName, codeText, type AngularTwin, type Twin } from "./codeMap";
import type { IngredientPart } from "./ingredients";
import type { FilledRecipe, Recipe } from "./recipes";
import type { ContextPack } from "./contextPacks";
import type { SociProposal } from "./sock";
import { nodeFileKey } from "./workspaceMerge";

/**
 * Handoff sheet (step 4): for a designed screen, one sheet a developer can build from.
 * Recipe slots, every component placed on the screen with its Figma id and code twin, the parts inside each
 * one (ingredients), suggested inputs from Figma variant properties, the verify result, approved decisions,
 * and open questions. Never guesses code: a component with no code-map entry says "unmapped".
 *
 * Gates (production, the default):
 * - a retired component anywhere on the screen refuses the handoff (no draft escape), including a retired part read
 *   from the main component of a copy whose insides are not learned;
 * - a component known only from its layer name refuses it: "MCP metadata insufficient for component X. Use Figma REST or design_context.";
 * - a copy whose component is in no learned file refuses it (kind "not-found": learn the library that holds it, or replace the copy).
 * Draft (`--draft`, MCP `allowWeak`) allows name guesses and missing components, labels them (`identity: "name-guess"` or
 * `"not-found"`), and sets `draft: true`. A component from a library file that is not learned is `status: "other-library"`:
 * no Figma id of this file, no code link, never blocks.
 */

export const HANDOFF_VERSION = 1;
export const NAME_GUESS = "name-guess";
export const SUGGESTED = "suggested from the Figma variant properties; check the values against the code";
export const SCREEN_TYPES = new Set(["FRAME", "SECTION", "GROUP", "AUTO_LAYOUT_CONTAINER"]);
const clean = (s: string) => s.replace(/\p{Cc}|[\u2028\u2029]/gu, " ").trim();

/** What the host (agentSurface) knows. Hooks keep this file free of an import cycle. */
export interface HandoffHooks {
  /** A remote stub's learned library component (same published key), else the node itself. */
  real?(node: GraphNode): GraphNode;
  retired(node: GraphNode): boolean;
  nameGuess(node: GraphNode): boolean;
  twin(node: GraphNode): Twin | undefined;
  codeMap: boolean;
  /** Current replacement of a retired component, and its code twin when mapped. */
  replacement(node: GraphNode): { name: string; guess: boolean; twin?: Twin } | undefined;
  /** Card name, e.g. `Button / Variant=Primary, Size=Medium`. */
  cardName(node: GraphNode): string;
  /** Ingredient card for one placed copy (`fileKey:figmaNodeId`). */
  ingredient(ask: string, depth: number, maxChars?: number): {
    found: boolean;
    parts?: IngredientPart[];
    instance?: { partsFrom?: string };
    summary?: { nameGuessed: number };
    cut?: { reason: string };
  };
  /** verify_frame on this screen, or on a component list (a screen that is one copy: verify reads frames, not copies). */
  verify(frameId: string, components?: string[]): VerifyLike;
  /** A frame by graph id, Figma id, `fileKey:id`, or name. */
  frame(ask: string): { node?: GraphNode; others?: number; notScreen?: GraphNode; fuzzy?: boolean; message?: string };
  fillRecipe?(recipe: Recipe): FilledRecipe;
}

export interface VerifyLike {
  pass: boolean;
  approved?: number;
  deprecated?: Array<{ name: string; figmaNodeId?: string; fileKey?: string }>;
  invents?: Array<{ name: string; reason?: string; figmaNodeId?: string }>;
  unresolved?: Array<{ name: string; reason?: string }>;
  retired?: string[] | string;
  textChecked?: unknown;
  result?: string;
  hint?: string;
}

export interface HandoffDecisionInput {
  proposal: SociProposal;
  who: string;
  when: string;
}

export interface HandoffOptions {
  /** Allow name-guess identities (labelled). Retired components still refuse. */
  draft?: boolean;
  /** Recipe id or intent. Default: the recipe whose name or alias matches the screen name, if any. */
  recipe?: string;
  recipes?: Recipe[];
  matchRecipe?: (recipes: Recipe[], query: string) => Recipe | undefined;
  context?: ContextPack;
  /** Approved SOCI decisions (with who / when from the audit log). Only those about this screen are shown. */
  decisions?: HandoffDecisionInput[];
  /** Levels of parts per component (1-3). Default 3. */
  depth?: number;
  /** Size guard per ingredient card (MCP). */
  maxCharsPerCard?: number;
}

export interface HandoffPart {
  name: string;
  fileKey?: string;
  figmaNodeId?: string;
  count: number;
  status: IngredientPart["status"];
  code: string | null;
  angular?: AngularTwin;
  identity?: typeof NAME_GUESS;
  use?: string;
  useCode?: string;
  insideFrom?: string;
  inside?: number;
  parts?: HandoffPart[];
}

export interface InputHint {
  input: string;
  value: string;
  /** `Variant=Primary` */
  from: string;
}

export interface HandoffComponent {
  name: string;
  variant?: string;
  fileKey?: string;
  figmaNodeId?: string;
  count: number;
  /** Placed copies on this screen (Figma ids, first 10; `count` has them all). */
  copies: string[];
  /** `not-found`: the copy's component is in no learned file (draft only). */
  identity: "confirmed" | typeof NAME_GUESS | "not-found";
  /** `other-library`: from a library file that is not learned (no Figma id of this file, code unknown). */
  status: "current" | "retired" | "not-found" | "other-library";
  slot?: string;
  /** Code from the code map, "unmapped" (never guessed), or "unknown" when its component is not in the learned files (other library, not found). */
  code: string;
  angular?: AngularTwin;
  /** Figma variant properties of the placed variant. */
  figmaProps?: Record<string, string>;
  /** Angular inputs whose name matches a Figma property (suggested values). */
  inputs?: InputHint[];
  /** One-line Angular template (suggested). */
  template?: string;
  /** Other values each Figma property can take on this component (the placed value is left out; despite the name, these are the OTHER states to build). */
  states?: Record<string, string[]>;
  use?: string;
  partsFrom?: string;
  /** Set when the parts list was cut to stay under the size guard (MCP). */
  partsCut?: string;
  parts: HandoffPart[];
}

export interface HandoffIngredient {
  name: string;
  fileKey?: string;
  figmaNodeId?: string;
  status: "mapped" | "unmapped" | "retired" | typeof NAME_GUESS | "other-library" | "not-found";
  code: string;
  angular?: AngularTwin;
  usedBy: string[];
  /** Screens that use it (pack only). */
  screens?: string[];
}

export interface HandoffSlot {
  role: string;
  required: boolean;
  status: string;
  component?: { name: string; fileKey?: string; figmaNodeId?: string };
  /** True when a copy is placed on the screen for this slot (`state` "placed"). A part inside a placed component is not `onScreen`; see `state`. */
  onScreen: boolean;
  /** Only for a slot with a bound component. `placed`: a copy placed on the screen (or directly in a whole-screen copy). `inside`: only a part of a placed component (`insideOf` names it). `missing`: neither. One copy fills at most one slot. */
  state?: "placed" | "inside" | "missing";
  insideOf?: string;
  /** `missing` because the only placed copies of its component already fill another slot. */
  sharedWith?: string;
}

export interface HandoffDecision {
  proposalId: string;
  type: string;
  summary: string;
  who: string;
  when: string;
  why: string;
}

export interface HandoffScreen {
  screen: { name: string; fileKey?: string; figmaNodeId?: string; link?: string; id: string };
  context?: { id?: string; product?: string; journey?: string; domain?: string; audience?: string; accessibility?: string; a11y?: string; density?: string };
  /** `matchedBy: "screen name"` when Resolve picked the recipe from the screen's name (a match, not a fact); `"asked"` with --recipe. */
  recipe: {
    id: string;
    title: string;
    matchedBy: "asked" | "screen name";
    slots: HandoffSlot[];
    /** `covered` counts `placed` and `inside` slots out of all `slots`. */
    coverage: { slots: number; covered: number; placed: number; inside: number };
  } | null;
  /** Set when the frame was found by a loose name match, not its exact name or id. */
  matchedFrame?: string;
  recipeNote?: string;
  components: HandoffComponent[];
  ingredients: HandoffIngredient[];
  verify: { pass: boolean; approved: number; retired: string[]; invents: string[]; unresolved: string[]; checked?: "components"; note?: string };
  decisions: HandoffDecision[];
  openQuestions: string[];
  summary: {
    components: number;
    copies: number;
    linkedToCode: number;
    unmapped: number;
    parts: number;
    partsLinkedToCode: number;
    nameGuesses: number;
    /** Components and parts whose component is in no learned file. */
    notFound: number;
    /** Components and parts from a library file that is not learned. */
    otherLibrary: number;
  };
  note?: string;
}

export interface HandoffRefusal {
  screen: string;
  figmaNodeId?: string;
  /** `not-found` with a component: the copy's component is in no learned file; without: the frame was not found. */
  kind: "retired" | "identity" | "not-found";
  component?: string;
  message: string;
}

export type HandoffPack =
  | {
      ok: true;
      handoff: typeof HANDOFF_VERSION;
      draft: boolean;
      codeMap: boolean;
      screens: HandoffScreen[];
      ingredients: HandoffIngredient[];
    }
  | {
      ok: false;
      handoff: typeof HANDOFF_VERSION;
      draft: boolean;
      refused: HandoffRefusal[];
      hint: string;
    };

const slotCoverage = (slots: HandoffSlot[]) => {
  const placed = slots.filter((s) => s.state === "placed").length;
  const inside = slots.filter((s) => s.state === "inside").length;
  return { slots: slots.length, covered: placed + inside, placed, inside };
};
const fid = (index: GraphIndex, n: GraphNode) => nodeFileKey(n, index.graph.fileKey);
const where = (fileKey?: string, id?: string) => [fileKey, id].filter(Boolean).join(" ");
export const figmaLink = (fileKey?: string, id?: string) =>
  fileKey && id && /^[A-Za-z0-9]{2,40}$/.test(fileKey) && /^\d+[:-]\d+$/.test(id) ? `https://www.figma.com/design/${fileKey}/?node-id=${id.replace(":", "-")}` : undefined;
const setOf = (index: GraphIndex, n: GraphNode) =>
  n.type === "COMPONENT_SET" ? n : n.componentSetId ? index.getNode(n.componentSetId) : undefined;
const familyKey = (index: GraphIndex, n: GraphNode) => setOf(index, n)?.id ?? n.id;

/** Instances placed on the screen itself (not the parts inside them). A screen that is one copy is its own single placed copy. */
function placedCopies(index: GraphIndex, frameId: string): GraphNode[] {
  const self = index.getNode(frameId);
  if (self?.type === "COMPONENT_INSTANCE") return [self];
  const out: GraphNode[] = [];
  const walk = (parentId: string) => {
    for (const child of index.getChildren(parentId)) {
      if (child.type === "COMPONENT_INSTANCE") out.push(child);
      else walk(child.id);
    }
  };
  walk(frameId);
  return out;
}

/** Copies placed directly on the screen: the placed copies, and for a screen that is one copy, the copies directly inside it too. */
function directCopies(index: GraphIndex, frame: GraphNode): GraphNode[] {
  if (frame.type !== "COMPONENT_INSTANCE") return placedCopies(index, frame.id);
  const out: GraphNode[] = [frame];
  const walk = (parentId: string) => {
    for (const child of index.getChildren(parentId)) {
      if (child.type === "COMPONENT_INSTANCE") out.push(child);
      else walk(child.id);
    }
  };
  walk(frame.id);
  return out;
}

/** Lowercase with dashes, keeping letters and digits of any script (`Größe Ärger` -> `größe-ärger`). */
const kebab = (v: string) => v.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
const norm = (v: string) => v.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** Variant=Primary -> variant="primary" when the Angular entry lists an input named like the property. */
export function inputHints(props: Record<string, string> | undefined, angular: AngularTwin | undefined): InputHint[] {
  if (!props || !angular?.inputs?.length) return [];
  const hints: InputHint[] = [];
  for (const [prop, raw] of Object.entries(props)) {
    const input = angular.inputs.map(bindingName).find((i) => norm(i) === norm(prop));
    if (!input) continue;
    const bool = /^(true|false|yes|no|on|off)$/i.test(raw.trim());
    const value = bool ? String(/^(true|yes|on)$/i.test(raw.trim())) : kebab(raw);
    if (!value) continue;
    hints.push({ input, value, from: `${prop}=${raw}` });
  }
  return hints;
}

/** Attributes a selector pins, e.g. `acme-button[variant="primary"]` -> variant: primary. */
export function selectorPins(angular: AngularTwin | undefined): Map<string, string> {
  const pins = new Map<string, string>();
  const first = angular?.selector.split(",")[0]!.trim() ?? "";
  for (const a of first.matchAll(/\[([^\]=]+)=(?:"([^"]*)"|'([^']*)'|([^\]]*))\]/g)) pins.set(a[1]!, a[2] ?? a[3] ?? a[4] ?? "");
  return pins;
}

/** `<acme-button variant="primary" (pressed)="…"></acme-button>` for an element selector; undefined for attribute-only or class selectors. */
export function angularTemplate(angular: AngularTwin | undefined, hints: InputHint[], drop: string[] = []): string | undefined {
  if (!angular) return undefined;
  const first = angular.selector.split(",")[0]!.trim();
  const m = /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*)((?:\[[^\]]+\])*)$/.exec(first);
  if (!m) return undefined;
  const el = m[1]!;
  const attrs = [...m[2]!.matchAll(/\[([^\]=]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g)].filter((a) => !drop.includes(a[1]!)).map((a) => {
    const value = a[2] ?? a[3] ?? a[4];
    return value === undefined ? a[1]! : `${a[1]}="${value}"`;
  });
  if (!el.includes("-") && !attrs.length) return undefined;
  const ins = (angular.inputs ?? []).map(bindingName);
  const outs = (angular.outputs ?? []).map(bindingName);
  const bits: string[] = [...attrs];
  // An attribute the selector already sets (`acme-button[variant="primary"]`) is written once, as the selector has it.
  const used = new Set<string>(attrs.map((a) => a.split("=")[0]!));
  for (const h of hints) {
    if (used.has(h.input)) continue;
    used.add(h.input);
    bits.push(/^(true|false)$/.test(h.value) ? `[${h.input}]="${h.value}"` : `${h.input}="${h.value}"`);
  }
  for (const i of ins) {
    if (used.has(i)) continue;
    used.add(i);
    if (outs.includes(`${i}Change`)) {
      bits.push(`[(${i})]="…"`);
      used.add(`${i}Change`);
    } else bits.push(`[${i}]="…"`);
  }
  for (const o of outs) if (!used.has(o)) bits.push(`(${o})="…"`);
  const shown = bits.slice(0, 8);
  return `<${el}${shown.length ? ` ${shown.join(" ")}` : ""}${bits.length > shown.length ? " …" : ""}></${el}>`;
}

function trimParts(parts: IngredientPart[] | undefined): HandoffPart[] {
  return (parts ?? []).map((p) => ({
    name: clean(p.name),
    ...(p.fileKey ? { fileKey: p.fileKey } : {}),
    ...(p.figmaNodeId ? { figmaNodeId: p.figmaNodeId } : {}),
    count: p.count,
    status: p.status,
    code: p.code,
    ...(p.angular ? { angular: p.angular } : {}),
    ...(p.identity || p.status === "unconfirmed" ? { identity: NAME_GUESS } : {}),
    ...(p.use ? { use: p.use } : {}),
    ...(p.useCode ? { useCode: p.useCode } : {}),
    ...(p.insideFrom ? { insideFrom: p.insideFrom } : {}),
    ...(p.inside && !p.parts?.length ? { inside: p.inside } : {}),
    ...(p.parts?.length ? { parts: trimParts(p.parts) } : {}),
  }));
}

const partStatus = (p: HandoffPart): HandoffIngredient["status"] =>
  p.status === "retired"
    ? "retired"
    : p.status === "unconfirmed"
      ? NAME_GUESS
      : p.status === "other-library"
        ? "other-library"
        : p.status === "not-found"
          ? "not-found"
          : p.code
            ? "mapped"
            : "unmapped";

/** Other values each variant property takes on this component (the placed value left out). */
function statesOf(index: GraphIndex, node: GraphNode): Record<string, string[]> | undefined {
  const set = setOf(index, node);
  if (!set) return undefined;
  const values = new Map<string, Set<string>>();
  for (const v of index.getVariantsOf(set.id)) {
    for (const [k, val] of Object.entries(v.variantProperties ?? {})) {
      if (!values.has(k)) values.set(k, new Set());
      values.get(k)!.add(val);
    }
  }
  const out: Record<string, string[]> = {};
  for (const [k, vals] of values) {
    if (vals.size < 2) continue;
    const others = [...vals].filter((v) => v !== node.variantProperties?.[k]);
    if (others.length) out[k] = others;
  }
  return Object.keys(out).length ? out : undefined;
}

function decisionsFor(
  input: HandoffDecisionInput[] | undefined,
  frame: GraphNode,
  recipeId: string | undefined,
  familyIds: Set<string>,
  index: GraphIndex,
): HandoffDecision[] {
  if (!input?.length) return [];
  const famOf = (id?: string) => {
    if (!id) return undefined;
    const n = index.getNode(id);
    return n ? familyKey(index, n) : id;
  };
  return input
    .filter(({ proposal: p }) => {
      const evidence = Array.isArray(p.evidence) ? p.evidence : [];
      const onScreen = evidence.some(
        (e) =>
          e.frameId === frame.id ||
          e.screenId === frame.id ||
          (frame.figmaNodeId && (e.frameId === frame.figmaNodeId || e.screenId === frame.figmaNodeId)) ||
          (e.screenName && e.screenName.trim().toLowerCase() === frame.name.trim().toLowerCase()),
      );
      const recipe = Boolean(recipeId) && (p.scope?.recipeId === recipeId || p.suggestedRecipe?.recipeId === recipeId);
      const ids = [
        p.scope?.masterId,
        p.suggestedRule?.masterId,
        p.suggestedRule?.overMasterId,
        p.suggestedRecipe?.masterId,
        p.suggestedVariant?.masterId,
        p.suggestedDeprecation?.masterId,
      ];
      const component = ids.some((id) => {
        const fam = famOf(id);
        return fam ? familyIds.has(fam) : false;
      });
      return onScreen || recipe || component;
    })
    .map(({ proposal: p, who, when }) => ({
      proposalId: p.id,
      type: p.type ?? "require-rule",
      summary: clean(p.summary),
      who: clean(who),
      when,
      why: clean(p.decisionNote ?? p.summary),
    }));
}

type Built = { ok: true; sheet: HandoffScreen } | { ok: false; refused: HandoffRefusal[] };

function buildScreen(index: GraphIndex, ask: string, hooks: HandoffHooks, options: HandoffOptions): Built {
  if (!clean(ask)) return { ok: false, refused: [{ screen: "", kind: "not-found", message: "Give a frame name or Figma id (the frame name was empty)." }] };
  const found = hooks.frame(ask);
  if (!found.node) {
    const message = found.message
      ? found.message
      : found.notScreen
        ? `"${clean(ask)}" is a ${found.notScreen.type}, not a screen. Ask for a frame; for one component use resolve ingredients.`
        : `No frame named "${clean(ask)}" in the learned files.`;
    return { ok: false, refused: [{ screen: clean(ask), kind: "not-found", message }] };
  }
  const frame = found.node;
  const frameKey = fid(index, frame);
  const mainOf = (copy: GraphNode) => {
    const main = index.getMainComponent(copy.id);
    return main && hooks.real ? hooks.real(main) : main;
  };
  /** The main component id a REST copy points at when that component is in no learned file. */
  const missingOf = (copy: GraphNode) => {
    const id = copy.metadata?.["unresolvedMainComponentId"];
    return typeof id === "string" && id.trim() ? clean(id) : undefined;
  };
  const familyName = (main: GraphNode) => clean(setOf(index, main)?.name ?? main.name);
  const screenName = clean(frame.name);
  const draft = Boolean(options.draft);
  const refused: HandoffRefusal[] = [];
  const depth = Math.min(Math.max(Math.floor(options.depth ?? 3), 1), 3);
  const isCopy = (n: GraphNode) => n.type === "COMPONENT_INSTANCE";

  // Gates look at every copy on the screen, including the copies inside placed components.
  // Every copy under the screen: the NESTS links plus a walk of the tree (a screen that is one copy has no NESTS of its own).
  const nested = [...new Set([...(isCopy(frame) ? [frame] : []), ...index.getNestedInstances(frame.id), ...index.getDescendants(frame.id).filter(isCopy)])];
  const seenRetired = new Set<string>();
  const seenGuess = new Set<string>();
  const seenMissing = new Set<string>();
  const retiredRefusal = (main: GraphNode, where_: string, inLibrary = false) => {
    const key = familyKey(index, main);
    if (seenRetired.has(key)) return;
    seenRetired.add(key);
    const use = hooks.replacement(main);
    const family = familyName(main);
    const useBit = use ? ` Replace it with ${clean(use.name)}${use.guess ? " (closest current part, a guess)" : ""}${use.twin ? ` (code: ${codeText(use.twin)})` : ""}` : " It has no current replacement; ask the design team";
    refused.push({
      screen: screenName,
      figmaNodeId: frame.figmaNodeId,
      kind: "retired",
      component: family,
      message: `Retired component ${family} ${where_}.${useBit}${inLibrary ? " in the library component" : ""}, then run handoff again. A draft does not skip this.`,
    });
  };
  for (const copy of nested) {
    const main = mainOf(copy);
    const name = main ? clean(hooks.cardName(main)) : clean(copy.name);
    if (main && hooks.retired(main)) {
      retiredRefusal(main, `is on this screen (copy ${where(fid(index, copy), copy.figmaNodeId)})`);
    } else if (!main && missingOf(copy)) {
      if (draft) continue;
      const missing = missingOf(copy)!;
      if (seenMissing.has(missing)) continue;
      seenMissing.add(missing);
      refused.push({
        screen: screenName,
        figmaNodeId: frame.figmaNodeId,
        kind: "not-found",
        component: name,
        message: `The component of ${name} (copy ${where(fid(index, copy), copy.figmaNodeId)}) is not in the learned library: its main component ${missing} is in no learned file. Learn the library file that holds it, or replace the copy, then run handoff again. (Or pass --draft for a labelled draft that is not for build.)`,
      });
    } else if ((!main || hooks.nameGuess(main)) && !draft) {
      const key = main ? familyKey(index, main) : `layer:${name.toLowerCase()}`;
      if (seenGuess.has(key)) continue;
      seenGuess.add(key);
      refused.push({
        screen: screenName,
        figmaNodeId: frame.figmaNodeId,
        kind: "identity",
        component: name,
        message: `MCP metadata insufficient for component ${name}. Use Figma REST or design_context. (Or pass --draft for a labelled draft that is not for build.)`,
      });
    }
  }
  // A copy with no insides of its own shows the parts of its main component; a retired part there refuses too.
  const seenDef = new Set<string>();
  const walkDefinition = (main: GraphNode, top: GraphNode) => {
    if (seenDef.has(main.id)) return;
    seenDef.add(main.id);
    const inner = [...new Set([...index.getNestedInstances(main.id), ...index.getDescendants(main.id).filter(isCopy)])];
    for (const c of inner) {
      const m = mainOf(c);
      if (!m && missingOf(c) && !draft) {
        const missing = missingOf(c)!;
        if (!seenMissing.has(missing)) {
          seenMissing.add(missing);
          refused.push({
            screen: screenName,
            figmaNodeId: frame.figmaNodeId,
            kind: "not-found",
            component: clean(c.name),
            message: `The component of ${clean(c.name)} (copy ${where(fid(index, c), c.figmaNodeId)}) is not in the learned library: its main component ${missing} is in no learned file. It is inside ${familyName(main)} [${where(fid(index, main), main.figmaNodeId)}] (read from its main component, because the copy ${where(fid(index, top), top.figmaNodeId)} on this screen has no learned insides of its own). Learn the library file that holds it, or replace the part, then run handoff again. (Or pass --draft for a labelled draft that is not for build.)`,
          });
        }
        continue;
      }
      if (!m || m.isRemote) continue;
      if (hooks.retired(m)) {
        retiredRefusal(
          m,
          `is inside ${familyName(main)} [${where(fid(index, main), main.figmaNodeId)}] (read from its main component, because the copy ${where(fid(index, top), top.figmaNodeId)} on this screen has no learned insides of its own)`,
          true,
        );
      } else if (!index.getChildren(c.id).length) walkDefinition(m, top);
    }
  };
  for (const copy of nested) {
    const main = mainOf(copy);
    if (main && !main.isRemote && !hooks.retired(main) && !index.getChildren(copy.id).length) walkDefinition(main, copy);
  }
  if (refused.length) return { ok: false, refused };

  // Components placed on the screen, one entry per main component (variant).
  const groups = new Map<string, { main?: GraphNode; copies: GraphNode[] }>();
  for (const copy of placedCopies(index, frame.id)) {
    const main = mainOf(copy);
    const key = main ? main.id : `layer:${missingOf(copy) ?? ""}:${clean(copy.name).toLowerCase()}`;
    const g = groups.get(key) ?? { main, copies: [] };
    g.copies.push(copy);
    groups.set(key, g);
  }

  // Recipe and its slots. From the screen name only on a strong match (exact id, title or alias); a loose match is named, not used.
  const recipes = options.recipes ?? [];
  const exactly = (r: Recipe | undefined, q: string) => {
    const n = q.trim().toLowerCase();
    return Boolean(r && (r.id.toLowerCase() === n || r.title.toLowerCase() === n || r.intentAliases.some((a) => a.trim().toLowerCase() === n)));
  };
  const byName = options.recipe ? undefined : options.matchRecipe?.(recipes, frame.name);
  const recipe = options.recipe ? options.matchRecipe?.(recipes, options.recipe) : exactly(byName, frame.name) ? byName : undefined;
  let recipeNote: string | undefined;
  if (options.recipe && !recipe) recipeNote = `No recipe matched "${clean(options.recipe)}". Run resolve recipe list.`;
  else if (!recipe && byName) recipeNote = `No recipe has this screen's name. The closest by name is ${clean(byName.title)} (${byName.id}), a loose match, so it is not checked; pass --recipe ${byName.id} to check the screen against it.`;
  else if (!recipe) recipeNote = "No recipe matched this screen's name. Pass --recipe and a recipe id (see resolve recipe list) to check the screen against one.";
  const filled = recipe && hooks.fillRecipe ? hooks.fillRecipe(recipe) : undefined;
  // Slots and decisions count components placed on the screen itself, not parts inside other components.
  const placedFamilies = new Map<string, GraphNode>();
  for (const copy of directCopies(index, frame)) {
    const main = mainOf(copy);
    if (main) placedFamilies.set(familyKey(index, main), main);
  }
  // Each slot is filled by one copy: a placed copy, else a part inside a placed component, else it is missing.
  const hostsOf = (() => {
    const all = directCopies(index, frame);
    return [...all.filter((c) => c.id !== frame.id), ...all.filter((c) => c.id === frame.id)];
  })();
  const innerCopies = (copy: GraphNode, seen = new Set<string>()): GraphNode[] => {
    const own = [...new Set([...index.getNestedInstances(copy.id), ...index.getDescendants(copy.id).filter(isCopy)])].filter((c) => c.id !== copy.id);
    if (own.length || index.getChildren(copy.id).length) return own;
    const main = mainOf(copy);
    if (!main || main.isRemote || seen.has(main.id)) return [];
    seen.add(main.id);
    const def = [...new Set([...index.getNestedInstances(main.id), ...index.getDescendants(main.id).filter(isCopy)])];
    return def.flatMap((c) => [c, ...innerCopies(c, seen)]);
  };
  const insideBy = new Map<string, Array<{ copy: GraphNode; parent: string }>>();
  for (const host of hostsOf) {
    const hostMain = mainOf(host);
    const parent = hostMain ? familyName(hostMain) : clean(host.name);
    for (const c of innerCopies(host)) {
      const m = mainOf(c);
      if (!m) continue;
      const list = insideBy.get(familyKey(index, m)) ?? [];
      if (!list.some((e) => e.copy.id === c.id)) list.push({ copy: c, parent });
      insideBy.set(familyKey(index, m), list);
    }
  }
  const taken = new Set<string>();
  const filledBy = new Map<string, string>();
  const slots: HandoffSlot[] = (filled?.slots ?? []).map((s) => {
    const node = s.master ? index.getNode(s.master.id) : undefined;
    const fam = node ? familyKey(index, node) : undefined;
    let state: HandoffSlot["state"];
    let insideOf: string | undefined;
    let sharedWith: string | undefined;
    if (fam) {
      const copy = hostsOf.find((c) => !taken.has(c.id) && mainOf(c) && familyKey(index, mainOf(c)!) === fam);
      const part = copy ? undefined : insideBy.get(fam)?.find((e) => !taken.has(e.copy.id));
      if (copy) {
        taken.add(copy.id);
        filledBy.set(fam, filledBy.get(fam) ?? s.role);
        state = "placed";
      } else if (part) {
        taken.add(part.copy.id);
        state = "inside";
        insideOf = part.parent;
      } else {
        state = "missing";
        sharedWith = filledBy.get(fam);
      }
    }
    return {
      role: s.role,
      required: s.required,
      status: s.status,
      ...(s.master
        ? { component: { name: clean(s.master.set ?? s.master.name), ...(s.master.fileKey ? { fileKey: s.master.fileKey } : {}), ...(s.master.figmaNodeId ? { figmaNodeId: s.master.figmaNodeId } : {}) } }
        : {}),
      onScreen: state === "placed",
      ...(state ? { state } : {}),
      ...(insideOf ? { insideOf } : {}),
      ...(sharedWith ? { sharedWith } : {}),
    };
  });
  const slotOfFamily = new Map<string, string>();
  for (const s of filled?.slots ?? []) {
    const node = s.master ? index.getNode(s.master.id) : undefined;
    if (node && !slotOfFamily.has(familyKey(index, node))) slotOfFamily.set(familyKey(index, node), s.role);
  }

  const open: string[] = [];
  const components: HandoffComponent[] = [];
  for (const { main, copies } of groups.values()) {
    const first = copies[0]!;
    const remote = Boolean(main?.isRemote);
    const missing = !main ? missingOf(first) : undefined;
    const set = main ? setOf(index, main) : undefined;
    const name = clean(set?.name ?? main?.name ?? first.name);
    const twin = main && !remote ? hooks.twin(main) : undefined;
    const props = main?.variantProperties && Object.keys(main.variantProperties).length ? main.variantProperties : undefined;
    const allHints = inputHints(props, twin?.angular);
    // A selector that pins an attribute (`acme-button[variant="primary"]`) only matches that value: a different Figma value is not suggested.
    const pins = selectorPins(twin?.angular);
    const conflicts: string[] = [];
    const hints = allHints.filter((h) => {
      const pinned = [...pins].find(([attr]) => norm(attr) === norm(h.input));
      if (!pinned || norm(pinned[1]) === norm(h.value)) return true;
      conflicts.push(pinned[0]);
      open.push(`${name}: the selector only matches ${pinned[0]}="${pinned[1]}"; this copy is ${h.from.slice(h.from.indexOf("=") + 1)} (${h.from}). Check how the code builds this variant.`);
      return false;
    });
    const template = angularTemplate(twin?.angular, hints, conflicts);
    const card = hooks.ingredient(`${fid(index, first) ?? ""}:${first.figmaNodeId ?? first.id}`.replace(/^:/, ""), depth, options.maxCharsPerCard);
    const parts = card.found ? trimParts(card.parts) : [];
    const guess = !main ? !missing : hooks.nameGuess(main);
    const states = main && !remote ? statesOf(index, main) : undefined;
    components.push({
      name,
      ...(props ? { variant: Object.entries(props).map(([k, v]) => `${k}=${v}`).join(", ") } : {}),
      ...(main && !remote && fid(index, main) ? { fileKey: fid(index, main) } : {}),
      ...(main?.figmaNodeId && !remote ? { figmaNodeId: main.figmaNodeId } : {}),
      count: copies.length,
      copies: copies.slice(0, 10).flatMap((c) => (c.figmaNodeId ? [c.figmaNodeId] : [])),
      identity: missing ? "not-found" : guess ? NAME_GUESS : "confirmed",
      status: !main ? "not-found" : remote ? "other-library" : hooks.retired(main) ? "retired" : "current",
      ...(main && slotOfFamily.has(familyKey(index, main)) ? { slot: slotOfFamily.get(familyKey(index, main)) } : {}),
      code: twin ? twin.line : remote || missing ? "unknown" : "unmapped",
      ...(twin?.angular ? { angular: twin.angular } : {}),
      ...(props ? { figmaProps: props } : {}),
      ...(hints.length ? { inputs: hints } : {}),
      ...(template ? { template } : {}),
      ...(states ? { states } : {}),
      ...(card.found && card.instance?.partsFrom ? { partsFrom: card.instance.partsFrom } : {}),
      ...(card.found && card.cut ? { partsCut: card.cut.reason } : {}),
      parts,
    });
    if (missing) open.push(`${name}: its component (${missing}) is not in the learned library. Learn the library file that holds it, or replace the copy, before building.`);
    else if (guess) open.push(`${name}: identity is a guess from the layer name. Confirm it with Figma REST or design_context before building.`);
    if (remote) open.push(`${name} (placed: ${copies.flatMap((c) => (c.figmaNodeId ? [c.figmaNodeId] : [])).slice(0, 3).join(", ") || "on this screen"}) is from a library file that is not learned, so its code is unknown. Learn that library file to see its code and parts.`);
  }

  // Ingredients: every part inside the placed components, once each, with what uses it.
  const byPart = new Map<string, HandoffIngredient>();
  const walk = (parts: HandoffPart[], owner: string) => {
    for (const p of parts) {
      const key = p.figmaNodeId ? `${p.fileKey ?? ""}:${p.figmaNodeId}` : `name:${p.name.toLowerCase()}`;
      const row = byPart.get(key) ?? {
        name: p.name,
        ...(p.fileKey ? { fileKey: p.fileKey } : {}),
        ...(p.figmaNodeId ? { figmaNodeId: p.figmaNodeId } : {}),
        status: partStatus(p),
        code: p.code ?? (p.status === "other-library" || p.status === "not-found" ? "unknown" : "unmapped"),
        ...(p.angular ? { angular: p.angular } : {}),
        usedBy: [],
      };
      if (!row.usedBy.includes(owner)) row.usedBy.push(owner);
      byPart.set(key, row);
      if (p.parts?.length) walk(p.parts, p.name.split(" / ")[0]!);
    }
  };
  for (const c of components) walk(c.parts, c.name);
  const ingredients = [...byPart.values()];

  // Verify (the same check as verify_frame).
  const asCopy = isCopy(frame);
  const mains = asCopy
    ? [...new Set(nested.flatMap((c) => {
        const m = mainOf(c);
        return m?.figmaNodeId ? [`${fid(index, m) ? `${fid(index, m)}:` : ""}${m.figmaNodeId}`] : [];
      }))]
    : undefined;
  const v = hooks.verify(frame.id, mains);
  const verify: HandoffScreen["verify"] = {
    pass: v.pass,
    approved: v.approved ?? 0,
    retired: (v.deprecated ?? []).map((d) => clean(d.name)),
    invents: (v.invents ?? []).map((d) => `${clean(d.name)}${d.reason ? ` (${d.reason})` : ""}`),
    unresolved: (v.unresolved ?? []).map((d) => `${clean(d.name)}${d.reason ? ` (${d.reason})` : ""}`),
    ...(asCopy ? { checked: "components" as const } : {}),
    ...(!v.pass && v.result ? { note: `${v.result}${v.hint ? `: ${clean(v.hint)}` : ""}` } : {}),
  };

  // Open questions: what a developer would otherwise have to ask.
  if (!components.length) open.push("No components are placed on this screen, so there is nothing to build from the library. Is it the right frame?");
  if (!hooks.codeMap) open.push("No code map, so no component has a code link. Add .resolve/code-map.json (resolve code-map --init writes a spreadsheet to fill).");
  else {
    for (const c of components) if (c.code === "unmapped" && c.identity === "confirmed" && c.status === "current") open.push(`${c.name} [${where(c.fileKey, c.figmaNodeId)}] has no code link. Map it in the code map, or say it is new and must be built.`);
    const unmappedParts = ingredients.filter((i) => i.status === "unmapped");
    for (const i of unmappedParts) open.push(`Part ${i.name} [${where(i.fileKey, i.figmaNodeId)}] (inside ${i.usedBy.join(", ")}) has no code link.`);
  }
  for (const i of ingredients) {
    if (i.status === NAME_GUESS) open.push(`Part ${i.name} (inside ${i.usedBy.join(", ")}) is a guess from its layer name.`);
    if (i.status === "other-library") open.push(`Part ${i.name} (inside ${i.usedBy.join(", ")}) is from a library file that is not learned, so its code is unknown.`);
    if (i.status === "not-found") open.push(`Part ${i.name} (inside ${i.usedBy.join(", ")}): its component is not in the learned files.`);
    if (i.status === "retired") open.push(`Part ${i.name} (inside ${i.usedBy.join(", ")}) is retired in the library; the library component needs an update.`);
  }
  for (const s of slots) {
    if (s.required && s.component && s.state === "missing") open.push(`Recipe slot ${s.role} expects ${s.component.name}; it is not placed on this screen.${s.sharedWith ? ` Its placed copy already fills ${s.sharedWith}.` : ""} Is that on purpose?`);
    if (s.required && s.component && s.state === "inside") open.push(`Recipe slot ${s.role}: ${s.component.name} comes with ${s.insideOf}; check it is meant to fill the ${s.role} slot.`);
    if (s.required && !s.component) open.push(`Recipe slot ${s.role} has no component bound in the recipe; check what the design uses for it.`);
  }
  for (const i of verify.invents) open.push(`Verify flagged ${i}.`);
  for (const u of verify.unresolved) open.push(`Verify could not resolve ${u}.`);

  const familyIds = new Set([...placedFamilies.keys()]);
  const decisions = decisionsFor(options.decisions, frame, recipe?.id, familyIds, index);
  const pack = options.context;
  const linked = components.filter((c) => c.code !== "unmapped" && c.code !== "unknown").length;
  const allParts = ingredients.length;
  const nameGuesses = components.filter((c) => c.identity === NAME_GUESS).length + ingredients.filter((i) => i.status === NAME_GUESS).length;
  const notFound = components.filter((c) => c.status === "not-found").length + ingredients.filter((i) => i.status === "not-found").length;
  const otherLibrary = components.filter((c) => c.status === "other-library").length + ingredients.filter((i) => i.status === "other-library").length;
  const notes = [
    found.others ? `${found.others + 1} frames are named "${screenName}"; this is ${where(frameKey, frame.figmaNodeId)}. Pass a frame id to pick another.` : "",
    isCopy(frame) ? `This screen is one placed copy of ${clean(components[0]?.name ?? frame.name)}; everything on it is listed as that component's parts.` : "",
  ].filter(Boolean);
  const sheet: HandoffScreen = {
    screen: {
      name: screenName,
      id: frame.id,
      ...(frameKey ? { fileKey: frameKey } : {}),
      ...(frame.figmaNodeId ? { figmaNodeId: frame.figmaNodeId } : {}),
      ...(figmaLink(frameKey, frame.figmaNodeId) ? { link: figmaLink(frameKey, frame.figmaNodeId) } : {}),
    },
    ...(found.fuzzy ? { matchedFrame: `closest match for "${clean(ask)}"; no frame has that exact name or id` } : {}),
    ...(pack
      ? {
          context: {
            ...(pack.id ? { id: pack.id } : {}),
            ...(pack.product?.name || pack.product?.id ? { product: pack.product?.name ?? pack.product?.id } : {}),
            ...(pack.journey?.step || pack.journey?.screenJob ? { journey: pack.journey?.screenJob ?? pack.journey?.step } : {}),
            ...(pack.domain ? { domain: pack.domain } : {}),
            ...(pack.audience ? { audience: pack.audience } : {}),
            ...(pack.constraints?.a11y ? { accessibility: pack.constraints.a11y, a11y: pack.constraints.a11y } : {}),
            ...(pack.constraints?.density ? { density: pack.constraints.density } : {}),
          },
        }
      : {}),
    recipe: recipe ? { id: recipe.id, title: recipe.title, matchedBy: options.recipe ? "asked" : "screen name", slots, coverage: slotCoverage(slots) } : null,
    ...(recipeNote ? { recipeNote } : {}),
    components,
    ingredients,
    verify,
    decisions,
    openQuestions: [...new Set(open)],
    summary: {
      components: components.length,
      copies: components.reduce((n, c) => n + c.count, 0),
      linkedToCode: linked,
      unmapped: components.filter((c) => c.code === "unmapped").length,
      parts: allParts,
      partsLinkedToCode: ingredients.filter((i) => i.status === "mapped").length,
      nameGuesses,
      notFound,
      otherLibrary,
    },
    ...(notes.length ? { note: notes.join(" ") } : {}),
  };
  return { ok: true, sheet };
}

/** One handoff for one or more screens. Any refusal refuses the whole pack (nothing half-written). */
export function buildHandoff(index: GraphIndex, frames: string[], hooks: HandoffHooks, options: HandoffOptions = {}): HandoffPack {
  const draft = Boolean(options.draft);
  const built = frames.map((f) => buildScreen(index, f, hooks, options));
  const refused = built.flatMap((b) => (b.ok ? [] : b.refused));
  if (refused.length) {
    const retired = refused.some((r) => r.kind === "retired");
    const identity = refused.some((r) => r.kind === "identity");
    const missing = refused.some((r) => r.kind === "not-found" && r.component);
    return {
      ok: false,
      handoff: HANDOFF_VERSION,
      draft,
      refused,
      hint: [
        retired ? "Replace the retired components named above (verify lists the ones placed on the screen), then run handoff again." : "",
        identity ? "Re-learn the file with Figma REST, or pass design_context, so components are confirmed. --draft makes a labelled draft that is not for build." : "",
        missing ? "Learn the library file that holds the missing components (resolve ingest), or replace those copies. --draft makes a labelled draft that is not for build." : "",
        refused.some((r) => r.kind === "not-found" && !r.component) ? "Check the frame name, or pass its Figma id." : "",
      ].filter(Boolean).join(" "),
    };
  }
  const screens = built.flatMap((b) => (b.ok ? [b.sheet] : []));
  const merged = new Map<string, HandoffIngredient>();
  for (const s of screens) {
    for (const i of s.ingredients) {
      const key = i.figmaNodeId ? `${i.fileKey ?? ""}:${i.figmaNodeId}` : `name:${i.name.toLowerCase()}`;
      const row = merged.get(key) ?? { ...i, usedBy: [], screens: [] };
      for (const u of i.usedBy) if (!row.usedBy.includes(u)) row.usedBy.push(u);
      if (!row.screens!.includes(s.screen.name)) row.screens!.push(s.screen.name);
      merged.set(key, row);
    }
  }
  return { ok: true, handoff: HANDOFF_VERSION, draft, codeMap: hooks.codeMap, screens, ingredients: [...merged.values()] };
}

// ---------- Markdown ----------

/**
 * Text from Figma or the stores, made inert in markdown: backslash, backticks, `*`, raw HTML (`<` `>`), table pipes, word-edge `_`,
 * and `](` (so `[x](y)` is never a link). Plain `[ACMEUI 30:40]` stays readable.
 */
const md = (s: string) =>
  clean(s)
    .replace(/[\\`*<>|]/g, (c) => `\\${c}`)
    .replace(/_/g, (c, at: number, all: string) => (/[\p{L}\p{N}]/u.test(all[at - 1] ?? "") && /[\p{L}\p{N}]/u.test(all[at + 1] ?? "") ? c : `\\${c}`))
    .replace(/\]\(/g, "]\\(");
/** Link text: also every bracket, so a `]` in a name cannot end the link early. */
const mdLink = (s: string) => md(s).replace(/[[\]]/g, (c) => `\\${c}`);
/** A Figma node id (`12:34`, `I12:34;56:78`), not a pseudo id such as `mcp-name:Button`. */
const figmaId = (id?: string) => (id && /^I?\d+[:-]\d+([;:-]\d+)*$/.test(id) ? id : undefined);
/** `2026-02-03 10:00 UTC`: the decision time with its zone. */
const whenText = (when: string) => {
  const t = Date.parse(when);
  return Number.isNaN(t) ? md(when) : `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;
};
const inputText = (h: InputHint) => (/^(true|false)$/.test(h.value) ? `[${h.input}]="${h.value}"` : `${h.input}="${h.value}"`);
const ng = (a: AngularTwin, full = false) => `\`${angularText(a, full)}\``;
const codeLine = (code: string, angular?: AngularTwin) => (code === "unmapped" ? "unmapped (no code-map entry)" : `\`${code}\`${angular ? `, ${ng(angular)}` : ""}`);

function partLines(parts: HandoffPart[], indent: string): string[] {
  return parts.flatMap((p) => {
    const tag = [
      p.code ? `code: \`${p.code}\`${p.angular ? `, ${ng(p.angular)}` : ""}` : p.status === "current" ? "unmapped" : "",
      p.status === "retired" ? `retired${p.use ? `; use ${md(p.use)}${p.useCode ? ` (\`${p.useCode}\`)` : ""}` : ""}` : "",
      p.identity ? "guess from layer name" : "",
      p.status === "other-library" ? "from a library file that is not learned" : "",
      p.status === "not-found" ? "component not found" : "",
      p.inside ? `${p.inside} parts inside, not shown` : "",
    ].filter(Boolean).join("; ");
    const line = `${indent}- ${md(p.name)}${p.count > 1 ? ` ×${p.count}` : ""}${figmaId(p.figmaNodeId) ? ` [${md(where(p.fileKey, p.figmaNodeId))}]` : ""}${tag ? ` (${tag})` : ""}`;
    return [line, ...partLines(p.parts ?? [], `${indent}  `)];
  });
}

/** The developer's screen sheet (screen-<name>.md). */
export function formatHandoffScreen(s: HandoffScreen, draft: boolean): string {
  const out: string[] = [];
  out.push(`# Handoff: ${md(s.screen.name)}${draft ? " (DRAFT)" : ""}`, "");
  if (s.verify.note?.includes("library node")) out.push(`> ${md(s.verify.note)}`, "");
  if (draft) {
    const weak = [
      s.summary.nameGuesses ? `${s.summary.nameGuesses} name guess${s.summary.nameGuesses === 1 ? "" : "es"} (marked \`name-guess\`; confirm with Figma REST or design_context)` : "",
      s.summary.notFound ? `${s.summary.notFound} component${s.summary.notFound === 1 ? "" : "s"} not in the learned library (marked \`not-found\`; learn the library file that holds ${s.summary.notFound === 1 ? "it" : "them"}, or replace the cop${s.summary.notFound === 1 ? "y" : "ies"})` : "",
    ].filter(Boolean);
    out.push(`> **Draft, not for build.** ${weak.length ? `Below: ${weak.join("; ")}. Fix these, then run handoff without --draft.` : "Nothing below is weak; run handoff without --draft for the copy to build from."}`, "");
  }
  out.push(`- Screen: ${md(s.screen.name)} [${md(where(s.screen.fileKey, s.screen.figmaNodeId))}]${s.screen.link ? ` (${s.screen.link})` : ""}`);
  if (s.matchedFrame) out.push(`- Frame: ${md(s.matchedFrame)}. Pass the exact name or Figma id to be sure.`);
  if (s.context) {
    const c = s.context;
    if (c.id) out.push(`- Context pack: ${md(c.id)}${[c.product, c.journey, c.domain].filter(Boolean).length ? ` (${[c.product, c.journey, c.domain].filter(Boolean).map((x) => md(x!)).join(", ")})` : ""}`);
    else {
      if (c.product) out.push(`- Product: ${md(c.product)}`);
      if (c.journey) out.push(`- Journey: ${md(c.journey)}`);
    }
    if (c.audience) out.push(`- Audience: ${md(c.audience)}`);
    if (c.a11y || c.accessibility) out.push(`- Accessibility (a11y): ${md(c.a11y || c.accessibility || "")}`);
  }
  out.push(`- ${s.summary.components} component${s.summary.components === 1 ? "" : "s"} placed (${s.summary.copies} cop${s.summary.copies === 1 ? "y" : "ies"}), ${s.summary.linkedToCode} linked to code, ${s.summary.unmapped} unmapped. ${s.summary.parts} part${s.summary.parts === 1 ? "" : "s"} inside, ${s.summary.partsLinkedToCode} linked to code.${s.summary.otherLibrary ? ` ${s.summary.otherLibrary} from a library file that is not learned.` : ""}`);
  if (s.note) out.push(`- Note: ${md(s.note)}`);
  out.push("", "## Recipe", "");
  if (s.recipe) {
    out.push(`${md(s.recipe.title)} (\`${s.recipe.id}\`)${s.recipe.matchedBy === "screen name" ? ", matched from the screen name; pass --recipe <id> to pick another" : ""}`, "", "| Slot | Required | Recipe status | Component | On this screen |", "|---|---|---|---|---|");
    for (const sl of s.recipe.slots) {
      out.push(`| ${md(sl.role)} | ${sl.required ? "yes" : "no"} | ${md(sl.status)} | ${sl.component ? `${md(sl.component.name)} [${md(where(sl.component.fileKey, sl.component.figmaNodeId))}]` : "none bound"} | ${sl.state === "placed" ? "placed" : sl.state === "inside" ? `inside ${md(sl.insideOf ?? "a placed component")}` : sl.state === "missing" ? (sl.sharedWith ? `missing (its placed copy fills ${md(sl.sharedWith)})` : "missing") : "-"} |`);
    }
    const cov = s.recipe.coverage;
    out.push("", `${cov.covered}/${cov.slots} slots covered (${cov.placed} placed, ${cov.inside} inside another component).`);
  } else out.push(md(s.recipeNote ?? "No recipe."));
  out.push("", `## Components (${s.components.length})`, "");
  for (const c of s.components) {
    out.push(`### ${md(c.name)}${c.variant ? ` / ${md(c.variant)}` : ""}${c.count > 1 ? ` ×${c.count}` : ""}`, "");
    const placed = c.copies.length ? ` (placed: ${md(c.copies.join(", "))}${c.count > c.copies.length ? `, +${c.count - c.copies.length} more` : ""})` : "";
    const figma =
      c.status === "other-library"
        ? "its component is in a library file that is not learned (no Figma id in the learned files)"
        : figmaId(c.figmaNodeId)
          ? md(where(c.fileKey, c.figmaNodeId))
          : c.status === "not-found"
            ? "component not in the learned library"
            : "no Figma component id (known by its layer name only)";
    out.push(c.status === "other-library" && placed ? `- Figma: placed as ${md(c.copies.join(", "))}${c.count > c.copies.length ? `, +${c.count - c.copies.length} more` : ""}; ${figma}${c.slot ? `; recipe slot: ${md(c.slot)}` : ""}` : `- Figma: ${figma}${placed}${c.slot ? `; recipe slot: ${md(c.slot)}` : ""}`);
    if (c.identity === NAME_GUESS) out.push("- Identity: **name-guess** (from the layer name, not confirmed)");
    if (c.identity === "not-found") out.push("- Identity: **not-found** (the copy's component is in no learned file)");
    out.push(`- Code: ${c.status === "other-library" ? "unknown (its library file is not learned)" : c.code === "unknown" ? "unknown (its component is not in the learned files)" : codeLine(c.code, undefined)}`);
    if (c.angular) out.push(`- Angular: ${ng(c.angular, true)}${c.angular.standalone ? " (add the component to `imports`)" : c.angular.module ? ` (import \`${c.angular.module}\` from '${c.angular.importPath}')` : ""}`);
    if (c.figmaProps) {
      const hints = c.inputs?.length ? ` → inputs (suggested): ${c.inputs.map(inputText).map(md).join(", ")}` : "";
      out.push(`- Figma properties: ${Object.entries(c.figmaProps).map(([k, v]) => `${md(k)}=${md(v)}`).join(", ")}${hints}`);
    }
    if (c.template) out.push(`- Template (suggested): \`${c.template.replace(/`/g, "'")}\``);
    if (c.states) out.push(`- Other variants in Figma (states to build): ${Object.entries(c.states).map(([k, vs]) => `${md(k)}: ${vs.map(md).join(", ")}`).join("; ")}`);
    if (c.parts.length) {
      out.push(`- Parts inside${c.partsFrom ? ` (${c.partsFrom})` : ""}:`);
      out.push(...partLines(c.parts, "  "));
      if (c.partsCut) out.push(`  - (cut: ${md(c.partsCut)})`);
    } else out.push("- Parts inside: none (a base part)");
    out.push("");
  }
  const imports = new Map<string, string>();
  for (const c of s.components) {
    if (c.code === "unmapped" || c.code === "unknown") continue;
    const a = c.angular;
    imports.set(c.code, a ? `\`${c.code}\` (${a.standalone ? "standalone" : a.module ? `module \`${a.module}\`` : "Angular"})` : `\`${c.code}\``);
  }
  out.push("## Code to import", "");
  out.push(...(imports.size ? [...imports.values()].map((x) => `- ${x}`) : ["- Nothing mapped yet."]), "");
  out.push(`## Ingredients (${s.ingredients.length} parts)`, "");
  if (s.ingredients.length) {
    out.push("| Part | Figma | Code | Status | Used by |", "|---|---|---|---|---|");
    for (const i of s.ingredients) out.push(`| ${md(i.name)} | ${figmaId(i.figmaNodeId) ? md(where(i.fileKey, i.figmaNodeId)) : "-"} | ${i.code === "unmapped" || i.code === "unknown" ? i.code : `\`${i.code}\`${i.angular ? `, ${ng(i.angular)}` : ""}`} | ${i.status} | ${i.usedBy.map(md).join(", ")} |`);
  } else out.push("No parts inside the placed components.");
  out.push("", "## Verify", "");
  if (s.verify.checked) out.push("Checked as a component list (this screen is one copy).", "");
  if (s.verify.note && !s.verify.note.includes("library node")) out.push(`Note: ${md(s.verify.note)}`, "");
  out.push(`${s.verify.pass ? "PASS" : "FAIL"}: ${s.verify.approved} approved component${s.verify.approved === 1 ? "" : "s"}.${s.verify.retired.length ? ` Retired: ${s.verify.retired.map(md).join(", ")}.` : ""}${s.verify.invents.length ? ` Flagged: ${s.verify.invents.map(md).join(", ")}.` : ""}${s.verify.unresolved.length ? ` Unresolved: ${s.verify.unresolved.map(md).join(", ")}.` : ""}`);
  out.push("", "## Decisions", "");
  if (s.decisions.length) for (const d of s.decisions) out.push(`- ${whenText(d.when)}, ${md(d.who)}: ${md(d.summary)}${d.why !== d.summary ? ` Why: ${md(d.why)}` : ""} (\`${d.proposalId}\`)`);
  else out.push("None approved for this screen yet.");
  out.push("", "## Open questions", "");
  out.push(...(s.openQuestions.length ? s.openQuestions.map((q) => `- ${md(q)}`) : ["None."]));
  return `${out.join("\n")}\n`;
}

/** ingredients.md for a pack: every part once, its code, and which screens and components use it. */
export function formatHandoffIngredients(pack: Extract<HandoffPack, { ok: true }>): string {
  const out = [`# Ingredients${pack.draft ? " (DRAFT)" : ""}`, ""];
  if (!pack.ingredients.length) return `${[...out, "No parts inside the placed components."].join("\n")}\n`;
  out.push("| Part | Figma | Code | Status | Used by | Screens |", "|---|---|---|---|---|---|");
  for (const i of pack.ingredients) {
    out.push(`| ${md(i.name)} | ${figmaId(i.figmaNodeId) ? md(where(i.fileKey, i.figmaNodeId)) : "-"} | ${i.code === "unmapped" || i.code === "unknown" ? i.code : `\`${i.code}\`${i.angular ? `, ${ng(i.angular)}` : ""}`} | ${i.status} | ${i.usedBy.map(md).join(", ")} | ${(i.screens ?? []).map(md).join(", ")} |`);
  }
  return `${out.join("\n")}\n`;
}

/** handoff.md: the index of a pack. */
export function formatHandoffIndex(pack: Extract<HandoffPack, { ok: true }>, files: string[]): string {
  const out = [`# Handoff${pack.draft ? " (DRAFT, not for build)" : ""}`, ""];
  for (const [n, s] of pack.screens.entries()) {
    out.push(`- [${mdLink(s.screen.name)}](${files[n]}): ${s.summary.components} component${s.summary.components === 1 ? "" : "s"}, ${s.summary.linkedToCode} linked to code, verify ${s.verify.pass ? "PASS" : "FAIL"}, ${s.openQuestions.length} open question${s.openQuestions.length === 1 ? "" : "s"}`);
  }
  out.push("- [Ingredients](ingredients.md)", "- [handoff.json](handoff.json)");
  return `${out.join("\n")}\n`;
}

/** Refusal, as text. */
export function formatHandoffRefusal(pack: Extract<HandoffPack, { ok: false }>): string {
  return [`Handoff refused${pack.draft ? " (draft)" : ""}. Nothing written.`, ...pack.refused.map((r) => `- ${r.screen || "(no frame)"}: ${r.message}`), pack.hint].filter(Boolean).join("\n");
}

/** `send-money` for file names. */
export const screenSlug = (name: string) => kebab(name).slice(0, 60) || "screen";
