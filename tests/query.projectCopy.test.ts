import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { learnLibrary } from "@/server/learn";
import { clearCache, loadSock, saveSock, syncProject } from "@/server/store";
import { runCli } from "@/server/cli";
import { emptySock, projectCopyDir, type SociProposal } from "@/core/query";

const KIT = (parts: string) => `<frame id="1:1" name="Kit">${parts}</frame>`;
const BUTTON = `<component_set id="5:1" name="Button"><component id="5:2" name="Type=Primary" /><component id="5:3" name="Type=Ghost" /></component_set>`;
const BUTTON_MORE = `<component_set id="5:1" name="Button"><component id="5:2" name="Type=Primary" /><component id="5:3" name="Type=Ghost" /><component id="5:4" name="Type=Danger" /></component_set>`;
const BADGE = `<component id="6:1" name="Badge" />`;

function read<T>(dir: string, name: string): T {
  return JSON.parse(readFileSync(join(dir, name), "utf8")) as T;
}

interface Row { id: string; name: string; stale?: true; staleSince?: string; fingerprint: string }
interface SociRow { id: string; status: string; summary: string; changed?: true; incoming?: SociProposal; staleComponent?: string; missingFromStore?: true }

const proposal = (id: string, summary: string, status: SociProposal["status"], masterId?: string): SociProposal => ({
  id,
  type: "require-rule",
  createdAt: "2026-10-01T00:00:00.000Z",
  status,
  summary,
  evidence: [],
  ...(masterId ? { suggestedRule: { require: "Badge", masterId } } : {}),
});

describe("per-project local SOCK / SOCI copy", () => {
  const saved = { home: process.env["RESOLVE_HOME"], copy: process.env["RESOLVE_PROJECT_COPY"], dir: process.env["RESOLVE_PROJECT_DIR"] };
  let project: string;
  let local: string;
  beforeEach(() => {
    process.env["RESOLVE_HOME"] = mkdtempSync(join(tmpdir(), "resolve-store-"));
    project = mkdtempSync(join(tmpdir(), "resolve-project-"));
    local = join(project, ".resolve", "local");
    process.env["RESOLVE_PROJECT_DIR"] = project;
    delete process.env["RESOLVE_PROJECT_COPY"];
    clearCache();
  });
  afterEach(() => {
    for (const [key, value] of [["RESOLVE_HOME", saved.home], ["RESOLVE_PROJECT_COPY", saved.copy], ["RESOLVE_PROJECT_DIR", saved.dir]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearCache();
  });

  it("the first run writes components, SOCK and SOCI into the project", () => {
    learnLibrary({ fileKey: "LIB", role: "library", metadataXml: KIT(BUTTON + BADGE) });
    saveSock({ ...emptySock(), proposals: [proposal("p1", "Use Badge on cards", "pending")] });
    const report = syncProject()!;
    expect(report.synced).toBe(true);
    expect(report.components).toMatchObject({ total: 2, added: 2, stale: 0 });
    const names = read<{ components: Row[] }>(local, "components.json").components.map((row) => row.name);
    expect(names).toEqual(["Badge", "Button"]);
    expect(read<{ proposals: SociRow[] }>(local, "soci.json").proposals).toEqual([expect.objectContaining({ id: "p1", status: "pending" })]);
    expect(existsSync(join(local, "sock.json"))).toBe(true);
    expect(report.warnings).toEqual([]);
  });

  it("a rerun with nothing changed skips the write, and a forced one changes nothing", () => {
    learnLibrary({ fileKey: "LIB", role: "library", metadataXml: KIT(BUTTON) });
    expect(syncProject()?.synced).toBe(true);
    expect(syncProject()).toBeUndefined();
    expect(syncProject(true)?.components).toMatchObject({ total: 1, added: 0, updated: 0, newlyStale: 0 });
  });

  it("a rerun syncs components: a changed set is updated, a removed one is kept and marked stale", () => {
    learnLibrary({ fileKey: "LIB", role: "library", metadataXml: KIT(BUTTON + BADGE) });
    syncProject();
    const before = read<{ components: Row[] }>(local, "components.json").components.find((row) => row.name === "Button")!;
    learnLibrary({ fileKey: "LIB", role: "library", metadataXml: KIT(BUTTON_MORE), resume: false });
    clearCache();
    const report = syncProject()!;
    expect(report.components).toMatchObject({ updated: 1, newlyStale: 1, stale: 1 });
    const rows = read<{ components: Row[] }>(local, "components.json").components;
    const badge = rows.find((row) => row.name === "Badge")!;
    expect(badge.stale).toBe(true);
    expect(badge.staleSince).toBeTruthy();
    expect(rows.find((row) => row.name === "Button")!.fingerprint).not.toBe(before.fingerprint);
    expect(report.warnings[0]?.next).toMatch(/swap stale components/);
  });

  it("keeps an approved SOCI proposal, flags it when it changes, and never approves anything itself", () => {
    learnLibrary({ fileKey: "LIB", role: "library", metadataXml: KIT(BUTTON + BADGE) });
    saveSock({ ...emptySock(), proposals: [proposal("p1", "Require Badge on cards", "approved"), proposal("p2", "Prefer Button", "pending")] });
    syncProject();

    const sock = loadSock()!;
    saveSock({ ...sock, proposals: [proposal("p1", "Require Badge on every card and list row", "pending"), proposal("p2", "Prefer Button", "pending"), proposal("p3", "New idea", "pending")] });
    clearCache();
    const report = syncProject()!;
    const rows = read<{ proposals: SociRow[] }>(local, "soci.json").proposals;
    const p1 = rows.find((row) => row.id === "p1")!;
    expect(p1.status).toBe("approved");
    expect(p1.summary).toBe("Require Badge on cards");
    expect(p1.changed).toBe(true);
    expect(p1.incoming?.summary).toBe("Require Badge on every card and list row");
    expect(rows.find((row) => row.id === "p3")?.status).toBe("pending");
    expect(rows.filter((row) => row.status === "approved").map((row) => row.id)).toEqual(["p1"]);
    expect(report.soci).toMatchObject({ approved: 1, pending: 2, changedApproved: 1, added: 1 });
    expect(report.warnings.map((warning) => warning.next).join(" ")).toMatch(/approve it again/);
    // The store itself is never changed by a sync.
    expect(loadSock()!.proposals.find((row) => row.id === "p1")?.status).toBe("pending");
  });

  it("flags an approved rule whose component went stale, and keeps an approved rule that left the store", () => {
    learnLibrary({ fileKey: "LIB", role: "library", metadataXml: KIT(BUTTON + BADGE) });
    syncProject();
    const badgeId = read<{ components: Row[] }>(local, "components.json").components.find((row) => row.name === "Badge")!.id;
    saveSock({ ...emptySock(), proposals: [proposal("p1", "Require Badge", "approved", badgeId), proposal("p2", "Old rule", "approved")] });
    clearCache();
    syncProject();
    learnLibrary({ fileKey: "LIB", role: "library", metadataXml: KIT(BUTTON), resume: false });
    saveSock({ ...loadSock()!, proposals: [proposal("p1", "Require Badge", "approved", badgeId)] });
    clearCache();
    const report = syncProject()!;
    const rows = read<{ proposals: SociRow[] }>(local, "soci.json").proposals;
    expect(rows.find((row) => row.id === "p1")?.staleComponent).toBe(badgeId);
    expect(rows.find((row) => row.id === "p2")).toMatchObject({ status: "approved", missingFromStore: true });
    expect(report.warnings.some((warning) => /stale component/.test(warning.message))).toBe(true);
  });

  it("every CLI run syncs the copy; resolve sync forces one", async () => {
    learnLibrary({ fileKey: "LIB", role: "library", metadataXml: KIT(BUTTON) });
    await runCli(["status"]);
    expect(existsSync(join(local, "components.json"))).toBe(true);
    const lines: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => (lines.push(String(chunk)), true)) as typeof process.stdout.write;
    try {
      await runCli(["sync"]);
    } finally {
      process.stdout.write = write;
    }
    expect(JSON.parse(lines.join(""))).toMatchObject({ synced: true, components: { total: 1 } });
  });

  it("does not write into the home folder, the store, or when turned off", () => {
    const home = mkdtempSync(join(tmpdir(), "resolve-home-"));
    const store = join(home, ".resolve", "default");
    mkdirSync(store, { recursive: true });
    expect(projectCopyDir(home, { HOME: home }, store)).toBeUndefined();
    expect(projectCopyDir(store, { HOME: home }, store)).toBeUndefined();
    expect(projectCopyDir(project, { HOME: home, RESOLVE_PROJECT_COPY: "0" }, store)).toBeUndefined();
    const nested = join(project, "src", "screens");
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(project, ".git"));
    expect(projectCopyDir(nested, { HOME: home }, store)).toBe(join(project, ".resolve", "local"));
  });
});
