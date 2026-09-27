import { z } from "zod";
import { COMPONENT_DEFINITION_TYPES, type GraphNode } from "@/core/model";
import type { GraphIndex } from "./GraphIndex";
import packagedRecipes from "@/data/recipes.json";
import {
  isPrivateMasterName,
  recommendMasters,
  resolveNode,
  withCost,
  type RecommendCandidate,
} from "./agentSurface";
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
  fileKey?: string;
  variantProperties?: Record<string, string>;
  set?: string;
  status?: GraphNode["status"];
  deprecated: boolean;
  hint?: string;
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

function oneLineHint(text: string | undefined, max = 72): string | undefined {
  if (!text) return undefined;
  const line = text.split("\n")[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function compactCardMaster(master: RecipeMaster) {
  const hint = oneLineHint(master.hint);
  return {
    id: master.id,
    name: master.name,
    ...(master.figmaNodeId ? { figmaNodeId: master.figmaNodeId } : {}),
    ...(master.fileKey ? { fileKey: master.fileKey } : {}),
    status: master.status,
    ...(hint ? { hint } : {}),
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

export function listRecipes(recipes: Recipe[], index?: GraphIndex, bind?: ContextBind) {
  const rows = [...recipes]
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
    .map((recipe) => {
      const pack = bind ? packForRecipe(recipe, bind) : undefined;
      const filled = index
        ? fillRecipe(index, recipe, undefined, pack, bind?.workspace)
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
      ? 'Slots bound/filled from live masters. Overlay .graphify/recipes.json still wins. Context packs (.graphify/context-packs.json) scope recommend. Unbound: recommend the nextRecommend query. After draw: verify_frame. Do not invent node ids. Do not Read graph.json.'
      : 'Ingest a library, then list_recipes again to bind slots. Overlay .graphify/recipes.json still wins. Optional .graphify/context-packs.json scopes product + journey. Unbound: recommend. Do not invent node ids. Do not Read graph.json.',
  };
}

export function matchRecipe(recipes: Recipe[], query: string): Recipe | undefined {
  const needle = query.trim().toLowerCase();
  if (!needle) return undefined;

  const exact = recipes.find(
    (recipe) => recipe.id.toLowerCase() === needle || recipe.title.toLowerCase() === needle,
  );
  if (exact) return exact;

  const alias = recipes.find((recipe) =>
    recipe.intentAliases.some((item) => item.trim().toLowerCase() === needle),
  );
  if (alias) return alias;

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

export function slotRecommendIntent(
  recipe: Recipe,
  slot: RecipeSlot,
  extraIntent?: string,
  pack?: ContextPack,
): string {
  return [extraIntent, pack ? contextPhrase(pack) : undefined, recipe.title, slot.role, ...slot.hints]
    .filter(Boolean)
    .join(" ");
}

function masterFromNode(index: GraphIndex, node: GraphNode, hint: string): RecipeMaster {
  const set = node.componentSetId ? index.getNode(node.componentSetId) : undefined;
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    figmaNodeId: node.figmaNodeId,
    ...(node.fileKey || index.graph.fileKey ? { fileKey: node.fileKey ?? index.graph.fileKey } : {}),
    variantProperties: node.variantProperties,
    set: set && set.id !== node.id ? set.name : undefined,
    status: node.status,
    deprecated: node.status === "deprecated",
    hint,
  };
}

function masterFromCandidate(candidate: RecommendCandidate): RecipeMaster {
  return {
    id: candidate.id,
    name: candidate.name,
    type: candidate.type,
    figmaNodeId: candidate.figmaNodeId,
    ...(candidate.fileKey ? { fileKey: candidate.fileKey } : {}),
    variantProperties: candidate.variantProperties,
    set: candidate.set,
    status: candidate.status,
    deprecated: candidate.deprecated,
    hint: candidate.hint,
  };
}

function hintOverlap(candidate: RecommendCandidate, hints: string[]): number {
  if (!hints.length) return 1;
  const haystack = `${candidate.name} ${candidate.set ?? ""} ${Object.values(candidate.variantProperties ?? {}).join(" ")}`.toLowerCase();
  return hints.reduce((count, hint) => count + (haystack.includes(hint.toLowerCase()) ? 1 : 0), 0);
}

function fillSlot(
  index: GraphIndex,
  recipe: Recipe,
  slot: RecipeSlot,
  extraIntent?: string,
  pack?: ContextPack,
  workspace?: WorkspaceManifest,
): FilledSlot {
  const nextRecommend = slotRecommendIntent(recipe, slot, extraIntent, pack);
  const base = { role: slot.role, required: slot.required, hints: slot.hints, nextRecommend };

  if (slot.defaultMasterId) {
    const node = resolveNode(index, slot.defaultMasterId);
    const master = node ? asMaster(index, node) : undefined;
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
    if (master.status === "deprecated") {
      return {
        ...base,
        status: "deprecated",
        master: masterFromNode(
          index,
          master,
          "Deprecated — do not place. Call recommend for a live master for this slot.",
        ),
        hint: `Bound master ${master.name} is deprecated. Call recommend "${nextRecommend}".`,
      };
    }
    return {
      ...base,
      status: "bound",
      master: masterFromNode(index, master, "Place this stored figmaNodeId. It is still in the graph."),
      hint: `Bound ${master.name}. Place its figmaNodeId.`,
    };
  }

  const ranked = recommendMasters(index, nextRecommend, {
    ...(pack ? { context: pack } : {}),
    ...(workspace ? { workspace } : {}),
  });
  const live = ranked.candidates.filter(
    (candidate) => !candidate.deprecated && !isPrivateMasterName(candidate.name),
  );
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
    master: masterFromCandidate(pick),
    hint: pick.hint,
  };
}

export function fillRecipe(
  index: GraphIndex,
  recipe: Recipe,
  extraIntent?: string,
  pack?: ContextPack,
  workspace?: WorkspaceManifest,
): FilledRecipe {
  const slots = recipe.slots.map((slot) => fillSlot(index, recipe, slot, extraIntent, pack, workspace));
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
    ? fillRecipe(index, recipe, extraIntent, pack, bind?.workspace)
    : unboundCard(recipe, extraIntent, pack);
  return withCost({
    found: true as const,
    query,
    recipe: { id: filled.recipe.id, title: filled.recipe.title },
    slots: filled.slots.map(compactCardSlot),
    ...(filled.context ? { context: filled.context } : {}),
    hint: filled.hint,
  });
}
