import type { GraphIndex } from "./GraphIndex";
import {
  BindRuleError,
  emptyBindRules,
  mergeBindRules,
  parseBindRulesFile,
  parseOne,
  requireHasScope,
  resolveBindRules,
  resolveRequireMaster,
  ruleLabel,
  type AuditLine,
  type BindRule,
  type BindRuleWarning,
  type BindRulesFile,
} from "./bindRules";
import { isRemovedByAbsence, type SociProposal, type SockState } from "./sock";
import type { WorkspaceManifest } from "./workspace";

const WARNING_OVERFLOW = (count: number) => `and ${count} more warnings`;

/**
 * Quarantine warnings count toward the agent card budget. Truncate extras with
 * "and K more warnings" rather than overflowing the cap.
 */
export function fitBindRuleWarnings(
  warnings: BindRuleWarning[] | undefined,
  base: object,
  budgetChars: number,
): { bindRuleWarnings?: BindRuleWarning[]; warningNote?: string } {
  if (!warnings?.length) return {};
  const sizeOf = (count: number, note?: string) =>
    JSON.stringify({
      ...base,
      ...(count ? { bindRuleWarnings: warnings.slice(0, count) } : {}),
      ...(note ? { warningNote: note } : {}),
    }).length;

  if (sizeOf(warnings.length) <= budgetChars) {
    return { bindRuleWarnings: warnings };
  }

  let keep = warnings.length;
  while (keep > 0 && sizeOf(keep, keep < warnings.length ? WARNING_OVERFLOW(warnings.length - keep) : undefined) > budgetChars) {
    keep -= 1;
  }
  if (keep <= 0) {
    const leftover = warnings.length;
    if (JSON.stringify({ ...base, warningNote: WARNING_OVERFLOW(leftover) }).length <= budgetChars) {
      return { warningNote: WARNING_OVERFLOW(leftover) };
    }
    return {};
  }
  const more = warnings.length - keep;
  return more
    ? { bindRuleWarnings: warnings.slice(0, keep), warningNote: WARNING_OVERFLOW(more) }
    : { bindRuleWarnings: warnings.slice(0, keep) };
}

export function rulesEquivalent(left: BindRule, right: BindRule): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "require": {
      if (right.kind !== "require") return false;
      const leftNeedle = (left.requireId ?? left.require).toLowerCase();
      const rightNeedle = (right.requireId ?? right.require).toLowerCase();
      const leftName = (left.requireName ?? left.require).toLowerCase();
      const rightName = (right.requireName ?? right.require).toLowerCase();
      const sameTarget =
        leftNeedle === rightNeedle ||
        leftName === rightName ||
        left.require.toLowerCase() === right.require.toLowerCase();
      return (
        sameTarget &&
        (left.screenType ?? "").toLowerCase() === (right.screenType ?? "").toLowerCase() &&
        (left.slot ?? "").toLowerCase() === (right.slot ?? "").toLowerCase() &&
        (left.journey ?? "").toLowerCase() === (right.journey ?? "").toLowerCase() &&
        (left.product ?? "").toLowerCase() === (right.product ?? "").toLowerCase() &&
        (left.pack ?? "").toLowerCase() === (right.pack ?? "").toLowerCase()
      );
    }
    case "forbid":
      return right.kind === "forbid" && left.forbid.toLowerCase() === right.forbid.toLowerCase();
    case "prefer":
      return (
        right.kind === "prefer" &&
        left.prefer.toLowerCase() === right.prefer.toLowerCase() &&
        left.over.toLowerCase() === right.over.toLowerCase() &&
        (left.masterId ?? "") === (right.masterId ?? "") &&
        (left.overMasterId ?? "") === (right.overMasterId ?? "") &&
        (left.screenType ?? "").toLowerCase() === (right.screenType ?? "").toLowerCase() &&
        (left.slot ?? "").toLowerCase() === (right.slot ?? "").toLowerCase()
      );
    default: {
      const _exhaustive: never = left;
      return _exhaustive;
    }
  }
}

export function assertRuleWritable(
  rule: BindRule,
  options: {
    index?: GraphIndex;
    workspace?: WorkspaceManifest;
    sock?: SockState;
    existing?: BindRulesFile;
  } = {},
): BindRule {
  if (options.existing?.rules.some((row) => rulesEquivalent(row, rule))) {
    throw new BindRuleError(`Bind rule ${ruleLabel(rule)}: duplicate rule. Already in bind-rules.json.`);
  }
  switch (rule.kind) {
    case "require": {
      if (!requireHasScope(rule)) {
        throw new BindRuleError(
          `Bind rule ${ruleLabel(rule)}: unscoped require is invalid. Need screenType, slot, journey, product, or pack. Never guessing.`,
        );
      }
      if (!options.index) {
        throw new BindRuleError(
          `Bind rule ${ruleLabel(rule)}: cannot approve without a graph. Ingest first. Never guessing.`,
        );
      }
      const master = resolveRequireMaster(options.index, rule.require, `Bind rule ${ruleLabel(rule)}`);
      if (master.status === "deprecated") {
        throw new BindRuleError(
          `Bind rule ${ruleLabel(rule)}: master "${master.name}" (${master.id}) is deprecated. Never guessing.`,
        );
      }
      if (isRemovedByAbsence(options.sock, master) || master.metadata?.["removedByAbsence"] === true) {
        throw new BindRuleError(
          `Bind rule ${ruleLabel(rule)}: master "${master.name}" (${master.id}) was removed. Never guessing.`,
        );
      }
      return { ...rule, require: rule.require, requireId: master.id, requireName: master.name };
    }
    case "forbid":
      return rule;
    case "prefer": {
      if (!options.workspace?.files.length) return rule;
      return resolveBindRules({ version: 1, rules: [rule] }, { workspace: options.workspace }).rules[0]!;
    }
    default: {
      const _exhaustive: never = rule;
      return _exhaustive;
    }
  }
}

function resolveOneLenient(
  rule: BindRule,
  options: { index?: GraphIndex; workspace?: WorkspaceManifest; sock?: SockState },
): { rule?: BindRule; warning?: BindRuleWarning } {
  try {
    if (rule.kind === "require" && !requireHasScope(rule)) {
      return {
        warning: {
          rule: ruleLabel(rule),
          reason: "unscoped require is invalid. Need screenType, slot, journey, product, or pack.",
        },
      };
    }
    if (rule.kind === "require" && options.index) {
      const master = resolveRequireMaster(options.index, rule.require, `Bind rule ${ruleLabel(rule)}`);
      if (master.status === "deprecated") {
        return {
          warning: {
            rule: ruleLabel(rule),
            reason: `master "${master.name}" (${master.id}) is deprecated`,
          },
        };
      }
      if (isRemovedByAbsence(options.sock, master) || master.metadata?.["removedByAbsence"] === true) {
        return {
          warning: {
            rule: ruleLabel(rule),
            reason: `master "${master.name}" (${master.id}) was removed`,
          },
        };
      }
      return { rule: { ...rule, requireId: master.id, requireName: master.name } };
    }
    if (rule.kind === "prefer" && options.workspace?.files.length) {
      return { rule: resolveBindRules({ version: 1, rules: [rule] }, { workspace: options.workspace }).rules[0] };
    }
    return { rule };
  } catch (error) {
    return {
      warning: {
        rule: ruleLabel(rule),
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** Load-time parse: skip invalid rules, keep the rest, name each skip. */
export function loadBindRulesLenient(
  raw: unknown,
  options: { index?: GraphIndex; workspace?: WorkspaceManifest; sock?: SockState } = {},
): BindRulesFile {
  const warnings: BindRuleWarning[] = [];
  if (raw == null) return emptyBindRules();
  let list: unknown[];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    const rules = record["rules"] ?? record["bindRules"];
    if (rules == null) return emptyBindRules();
    if (!Array.isArray(rules)) {
      return {
        version: 1,
        rules: [],
        warnings: [{ rule: "bind-rules.json", reason: "`rules` must be an array. Never guessing." }],
      };
    }
    list = rules;
  } else {
    return {
      version: 1,
      rules: [],
      warnings: [{ rule: "bind-rules.json", reason: "must be a JSON object or array. Never guessing." }],
    };
  }
  const kept: BindRule[] = [];
  list.forEach((item, index) => {
    try {
      const parsed = parseOne(item, index);
      const resolved = resolveOneLenient(parsed, options);
      if (resolved.warning) warnings.push(resolved.warning);
      if (resolved.rule) kept.push(resolved.rule);
    } catch (error) {
      warnings.push({
        rule: `rule ${index + 1}`,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  });
  return { version: 1, rules: kept, ...(warnings.length ? { warnings } : {}) };
}

export function requirePendingProposal(sock: SockState, proposalId: string): SociProposal {
  const proposal = sock.proposals.find((row) => row.id === proposalId);
  if (!proposal) {
    throw new BindRuleError(`Proposal "${proposalId}" not found.`);
  }
  if (proposal.status !== "pending") {
    throw new BindRuleError(`Proposal "${proposalId}" is already ${proposal.status}.`);
  }
  return proposal;
}

export function applyProposalDecision(
  sock: SockState, rules: BindRulesFile, proposalId: string,
  action: "approve" | "reject", who: string, when: string,
  options: { index?: GraphIndex; workspace?: WorkspaceManifest } = {},
): { sock: SockState; rules: BindRulesFile; audit: AuditLine } {
  const proposal = requirePendingProposal(sock, proposalId);
  const before = rules.rules;
  let after = before;
  let nextRules = rules;
  if (action === "approve") {
    const suggested = proposal.suggestedRule;
    if (!suggested) {
      throw new BindRuleError(
        `Proposal "${proposalId}" has no suggested rule. Write bind-rules.json by hand.`,
      );
    }
    const parsed = parseBindRulesFile({ rules: [suggested] });
    const written = parsed.rules.map((rule) =>
      assertRuleWritable(rule, {
        index: options.index,
        workspace: options.workspace,
        sock,
        existing: rules,
      }),
    );
    nextRules = mergeBindRules(rules, { version: 1, rules: written });
    after = nextRules.rules;
  }
  const nextProposals: SociProposal[] = sock.proposals.map((row) =>
    row.id === proposalId ? { ...row, status: action === "approve" ? "approved" : "rejected" } : row,
  );
  return {
    sock: { ...sock, proposals: nextProposals },
    rules: nextRules,
    audit: {
      who,
      when,
      proposalId,
      action,
      before,
      after,
    },
  };
}

export function actorName(flag?: string, env: NodeJS.ProcessEnv = process.env): string {
  return flag?.trim() || env["RESOLVE_ACTOR"]?.trim() || env["USER"]?.trim() || "human";
}
