import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DesignGraph } from "@/core/model";
import { isLinkMapRequest, runCodeCommand } from "@/server/code/command";
import { deprecationNotice } from "@/server/deprecations";
import { runCli } from "@/server/cli";
import { clearCache, saveGraph } from "@/server/store";
import { callTool, listToolDefinitions } from "@/server/tools";

const angularRoot = join(__dirname, "..", "fixtures", "acme-ui-angular");
const NOTICE = deprecationNotice("code map", "code-map");

const graph: DesignGraph = {
  fileKey: "ACMEUI",
  fileName: "Acme UI",
  schemaVersion: 1,
  builtAt: "2026-01-01T00:00:00.000Z",
  source: { kind: "mock", ingestedAt: "2026-01-01T00:00:00.000Z" },
  nodes: [
    { id: "node:1:1", figmaNodeId: "1:1", fileKey: "ACMEUI", type: "COMPONENT_SET", name: "Button" },
    { id: "node:1:2", figmaNodeId: "1:2", fileKey: "ACMEUI", type: "COMPONENT_SET", name: "Payee picker" },
  ],
  edges: [],
  warnings: [],
};

async function capture(run: () => void | Promise<void>): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const write = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
  process.stdout.write = ((chunk: string | Uint8Array) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => (err.push(String(chunk)), true)) as typeof process.stderr.write;
  try {
    await run();
  } finally {
    process.stdout.write = write.out;
    process.stderr.write = write.err;
  }
  return { out: out.join(""), err: err.join("") };
}

describe("one code-map command", () => {
  const previous = {
    home: process.env["RESOLVE_HOME"],
    mode: process.env["RESOLVE_MODE"],
    advanced: process.env["RESOLVE_MCP_ADVANCED"],
    repo: process.env["RESOLVE_REPO_PATH"],
  };
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "resolve-unify-"));
    const home = join(root, "store");
    mkdirSync(home, { recursive: true });
    process.env["RESOLVE_HOME"] = home;
    delete process.env["RESOLVE_MODE"];
    delete process.env["RESOLVE_REPO_PATH"];
    delete process.env["RESOLVE_MCP_ADVANCED"];
    clearCache();
    mkdirSync(join(root, "components", "button"), { recursive: true });
    mkdirSync(join(root, "components", "badge"), { recursive: true });
    writeFileSync(join(root, "components", "button", "button.css"), ".btn { color: var(--ink); }\n");
    writeFileSync(join(root, "components", "badge", "badge.css"), ".badge { color: var(--ink); }\n");
    writeFileSync(
      join(home, "code-map.json"),
      `${JSON.stringify({
        entries: [{ fileKey: "ACMEUI", id: "1:1", code: { import: "import { Button } from '@acme/ui'", component: "Button" } }],
      })}\n`,
    );
    saveGraph(graph);
  });

  afterEach(() => {
    clearCache();
    process.exitCode = undefined;
    const restore = (key: "RESOLVE_HOME" | "RESOLVE_MODE" | "RESOLVE_MCP_ADVANCED" | "RESOLVE_REPO_PATH", value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore("RESOLVE_HOME", previous.home);
    restore("RESOLVE_MODE", previous.mode);
    restore("RESOLVE_MCP_ADVANCED", previous.advanced);
    restore("RESOLVE_REPO_PATH", previous.repo);
  });

  it("merges the import map with pairs, unmatched, and suggestions", async () => {
    const plain = await capture(() => runCli(["code-map"]));
    expect(plain.err).toBe("");
    expect(plain.out).toContain("1 mapped");
    expect(plain.out).not.toContain("Import map:");
    expect(plain.out).not.toContain("Button -> button");

    const merged = await capture(() => runCli(["code-map", "--suggest", "--repo", root]));
    expect(merged.err).toBe("");
    expect(merged.out).toContain("Import map:");
    expect(merged.out).toContain("1 mapped");
    expect(merged.out).toContain("Button -> button");
    expect(merged.out).toContain("Figma with no coded match: Payee picker");
    expect(merged.out).toContain("Coded with no Figma match: badge");
    expect(merged.out).toMatch(/No suggestions\.|Suggested \(not joined/);

    const pairsOnly = await capture(() => runCli(["code-map", "--pairs", "--repo", root]));
    expect(pairsOnly.out).toContain("Button -> button");
    expect(pairsOnly.out).not.toContain("Figma with no coded match");

    const unmatchedOnly = await capture(() => runCli(["code-map", "--unmatched", "--repo", root]));
    expect(unmatchedOnly.out).toContain("Figma with no coded match: Payee picker");
    expect(unmatchedOnly.out).not.toContain("Button -> button");

    const json = JSON.parse((await capture(() => runCli(["code-map", "--suggest", "--repo", root, "--json"]))).out) as {
      imports: { counts: { mapped: number } };
      pairs: Array<{ figma: string; code: string; confidence: string }>;
      unmatchedFigma: string[];
      unmatchedCode: string[];
      suggestions: unknown[];
    };
    expect(json.imports.counts.mapped).toBe(1);
    expect(json.pairs).toContainEqual({ figma: "Button", code: "button", confidence: "exact" });
    expect(json.unmatchedFigma).toEqual(["Payee picker"]);
    expect(json.unmatchedCode).toEqual(["badge"]);
    expect(json.suggestions).toEqual(expect.any(Array));
  });

  it("keeps code map as a deprecated alias with the same report", async () => {
    const joined = await capture(() => runCli(["code-map", "--pairs", "--unmatched", "--repo", root]));
    const bare = await capture(() => runCodeCommand(["map", "--repo", root]));
    expect(bare.err).toBe(`${NOTICE}\n`);
    expect(bare.out).toBe(joined.out);

    const direct = await capture(() => runCli(["code-map", "--suggest", "--repo", root]));
    const alias = await capture(() => runCodeCommand(["map", "--suggest", "--repo", root]));
    expect(alias.err).toBe(`${NOTICE}\n`);
    expect(alias.out).toBe(direct.out);
    expect(direct.err).toBe("");

    const aliasJson = await capture(() => runCodeCommand(["map", "--suggest", "--repo", root, "--json"]));
    const directJson = await capture(() => runCli(["code-map", "--suggest", "--repo", root, "--json"]));
    expect(aliasJson.err).toBe(`${NOTICE}\n`);
    expect(JSON.parse(aliasJson.out)).toEqual(JSON.parse(directJson.out));
  });

  it("offers one MCP tool and keeps the older names as aliases", () => {
    expect(listToolDefinitions(true, "figma").map((tool) => tool.name)).not.toContain("code_map_scan");
    expect(listToolDefinitions(false, "code").map((tool) => tool.name).filter((name) => name.startsWith("code_map"))).toEqual(["code_map"]);

    process.env["RESOLVE_MODE"] = "code";
    const scanned = callTool("code_map", { action: "scan", package: angularRoot }) as { packageName?: string; deprecation?: string };
    expect(scanned.packageName).toBe("@acme/ui-angular");
    expect(scanned.deprecation).toBeUndefined();

    process.env["RESOLVE_MODE"] = "figma";
    expect(() => callTool("code_map_scan", { package: angularRoot })).toThrow(/RESOLVE_MCP_ADVANCED/);
    process.env["RESOLVE_MCP_ADVANCED"] = "1";
    const alias = callTool("code_map_scan", { package: angularRoot }) as { packageName?: string; deprecation?: string };
    expect(alias.deprecation).toBe(deprecationNotice("code_map_scan", "code_map"));
    expect(alias.packageName).toBe("@acme/ui-angular");
    expect(isLinkMapRequest(["suggest", "./pkg", "--write"])).toBe(false);
    expect(isLinkMapRequest(["--suggest"])).toBe(true);
    expect(isLinkMapRequest(["--write", "Button=button"])).toBe(true);
  });
});
