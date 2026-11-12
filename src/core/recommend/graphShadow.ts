import type { GraphIndex } from "../read/GraphIndex";
import type { DsckState } from "../codeKnowledge/dsck";
import type { RecommendContext } from "./recommendSupport";
import { resolveByGraph, type GraphLead } from "./graphResolver";
import { recordShadowReport } from "./graphShadowReport";

/**
 * Internal switch. Off unless RESOLVE_GRAPH_SHADOW=1.
 * The lead is stored aside and is not part of any card, CLI line, or MCP payload.
 * RESOLVE_GRAPH_SHADOW_REPORT=<path> appends one JSON line per recommend, and only when the shadow is on.
 */

const BLOCKED_REPORT = new Set(["-", "/dev/stdout", "/dev/stderr", "/dev/fd/1", "/dev/fd/2"]);

export function graphShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["RESOLVE_GRAPH_SHADOW"] === "1";
}

/** Report path. Undefined unless the shadow is on and the path is a real file path. */
export function graphShadowReportPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!graphShadowEnabled(env)) return undefined;
  const raw = env["RESOLVE_GRAPH_SHADOW_REPORT"];
  if (typeof raw !== "string") return undefined;
  const path = raw.trim();
  if (!path || BLOCKED_REPORT.has(path.toLowerCase())) return undefined;
  return path;
}

let last: GraphLead | undefined;

export function readGraphShadow(): GraphLead | undefined {
  return last;
}

export function noteGraphShadow(
  index: GraphIndex,
  ask: string,
  options: { dsck?: DsckState; context?: RecommendContext } = {},
  card?: unknown,
): void {
  if (!graphShadowEnabled()) return;
  try {
    last = resolveByGraph(index, ask, { dsck: options.dsck, context: options.context });
  } catch {
    last = undefined;
  }
  const path = graphShadowReportPath();
  if (!path) return;
  recordShadowReport(path, { index, ask, lead: last, card, context: options.context, dsck: options.dsck });
}
