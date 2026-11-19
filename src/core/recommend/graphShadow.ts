import type { GraphIndex } from "../read/GraphIndex";
import type { DsckState } from "../codeKnowledge/dsck";
import type { RecommendContext } from "./recommendSupport";
import { resolveByGraph, type GraphLead } from "./graphResolver";

/** The graph runs on every recommend. RESOLVE_GRAPH_SHADOW=0 turns the lead off. */
export function graphShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["RESOLVE_GRAPH_SHADOW"] !== "0";
}

let last: GraphLead | undefined;

export function readGraphShadow(): GraphLead | undefined {
  return last;
}

export function noteGraphShadow(
  index: GraphIndex,
  ask: string,
  options: { dsck?: DsckState; context?: RecommendContext } = {},
): GraphLead | undefined {
  if (!graphShadowEnabled()) {
    last = undefined;
    return undefined;
  }
  try {
    last = resolveByGraph(index, ask, { dsck: options.dsck, context: options.context });
  } catch {
    last = undefined;
  }
  return last;
}
