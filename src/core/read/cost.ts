/** Char cost attached to every agent payload. */


/**
 * Agent-facing graph surface. Graph stays on disk. Agents call resolve /
 * recommend / recipe / verify_frame — never Read
 * graph.json. Every MCP payload carries a char cost.
 */

export interface AgentCost {
  chars: number;
  approxTokens: number;
}
export function costOf(value: unknown): AgentCost {
  const chars = JSON.stringify(value).length;
  return { chars, approxTokens: Math.ceil(chars / 4) };
}
export function withCost<T extends object>(payload: T): T & { cost: AgentCost } {
  return { ...payload, cost: costOf(payload) };
}
