import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyProposalDecision,
  parseBindRulesFile,
  serializeBindRulesFile,
} from "@/core/query/bindRules";
import {
  emptyDsck,
  newlyStrongPatterns,
  proposeRuleChange,
  proposeStrongPatterns,
  recordVerifiedUsage,
} from "@/core/query/dsck";
import { indexGraph, recommendMasters, verifyFrame } from "@/core/query";
import { clearCache, commitProposalDecision, readBindRules, saveGraph, saveDsck } from "@/server/store";
import { governanceView } from "@/server/governance";
import { runCli } from "@/server/cli";
import { callTool, listToolDefinitions, ToolError } from "@/server/tools";
import { graph, ids, index as demo } from "./fixture";

describe("approve / reject proposal", () => {
  const previousHome = process.env["RESOLVE_HOME"];
  const previousAdvanced = process.env["RESOLVE_MCP_ADVANCED"];

  beforeEach(() => {
    process.env["RESOLVE_HOME"] = mkdtempSync(join(tmpdir(), "resolve-approve-"));
    delete process.env["RESOLVE_MCP_ADVANCED"];
    clearCache();
    saveGraph(graph);
  });

  afterEach(() => {
    clearCache();
    if (previousHome === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previousHome;
    if (previousAdvanced === undefined) delete process.env["RESOLVE_MCP_ADVANCED"];
    else process.env["RESOLVE_MCP_ADVANCED"] = previousAdvanced;
  });

  it("approve writes the rules file and an audit line", () => {
    let dsck = emptyDsck();
    dsck = proposeRuleChange(dsck, "Require Card on payment", "strong on 3 screens", {
      screenType: "payment",
      slot: "primary-action",
      require: ids.card,
    });
    const proposalId = dsck.proposals[0]!.id;
    const before = parseBindRulesFile({ rules: [] });
    const decided = applyProposalDecision(
      dsck,
      before,
      proposalId,
      "approve",
      "tanishk",
      "2026-09-27T00:00:00.000Z",
      { index: demo },
    );
    expect(decided.dsck.proposals[0]?.status).toBe("approved");
    expect(decided.rules.rules).toHaveLength(1);
    expect(decided.rules.rules[0]).toMatchObject({
      kind: "require",
      require: ids.card,
      slot: "primary-action",
    });
    expect(decided.audit).toEqual({
      who: "tanishk",
      when: "2026-09-27T00:00:00.000Z",
      proposalId,
      action: "approve",
      before: [],
      after: decided.rules.rules,
    });

    commitProposalDecision(decided);
    expect(readBindRules().rules).toHaveLength(1);
    const auditPath = join(process.env["RESOLVE_HOME"]!, "bind-rules.audit.jsonl");
    expect(existsSync(auditPath)).toBe(true);
    const line = JSON.parse(readFileSync(auditPath, "utf8").trim()) as { who: string; proposalId: string };
    expect(line.who).toBe("tanishk");
    expect(line.proposalId).toBe(proposalId);
    const onDisk = JSON.parse(readFileSync(join(process.env["RESOLVE_HOME"]!, "bind-rules.json"), "utf8")) as {
      rules: Array<Record<string, unknown>>;
    };
    expect(onDisk.rules[0]).toEqual({
      screenType: "payment",
      slot: "primary-action",
      require: ids.card,
    });
    expect(onDisk.rules[0]).not.toHaveProperty("kind");
    expect(onDisk.rules[0]).not.toHaveProperty("requireId");
    expect(onDisk.rules[0]).not.toHaveProperty("requireName");
  });

  it("reject leaves rules unchanged and still audits", () => {
    let dsck = emptyDsck();
    dsck = proposeRuleChange(dsck, "Require Pay CTA", "strong on 3 screens", {
      require: "node:live",
    });
    const existing = parseBindRulesFile({
      rules: [{ forbid: "deprecated" }],
    });
    const decided = applyProposalDecision(
      dsck,
      existing,
      dsck.proposals[0]!.id,
      "reject",
      "tanishk",
      "2026-09-27T00:00:00.000Z",
    );
    expect(decided.dsck.proposals[0]?.status).toBe("rejected");
    expect(decided.rules.rules).toHaveLength(1);
    expect(decided.rules.rules[0]).toMatchObject({ kind: "forbid", forbid: "deprecated" });
    expect(decided.audit.action).toBe("reject");
    expect(decided.audit.before).toEqual(decided.audit.after);
  });

  it("CLI approve writes the file and MCP approve stays off the default surface", async () => {
    expect(listToolDefinitions(false).map((tool) => tool.name)).not.toContain("approve_proposal");
    let dsck = emptyDsck();
    dsck = proposeRuleChange(dsck, "Forbid deprecated", "strong", { forbid: "deprecated" });
    saveDsck(dsck);
    const id = dsck.proposals[0]!.id;
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runCli(["approve", id, "--who", "tanishk"]);
    } finally {
      process.stdout.write = write;
    }
    expect(readBindRules().rules.some((rule) => rule.kind === "forbid")).toBe(true);
    const payload = JSON.parse(chunks.join("")) as { ok: boolean; who: string };
    expect(payload.ok).toBe(true);
    expect(payload.who).toBe("tanishk");

    process.env["RESOLVE_MCP_ADVANCED"] = "1";
    const again = emptyDsck();
    const rejected = proposeRuleChange(again, "Other", "n", { forbid: "removed" });
    saveDsck(rejected);
    const result = callTool("reject_proposal", {
      proposalId: rejected.proposals[0]!.id,
      confirmedBy: "tanishk",
    }) as { action: string; rules: unknown[] };
    expect(result.action).toBe("reject");
    expect(result.rules).toEqual(readBindRules().rules);
    const view = governanceView();
    expect(view.rules.some((rule) => rule.label.includes("forbid"))).toBe(true);
    expect(view.hint).toMatch(/Read-only/);
  });

  it("callTool refuses approve_proposal and reject_proposal unless RESOLVE_MCP_ADVANCED=1", () => {
    let dsck = emptyDsck();
    dsck = proposeRuleChange(dsck, "Require Card", "strong", {
      screenType: "payment",
      slot: "body",
      require: ids.card,
    });
    saveDsck(dsck);
    const proposalId = dsck.proposals[0]!.id;
    expect(() => callTool("approve_proposal", { proposalId, confirmedBy: "tanishk" })).toThrow(ToolError);
    expect(() => callTool("approve_proposal", { proposalId, confirmedBy: "tanishk" })).toThrow(
      /RESOLVE_MCP_ADVANCED/,
    );
    expect(readBindRules().rules).toEqual([]);
    expect(() => callTool("reject_proposal", { proposalId, confirmedBy: "tanishk" })).toThrow(
      /RESOLVE_MCP_ADVANCED/,
    );
    expect(readDsckStatus(proposalId)).toBe("pending");
  });

  it("callTool refuses approve/reject without confirmedBy even when the flag is set", () => {
    process.env["RESOLVE_MCP_ADVANCED"] = "1";
    let dsck = emptyDsck();
    dsck = proposeRuleChange(dsck, "Require Card", "strong", {
      screenType: "payment",
      slot: "body",
      require: ids.card,
    });
    saveDsck(dsck);
    const proposalId = dsck.proposals[0]!.id;
    expect(() => callTool("approve_proposal", { proposalId, who: "tanishk" })).toThrow(/confirmedBy/);
    expect(() => callTool("reject_proposal", { proposalId })).toThrow(/confirmedBy/);
    expect(readBindRules().rules).toEqual([]);
    expect(readDsckStatus(proposalId)).toBe("pending");
  });

  it("refuses unscoped require on approve", () => {
    let dsck = emptyDsck();
    dsck = proposeRuleChange(dsck, "Global Input", "strong", { require: ids.inputSet });
    expect(() =>
      applyProposalDecision(
        dsck,
        parseBindRulesFile({ rules: [] }),
        dsck.proposals[0]!.id,
        "approve",
        "tanishk",
        "t",
        { index: demo },
      ),
    ).toThrow(/Unscoped require is invalid/);
  });

  it("refuses unknown, deprecated, removed, and duplicate masters on approve", () => {
    const empty = parseBindRulesFile({ rules: [] });
    const unknown = proposeRuleChange(emptyDsck(), "gone", "e", {
      screenType: "payment",
      require: "node:gone",
    });
    expect(() =>
      applyProposalDecision(unknown, empty, unknown.proposals[0]!.id, "approve", "tanishk", "t", { index: demo }),
    ).toThrow(/unknown master "node:gone"/);

    const deprecated = proposeRuleChange(emptyDsck(), "banner", "e", {
      screenType: "payment",
      require: ids.banner,
    });
    expect(() =>
      applyProposalDecision(deprecated, empty, deprecated.proposals[0]!.id, "approve", "tanishk", "t", {
        index: demo,
      }),
    ).toThrow(/deprecated/);

    const removedIndex = indexGraph({
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === ids.card ? { ...node, metadata: { ...node.metadata, removedByAbsence: true } } : node,
      ),
    });
    const removed = proposeRuleChange(emptyDsck(), "card", "e", {
      screenType: "payment",
      require: ids.card,
    });
    expect(() =>
      applyProposalDecision(removed, empty, removed.proposals[0]!.id, "approve", "tanishk", "t", {
        index: removedIndex,
      }),
    ).toThrow(/removed/);

    const first = proposeRuleChange(emptyDsck(), "card", "e", {
      screenType: "payment",
      slot: "body",
      require: ids.card,
    });
    const approved = applyProposalDecision(first, empty, first.proposals[0]!.id, "approve", "tanishk", "t", {
      index: demo,
    });
    const dup = proposeRuleChange(emptyDsck(), "card again", "e", {
      screenType: "payment",
      slot: "body",
      require: ids.card,
    });
    expect(() =>
      applyProposalDecision(dup, approved.rules, dup.proposals[0]!.id, "approve", "tanishk", "t", {
        index: demo,
      }),
    ).toThrow(/duplicate rule/);
  });

  it("scoped Input proposal does not hijack unrelated recommend/verify", () => {
    let dsck = emptyDsck(3);
    const before = dsck;
    for (const screen of ["Payment 1", "Payment 2", "Payment 3"]) {
      dsck = recordVerifiedUsage(dsck, {
        screenId: screen,
        screenName: screen,
        masters: [{ id: ids.inputSet, name: "Input" }],
        slot: "field",
      });
    }
    dsck = proposeStrongPatterns(dsck, newlyStrongPatterns(before, dsck), () => false);
    const proposal = dsck.proposals[0];
    expect(proposal?.suggestedRule).toMatchObject({
      require: ids.inputSet,
      screenType: "payment",
      slot: "field",
    });
    const decided = applyProposalDecision(
      dsck,
      parseBindRulesFile({ rules: [] }),
      proposal!.id,
      "approve",
      "tanishk",
      "t",
      { index: demo },
    );
    const rec = recommendMasters(demo, "avatar", { bindRules: decided.rules });
    expect(rec.candidates.map((row) => row.name.toLowerCase())).not.toEqual(["input"]);
    expect(rec.candidates[0]?.name.toLowerCase()).toBe("avatar");
    const check = verifyFrame(demo, { components: ["Button"], bindRules: decided.rules });
    expect(check.pass).toBe(false);
    expect(JSON.stringify(check)).toContain('"result":"nothing checked"');
    expect(check.hint).not.toMatch(/verified/i);
    expect(check.ruleFailure).toBeUndefined();
  });

  it("writes prefer labels, not file keys", () => {
    const human = serializeBindRulesFile(
      parseBindRulesFile({ rules: [{ prefer: "Shared DS", over: "Storefront" }] }),
    );
    expect(human.rules[0]).toEqual({ prefer: "Shared DS", over: "Storefront" });
  });
});

function readDsckStatus(proposalId: string): string | undefined {
  const raw = JSON.parse(readFileSync(join(process.env["RESOLVE_HOME"]!, "dsck.json"), "utf8")) as {
    proposals: Array<{ id: string; status: string }>;
  };
  return raw.proposals.find((row) => row.id === proposalId)?.status;
}
