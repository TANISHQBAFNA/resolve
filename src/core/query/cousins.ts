import { COMPONENT_DEFINITION_TYPES, type GraphNode } from "@/core/model";
import {
  isNameInferredMaster,
  resolveNode,
  withCost,
  type RecommendContext,
} from "./agentSurface";
import type { GraphIndex } from "./GraphIndex";
import {
  fillRecipe,
  matchRecipe,
  starterRecipes,
  type Recipe,
} from "./recipes";
import type { ContextPack } from "./contextPacks";
import { libraryFiles, type WorkspaceManifest } from "./workspace";
import { nodeFileKey } from "./workspaceMerge";

/**
 * Wrong-cousin report. Same role / weak name, different master family than
 * the shared DS library. Refuse-over-guess — no invented expected masters.
 */

const MASTER_TYPES = new Set<string>(COMPONENT_DEFINITION_TYPES);

const GENERIC = new Set([
  "button",
  "btn",
  "cta",
  "input",
  "field",
  "card",
  "row",
  "icon",
  "avatar",
  "banner",
  "text",
  "label",
  "header",
  "title",
  "primary",
  "secondary",
  "tertiary",
]);

const tokensOf = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 1);

const isMaster = (node: GraphNode): boolean => MASTER_TYPES.has(node.type);

const asMaster = (index: GraphIndex, node: GraphNode): GraphNode | undefined => {
  if (isMaster(node)) return node;
  if (node.type === "COMPONENT_INSTANCE") return index.getMainComponent(node.id);
  return undefined;
};

function familyKey(node: GraphNode): string {
  if (node.componentSetId) return `set:${node.componentSetId}`;
  return `id:${node.id}`;
}

function sameFamily(a: GraphNode, b: GraphNode): boolean {
  if (a.id === b.id) return true;
  if (familyKey(a) === familyKey(b)) return true;
  if (a.figmaNodeId && a.figmaNodeId === b.figmaNodeId && a.fileKey && a.fileKey === b.fileKey) {
    return true;
  }
  return false;
}

function stamp(node: GraphNode, fallback?: string) {
  const fileKey = nodeFileKey(node, fallback);
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    ...(node.figmaNodeId ? { figmaNodeId: node.figmaNodeId } : {}),
    ...(fileKey ? { fileKey } : {}),
  };
}

function nameOverlap(a: GraphNode, b: GraphNode, extra: string[] = []): { shared: string[]; specific: string[] } {
  const left = new Set([...tokensOf(a.name), ...extra]);
  const right = new Set(tokensOf(`${b.name} ${b.componentSetId ?? ""}`));
  const shared = [...left].filter((token) => right.has(token));
  return { shared, specific: shared.filter((token) => !GENERIC.has(token)) };
}

function isLibraryMaster(
  node: GraphNode,
  workspace: WorkspaceManifest,
  index: GraphIndex,
  fallback?: string,
): boolean {
  const key = nodeFileKey(node, fallback);
  if (key) {
    const needle = key.toLowerCase();
    if (libraryFiles(workspace).some((file) => file.key.toLowerCase() === needle)) return true;
  }
  if (!node.libraryId) return false;
  const source = index.getNode(node.libraryId);
  if (!source) return false;
  const sourceKey =
    source.type === "FILE" ? (source.fileKey ?? source.id.replace(/^file:/, "")) : nodeFileKey(source);
  return Boolean(sourceKey && libraryFiles(workspace).some((file) => file.key.toLowerCase() === sourceKey.toLowerCase()));
}

function hintHit(node: GraphNode, setName: string | undefined, hints: string[]): number {
  const haystack = `${node.name} ${setName ?? ""}`.toLowerCase();
  return hints.reduce((count, hint) => count + (haystack.includes(hint.toLowerCase()) ? 1 : 0), 0);
}

export interface CousinHit {
  placed: ReturnType<typeof stamp>;
  role?: string;
  expected?: ReturnType<typeof stamp>;
  why: string;
  confidence: "cousin" | "unsure";
}

export interface CousinReport {
  checked: boolean;
  reason?: "no-library-file" | "no-placements" | "no-graph";
  frame?: ReturnType<typeof stamp>;
  cousins: CousinHit[];
  unsure: CousinHit[];
  ok: number;
  hint: string;
}

export function checkCousins(
  index: GraphIndex | undefined,
  input: {
    frame?: string;
    components?: string[];
    job?: string;
    recipes?: Recipe[];
    context?: RecommendContext;
    workspace?: WorkspaceManifest;
  } = {},
) {
  const workspace = input.workspace;
  if (!workspace || !libraryFiles(workspace).length) {
    return withCost({
      checked: false,
      reason: "no-library-file" as const,
      cousins: [] as CousinHit[],
      unsure: [] as CousinHit[],
      ok: 0,
      hint: "No library-role file in this workspace. Add the shared DS to .graphify/workspace.json and ingest it. Do not guess cousins. Do not Read graph.json.",
    });
  }
  if (!index) {
    return withCost({
      checked: false,
      reason: "no-graph" as const,
      cousins: [] as CousinHit[],
      unsure: [] as CousinHit[],
      ok: 0,
      hint: "Ingest the library and the product/client file first. Do not Read graph.json.",
    });
  }

  const fallback = index.graph.fileKey;
  const recipes = input.recipes ?? starterRecipes();
  const job = input.job?.trim() || input.context?.journey?.screenJob || input.context?.id;
  const recipe = job ? matchRecipe(recipes, job) : undefined;
  const pack = input.context?.id ? (input.context as ContextPack) : undefined;
  const filled = recipe ? fillRecipe(index, recipe, undefined, pack, workspace) : undefined;

  const placed: GraphNode[] = [];
  const seen = new Set<string>();
  const pushMaster = (master: GraphNode | undefined) => {
    if (!master || seen.has(master.id)) return;
    seen.add(master.id);
    placed.push(master);
  };

  let frameNode: GraphNode | undefined;
  if (input.frame?.trim()) {
    frameNode = resolveNode(index, input.frame.trim());
    if (frameNode) {
      for (const instance of index.getNestedInstances(frameNode.id)) {
        pushMaster(index.getMainComponent(instance.id));
      }
    }
  }
  for (const raw of input.components ?? []) {
    const node = resolveNode(index, raw.trim());
    if (!node) continue;
    pushMaster(asMaster(index, node));
  }

  if (!placed.length) {
    return withCost({
      checked: false,
      reason: "no-placements" as const,
      frame: frameNode ? stamp(frameNode, fallback) : undefined,
      cousins: [] as CousinHit[],
      unsure: [] as CousinHit[],
      ok: 0,
      hint: frameNode
        ? "Frame has no resolved instances to compare. Place library masters, then check again. Do not invent a cousin."
        : "Give a product/client frame or placed component names. Do not invent a cousin. Do not Read graph.json.",
    });
  }

  const libraryMasters = index
    .getNodesByType("COMPONENT_SET", "MAIN_COMPONENT", "VARIANT")
    .filter((node) => isLibraryMaster(node, workspace, index, fallback));

  const cousins: CousinHit[] = [];
  const unsure: CousinHit[] = [];
  let ok = 0;

  for (const master of placed) {
    if (isLibraryMaster(master, workspace, index, fallback)) {
      ok += 1;
      continue;
    }
    const placedName = master.name.trim().toLowerCase();
    // Guessed instance names (`mcp-name:`) are not a second master. A real local
    // copy with the same name is still a cousin of the library component.
    if (
      isNameInferredMaster(master) &&
      placedName &&
      libraryMasters.some((candidate) => candidate.name.trim().toLowerCase() === placedName)
    ) {
      ok += 1;
      continue;
    }

    const set = master.componentSetId ? index.getNode(master.componentSetId) : undefined;
    const slot = filled?.slots.find((row) => hintHit(master, set?.name, row.hints) > 0);
    const expectedFromSlot =
      slot?.master && slot.status !== "deprecated"
        ? index.getNode(slot.master.id)
        : undefined;
    const expectedLibrary =
      expectedFromSlot && isLibraryMaster(expectedFromSlot, workspace, index, fallback)
        ? expectedFromSlot
        : undefined;

    if (expectedLibrary && !sameFamily(master, expectedLibrary)) {
      cousins.push({
        placed: stamp(master, fallback),
        role: slot?.role,
        expected: stamp(expectedLibrary, fallback),
        why: "same role, different master family than the shared DS library",
        confidence: "cousin",
      });
      continue;
    }

    const scored = libraryMasters
      .map((candidate) => {
        const overlap = nameOverlap(master, candidate, set ? tokensOf(set.name) : []);
        const score = overlap.specific.length * 4 + overlap.shared.length;
        return { candidate, overlap, score };
      })
      .filter((row) => row.score > 0 && !sameFamily(master, row.candidate))
      .sort((a, b) => b.score - a.score || a.candidate.name.localeCompare(b.candidate.name));

    const top = scored[0];
    const runnerUp = scored[1];
    if (!top) {
      unsure.push({
        placed: stamp(master, fallback),
        why: "no confident library match — will not invent a master",
        confidence: "unsure",
      });
      continue;
    }
    if (top.overlap.specific.length === 0 && top.overlap.shared.length < 2) {
      unsure.push({
        placed: stamp(master, fallback),
        why: "name match is only a generic word — not sure this is a cousin",
        confidence: "unsure",
      });
      continue;
    }
    if (runnerUp && runnerUp.score === top.score) {
      unsure.push({
        placed: stamp(master, fallback),
        why: "several library masters match equally — not sure which family is expected",
        confidence: "unsure",
      });
      continue;
    }

    cousins.push({
      placed: stamp(master, fallback),
      role: slot?.role,
      expected: stamp(top.candidate, fallback),
      why: "same role or weak name match, different master family / file than the DS library",
      confidence: "cousin",
    });
  }

  const report: CousinReport = {
    checked: true,
    frame: frameNode ? stamp(frameNode, fallback) : undefined,
    cousins,
    unsure,
    ok,
    hint:
      cousins.length === 0 && unsure.length === 0
        ? "Placed masters match the shared DS library (or are the library). Do not Read graph.json."
        : cousins.length
          ? "Wrong cousin: place the expected library figmaNodeId (fileKey + id). Unsure rows are not guesses. Do not invent a master."
          : "Not sure — listed placements did not confidently match a library master. Do not invent one. Do not Read graph.json.",
  };
  return withCost(report);
}
