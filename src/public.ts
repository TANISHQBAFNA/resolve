/**
 * Public API for an optional add-on under addons/.
 * An add-on may import this module, read the handoff pack files (handoff.json, decision.json),
 * and use the exit codes below. Core never imports from addons/.
 */
export {
  BriefAnswerIdsSchema,
  DecisionPickSchema,
  DecisionRejectSchema,
  parseDecisionRecord,
  recordFromHandoff,
  type DecisionPick,
  type DecisionRecord,
} from "./core/query/decisionRecord";

export type { HandoffComponent, HandoffPack, HandoffScreen } from "./core/query/handoff";

export { flag, positionals, printJson, withJsonErrors } from "./server/cliArgs";

export { withCost } from "./core/query/cost";

/** CLI process status. 0 is a written export. 1 is a refused export or a file that could not be written. */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
