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
  emptySock,
  newlyStrongPatterns,
  proposeRuleChange,
  proposeStrongPatterns,
  recordVerifiedUsage,
} from "@/core/query/sock";
import { indexGraph, recommendMasters, verifyFrame } from "@/core/query";
import { clearCache, commitProposalDecision, readBindRules, saveGraph, saveSock } from "@/server/store";
import { governanceView } from "@/server/governance";
import { runCli } from "@/server/cli";
import { callTool, listToolDefinitions, ToolError } from "@/server/tools";
import { graph, ids, index as demo } from "./fixture";

describe("approve / reject proposal", () => {
  const previousHome = process.env["GRAPHIFY_HOME"];
  const previousAdvanced = process.env["RESOLVE_MCP_ADVANCED"];

  beforeEach(() => {
    process.env["GRAPHIFY_HOME"] = mkdtempSync(join(tmpdir(), "resolve-approve-"));
    delete process.env["RESOLVE_MCP_ADVANCED"];
    clearCache();
    saveGraph(graph);
  });

  afterEach(() => {
    clearCache();
    if (previousHome === undefined) delete process.env["GRAPHIFY_HOME"];
    else process.env["GRAPHIFY_HOME"] = previousHome;
    if (previousAdvanced === undefined) delete process.env["RESOLVE_MCP_ADVANCED"];
    else process.env["RESOLVE_MCP_ADVANCED"] = previousAdvanced;
  });

  it("approve writes the rules file and an audit line", () => {
    let sock = emptySock();
    sock = proposeRuleChange(sock, "Require Card on payment", "strong on 3 screens", {
      screenType: "payment",
      slot: "primary-action",
      require: ids.card,
    });
    const proposalId = sock.proposals[0]!.id;
    const before = parseBindRulesFile({ rules: [] });
    const decided = applyProposalDecision(
      sock,
      before,
      proposalId,
      "approve",
      "tanishk",
      "2026-09-27T00:00:00.000Z",
      { index: demo },
    );
    expect(decided.sock.proposals[0]?.status).toBe("approved");
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
    const auditPath = join(process.env["GRAPHIFY_HOME"]!, "bind-rules.audit.jsonl");
    expect(existsSync(auditPath)).toBe(true);
    const line = JSON.parse(readFileSync(auditPath, "utf8").trim()) as { who: string; proposalId: string };
    expect(line.who).toBe("tanishk");
    expect(line.proposalId).toBe(proposalId);
    const onDisk = JSON.parse(readFileSync(join(process.env["GRAPHIFY_HOME"]!, "bind-rules.json"), "utf8")) as {
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
    let sock = emptySock();
    sock = proposeRuleChange(sock, "Require Pay CTA", "strong on 3 screens", {
      require: "node:live",
    });
    const existing = parseBindRulesFile({
      rules: [{ forbid: "deprecated" }],
    });
    const decided = applyProposalDecision(
      sock,
      existing,
      sock.proposals[0]!.id,
      "reject",
      "tanishk",
      "2026-09-27T00:00:00.000Z",
    );
    expect(decided.sock.proposals[0]?.status).toBe("rejected");
    expect(decided.rules.rules).toHaveLength(1);
    expect(decided.rules.rules[0]).toMatchObject({ kind: "forbid", forbid: "deprecated" });
    expect(decided.audit.action).toBe("reject");
    expect(decided.audit.before).toEqual(decided.audit.after);
  });

  it("CLI approve writes the file and MCP approve stays off the default surface", async () => {
    expect(listToolDefinitions(false).map((tool) => tool.name)).not.toContain("approve_proposal");
    let sock = emptySock();
    sock = proposeRuleChange(sock, "Forbid deprecated", "strong", { forbid: "deprecated" });
    saveSock(sock);
    const id = sock.proposals[0]!.id;
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
    const again = emptySock();
    const rejected = proposeRuleChange(again, "Other", "n", { forbid: "removed" });
    saveSock(rejected);
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
    let sock = emptySock();
    sock = proposeRuleChange(sock, "Require Card", "strong", {
      screenType: "payment",
      slot: "body",
      require: ids.card,
    });
    saveSock(sock);
    const proposalId = sock.proposals[0]!.id;
    expect(() => callTool("approve_proposal", { proposalId, confirmedBy: "tanishk" })).toThrow(ToolError);
    expect(() => callTool("approve_proposal", { proposalId, confirmedBy: "tanishk" })).toThrow(
      /RESOLVE_MCP_ADVANCED/,
    );
    expect(readBindRules().rules).toEqual([]);
    expect(() => callTool("reject_proposal", { proposalId, confirmedBy: "tanishk" })).toThrow(
      /RESOLVE_MCP_ADVANCED/,
    );
    expect(readSockStatus(proposalId)).toBe("pending");
  });

  it("callTool refuses approve/reject without confirmedBy even when the flag is set", () => {
    process.env["RESOLVE_MCP_ADVANCED"] = "1";
    let sock = emptySock();
    sock = proposeRuleChange(sock, "Require Card", "strong", {
      screenType: "payment",
      slot: "body",
      require: ids.card,
    });
    saveSock(sock);
    const proposalId = sock.proposals[0]!.id;
    expect(() => callTool("approve_proposal", { proposalId, who: "tanishk" })).toThrow(/confirmedBy/);
    expect(() => callTool("reject_proposal", { proposalId })).toThrow(/confirmedBy/);
    expect(readBindRules().rules).toEqual([]);
    expect(readSockStatus(proposalId)).toBe("pending");
  });

  it("refuses unscoped require on approve", () => {
    let sock = emptySock();
    sock = proposeRuleChange(sock, "Global Input", "strong", { require: ids.inputSet });
    expect(() =>
      applyProposalDecision(
        sock,
        parseBindRulesFile({ rules: [] }),
        sock.proposals[0]!.id,
        "approve",
        "tanishk",
        "t",
        { index: demo },
      ),
    ).toThrow(/Unscoped require is invalid/);
  });

  it("refuses unknown, deprecated, removed, and duplicate masters on approve", () => {
    const empty = parseBindRulesFile({ rules: [] });
    const unknown = proposeRuleChange(emptySock(), "gone", "e", {
      screenType: "payment",
      require: "node:gone",
    });
    expect(() =>
      applyProposalDecision(unknown, empty, unknown.proposals[0]!.id, "approve", "tanishk", "t", { index: demo }),
    ).toThrow(/unknown master "node:gone"/);

    const deprecated = proposeRuleChange(emptySock(), "banner", "e", {
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
    const removed = proposeRuleChange(emptySock(), "card", "e", {
      screenType: "payment",
      require: ids.card,
    });
    expect(() =>
      applyProposalDecision(removed, empty, removed.proposals[0]!.id, "approve", "tanishk", "t", {
        index: removedIndex,
      }),
    ).toThrow(/removed/);

    const first = proposeRuleChange(emptySock(), "card", "e", {
      screenType: "payment",
      slot: "body",
      require: ids.card,
    });
    const approved = applyProposalDecision(first, empty, first.proposals[0]!.id, "approve", "tanishk", "t", {
      index: demo,
    });
    const dup = proposeRuleChange(emptySock(), "card again", "e", {
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
    let sock = emptySock(3);
    const before = sock;
    for (const screen of ["Payment 1", "Payment 2", "Payment 3"]) {
      sock = recordVerifiedUsage(sock, {
        screenId: screen,
        screenName: screen,
        masters: [{ id: ids.inputSet, name: "Input" }],
        slot: "field",
      });
    }
    sock = proposeStrongPatterns(sock, newlyStrongPatterns(before, sock), () => false);
    const proposal = sock.proposals[0];
    expect(proposal?.suggestedRule).toMatchObject({
      require: ids.inputSet,
      screenType: "payment",
      slot: "field",
    });
    const decided = applyProposalDecision(
      sock,
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
    expect(check.pass).toBe(true);
    expect(check.ruleFailure).toBeUndefined();
  });

  it("writes prefer labels, not file keys", () => {
    const human = serializeBindRulesFile(
      parseBindRulesFile({ rules: [{ prefer: "Shared DS", over: "Storefront" }] }),
    );
    expect(human.rules[0]).toEqual({ prefer: "Shared DS", over: "Storefront" });
  });
});

function readSockStatus(proposalId: string): string | undefined {
  const raw = JSON.parse(readFileSync(join(process.env["GRAPHIFY_HOME"]!, "sock.json"), "utf8")) as {
    proposals: Array<{ id: string; status: string }>;
  };
  return raw.proposals.find((row) => row.id === proposalId)?.status;
}
