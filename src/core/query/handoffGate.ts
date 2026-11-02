/**
 * Handoff (the developer build sheet) is beyond the readiness check, so it is opt-in:
 * `RESOLVE_HANDOFF=1` turns on `resolve handoff` and the `get_handoff` MCP tool. The code stays.
 */
export const handoffEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env["RESOLVE_HANDOFF"]?.trim() === "1";

export const HANDOFF_OFF = {
  warning: "handoff is off by default. Resolve stops at the readiness check (resolve brief check).",
  next: "use resolve parts for each component on a screen and its code; set RESOLVE_HANDOFF=1 to turn the handoff sheet on.",
} as const;

export const handoffOffText = () => `warning: ${HANDOFF_OFF.warning}\nnext: ${HANDOFF_OFF.next}\n`;
