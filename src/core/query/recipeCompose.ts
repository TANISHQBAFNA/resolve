import type { GraphIndex } from "./GraphIndex";
import type { BindRulesFile } from "./bindRules";
import { packForRecipe, type ContextBind } from "./contextPacks";
import { compactCardSlot, exactRecipe, fillRecipe, recipeCard, type Recipe, type RecipeSlot } from "./recipes";
import { withCost } from "./agentSurface";
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
const ARTICLES = new Set(["a", "an", "the", "some", "its", "their", "our", "my", "your"]);
// Words after these say where or why, not which part: "a radio list for delivery".
const PURPOSE = /\s+\b(?:for|on|in|of|to|when|while|that|which|at|above|below|under|over|next|from)\b.*$/i;

/** The screen name (before "with") and one phrase per named part. */
export function composeParts(request: string): { title: string; phrases: string[] } {
  const text = request.trim().replace(/\s+/g, " ");
  const at = text.search(/\bwith\b/i);
  const title = at > 0 ? text.slice(0, at).trim() : "";
  const body = at >= 0 ? text.slice(at + 4) : text;
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
  index: GraphIndex;
  recipes: Recipe[];
  bind?: ContextBind;
  sock?: SockState;
  bindRules?: BindRulesFile;
  placeholders?: string[];
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
    slots: phrases.map((phrase) => ({ role: slug(phrase), required: true, hints: phrase.split(" ") })),
  };
  if (!draft.slots.length) return { card: noMatch(request, phrases) };
  const pack = input.bind ? packForRecipe(draft, input.bind) : undefined;
  const filled = fillRecipe(index, draft, undefined, pack, input.bind?.workspace, input.sock, input.bindRules, input.placeholders);
  const parts = filled.slots.filter((slot) => slot.master && (slot.status === "filled" || slot.status === "bound"));
  if (!parts.length) return { card: noMatch(request, phrases) };
  if (parts.length < COMPOSE_MIN_PARTS) {
    const master = parts[0]!.master!;
    return {
      card: withCost({
        found: false as const,
        composed: false as const,
        query: request,
        part: { id: master.id, name: master.name, figmaNodeId: master.figmaNodeId, ...(master.fileKey ? { fileKey: master.fileKey } : {}) },
        hint: `One part fits (${master.name}). A composed recipe needs ${COMPOSE_MIN_PARTS} or more. Use recommend for one part. Do not invent the rest.`,
      }),
    };
  }
  const empty = filled.slots.filter((slot) => !parts.includes(slot));
  // Saved shape: filled slots keep the returned id; empty slots stay optional with no id.
  const recipe: Recipe = {
    ...draft,
    slots: filled.slots.map((slot): RecipeSlot => {
      const id = parts.includes(slot) ? slot.master?.id : undefined;
      return { role: slot.role, required: Boolean(id), hints: slot.hints, ...(id ? { defaultMasterId: id } : {}) };
    }),
  };
  const card = withCost({
    found: true as const,
    composed: true as const,
    saved: false as const,
    query: request,
    recipe: { id: recipe.id, title: recipe.title },
    slots: filled.slots.map(compactCardSlot),
    ...(empty.length ? { noMatch: empty.map((slot) => slot.role) } : {}),
    ...(filled.context ? { context: filled.context } : {}),
    hint: `Composed from the parts you named; not saved. ${empty.length ? `No match for ${empty.map((slot) => slot.role).join(", ")}: recommend those, do not invent. ` : ""}To keep it, propose it (--propose) and a person approves. Then verify_frame.`,
  });
  return { card, recipe };
}

function noMatch(request: string, phrases: string[]) {
  return withCost({
    found: false as const,
    composed: false as const,
    query: request,
    hint: `No match. No learned part fits ${phrases.length ? phrases.map((phrase) => `"${phrase}"`).join(", ") : "this request"}. Name parts from the library, check the spelling, or learn the library. Do not invent a component.`,
  });
}

/** CLI and MCP both call this. `state` is set only when a proposal was filed; the caller saves it. */
export function composeCard(input: ComposeInput, propose: boolean, now: string): { card: object; state?: SockState } {
  const { card, recipe } = composeRecipe(input);
  if (!propose) return { card };
  if (!recipe) return { card: { ...card, proposal: "none (nothing composed to propose)" } };
  const filed = proposeComposedRecipe(input.sock ?? emptySock(), recipe, now);
  return {
    card: { ...card, proposal: filed.proposalId, hint: `Proposed as ${filed.proposalId}; not saved until a person approves it (resolve approve ${filed.proposalId} --who <name>).` },
    state: filed.state,
  };
}

/** File a pending recipe-update proposal that adds the composed recipe. A person approves it; nothing else writes recipes.json. */
export function proposeComposedRecipe(state: SockState, recipe: Recipe, now: string): { state: SockState; proposalId: string } {
  const proposalId = proposalIdFor("recipe-update", `new:${recipe.id}`);
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
