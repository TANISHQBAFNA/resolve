import {
  briefAnswerParts,
  briefAnswers,
  recordFromBrief,
  recordFromCompose,
  recordFromHandoff,
  type BriefResult,
  type ComposeCardLike,
  type DecisionRecord,
  type HandoffPack,
} from "@/core/query";
import { aidlcFromFolder, readDecision, storeDecision } from "./decisionCommand";
import { resolveGraph } from "./store";

/** Advanced MCP tools for decision records and the AIDLC export. Default tools do not change. */
export const DECISION_TOOLS = [
  {
    name: "decision_record",
    description:
      "Read a decision record back: what was asked, which parts were picked and why, what was rejected, and the recipe. Pass the path a brief, recipe compose or get_handoff call returned as decisionRecord, or a handoff folder's decision.json. Advanced surface.",
    inputSchema: { type: "object", properties: { ref: { type: "string", description: "Record path, file name or slug." } }, required: ["ref"] },
  },
  {
    name: "export_aidlc",
    description:
      "Opt-in AIDLC hook. Turns a handoff --out folder (handoff.json + decision.json) into the resolve.aidlc schemaVersion 1 contract: requirementsContext in, designHandoff out. Reads files only; never runs a handoff. Advanced surface.",
    inputSchema: { type: "object", properties: { folder: { type: "string", description: "A folder written by resolve handoff --out." } }, required: ["folder"] },
  },
];

/** `record` on brief, recipe (compose) and get_handoff. */
export const RECORD_PROPERTY = {
  record: { type: "boolean", description: "Advanced only. Write a decision record (.resolve/decisions/<kind>-<slug>.json and .md) and return its path as decisionRecord." },
};

export const RECORD_TOOLS = new Set(["brief", "recipe", "get_handoff"]);

export function runDecisionTool(name: string, args: Record<string, unknown>): unknown {
  if (name === "decision_record") return readDecision(String(args["ref"] ?? ""));
  return aidlcFromFolder(String(args["folder"] ?? ""));
}

/** What `record` asks for, or why it is wrong. */
export function recordProblem(name: string, args: Record<string, unknown>): string | undefined {
  if (args["record"] === undefined) return undefined;
  if (typeof args["record"] !== "boolean") return "record must be true or false.";
  if (!RECORD_TOOLS.has(name)) return `record works on ${[...RECORD_TOOLS].join(", ")}.`;
  return undefined;
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

function contextOf(args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["pack", "product", "journey", "domain", "audience", "a11y"]) {
    const value = text(args[key]);
    if (value) out[key] = value;
  }
  return out;
}

function build(name: string, args: Record<string, unknown>, result: unknown, createdAt: string): DecisionRecord | undefined {
  const answers = briefAnswers(args["answers"]);
  if (name === "brief") {
    const request = text(args["request"] ?? args["intent"] ?? args["query"]) ?? "";
    const index = resolveGraph(text(args["graphId"]))?.index;
    const answerParts = index ? briefAnswerParts(answers, index) : [];
    return recordFromBrief({ request, ...(answers ? { answers } : {}), answerParts, context: contextOf(args), result: result as BriefResult, createdAt });
  }
  if (name === "recipe") {
    if (args["compose"] !== true) return undefined;
    const request = text(args["query"] ?? args["name"] ?? args["recipe"] ?? args["intent"]) ?? "";
    return recordFromCompose({ request, ...(answers ? { answers } : {}), card: result as ComposeCardLike, createdAt });
  }
  const pack = result as HandoffPack;
  return pack.ok ? recordFromHandoff({ pack, ...(answers ? { answers } : {}), createdAt }) : undefined;
}

/** With record: true (advanced), store the record and add only its path, so the card budgets hold. */
export function withDecisionRecord(name: string, args: Record<string, unknown>, result: unknown, advanced: boolean): unknown {
  if (args["record"] !== true || !result || typeof result !== "object") return result;
  if (!advanced) return { ...result, decisionRecord: "Recording needs the advanced surface (RESOLVE_MCP_ADVANCED=1)." };
  const record = build(name, args, result, new Date().toISOString());
  if (!record) return { ...result, decisionRecord: "Nothing to record (no compose, or the handoff was refused)." };
  return { ...result, decisionRecord: storeDecision(record) };
}
