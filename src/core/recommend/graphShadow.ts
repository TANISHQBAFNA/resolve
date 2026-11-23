import type { GraphIndex } from "../read/GraphIndex";
import type { DsckState } from "../codeKnowledge/dsck";
import type { RecommendContext } from "./recommendSupport";
import { resolveByGraph, type GraphLead } from "./graphResolver";

/**
 * Internal switch. Off unless RESOLVE_GRAPH_SHADOW=1.
 * The lead is stored aside and is not part of any card, CLI line, or MCP payload.
 */
export function graphShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["RESOLVE_GRAPH_SHADOW"] === "1";
}

let last: GraphLead | undefined;

export function readGraphShadow(): GraphLead | undefined {
  return last;
}

export function noteGraphShadow(
  index: GraphIndex,
  ask: string,
  options: { dsck?: DsckState; context?: RecommendContext } = {},
): void {
  if (!graphShadowEnabled()) return;
  try {
    last = resolveByGraph(index, ask, { dsck: options.dsck, context: options.context });
  } catch {
    last = undefined;
  }
}
