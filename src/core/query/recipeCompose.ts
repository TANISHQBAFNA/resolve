import { createHash } from "node:crypto";
import type { GraphIndex } from "./GraphIndex";
import type { BindRulesFile } from "./bindRules";
import { packForRecipe, type ContextBind } from "./contextPacks";
import { compactCardSlot, exactRecipe, fillRecipe, recipeCard, type FilledSlot, type Recipe, type RecipeSlot } from "./recipes";
import { withCost } from "./agentSurface";
import { nameTokens } from "@/core/rules/names";
import { allSynonymGroups } from "./recommendContext";
import { sameWordForm } from "./screenInventory";
import { proposalIdFor } from "./soci";
import { emptySock, type SockState } from "./sock";

/**
 * Composed recipes. Only when asked (`--compose`, MCP `compose: true`).
 * One slot per part the request names, filled by the same path as a saved
 * recipe (fillRecipe, so recommend). Never invents: a slot binds only to a
 * master recommend returned. Nothing is written; saving is a recipe-update
 * proposal a person approves.
 */

/** A composed recipe needs at least this many filled parts. One part is a recommend answer. */
export const COMPOSE_MIN_PARTS = 2;

const LINKS = /\s*(?:,|;|&|\band\b|\bplus\b|\bthen\b)\s*/i;
// Where a part sits joins two parts: "a toast next to the header bar" names a toast and a header bar.
const SPATIAL = /\s+(?:next to|on top of|left of|right of|in front of|beside|underneath|beneath|under|above|below|over|inside|within|near|on|in|after|before)\s+/gi;
const ARTICLES = new Set(["a", "an", "the", "some", "its", "their", "our", "my", "your"]);
// Words after these say why or whose, not which part: "a radio list for delivery".
const PURPOSE = /\s+\b(?:for|of|to|when|while|that|which|at|from)\b.*$/i;

/** The screen name (before "with") and one phrase per named part. */
export function composeParts(request: string): { title: string; phrases: string[] } {
  const text = request.trim().replace(/\s+/g, " ");
  const at = text.search(/\bwith\b/i);
  const title = at > 0 ? text.slice(0, at).trim() : "";
  const body = (at >= 0 ? text.slice(at + 4) : text).replace(SPATIAL, ", ");
  const phrases: string[] = [];
  for (const raw of body.split(LINKS)) {
    const phrase = raw
      .replace(PURPOSE, "")
      .split(" ")
      .filter((word) => word && !ARTICLES.has(word.toLowerCase()))
      .join(" ")
      .toLowerCase();
    if (/[a-z]/.test(phrase) && !phrases.includes(phrase)) phrases.push(phrase);
  }
  return { title, phrases };
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);

export interface ComposeInput {
  request: string;
  /** Parts from briefing answers (briefAnswerParts). Each becomes a slot bound to that part. */
  answerParts?: Array<{ id: string; name: string }>;
  index: GraphIndex;
  recipes: Recipe[];
  bind?: ContextBind;
  sock?: SockState;
  bindRules?: BindRulesFile;
  placeholders?: string[];
}

// Words that hold parts, not parts: in "radio list" the part is radio.
const CONTAINERS = ["list", "group", "set", "stack", "collection"];

/** The part word: the last word that is not a container ("search field" → field, "radio list" → radio). */
function headWord(hints: string[]): string | undefined {
  const words = hints.map((hint) => hint.toLowerCase());
  return [...words].reverse().find((word) => !CONTAINERS.some((container) => sameWordForm(container, word))) ?? words.at(-1);
}

/** The part word must match the part found. A fill that only shares another word is weak. Synonyms count (button, cta). */
function headMatches(slot: FilledSlot): boolean {
  const head = headWord(slot.hints);
  if (!head || !slot.master) return false;
  const forms = [head, ...allSynonymGroups().filter((group) => group.terms.some((term) => sameWordForm(term, head))).flatMap((group) => group.terms)];
  return nameTokens(slot.master.name).some((token) => forms.some((form) => sameWordForm(token, form)));
}

function weakSlot(slot: FilledSlot) {
  const master = slot.master!;
  return {
    role: slot.role,
    status: "weak" as const,
    master: { id: master.id, name: master.name, figmaNodeId: master.figmaNodeId, ...(master.fileKey ? { fileKey: master.fileKey } : {}) },
    nextRecommend: slot.nextRecommend,
    hint: `Weak, check: "${headWord(slot.hints)}" is not in ${master.name}. Not counted as a fit.`,
  };
}

/** Saved recipes with the same title, or the same set of parts. */
function duplicates(input: ComposeInput, title: string, ids: string[]): string[] {
  const key = (list: string[]) => [...new Set(list)].sort().join("|");
  const want = key(ids);
  return input.recipes
    .filter((recipe) => {
      if (title && recipe.title.toLowerCase() === title.toLowerCase()) return true;
      const filled = fillRecipe(input.index, recipe, undefined, undefined, input.bind?.workspace, input.sock, input.bindRules, input.placeholders);
      const theirs = filled.slots.flatMap((slot) => (slot.master && slot.status !== "deprecated" ? [slot.master.id] : []));
      return want.length > 0 && key(theirs) === want;
    })
    .map((recipe) => recipe.title);
}

export function composeRecipe(input: ComposeInput) {
  const { request, index } = input;
  const saved = exactRecipe(input.recipes, request);
  if (saved) {
    const card = recipeCard(input.recipes, saved.id, index, undefined, input.bind, input.sock, input.bindRules, input.placeholders);
    return { card: { ...card, composed: false as const, note: `Saved recipe ${saved.title} covers this. Nothing composed.` } };
  }
  const { title, phrases } = composeParts(request);
  const draft: Recipe = {
    id: `composed-${slug(title || phrases.join(" ")) || "screen"}`,
    title: title || request.trim(),
    intentAliases: [request.trim()],
    notes: `Composed by Resolve from: ${request.trim()}`,
    slots: [
      ...phrases.map((phrase) => ({ role: slug(phrase), required: true, hints: phrase.split(" ") })),
      // Briefing answers name real parts; bind them directly.
      ...(input.answerParts ?? []).map((part) => ({ role: slug(part.name), required: true, hints: nameTokens(part.name), defaultMasterId: part.id })),
    ],
  };
  if (!draft.slots.length) return { card: noMatch(request, phrases) };
  const pack = input.bind ? packForRecipe(draft, input.bind) : undefined;
  const fill = (recipe: Recipe) => fillRecipe(index, recipe, undefined, pack, input.bind?.workspace, input.sock, input.bindRules, input.placeholders);
  const first = fill(draft);
  // A container word can hide the part from recommend ("avatar group"): retry those slots once without it.
  const bare = (hints: string[]) => hints.filter((hint) => !CONTAINERS.some((container) => sameWordForm(container, hint)));
  const retry = first.slots.map((slot, i) => {
    if (i >= phrases.length || (slot.master && headMatches(slot)) || bare(slot.hints).length === slot.hints.length || !bare(slot.hints).length) return slot;
    const again = fill({ ...draft, slots: [{ role: slot.role, required: true, hints: bare(slot.hints) }] }).slots[0]!;
    return again.master && headMatches(again) ? { ...again, hints: slot.hints } : slot;
  });
  const all = { ...first, slots: retry };
  // An answer part the request already named is one slot, not two.
  const named = new Set(all.slots.slice(0, phrases.length).flatMap((slot) => (slot.master ? [slot.master.id] : [])));
  const filled = { ...all, slots: all.slots.filter((slot, i) => i < phrases.length || !named.has(slot.master?.id ?? "")) };
  const isFit = (slot: FilledSlot) => Boolean(slot.master) && (slot.status === "filled" || slot.status === "bound") && headMatches(slot);
  const parts = filled.slots.filter(isFit);
  const weak = filled.slots.filter((slot) => !isFit(slot) && slot.master && slot.status === "filled");
  const empty = filled.slots.filter((slot) => !isFit(slot) && !weak.includes(slot));
  const misses = {
    ...(empty.length ? { noMatch: empty.map((slot) => slot.role) } : {}),
    ...(weak.length ? { weak: weak.map((slot) => `${slot.role}: ${slot.master!.name} (weak, check)`) } : {}),
  };
  const missLine = [
    ...empty.map((slot) => `No match for ${slot.role}: recommend "${slot.nextRecommend}", do not invent.`),
    ...weak.map((slot) => `Weak, check ${slot.role}: ${slot.master!.name} shares a word only.`),
  ].join(" ");
  if (!parts.length) return { card: noMatch(request, phrases, misses) };
  if (parts.length < COMPOSE_MIN_PARTS) {
    const master = parts[0]!.master!;
    return {
      card: withCost({
        found: false as const,
        composed: false as const,
        query: request,
        part: { id: master.id, name: master.name, figmaNodeId: master.figmaNodeId, ...(master.fileKey ? { fileKey: master.fileKey } : {}) },
        ...misses,
        hint: `One part fits (${master.name}). A composed recipe needs ${COMPOSE_MIN_PARTS} or more. Use recommend for one part. ${missLine}`.trim(),
      }),
    };
  }
  // Saved shape: fitting slots keep the returned id; the rest stay optional with no id.
  const recipe: Recipe = {
    ...draft,
    slots: filled.slots.map((slot): RecipeSlot => {
      const id = parts.includes(slot) ? slot.master?.id : undefined;
      return { role: slot.role, required: Boolean(id), hints: slot.hints, ...(id ? { defaultMasterId: id } : {}) };
    }),
  };
  const same = duplicates(input, recipe.title, parts.map((slot) => slot.master!.id));
  const card = withCost({
    found: true as const,
    composed: true as const,
    saved: false as const,
    query: request,
    recipe: { id: recipe.id, title: recipe.title },
    slots: filled.slots.map((slot) => (weak.includes(slot) ? weakSlot(slot) : compactCardSlot(slot))),
    ...misses,
    ...(same.length ? { duplicates: same } : {}),
    ...(filled.context ? { context: filled.context } : {}),
    hint: [
      "Composed from the parts you named; not saved.",
      same.length ? `Warning: saved recipe ${same.join(", ")} already covers this; use it instead.` : "",
      missLine,
      "To keep it, propose it (--propose) and a person approves. Then verify_frame.",
    ].filter(Boolean).join(" "),
  });
  return { card, recipe, duplicates: same };
}

function noMatch(request: string, phrases: string[], misses: object = {}) {
  return withCost({
    found: false as const,
    composed: false as const,
    query: request,
    ...misses,
    hint: `No match. No learned part fits ${phrases.length ? phrases.map((phrase) => `"${phrase}"`).join(", ") : "this request"}. Name parts from the library, check the spelling, or learn the library. Do not invent a component.`,
  });
}

/** The proposal id names the recipe and its parts, so a different set of parts is a different proposal. */
export function composedProposalId(recipe: Recipe): string {
  const parts = recipe.slots.map((slot) => `${slot.role}=${slot.defaultMasterId ?? ""}`).join("|");
  return proposalIdFor("recipe-update", `new:${recipe.id}:${createHash("sha1").update(parts).digest("hex").slice(0, 8)}`);
}

/** CLI and MCP both call this. `state` is set only when a proposal was filed; the caller saves it. */
export function composeCard(input: ComposeInput, propose: boolean, now: string): { card: object; state?: SockState } {
  const { card, recipe, duplicates: same } = composeRecipe(input);
  if (!propose) return { card };
  const refuse = (why: string) => ({ card: { ...card, proposal: "none", hint: `${why} Nothing filed.` } });
  if (!recipe) return refuse("Nothing composed to propose.");
  if (same?.length) return refuse(`Saved recipe ${same.join(", ")} already covers this.`);
  if (input.recipes.some((row) => row.id === recipe.id)) return refuse(`A saved recipe already uses the id ${recipe.id}.`);
  const sock = input.sock ?? emptySock();
  const id = composedProposalId(recipe);
  const earlier = sock.proposals.find((row) => row.id === id);
  if (earlier?.status === "pending") {
    return { card: { ...card, proposal: id, hint: `Already proposed as ${id}; not saved until a person approves it (resolve approve ${id} --who <name>).` } };
  }
  if (earlier) return refuse(`This exact recipe was already ${earlier.status} as ${id}.`);
  const filed = proposeComposedRecipe(sock, recipe, now);
  return {
    card: { ...card, proposal: filed.proposalId, hint: `Proposed as ${filed.proposalId}; not saved until a person approves it (resolve approve ${filed.proposalId} --who <name>).` },
    state: filed.state,
  };
}

/** File a pending recipe-update proposal that adds the composed recipe. A person approves it; nothing else writes recipes.json. */
export function proposeComposedRecipe(state: SockState, recipe: Recipe, now: string): { state: SockState; proposalId: string } {
  const proposalId = composedProposalId(recipe);
  if (state.proposals.some((row) => row.id === proposalId)) return { state, proposalId };
  const parts = recipe.slots.filter((slot) => slot.defaultMasterId).length;
  return {
    proposalId,
    state: {
      ...state,
      proposals: [
        ...state.proposals,
        {
          id: proposalId,
          createdAt: now,
          updatedAt: now,
          type: "recipe-update",
          status: "pending",
          scope: { recipeId: recipe.id, screenType: recipe.title },
          summary: `New composed recipe ${recipe.title} (${parts} parts)`,
          evidence: [{ note: recipe.notes ?? "Composed on request" }],
          confidence: "low",
          suggestedNewRecipe: recipe,
        },
      ],
    },
  };
}
