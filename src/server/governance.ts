import { ruleLabel, whyLine, type BindRule, type BindRuleWarning } from "@/core/query/bindRules";
import { patternsOf, type SockState } from "@/core/query/sock";
import { groupSociProposals, pendingImprovementCount } from "@/core/query/soci";
import { loadSock, readBindRules } from "./store";

export interface GovernanceView {
  rules: Array<BindRule & { label: string }>;
  proposals: NonNullable<SockState["proposals"]>;
  proposalGroups: ReturnType<typeof groupSociProposals>;
  pendingImprovements: number;
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
  const sock = loadSock() ?? { version: 1 as const, threshold: 3, facts: [], freshness: {}, proposals: [], corrections: [] };
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
  const pending = pendingImprovementCount(sock);
  return {
    rules: rules.rules.map((rule) => ({ ...rule, label: ruleLabel(rule) })),
    proposals: sock.proposals,
    proposalGroups: groupSociProposals(sock.proposals),
    pendingImprovements: pending,
    patterns,
    warnings: [
      ...(rules.warnings ?? []),
      ...(sock.warnings ?? []).map((reason) => ({ rule: "sock.json", reason })),
    ],
    hint: pending
      ? `Read-only. pending improvements: ${pending}. Write bind-rules.json / recipes.json yourself, or resolve approve <id> --who <name>. SOCI never auto-applies.`
      : "Read-only. Write bind-rules.json yourself, or resolve approve <id> --who <name> for a pending proposal. SOCI never auto-applies.",
  };
}
