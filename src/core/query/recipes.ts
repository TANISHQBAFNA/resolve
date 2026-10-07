import { z } from "zod";
import { COMPONENT_DEFINITION_TYPES, type GraphNode } from "@/core/model";
import type { GraphIndex } from "./GraphIndex";
import packagedRecipes from "@/data/recipes.json";
import {
  isNameInferredMaster,
  isPrivateMasterName,
  masterLooksLikeIcon,
  placeableMasterByName,
  recommendMasters,
  resolveNode,
  variantCardName,
  withCost,
  type RecommendCandidate,
} from "./agentSurface";
import { computeComponentUsage } from "./analytics";
import { examplePointer, type ExampleQuery, type ExampleReason } from "./examples";
import { placeReady } from "./placeReady";
import { usageAllowsRecipeFill, type SockState } from "./sock";
import { whyLineForMaster, mergeBindRules, type BindRulesFile } from "./bindRules";
import {
  appliedContext,
  contextPhrase,
  packForRecipe,
  type AppliedContext,
  type ContextBind,
  type ContextPack,
} from "./contextPacks";
import type { WorkspaceManifest } from "./workspace";

/**
 * Screen recipes — named packs of library masters for a common screen job.
 * Designers edit JSON. Agents get a card with real figmaNodeIds, never invents.
 */

export interface RecipeSlot {
  role: string;
  required: boolean;
  hints: string[];
  defaultMasterId?: string;
}

export interface Recipe {
  id: string;
  title: string;
  intentAliases: string[];
  slots: RecipeSlot[];
  notes?: string;
  contextPackId?: string;
}

export type RecipeSlotStatus = "bound" | "filled" | "missing" | "deprecated" | "unbound";

export interface RecipeMaster {
  id: string;
  name: string;
  type: string;
  figmaNodeId?: string;
  nodeId?: string;
  fileKey?: string;
  componentKey?: string;
  published?: boolean;
  publishState?: "published" | "local-only";
  variantProperties?: Record<string, string>;
  set?: string;
  status?: GraphNode["status"];
  deprecated: boolean;
  hint?: string;
  why?: string;
  /** Top pick. Node id, `file:nodeId` or `file:nodeId@screen` when the example file differs. Omitted when none. */
  ex?: string;
  exFileKey?: string;
  exWhy?: ExampleReason;
  exNote?: "other product";
}

export interface FilledSlot {
  role: string;
  required: boolean;
  hints: string[];
  status: RecipeSlotStatus;
  master?: RecipeMaster;
  nextRecommend?: string;
  hint: string;
}

export interface FilledRecipe {
  recipe: { id: string; title: string; notes?: string };
  slots: FilledSlot[];
  hint: string;
  context?: AppliedContext;
}

const SlotSchema = z.object({
  role: z.string().trim().min(1),
  required: z.boolean().optional(),
  hints: z.array(z.string()).optional(),
  defaultMasterId: z.string().optional(),
});

const RecipeSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  intentAliases: z.array(z.string()).optional(),
  notes: z.string().optional(),
  contextPackId: z.string().trim().min(1).optional(),
  slots: z.array(SlotSchema).min(1),
});

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "page",
  "screen",
  "frame",
  "i",
  "im",
  "am",
  "building",
  "build",
  "need",
  "needs",
  "this",
  "that",
  "our",
  "new",
  "and",
  "or",
  "for",
  "to",
  "of",
  "with",
  "from",
]);

const tokensOf = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 1 && !STOPWORDS.has(part));

function asMaster(index: GraphIndex, node: GraphNode): GraphNode | undefined {
  if ((COMPONENT_DEFINITION_TYPES as readonly string[]).includes(node.type)) return node;
  if (node.type === "COMPONENT_INSTANCE") return index.getMainComponent(node.id);
  return undefined;
}

function parseOne(raw: unknown): Recipe[] {
  const parsed = RecipeSchema.safeParse(raw);
  if (!parsed.success) return [];
  const data = parsed.data;
  const defaultMasterId = (slot: z.infer<typeof SlotSchema>) => {
    const id = slot.defaultMasterId?.trim();
    return id ? id : undefined;
  };
  return [
    {
      id: data.id,
      title: data.title,
      intentAliases: (data.intentAliases ?? []).map((alias) => alias.trim()).filter(Boolean),
      notes: data.notes,
      contextPackId: data.contextPackId,
      slots: data.slots.map((slot) => ({
        role: slot.role,
        required: slot.required ?? true,
        hints: (slot.hints ?? []).map((hint) => hint.trim()).filter(Boolean),
        defaultMasterId: defaultMasterId(slot),
      })),
    },
  ];
}

/** Designer JSON in, recipes out. Unknown keys ignored. Bad files → []. */
export function parseRecipeFile(raw: unknown): Recipe[] {
  if (Array.isArray(raw)) return raw.flatMap(parseOne);
  if (!raw || typeof raw !== "object") return [];
  const recipes = (raw as { recipes?: unknown }).recipes;
  if (!Array.isArray(recipes)) return [];
  return recipes.flatMap(parseOne);
}

export function starterRecipes(): Recipe[] {
  return parseRecipeFile(packagedRecipes);
}

export function mergeRecipes(base: Recipe[], overlay: Recipe[]): Recipe[] {
  const byId = new Map(base.map((recipe) => [recipe.id, recipe]));
  for (const recipe of overlay) byId.set(recipe.id, recipe);
  return [...byId.values()];
}

export function serializeRecipeFile(recipes: Recipe[]): {
  version: 1;
  recipes: Array<{
    id: string;
    title: string;
    intentAliases: string[];
    notes?: string;
    contextPackId?: string;
    slots: Array<{ role: string; required: boolean; hints: string[]; defaultMasterId?: string }>;
  }>;
} {
  return {
    version: 1,
    recipes: recipes.map((recipe) => ({
      id: recipe.id,
      title: recipe.title,
      intentAliases: recipe.intentAliases,
      ...(recipe.notes ? { notes: recipe.notes } : {}),
      ...(recipe.contextPackId ? { contextPackId: recipe.contextPackId } : {}),
      slots: recipe.slots.map((slot) => ({
        role: slot.role,
        required: slot.required,
        hints: slot.hints,
        ...(slot.defaultMasterId ? { defaultMasterId: slot.defaultMasterId } : {}),
      })),
    })),
  };
}

function oneLineHint(text: string | undefined, max = 72): string | undefined {
  if (!text) return undefined;
  const line = text.split("\n")[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function compactCardMaster(master: RecipeMaster) {
  const hint = oneLineHint(master.hint, 40);
  const why = master.why ? oneLineHint(master.why, 80) : undefined;
  return {
    id: master.id,
    name: master.name,
    ...(master.figmaNodeId
      ? {
          figmaNodeId: master.figmaNodeId,
          // nodeId repeats figmaNodeId on every filled slot. Keep one id so a
          // filled recipe stays inside the published card size.
          ...((master.nodeId ?? master.figmaNodeId) !== master.figmaNodeId
            ? { nodeId: master.nodeId }
            : {}),
        }
      : {}),
    ...(master.fileKey ? { fileKey: master.fileKey } : {}),
    ...(master.componentKey ? { componentKey: master.componentKey } : {}),
    status: master.status,
    ...(hint ? { hint } : {}),
    ...(why ? { why } : {}),
    ...(master.ex ? { ex: master.ex } : {}),
    ...(master.exFileKey ? { exFileKey: master.exFileKey } : {}),
    ...(master.exWhy ? { exWhy: master.exWhy } : {}),
    ...(master.exNote ? { exNote: master.exNote } : {}),
  };
}

function compactCardSlot(slot: FilledSlot) {
  const unbound =
    slot.status === "unbound" || slot.status === "missing" || slot.status === "deprecated";
  const hint = slot.master ? undefined : oneLineHint(slot.hint);
  return {
    role: slot.role,
    status: slot.status,
    ...(slot.master ? { master: compactCardMaster(slot.master) } : {}),
    ...(unbound ? { nextRecommend: slot.nextRecommend } : {}),
    ...(hint ? { hint } : {}),
  };
}

function compactListSlot(slot: FilledSlot) {
  const master = slot.master
    ? {
        id: slot.master.id,
        name: slot.master.name,
        figmaNodeId: slot.master.figmaNodeId,
        ...(slot.master.fileKey ? { fileKey: slot.master.fileKey } : {}),
        deprecated: slot.master.deprecated,
      }
    : undefined;
  const unbound =
    slot.status === "unbound" || slot.status === "missing" || slot.status === "deprecated";
  return {
    role: slot.role,
    required: slot.required,
    status: slot.status,
    ...(master ? { master } : {}),
    ...(unbound ? { nextRecommend: slot.nextRecommend } : {}),
  };
}

export function listRecipes(
  recipes: Recipe[],
  index?: GraphIndex,
  bind?: ContextBind,
  sock?: SockState,
  bindRules?: BindRulesFile,
  placeholders?: string[],
) {
  const rows = [...recipes]
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
    .map((recipe) => {
      const pack = bind ? packForRecipe(recipe, bind) : undefined;
      const filled = index
        ? fillRecipe(index, recipe, undefined, pack, bind?.workspace, sock, bindRules, placeholders)
        : unboundCard(recipe, undefined, pack);
      const context = pack ? appliedContext(pack) : undefined;
      return {
        id: recipe.id,
        title: recipe.title,
        intentAliases: recipe.intentAliases,
        notes: recipe.notes,
        ...(context ? { context } : {}),
        slots: filled.slots.map(compactListSlot),
      };
    });
  return {
    recipes: rows,
    hint: index
      ? 'Slots bound/filled from live masters. Overlay .resolve/recipes.json still wins. Context packs (.resolve/context-packs.json) scope recommend. Unbound: recommend the nextRecommend query. After draw: verify_frame. Do not invent node ids. Do not Read graph.json.'
      : 'Ingest a library, then list_recipes again to bind slots. Overlay .resolve/recipes.json still wins. Optional .resolve/context-packs.json scopes product + journey. Unbound: recommend. Do not invent node ids. Do not Read graph.json.',
  };
}

/** A recipe whose id, title or alias is the whole query (letter case ignored). */
export function exactRecipe(recipes: Recipe[], query: string): Recipe | undefined {
  const needle = query.trim().toLowerCase();
  if (!needle) return undefined;
  return (
    recipes.find((recipe) => recipe.id.toLowerCase() === needle || recipe.title.toLowerCase() === needle) ??
    recipes.find((recipe) => recipe.intentAliases.some((item) => item.trim().toLowerCase() === needle))
  );
}

export function matchRecipe(recipes: Recipe[], query: string): Recipe | undefined {
  const needle = query.trim().toLowerCase();
  if (!needle) return undefined;

  const exact = exactRecipe(recipes, query);
  if (exact) return exact;

  const tokens = tokensOf(query);
  if (!tokens.length) return undefined;

  let best: { recipe: Recipe; score: number } | undefined;
  for (const recipe of recipes) {
    const haystack = new Set(
      tokensOf([recipe.id, recipe.title, ...recipe.intentAliases].join(" ")),
    );
    const score = tokens.reduce((count, token) => count + (haystack.has(token) ? 1 : 0), 0);
    if (score === 0) continue;
    if (!best || score > best.score || (score === best.score && recipe.title < best.recipe.title)) {
      best = { recipe, score };
    }
  }
  return best?.recipe;
}

/** Every recipe a loose query hits, best first. Exact id/title/alias stays a single hit. */
export function rankRecipes(recipes: Recipe[], query: string): Recipe[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const exact = recipes.filter(
    (recipe) => recipe.id.toLowerCase() === needle || recipe.title.toLowerCase() === needle,
  );
  if (exact.length) return exact;
  const alias = recipes.filter((recipe) =>
    recipe.intentAliases.some((item) => item.trim().toLowerCase() === needle),
  );
  if (alias.length) return alias;

  const tokens = tokensOf(query);
  if (!tokens.length) return [];
  const scored: Array<{ recipe: Recipe; score: number }> = [];
  for (const recipe of recipes) {
    const haystack = new Set(tokensOf([recipe.id, recipe.title, ...recipe.intentAliases].join(" ")));
    const score = tokens.reduce((count, token) => count + (haystack.has(token) ? 1 : 0), 0);
    if (score > 0) scored.push({ recipe, score });
  }
  scored.sort((a, b) => b.score - a.score || a.recipe.title.localeCompare(b.recipe.title));
  return scored.map((row) => row.recipe);
}

export const RECIPE_RESPONSE_BUDGET = 2000;

function payloadSize(value: unknown): number {
  return JSON.stringify(value).length;
}

function slimListedRecipe(row: Record<string, unknown>): Record<string, unknown> {
  const slots = Array.isArray(row["slots"]) ? row["slots"] : [];
  return {
    id: row["id"],
    title: row["title"],
    slots: slots.map((slot) => {
      const record = slot as Record<string, unknown>;
      const master = record["master"];
      const masterRecord =
        master && typeof master === "object" ? (master as Record<string, unknown>) : undefined;
      return {
        role: record["role"],
        status: record["status"],
        ...(masterRecord
          ? {
              master: {
                id: masterRecord["id"],
                name: masterRecord["name"],
                figmaNodeId: masterRecord["figmaNodeId"],
                ...(masterRecord["fileKey"] ? { fileKey: masterRecord["fileKey"] } : {}),
              },
            }
          : {}),
      };
    }),
  };
}

/**
 * MCP recipe payloads stay within 2000 characters.
 * Several matches: the best recipe, plus the names of the others.
 */
export function capRecipePayload(value: object, budget = RECIPE_RESPONSE_BUDGET): object {
  if (payloadSize(value) <= budget) return value;
  const record = value as Record<string, unknown>;
  const recipes = record["recipes"];
  if (Array.isArray(recipes) && recipes.length > 0) {
    const rows = recipes.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object");
    const best = rows[0];
    if (!best) return value;
    const titles = rows.slice(1).map((row) => String(row["title"] ?? row["id"] ?? "")).filter(Boolean);
    const pack = (recipe: unknown, also: string[], omitted: number) => ({
      recipe,
      also,
      ...(omitted > 0 ? { omitted } : {}),
      hint: "Best matching recipe. Other matches are names only — call recipe with that title. Do not Read graph.json.",
    });
    let recipe: unknown = best;
    let also = titles;
    let payload: object = pack(recipe, also, 0);
    if (payloadSize(payload) > budget) {
      recipe = slimListedRecipe(best);
      payload = pack(recipe, also, 0);
    }
    while (payloadSize(payload) > budget && also.length > 0) {
      also = also.slice(0, -1);
      payload = pack(recipe, also, titles.length - also.length);
    }
    let slots = Array.isArray((recipe as { slots?: unknown[] }).slots)
      ? [...((recipe as { slots: unknown[] }).slots)]
      : [];
    while (payloadSize(payload) > budget && slots.length > 0) {
      slots = slots.slice(0, -1);
      recipe = { ...(recipe as object), slots };
      payload = pack(recipe, also, titles.length - also.length);
    }
    if (payloadSize(payload) > budget) {
      const title = String(best["title"] ?? best["id"] ?? "");
      payload = pack({ id: best["id"], title: title.slice(0, 80) }, [], titles.length);
    }
    return payload;
  }

  const next: Record<string, unknown> = { ...record };
  let also = Array.isArray(next["also"]) ? [...(next["also"] as unknown[])].filter((item) => typeof item === "string") : [];
  while (payloadSize({ ...next, also }) > budget && also.length > 0) also = also.slice(0, -1);
  if (also.length) next["also"] = also;
  else delete next["also"];
  if (payloadSize(next) <= budget) return next;
  const slots = next["slots"];
  if (Array.isArray(slots) && slots.length > 1) {
    next["slots"] = slots.slice(0, 1);
  }
  if (typeof next["hint"] === "string" && payloadSize(next) > budget) {
    next["hint"] = "Place bound figmaNodeIds, then verify_frame.";
  }
  return next;
}

export function slotRecommendIntent(
  _recipe: Recipe,
  slot: RecipeSlot,
  extraIntent?: string,
  pack?: ContextPack,
): string {
  const core = slot.hints.join(" ") || slot.role.replace(/-/g, " ");
  // Context stays in front of the component words. Words after the head noun
  // are treated as a different ask, so the component word stays at the end.
  return [pack ? contextPhrase(pack) : undefined, extraIntent, core].filter(Boolean).join(" ");
}

function exampleQueryFor(
  index: GraphIndex,
  sock?: SockState,
  pack?: ContextPack,
  placeholders?: string[],
): ExampleQuery {
  return {
    sock,
    graphFileKey: index.graph.fileKey,
    product: pack?.product?.name || pack?.product?.id,
    journey: pack?.journey?.screenJob || pack?.journey?.step,
    domain: pack?.domain,
    placeholders,
  };
}

function masterFromNode(
  index: GraphIndex,
  node: GraphNode,
  hint: string,
  sock?: SockState,
  pack?: ContextPack,
  placeholders?: string[],
): RecipeMaster {
  const set = node.componentSetId ? index.getNode(node.componentSetId) : undefined;
  const place = placeReady(node, index.graph.fileKey);
  const pointer = examplePointer(
    index,
    node,
    exampleQueryFor(index, sock, pack, placeholders),
    "screen",
  );
  return {
    id: node.id,
    name: variantCardName(index, node),
    type: node.type,
    ...place,
    variantProperties: node.variantProperties,
    set: set && set.id !== node.id ? set.name : undefined,
    status: node.status,
    deprecated: node.status === "deprecated",
    hint,
    why: whyLineForMaster(node, {
      sock,
      graphFileKey: index.graph.fileKey,
      instances: computeComponentUsage(index, node).instanceCount,
    }),
    ...pointer,
  };
}

function masterFromCandidate(candidate: RecommendCandidate, sock?: SockState, graphFileKey?: string): RecipeMaster {
  return {
    id: candidate.id,
    name: candidate.name,
    type: candidate.type ?? "MAIN_COMPONENT",
    figmaNodeId: candidate.figmaNodeId,
    nodeId: candidate.nodeId ?? candidate.figmaNodeId,
    ...(candidate.fileKey ? { fileKey: candidate.fileKey } : {}),
    ...(candidate.componentKey ? { componentKey: candidate.componentKey } : {}),
    published: candidate.published,
    publishState: candidate.publishState,
    variantProperties: candidate.variantProperties,
    set: candidate.set,
    status: candidate.status,
    deprecated: candidate.deprecated ?? false,
    hint: candidate.hint ?? "Place fileKey + nodeId.",
    ...(candidate.ex ? { ex: candidate.ex } : {}),
    ...(candidate.exFileKey ? { exFileKey: candidate.exFileKey } : {}),
    ...(candidate.exWhy ? { exWhy: candidate.exWhy } : {}),
    ...(candidate.exNote ? { exNote: candidate.exNote } : {}),
    why: candidate.why || whyLineForMaster(
      { id: candidate.id, name: candidate.name, type: candidate.type as GraphNode["type"], status: candidate.status },
      { sock, graphFileKey, instances: candidate.instances },
    ),
  };
}

function hintOverlap(candidate: RecommendCandidate, hints: string[]): number {
  if (!hints.length) return 1;
  const haystack = `${candidate.name} ${candidate.set ?? ""} ${Object.values(candidate.variantProperties ?? {}).join(" ")}`.toLowerCase();
  return hints.reduce((count, hint) => count + (haystack.includes(hint.toLowerCase()) ? 1 : 0), 0);
}

const CONTENT_SLOT = /^(?:content|body|detail|message)$/i;

function slotAsksIcon(slot: RecipeSlot): boolean {
  return /\b(?:icon|glyph|symbol)s?\b/i.test([slot.role, ...slot.hints].join(" "));
}

function iconForbidden(
  index: GraphIndex,
  slot: RecipeSlot,
  node: GraphNode | undefined,
  workspace?: WorkspaceManifest,
): boolean {
  if (!node || !masterLooksLikeIcon(index, node, workspace)) return false;
  if (CONTENT_SLOT.test(slot.role)) return true;
  return !slotAsksIcon(slot);
}

function fillSlot(
  index: GraphIndex,
  recipe: Recipe,
  slot: RecipeSlot,
  extraIntent?: string,
  pack?: ContextPack,
  workspace?: WorkspaceManifest,
  sock?: SockState,
  bindRules?: BindRulesFile,
  placeholders?: string[],
): FilledSlot {
  const nextRecommend = slotRecommendIntent(recipe, slot, extraIntent, pack);
  const base = { role: slot.role, required: slot.required, hints: slot.hints, nextRecommend };
  const mergedRules = mergeBindRules(bindRules ?? { version: 1, rules: [] }, pack?.bindRules);

  if (slot.defaultMasterId) {
    const node = resolveNode(index, slot.defaultMasterId);
    const resolved = node ? asMaster(index, node) : undefined;
    const master =
      resolved && isNameInferredMaster(resolved)
        ? placeableMasterByName(index, resolved.name, workspace)
        : resolved;
    if (!master) {
      return {
        ...base,
        status: "missing",
        hint: `Stored master "${slot.defaultMasterId}" is not in the graph. Call recommend "${nextRecommend}". Do not invent a node id.`,
      };
    }
    if (isPrivateMasterName(master.name)) {
      return {
        ...base,
        status: "missing",
        hint: `Stored master "${master.name}" is private (leading . or _). Call recommend "${nextRecommend}". Do not place unpublished parts.`,
      };
    }
    if (iconForbidden(index, slot, master, workspace)) {
      return {
        ...base,
        status: "unbound",
        hint: `Slot "${slot.role}" does not take an icon. Call recommend "${nextRecommend}". Do not place an icon.`,
      };
    }
    if (master.status === "deprecated") {
      return {
        ...base,
        status: "deprecated",
        master: masterFromNode(
          index,
          master,
          "Deprecated — do not place. Call recommend for a live master for this slot.",
          sock,
          pack,
          placeholders,
        ),
        hint: `Bound master ${master.name} is deprecated. Call recommend "${nextRecommend}".`,
      };
    }
    return {
      ...base,
      status: "bound",
      master: masterFromNode(
        index,
        master,
        "Place this stored figmaNodeId. It is still in the graph.",
        sock,
        pack,
        placeholders,
      ),
      hint: `Bound ${master.name}. Place its figmaNodeId.`,
    };
  }

  // Rank on the extra brief plus the slot's own words. The pack phrase stays on
  // nextRecommend and out of this query. The pack object is still passed as context.
  // A product name that is itself a component name can outrank the slot words; the
  // pack is not only a tie-break. Putting the pack phrase into the query makes a word
  // such as "payment" look like the component, the real slot component drops out, and
  // the slot comes back empty.
  const core = slot.hints.join(" ") || slot.role.replace(/-/g, " ");
  const rankQuery = [extraIntent, core].filter(Boolean).join(" ");
  const ranked = recommendMasters(index, rankQuery, {
    budgetChars: 2000,
    ...(pack ? { context: pack } : {}),
    ...(workspace ? { workspace } : {}),
    ...(sock ? { sock } : {}),
    ...(mergedRules.rules.length ? { bindRules: mergedRules } : {}),
    ...(placeholders?.length ? { placeholders } : {}),
  });
  const live = ranked.candidates.filter((candidate): candidate is RecommendCandidate => {
    if (!("deprecated" in candidate) || typeof candidate.instances !== "number") return false;
    if (
      candidate.deprecated !== false ||
      !candidate.figmaNodeId ||
      isPrivateMasterName(candidate.name) ||
      !usageAllowsRecipeFill(sock, candidate.id, candidate.instances)
    ) {
      return false;
    }
    const node = resolveNode(index, candidate.id);
    return !iconForbidden(index, slot, node, workspace);
  });
  const pick = live.find((candidate) => hintOverlap(candidate, slot.hints) > 0);
  if (!pick) {
    return {
      ...base,
      status: "unbound",
      hint: slot.required
        ? `Required slot empty. Call recommend "${nextRecommend}". Do not invent a component.`
        : `Optional slot empty. Skip, or call recommend "${nextRecommend}".`,
    };
  }
  return {
    ...base,
    status: "filled",
    master: masterFromCandidate(pick, sock, index.graph.fileKey),
    hint: pick.hint ?? "Place fileKey + nodeId.",
  };
}

export function fillRecipe(
  index: GraphIndex,
  recipe: Recipe,
  extraIntent?: string,
  pack?: ContextPack,
  workspace?: WorkspaceManifest,
  sock?: SockState,
  bindRules?: BindRulesFile,
  placeholders?: string[],
): FilledRecipe {
  const slots = recipe.slots.map((slot) =>
    fillSlot(index, recipe, slot, extraIntent, pack, workspace, sock, bindRules, placeholders),
  );
  const next = slots
    .filter((slot) => slot.status === "unbound" || slot.status === "missing" || slot.status === "deprecated")
    .map((slot) => slot.nextRecommend)
    .filter((item): item is string => Boolean(item));
  const placed = slots.filter((slot) => slot.master?.figmaNodeId && slot.status !== "deprecated").length;
  const context = pack ? appliedContext(pack) : undefined;
  return {
    recipe: { id: recipe.id, title: recipe.title, notes: recipe.notes },
    slots,
    ...(context ? { context } : {}),
    hint:
      next.length > 0
        ? `Place ${placed} bound/filled figmaNodeId(s). Next: recommend "${next[0]}". Then verify_frame. Do not Read graph.json.`
        : `Place these figmaNodeIds, then verify_frame. Do not invent one-offs. Do not Read graph.json.`,
  };
}

function unboundCard(recipe: Recipe, extraIntent?: string, pack?: ContextPack): FilledRecipe {
  const slots = recipe.slots.map((slot) => {
    const nextRecommend = slotRecommendIntent(recipe, slot, extraIntent, pack);
    return {
      role: slot.role,
      required: slot.required,
      hints: slot.hints,
      status: "unbound" as const,
      nextRecommend,
      hint: `Ingest a library, then recipe "${recipe.id}" again — or call recommend "${nextRecommend}".`,
    };
  });
  const context = pack ? appliedContext(pack) : undefined;
  return {
    recipe: { id: recipe.id, title: recipe.title, notes: recipe.notes },
    slots,
    ...(context ? { context } : {}),
    hint: `No graph yet. Ingest first, then recipe "${recipe.id}" to fill slots from the library. Do not Read graph.json.`,
  };
}

export function recipeCard(
  recipes: Recipe[],
  query: string,
  index?: GraphIndex,
  extraIntent?: string,
  bind?: ContextBind,
  sock?: SockState,
  bindRules?: BindRulesFile,
  placeholders?: string[],
) {
  const recipe = matchRecipe(recipes, query);
  if (!recipe) {
    return withCost({
      found: false as const,
      query,
      hint: "No recipe matched. Call list_recipes, or recommend with a free-text brief. Do not Read graph.json.",
    });
  }
  const pack = bind ? packForRecipe(recipe, bind) : undefined;
  const filled = index
    ? fillRecipe(index, recipe, extraIntent, pack, bind?.workspace, sock, bindRules, placeholders)
    : unboundCard(recipe, extraIntent, pack);
  return withCost({
    found: true as const,
    query,
    recipe: { id: filled.recipe.id, title: filled.recipe.title },
    slots: filled.slots.map(compactCardSlot),
    ...(filled.context ? { context: filled.context } : {}),
    hint: "Place bound figmaNodeIds, then verify_frame. Do not Read graph.json.",
  });
}
