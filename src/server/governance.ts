import { ruleLabel, whyLine, type BindRule, type BindRuleWarning } from "@/core/query/bindRules";
import { patternsOf, type DsckState } from "@/core/query/dsck";
import { groupDsciProposals, pendingImprovementCount } from "@/core/query/dsci";
import { loadDsck, readBindRules } from "./store";

export interface GovernanceView {
  rules: Array<BindRule & { label: string }>;
  proposals: NonNullable<DsckState["proposals"]>;
  proposalGroups: ReturnType<typeof groupDsciProposals>;
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
  const dsck = loadDsck() ?? { version: 1 as const, threshold: 3, facts: [], freshness: {}, proposals: [], corrections: [] };
  const patterns = patternsOf(dsck).map((row) => ({
    masterId: row.masterId,
    name: row.name,
    screens: row.screens.length,
    confidence: row.confidence,
    why: whyLine({
      usageScreens: row.screens.length,
      confidence: row.confidence,
    }),
  }));
  const pending = pendingImprovementCount(dsck);
  return {
    rules: rules.rules.map((rule) => ({ ...rule, label: ruleLabel(rule) })),
    proposals: dsck.proposals,
    proposalGroups: groupDsciProposals(dsck.proposals),
    pendingImprovements: pending,
    patterns,
    warnings: [
      ...(rules.warnings ?? []),
      ...(dsck.warnings ?? []).map((reason) => ({ rule: "dsck.json", reason })),
    ],
    hint: pending
      ? `Read-only. pending improvements: ${pending}. Write bind-rules.json / recipes.json yourself, or resolve approve <id> --who <name>. DSCI never auto-applies.`
      : "Read-only. Write bind-rules.json yourself, or resolve approve <id> --who <name> for a pending proposal. DSCI never auto-applies.",
  };
}
