import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { mapReport } from "@/server/code/map";
import { runCodeCommand, runLinkMap } from "@/server/code/command";
import { buildCatalog } from "@/server/code/scan";
import { proposalsFromReport } from "@/server/componentMap";
import type { ResolveConfig } from "@/server/mode";

const fixture = join(process.cwd(), "fixtures/acme-vanilla");

function config(repo: string, store: string, sourceRef?: string): ResolveConfig {
  return {
    mode: "both",
    modeSource: "env",
    repoPath: repo,
    localPrefixes: [],
    storeDir: store,
    ...(sourceRef ? { sourceRef } : {}),
  };
}

const masters = [
  { name: "Acme Button", nodeId: "1:1", description: "Pay. ds@1.4.0.core.button", variants: ["bold"] },
  { name: "Acme Tag", nodeId: "1:2" },
  { name: "Acme Badge", nodeId: "1:3" },
  { name: "Acme Banner", nodeId: "1:4" },
  { name: "Acme Field", nodeId: "1:5", description: "ds@2.0.0.core.field" },
  { name: "Acme Loud", nodeId: "1:6", variants: ["bold"] },
];

describe("vanilla HTML/CSS/JS component folders", () => {
  const previous = { home: process.env["RESOLVE_HOME"], mode: process.env["RESOLVE_MODE"] };

  afterEach(() => {
    if (previous.home === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previous.home;
    if (previous.mode === undefined) delete process.env["RESOLVE_MODE"];
    else process.env["RESOLVE_MODE"] = previous.mode;
    process.exitCode = undefined;
  });

  it("links an ID and a confirmed pair, drafts a missing ID, and warns on a malformed ID", () => {
    const store = mkdtempSync(join(tmpdir(), "resolve-vanilla-"));
    const cfg = config(fixture, store);
    const catalog = buildCatalog(cfg);
    const button = catalog.components.find((entry) => entry.name === "acme-button");
    expect(button?.dsId).toBe("ds@1.4.0.core.button");
    expect(button?.code?.roots).toContain("acme-button");
    expect(button?.code?.tokens).toContain("--acme-ink");
    expect(button?.variants).toContain("tone=bold");
    expect(catalog.components.find((entry) => entry.name === "acme-field")?.dsId).toBe("ds@2.0.0.core.field");

    const report = mapReport(catalog, cfg, { suggest: true, masters });
    expect(report.pairs).toContainEqual({ figma: "Acme Button", code: "acme-button", confidence: "mapped", source: "id" });
    expect(report.pairs).toContainEqual({ figma: "Acme Field", code: "acme-field", confidence: "mapped", source: "id" });
    expect(report.pairs).toContainEqual({ figma: "Acme Tag", code: "acme-chip", confidence: "mapped", source: "manifest" });
    expect(report.pairs.map((pair) => pair.code)).not.toContain("acme-badge");
    expect(report.pairs.map((pair) => pair.code)).not.toContain("acme-banner");
    expect(report.pairs.map((pair) => pair.figma)).not.toContain("Acme Loud");
    const draft = report.suggestions?.find((row) => row.figma === "Acme Badge" && row.code === "acme-badge");
    expect(draft?.confidence).toBe("risky: same name only");
    expect(proposalsFromReport(report)).toContainEqual(expect.objectContaining({ figma: "Acme Badge", code: "acme-badge", status: "proposed", tier: "risky" }));
    expect(report.bulkConfirm ?? []).not.toContain("Acme Badge=acme-badge");
    expect(report.problems?.some((line) => line.includes("not-an-id") && line.includes("next:"))).toBe(true);
  });

  it("reads a git URL at a ref, and a bad ref is a warning with exit 0", () => {
    const source = mkdtempSync(join(tmpdir(), "resolve-vanilla-git-"));
    mkdirSync(join(source, "acme-button"));
    writeFileSync(join(source, "acme-button", "acme-button.html"), '<button class="acme-button" data-ds-id="ds@1.4.0.core.button">Pay</button>\n');
    const git = (args: string[]) => spawnSync("git", args, { cwd: source, encoding: "utf8" });
    expect(git(["init", "-b", "main"]).status).toBe(0);
    expect(git(["config", "user.email", "dev@example.com"]).status).toBe(0);
    expect(git(["config", "user.name", "Dev"]).status).toBe(0);
    expect(git(["add", "."]).status).toBe(0);
    expect(git(["commit", "-m", "acme button"]).status).toBe(0);
    const url = `file://${source}`;
    const store = mkdtempSync(join(tmpdir(), "resolve-vanilla-clone-"));
    const catalog = buildCatalog(config(url, store, "main"));
    expect(catalog.components.find((entry) => entry.name === "acme-button")?.dsId).toBe("ds@1.4.0.core.button");

    const missed = buildCatalog(config(url, join(store, "miss"), "no-such-ref"));
    expect(missed.components).toEqual([]);
    expect(missed.sourceWarnings?.some((line) => line.includes("no-such-ref") && line.includes("next:"))).toBe(true);

    process.env["RESOLVE_HOME"] = store;
    process.env["RESOLVE_MODE"] = "code";
    process.exitCode = undefined;
    const err: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => (err.push(String(chunk)), true)) as typeof process.stderr.write;
    try {
      expect(() => runCodeCommand(["scan", "--repo", fixture])).not.toThrow();
      expect(() => runCodeCommand(["scan", "--repo", url, "--ref", "no-such-ref"])).not.toThrow();
      expect(() => runLinkMap(["--suggest", "--repo", fixture])).not.toThrow();
    } finally {
      process.stderr.write = write;
    }
    expect(process.exitCode ?? 0).toBe(0);
    expect(err.join("")).toMatch(/not-an-id[\s\S]*next:/);
  });
});
