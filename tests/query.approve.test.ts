import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyProposalDecision, parseBindRulesFile } from "@/core/query/bindRules";
import { emptySock, proposeRuleChange } from "@/core/query/sock";
import { appendBindAudit, clearCache, readBindRules, saveSock, writeBindRules } from "@/server/store";
import { governanceView } from "@/server/governance";
import { runCli } from "@/server/cli";
import { callTool, listToolDefinitions } from "@/server/tools";

describe("approve / reject proposal", () => {
  const previousHome = process.env["GRAPHIFY_HOME"];
  const previousAdvanced = process.env["RESOLVE_MCP_ADVANCED"];

  beforeEach(() => {
    process.env["GRAPHIFY_HOME"] = mkdtempSync(join(tmpdir(), "resolve-approve-"));
    delete process.env["RESOLVE_MCP_ADVANCED"];
    clearCache();
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
    sock = proposeRuleChange(sock, "Require Pay CTA", "strong on 3 screens", {
      screenType: "payment",
      slot: "primary-action",
      require: "node:live",
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
    );
    expect(decided.sock.proposals[0]?.status).toBe("approved");
    expect(decided.rules.rules).toHaveLength(1);
    expect(decided.rules.rules[0]).toMatchObject({
      kind: "require",
      require: "node:live",
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

    saveSock(decided.sock);
    writeBindRules(decided.rules);
    appendBindAudit(decided.audit);
    expect(readBindRules().rules).toHaveLength(1);
    const auditPath = join(process.env["GRAPHIFY_HOME"]!, "bind-rules.audit.jsonl");
    expect(existsSync(auditPath)).toBe(true);
    const line = JSON.parse(readFileSync(auditPath, "utf8").trim()) as { who: string; proposalId: string };
    expect(line.who).toBe("tanishk");
    expect(line.proposalId).toBe(proposalId);
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
    const rejected = proposeRuleChange(again, "Other", "n", { require: "node:x" });
    saveSock(rejected);
    const result = callTool("reject_proposal", {
      proposalId: rejected.proposals[0]!.id,
      who: "tanishk",
    }) as { action: string; rules: unknown[] };
    expect(result.action).toBe("reject");
    expect(result.rules).toEqual(readBindRules().rules);
    const view = governanceView();
    expect(view.rules.some((rule) => rule.label.includes("forbid"))).toBe(true);
    expect(view.hint).toMatch(/Read-only/);
  });
});
