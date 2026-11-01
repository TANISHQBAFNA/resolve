import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalProposalId, emptyDsck, proposeRuleChange, type DsciProposal } from "@/core/query";
import { clearCache, dsckPath, loadDsck, readApprovedDecisions, readDsck, saveDsck, saveGraph, syncProject } from "@/server/store";
import { learnLibrary } from "@/server/learn";
import { runCli } from "@/server/cli";
import { callTool } from "@/server/tools";
import { graph, ids } from "./fixture";

/** Data and names from before the DSCK / DSCI rename keep working. */
const OLD_PREFIX = "soci:";

function captureOut(): { out: () => string; err: () => string; restore: () => void } {
  let out = "";
  let err = "";
  const o = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => ((out += String(chunk)), true));
  const e = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => ((err += String(chunk)), true));
  return { out: () => out, err: () => err, restore: () => (o.mockRestore(), e.mockRestore()) };
}

describe("rename compatibility", () => {
  const saved = { home: process.env["RESOLVE_HOME"], advanced: process.env["RESOLVE_MCP_ADVANCED"], copy: process.env["RESOLVE_PROJECT_COPY"], dir: process.env["RESOLVE_PROJECT_DIR"] };

  beforeEach(() => {
    process.env["RESOLVE_HOME"] = mkdtempSync(join(tmpdir(), "resolve-rename-"));
    process.env["RESOLVE_PROJECT_COPY"] = "0";
    delete process.env["RESOLVE_PROJECT_DIR"];
    delete process.env["RESOLVE_MCP_ADVANCED"];
    clearCache();
    saveGraph(graph);
  });

  afterEach(() => {
    clearCache();
    for (const [key, value] of [["RESOLVE_HOME", saved.home], ["RESOLVE_MCP_ADVANCED", saved.advanced], ["RESOLVE_PROJECT_COPY", saved.copy], ["RESOLVE_PROJECT_DIR", saved.dir]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("maps an old proposal id to the new one and leaves other ids alone", () => {
    expect(canonicalProposalId(`${OLD_PREFIX}require-rule:pay-cta`)).toBe("dsci:require-rule:pay-cta");
    expect(canonicalProposalId("dsci:recipe-update:x")).toBe("dsci:recipe-update:x");
    expect(canonicalProposalId("p1")).toBe("p1");
  });

  it("new proposals get the new prefix", () => {
    const state = proposeRuleChange(emptyDsck(), "Require Card on payment", "strong on 3 screens", { screenType: "payment", require: ids.card });
    expect(state.proposals[0]!.id).toMatch(/^dsci:require-rule:/);
  });

  it("reads the old store file when the new one is missing, with old ids mapped, and writes only the new file", () => {
    const fresh = proposeRuleChange(emptyDsck(), "Require Card on payment", "strong on 3 screens", { screenType: "payment", slot: "primary-action", require: ids.card });
    const newId = fresh.proposals[0]!.id;
    const oldId = `${OLD_PREFIX}${newId.slice("dsci:".length)}`;
    const legacy = { ...fresh, proposals: [{ ...fresh.proposals[0]!, id: oldId }] };
    writeFileSync(dsckPath(true), JSON.stringify(legacy));
    expect(existsSync(dsckPath())).toBe(false);
    const loaded = loadDsck()!;
    expect(loaded.proposals.map((row) => row.id)).toEqual([newId]);

    saveDsck(loaded);
    expect(existsSync(dsckPath())).toBe(true);
    expect(JSON.parse(readFileSync(dsckPath(true), "utf8")).proposals[0].id).toBe(oldId);
  });

  it("the new store file wins over the old one", () => {
    writeFileSync(dsckPath(true), JSON.stringify({ ...emptyDsck(), threshold: 7 }));
    saveDsck({ ...emptyDsck(), threshold: 5 });
    clearCache();
    expect(readDsck().threshold).toBe(5);
  });

  it("approve accepts an old id, and an old audit line still counts as the approval", async () => {
    const fresh = proposeRuleChange(emptyDsck(), "Require Card on payment", "strong on 3 screens", { screenType: "payment", slot: "primary-action", require: ids.card });
    const newId = fresh.proposals[0]!.id;
    saveDsck(fresh);
    const oldId = `${OLD_PREFIX}${newId.slice("dsci:".length)}`;
    const io = captureOut();
    try {
      await runCli(["approve", oldId, "--who", "Avery"]);
    } finally {
      io.restore();
    }
    expect(JSON.parse(io.out()).proposalId).toBe(newId);
    expect(readDsck().proposals[0]!.status).toBe("approved");
    expect(readApprovedDecisions().map((row) => row.proposal.id)).toEqual([newId]);
  });

  it("the old CLI word still lists proposals and warns once with the new word", async () => {
    saveDsck(proposeRuleChange(emptyDsck(), "Require Card on payment", "strong", { screenType: "payment", require: ids.card }));
    const io = captureOut();
    try {
      await runCli(["soci"]);
    } finally {
      io.restore();
    }
    expect(JSON.parse(io.out()).proposals).toHaveLength(1);
    expect(io.err()).toMatch(/Deprecated: soci\..*Use dsci\./);
  });

  it("the old MCP tool name returns the same proposals with a deprecation note", () => {
    process.env["RESOLVE_MCP_ADVANCED"] = "1";
    saveDsck(proposeRuleChange(emptyDsck(), "Require Card on payment", "strong", { screenType: "payment", require: ids.card }));
    const io = captureOut();
    let oldResult: Record<string, unknown>;
    let newResult: Record<string, unknown>;
    try {
      oldResult = callTool("list_soci", {}) as Record<string, unknown>;
      newResult = callTool("list_dsci", {}) as Record<string, unknown>;
    } finally {
      io.restore();
    }
    expect(oldResult["proposals"]).toEqual(newResult["proposals"]);
    expect(oldResult["deprecation"]).toMatch(/Use list_dsci/);
    expect(newResult["deprecation"]).toBeUndefined();
  });

  it("a project copy synced before the rename keeps its approved proposals", () => {
    const project = mkdtempSync(join(tmpdir(), "resolve-rename-project-"));
    const local = join(project, ".resolve", "local");
    process.env["RESOLVE_PROJECT_DIR"] = project;
    delete process.env["RESOLVE_PROJECT_COPY"];
    learnLibrary({ fileKey: "LIB", role: "library", metadataXml: `<frame id="1:1" name="Kit"><component id="6:1" name="Badge" /></frame>` });
    const row = (status: DsciProposal["status"], summary: string): DsciProposal => ({ id: "dsci:require-rule:badge", type: "require-rule", createdAt: "2026-10-01T00:00:00.000Z", status, summary, evidence: [] });
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, "soci.json"), JSON.stringify({ version: 1, proposals: [{ ...row("approved", "Require Badge"), id: `${OLD_PREFIX}require-rule:badge`, proposal: row("approved", "Require Badge") }] }));
    saveDsck({ ...emptyDsck(), proposals: [row("pending", "Require Badge")] });
    clearCache();
    const report = syncProject(true)!;
    const rows = JSON.parse(readFileSync(join(local, "dsci.json"), "utf8")).proposals as Array<{ id: string; status: string }>;
    expect(rows).toEqual([expect.objectContaining({ id: "dsci:require-rule:badge", status: "approved" })]);
    expect(report.dsci).toMatchObject({ approved: 1, added: 0 });
  });
});
