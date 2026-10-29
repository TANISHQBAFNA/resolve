import {
  advanceSoci,
  checkCousins,
  exampleFactForMasterOnFrame,
  harvestOverrideKeysForFrame,
  isPrivateMasterName,
  isRealVerifiedFrame,
  jobOfName,
  packForRecommend,
  recordCousinCorrections,
  recordVerifiedUsage,
  topLevelMasterIds,
  verifyFrame,
  type ContextBind,
  type GraphIndex,
  type Recipe,
} from "@/core/query";
import { hiddenUnder } from "@/core/query/placed";
import { loadRecipes, readPlaceholders, readSock, readWorkspace, saveSock } from "./store";

function recipeAlreadyEncodes(pattern: { masterId: string; name: string }, recipes: Recipe[]): boolean {
  return recipes.some((recipe) =>
    recipe.slots.some(
      (slot) => slot.defaultMasterId === pattern.masterId || slot.defaultMasterId === pattern.name,
    ),
  );
}

/**
 * Save a passing verify to SOCK: usage facts, cousin corrections, SOCI proposals. MCP verify_frame and CLI verify both
 * call this, so a frame checked from the command line (a delivery-process design-check) counts as a mapped screen too.
 * Only real frames count toward patterns. The screen job comes from the journey, else the domain, else the frame name.
 */
export function recordVerifyUsage(
  index: GraphIndex,
  result: ReturnType<typeof verifyFrame>,
  input: {
    frame?: string;
    components?: string[];
    bind: ContextBind;
    slot?: string;
    journey?: string;
    product?: string;
    pack?: string;
    domain?: string;
  },
): void {
  if (!result.pass) return;
  const { frame, components, bind } = input;
  const pack = packForRecommend(bind);
  const masters: Array<{
    id: string;
    name: string;
    fileKey?: string;
    figmaNodeId?: string;
    deprecated?: boolean;
    private?: boolean;
  }> = [];
  for (const row of result.resolved) {
    if (!row.id) continue;
    const node = index.getNode(row.id);
    if (!node) continue;
    masters.push({
      id: node.id,
      name: node.name,
      fileKey: row.fileKey,
      figmaNodeId: node.figmaNodeId,
      deprecated: node.status === "deprecated",
      private: isPrivateMasterName(node.name),
    });
  }
  if (result.frame) {
    for (const instance of index.getNestedInstances(result.frame.id)) {
      if (hiddenUnder(index, instance, result.frame.id)) continue;
      const main = index.getMainComponent(instance.id);
      if (!main || masters.some((row) => row.id === main.id)) continue;
      masters.push({
        id: main.id,
        name: main.name,
        fileKey: main.fileKey,
        figmaNodeId: main.figmaNodeId,
        deprecated: main.status === "deprecated",
        private: isPrivateMasterName(main.name),
      });
    }
  }
  if (masters.length) {
    const realFrame = isRealVerifiedFrame(result.frame);
    const frameId = result.frame?.figmaNodeId ?? result.frame?.id;
    const screenId = realFrame
      ? `${result.frame!.fileKey}:${frameId}`
      : `obs:${(components ?? []).slice().sort().join(",") || "list"}`;
    const harvested =
      realFrame && result.frame?.id ? harvestOverrideKeysForFrame(index, result.frame.id) : new Map<string, string[]>();
    const slotArg = input.slot;
    const topLevel = result.frame?.id ? new Set(topLevelMasterIds(index, result.frame.id)) : undefined;
    const mastersWithOverrides = masters.map((master) => {
      const keys = harvested.get(master.id);
      const withKeys = keys?.length ? { ...master, overrideKeys: keys } : master;
      const example = result.frame?.id
        ? exampleFactForMasterOnFrame(index, result.frame.id, master.id, readPlaceholders())
        : undefined;
      const withExample = example ? { ...withKeys, ...example } : withKeys;
      const placed = topLevel && !topLevel.has(master.id) ? { ...withExample, nested: true } : withExample;
      if (!slotArg) return placed;
      if (topLevel) {
        return topLevel.has(master.id) ? { ...placed, slot: slotArg } : placed;
      }
      return { ...placed, slot: slotArg };
    });
    const journeyArg = input.journey;
    const screenName = result.frame?.name ?? frame ?? "observation";
    const job = realFrame ? (jobOfName(journeyArg) ?? jobOfName(input.domain) ?? jobOfName(screenName)) : undefined;
    let next = recordVerifiedUsage(readSock(), {
      screenId,
      screenName,
      masters: mastersWithOverrides,
      ...(job ? { job } : {}),
      journey: journeyArg,
      product: input.product,
      pack: input.pack,
      frameId: realFrame ? frameId : undefined,
      countsTowardThreshold: realFrame,
    });
    if (realFrame && result.frame) {
      const cousinReport = checkCousins(index, {
        frame: result.frame.id,
        recipes: loadRecipes(),
        context: pack,
        workspace: bind.workspace ?? readWorkspace(),
      });
      const hits = (cousinReport.cousins ?? [])
        .filter((hit) => hit.confidence === "cousin" && hit.expected)
        .map((hit) => ({
          fromId: hit.placed.id,
          fromName: hit.placed.name,
          fromFileKey: hit.placed.fileKey,
          toId: hit.expected!.id,
          toName: hit.expected!.name,
          toFileKey: hit.expected!.fileKey,
        }));
      next = recordCousinCorrections(next, {
        screenId,
        screenName: result.frame.name ?? frame ?? "frame",
        frameId,
        fileKey: result.frame.fileKey,
        hits,
      });
    }
    saveSock(
      advanceSoci(next, {
        recipes: loadRecipes(),
        index,
        workspace: bind.workspace ?? readWorkspace(),
        alreadyEncoded: (pattern) => recipeAlreadyEncodes(pattern, loadRecipes()),
      }),
    );
  }
}
