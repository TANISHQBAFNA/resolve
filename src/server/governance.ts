import { ruleLabel, whyLine, type BindRule, type BindRuleWarning } from "@/core/query/bindRules";
import { patternsOf, type SockState } from "@/core/query/sock";
import { loadSock, readBindRules } from "./store";

export interface GovernanceView {
  rules: Array<BindRule & { label: string }>;
  proposals: NonNullable<SockState["proposals"]>;
  patterns: Array<{
    masterId: string;
    name: string;
    screens: number;
    confidence: string;
    why: string;
  }>;
  warnings: BindRuleWarning[];
  hint: string;
}

/** Read-only snapshot for the human rules page. Never dumps the graph. */
export function governanceView(): GovernanceView {
  const rules = readBindRules();
  const sock = loadSock() ?? { version: 1 as const, threshold: 3, facts: [], freshness: {}, proposals: [] };
  const patterns = patternsOf(sock).map((row) => ({
    masterId: row.masterId,
    name: row.name,
    screens: row.screens.length,
    confidence: row.confidence,
    why: whyLine({
      usageScreens: row.screens.length,
      confidence: row.confidence,
    }),
  }));
  return {
    rules: rules.rules.map((rule) => ({ ...rule, label: ruleLabel(rule) })),
    proposals: sock.proposals,
    patterns,
    warnings: rules.warnings ?? [],
    hint: "Read-only. Write bind-rules.json yourself, or resolve approve <id> --who <name> for a pending proposal. Rules never auto-change.",
  };
}
