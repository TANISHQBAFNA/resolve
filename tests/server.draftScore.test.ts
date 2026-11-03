import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scoreUnmatched } from "@/core/query/draftScore";
import type { DesignGraph } from "@/core/model";
import { mapReport } from "@/server/code/map";
import { runLinkMap } from "@/server/code/command";
import { buildCatalog } from "@/server/code/scan";
import { runCli } from "@/server/cli";
import type { ResolveConfig } from "@/server/mode";
import { clearCache, saveGraph } from "@/server/store";

const FROZEN = "2026-01-01T00:00:00.000Z";

function tree(root: string, files: Record<string, string>) {
  for (const [rel, body] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
  }
}

function config(repo: string, store: string): ResolveConfig {
  return { mode: "both", modeSource: "env", repoPath: repo, localPrefixes: [], storeDir: store };
}

function capture(run: () => void): string {
  const lines: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => (lines.push(String(chunk)), true)) as typeof process.stdout.write;
  try {
    run();
  } finally {
    process.stdout.write = write;
  }
  return lines.join("");
}

const pillHtml = '<span class="pill" data-tone="bold" data-slot="label">New</span>\n';
const files = {
  "pill/pill.html": pillHtml,
  "pill/pill.css": ".pill { color: var(--acme-ink); }\n.pill__label { color: var(--acme-ink); }\n",
  "pill/component.json": `${JSON.stringify({ id: "pill", recipes: ["checkout"] }, null, 2)}\n`,
  "stamp/stamp.html": '<span class="stamp" style="color: var(--acme-ink)">x</span>\n',
  "crumb/crumb.html": '<span class="crumb">Home</span>\n',
  "mote/mote.html": '<span class="mote" style="color: var(--paper)">.</span>\n',
  "building-blocks/spacer/spacer.css": ".spacer { color: var(--ink); }\n",
  "figma-notes.txt": "AcmeTag stays in Figma. Resolve does not edit this file.\n",
};

const masters = [{
  name: "AcmeTag",
  nodeId: "1:1",
  variants: ["bold"],
  properties: { tone: ["bold"], slot: ["label"] },
  description: "Filter label. --acme-ink part: label recipe: checkout",
}];

describe("ranked draft scores", () => {
  it("scores a shared ID at 100 and does not measure the other signals", () => {
    const rows = scoreUnmatched({
      figma: { name: "AcmeTag", dsId: "ds@1.0.0.core.tag" },
      codes: [{ name: "pill", variants: ["bold"], modifiers: [], elements: [], tokens: ["--acme-ink"], aliases: [], dsId: "ds@1.0.0.core.tag", files: [] }],
    });
    expect(rows).toEqual([expect.objectContaining({ code: "pill", score: 100 })]);
    expect(rows[0]?.reasons.join(" ")).toMatch(/other signals not measured/);
    expect(rows[0]?.reasons.join(" ")).not.toMatch(/props /);
  });

  it("ranks AcmeTag with pill above a token-only lookalike, and never links from the score", () => {
    const root = mkdtempSync(join(tmpdir(), "resolve-draft-rank-"));
    const store = join(root, "store");
    tree(root, files);
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "mapping.json"), `${JSON.stringify({ mappings: [{ figma: "AcmeTag", aliases: ["pill"] }] }, null, 2)}\n`);
    const cfg = config(root, store);
    const report = mapReport(buildCatalog(cfg), cfg, { suggest: true, masters, limit: 5 });
    const drafts = (report.suggestions ?? []).filter((row) => row.figma === "AcmeTag");
    expect(drafts.map((row) => row.code)[0]).toBe("pill");
    expect(drafts.map((row) => row.code)).toContain("stamp");
    expect(drafts.map((row) => row.code)).not.toContain("crumb");
    const pill = drafts.find((row) => row.code === "pill");
    const stamp = drafts.find((row) => row.code === "stamp");
    expect(pill && stamp && pill.score > stamp.score).toBe(true);
    expect(pill?.confidence).toBe("suggested");
    const text = pill?.reasons.join("\n") ?? "";
    expect(text).toMatch(/score \d+\/100/);
    expect(text).toMatch(/props 30\/30/);
    expect(text).toMatch(/visual 0\/20 not yet measured/);
    expect(text).toMatch(/parts 15\/15/);
    expect(text).toMatch(/tokens 15\/15/);
    expect(text).toMatch(/alias 15\/15/);
    expect(text).toMatch(/recipe 10\/10/);
    expect(text).toMatch(/pill\/pill\.html:\d+/);
    expect(text).toMatch(/mapping\.json:\d+/);
    expect(report.pairs.map((pair) => pair.code)).not.toContain("pill");
    expect(report.bulkConfirm ?? []).not.toContain("AcmeTag=pill");
    expect(readFileSync(join(root, "figma-notes.txt"), "utf8")).toContain("does not edit this file");
  });
});

describe("confirm writes the shared ID back and leaves every other pair unconfirmed", () => {
  const previous = { home: process.env["RESOLVE_HOME"], mode: process.env["RESOLVE_MODE"] };

  afterEach(() => {
    if (previous.home === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previous.home;
    if (previous.mode === undefined) delete process.env["RESOLVE_MODE"];
    else process.env["RESOLVE_MODE"] = previous.mode;
    process.exitCode = undefined;
    clearCache();
  });

  it("offers the ID on confirm, writes it with --write-id, and confirms no wrong pair", () => {
    const root = mkdtempSync(join(tmpdir(), "resolve-draft-write-"));
    const repo = join(root, "repo");
    const store = join(root, "store");
    tree(repo, files);
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "mapping.json"), `${JSON.stringify({ mappings: [{ figma: "AcmeTag", aliases: ["pill"] }] }, null, 2)}\n`);
    process.env["RESOLVE_HOME"] = store;
    process.env["RESOLVE_MODE"] = "both";
    const offered = capture(() => runLinkMap(["--repo", repo, "--confirm", "AcmeTag=pill", "--who", "ada"], () => masters));
    expect(offered).toContain("Confirmed 1 pair");
    expect(offered).toMatch(/next: run code-map --confirm "AcmeTag=pill" --write-id/);
    expect(offered).toContain("Paste into the Figma description for AcmeTag: ds@1.0.0.core.acmetag");
    expect(offered).toContain("Resolve does not edit Figma.");
    expect(readFileSync(join(repo, "pill/pill.html"), "utf8")).toBe(pillHtml);
    expect(readFileSync(join(repo, "pill/component.json"), "utf8")).not.toContain("dsId");
    expect(process.exitCode ?? 0).toBe(0);

    const wrote = capture(() => runLinkMap(["--repo", repo, "--confirm", "AcmeTag=pill", "--write-id", "--who", "ada"], () => masters));
    expect(wrote).toContain('Wrote data-ds-id="ds@1.0.0.core.acmetag" on pill/pill.html.');
    expect(wrote).toContain('Wrote dsId "ds@1.0.0.core.acmetag" in pill/component.json.');
    expect(wrote).toContain("does not edit Figma");
    expect(readFileSync(join(repo, "pill/pill.html"), "utf8")).toContain('data-ds-id="ds@1.0.0.core.acmetag"');
    const manifest = JSON.parse(readFileSync(join(repo, "pill/component.json"), "utf8")) as { dsId?: string; recipes?: string[] };
    expect(manifest.dsId).toBe("ds@1.0.0.core.acmetag");
    expect(manifest.recipes).toEqual(["checkout"]);
    expect(readFileSync(join(repo, "figma-notes.txt"), "utf8")).toContain("does not edit this file");
    const map = JSON.parse(readFileSync(join(repo, ".resolve/component-map.json"), "utf8")) as { entries: Array<{ figma: string; code: string; status: string }> };
    const confirmed = map.entries.filter((entry) => entry.status === "confirmed");
    expect(confirmed.map((entry) => `${entry.figma}=${entry.code}`)).toEqual(["AcmeTag=pill"]);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("prints the score on code-map suggest and review, and exits 0", async () => {
    const home = mkdtempSync(join(tmpdir(), "resolve-draft-review-"));
    process.env["RESOLVE_HOME"] = home;
    clearCache();
    const graph: DesignGraph = {
      fileKey: "ACMEUI",
      fileName: "Acme UI",
      schemaVersion: 1,
      builtAt: FROZEN,
      source: { kind: "mock", ingestedAt: FROZEN, version: "2026.10.1" },
      nodes: [{
        id: "node:30:10",
        figmaNodeId: "30:10",
        fileKey: "ACMEUI",
        type: "COMPONENT_SET",
        name: "Button",
        propertyDefinitions: [{ name: "Variant", type: "VARIANT", options: ["One", "Two"] }],
      }],
      edges: [],
      warnings: [],
    };
    saveGraph(graph);
    const out = await (async () => {
      const lines: string[] = [];
      const write = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string | Uint8Array) => (lines.push(String(chunk)), true)) as typeof process.stdout.write;
      try {
        await runCli(["code-map", "suggest", join(process.cwd(), "fixtures/acme-ui-angular")]);
      } finally {
        process.stdout.write = write;
      }
      return lines.join("");
    })();
    expect(out).toContain("Button -> AcmeButtonComponent (maps, suggested)");
    expect(out).toContain("visual 0/20 not yet measured");
    expect(out).toMatch(/index\.d\.ts:\d+/);
    expect(out).toContain("A suggestion is not a code twin.");
    expect(process.exitCode ?? 0).toBe(0);

    writeFileSync(join(home, "code-map.json"), `${JSON.stringify({
      entries: [{
        fileKey: "ACMEUI",
        id: "1:2",
        name: "AcmeTag",
        status: "suggested",
        relation: "maps",
        code: { import: "import { Pill } from '@acme/ui'", component: "Pill", selector: "pill" },
      }],
    })}\n`);
    const review = await (async () => {
      const lines: string[] = [];
      const write = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string | Uint8Array) => (lines.push(String(chunk)), true)) as typeof process.stdout.write;
      try {
        await runCli(["code-map", "review", "--out", join(home, "review.csv"), "--force"]);
      } finally {
        process.stdout.write = write;
      }
      return lines.join("");
    })();
    expect(review).toContain("AcmeTag -> Pill");
    expect(review).toContain("visual 0/20 not yet measured");
    expect(review).toMatch(/next: a score never confirms a row/);
    expect(process.exitCode ?? 0).toBe(0);
  });
});
