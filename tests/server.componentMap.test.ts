import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { confirmComponentPairs, confirmEvidenceTier, proposalsFromReport, readComponentMap, writeDraft } from "@/server/componentMap";
import { runLinkMap } from "@/server/code/command";
import { mapReport, norm } from "@/server/code/map";
import { buildCatalog } from "@/server/code/scan";
import type { ResolveConfig } from "@/server/mode";

const css = (body: string) => body;
const root = join(process.cwd(), "fixtures/acme-map");

function config(repo: string, store: string): ResolveConfig {
  return { mode: "both", modeSource: "env", repoPath: repo, localPrefixes: [], storeDir: store };
}

function tree(dir: string, files: Record<string, string>) {
  for (const [rel, body] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
  }
}

const masters = [
  { name: "Acme Button", nodeId: "btn-key", variants: ["primary"] },
  { name: "Acme Switch", nodeId: "switch-key", variants: ["on"] },
  { name: "Acme Badge", nodeId: "badge-key" },
  { name: "Acme Banner", nodeId: "banner-key", variants: ["compact"] },
  { name: "Acme Chip", nodeId: "chip-key", variants: ["compact"] },
];

describe("component map", () => {
  it("links only the reviewed map and manifests", () => {
    const store = mkdtempSync(join(tmpdir(), "resolve-acme-map-"));
    const report = mapReport(buildCatalog(config(root, store)), config(root, store), { masters });
    expect(report.pairs).toEqual([
      { figma: "Acme Button", code: "acme-button", confidence: "mapped", source: "map" },
      { figma: "Acme Switch", code: "acme-switch", confidence: "mapped", source: "manifest" },
    ]);
    expect(report.pairs.map((pair) => pair.figma)).not.toContain("Acme Chip");
    expect(report.unlinkedFigma).toEqual(["Acme Chip"]);
    expect(report.unlinkedCode).toEqual(["acme-chip"]);
    expect(report.denies).toEqual(["Acme Badge -> acme-badge (manifest ignored)"]);
    expect(report.conflicts).toEqual(["Acme Banner is acme-banner in the manifest and acme-banner-alt in the map"]);
    expect(report.stale).toEqual([
      { figma: "Acme Banner", code: "acme-banner-alt", missing: "code" },
      { figma: "Acme Ghost", code: "acme-ghost", missing: "both" },
    ]);
    expect(report.componentMapExists).toBe(true);
    expect(report.draftHint).toBeUndefined();
  });

  it("still infers when the component map is absent, and says to draft one", () => {
    const store = mkdtempSync(join(tmpdir(), "resolve-acme-infer-"));
    const repo = mkdtempSync(join(tmpdir(), "resolve-acme-repo-"));
    cpSync(root, repo, { recursive: true });
    rmSync(join(repo, ".resolve", "component-map.json"));
    const cfg = config(repo, store);
    const report = mapReport(buildCatalog(cfg), cfg, { masters });
    expect(report.pairs).toContainEqual({ figma: "Acme Chip", code: "acme-chip", confidence: "exact" });
    expect(report.pairs).toContainEqual({ figma: "Acme Button", code: "acme-button", confidence: "mapped", source: "manifest" });
    expect(report.draftHint).toBe("No component map yet. Run code-map --draft.");
    expect(report.componentMapExists).toBe(false);
  });

  it("does not auto-link a mapping.json pair once the component map exists", () => {
    const store = mkdtempSync(join(tmpdir(), "resolve-acme-only-"));
    const repo = mkdtempSync(join(tmpdir(), "resolve-acme-only-repo-"));
    cpSync(root, repo, { recursive: true });
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "mapping.json"), `${JSON.stringify({ mappings: [{ figma: "Acme Chip", code: "acme-chip" }] })}\n`);
    const cfg = config(repo, store);
    const report = mapReport(buildCatalog(cfg), cfg, { masters });
    expect(report.pairs.map((pair) => pair.figma)).not.toContain("Acme Chip");
  });

  it("rejects a component map that fails validation and does not guess", () => {
    const store = mkdtempSync(join(tmpdir(), "resolve-acme-bad-"));
    const repo = mkdtempSync(join(tmpdir(), "resolve-acme-bad-repo-"));
    tree(repo, {
      "building-blocks/acme-chip/acme-chip.css": css(".acme-chip { color: var(--ink); }\n.acme-chip--compact { color: var(--ink); }\n"),
      ".resolve/component-map.json": `${JSON.stringify({ entries: [{ figma: "Acme Chip", code: "acme-chip", status: "confirmed" }] })}\n`,
    });
    const cfg = config(repo, store);
    const report = mapReport(buildCatalog(cfg), cfg, { masters: [{ name: "Acme Chip", nodeId: "chip-key", variants: ["compact"] }] });
    expect(report.pairs).toEqual([]);
    expect(report.problems?.join(" ")).toMatch(/by/);
    expect(readComponentMap(cfg).entries).toEqual([]);
  });

  it("reports a component.json that is not a manifest", () => {
    const store = mkdtempSync(join(tmpdir(), "resolve-acme-manifest-"));
    const repo = mkdtempSync(join(tmpdir(), "resolve-acme-manifest-repo-"));
    tree(repo, {
      "building-blocks/acme-button/acme-button.css": css(".acme-button { color: var(--ink); }\n"),
      "building-blocks/acme-button/component.json": `${JSON.stringify({ id: "acme-button", figma: {}, version: 1 })}\n`,
    });
    const cfg = config(repo, store);
    const report = mapReport(buildCatalog(cfg), cfg, { masters: [{ name: "Acme Button", nodeId: "1:1" }] });
    expect(report.problems?.join(" ")).toMatch(/figma/);
    expect(report.pairs.map((pair) => pair.source)).not.toContain("manifest");
  });
});

describe("component map draft and review", () => {
  it("classifies matcher rows and never marks them confirmed", () => {
    const rows = proposalsFromReport({
      pairs: [
        { figma: "Acme Button", code: "acme-button", confidence: "exact" },
        { figma: "Acme Card", code: "acme-card", confidence: "mapped" },
      ],
      suggestions: [
        { figma: "Acme Badge", code: "acme-badge", reasons: ["same name, no evidence"] },
        { figma: "Acme Note", code: "acme-field", reasons: ["note~field"] },
      ],
    });
    expect(rows.map((row) => row.status)).toEqual(["proposed", "proposed", "proposed", "proposed"]);
    expect(rows.map((row) => [row.figma, row.tier])).toEqual([
      ["Acme Button", "evidence"],
      ["Acme Card", "evidence"],
      ["Acme Note", "suggested"],
      ["Acme Badge", "risky"],
    ]);
    expect(rows.find((row) => row.figma === "Acme Button")?.reason).toMatch(/shared variant/);
  });

  it("keeps confirmed and denied rows when the draft is written again", () => {
    const store = mkdtempSync(join(tmpdir(), "resolve-draft-"));
    const repo = mkdtempSync(join(tmpdir(), "resolve-draft-repo-"));
    tree(repo, {
      "building-blocks/acme-button/acme-button.css": css(".acme-button { color: var(--ink); }\n.acme-button--primary { color: var(--ink); }\n"),
      "building-blocks/acme-badge/acme-badge.css": css(".acme-badge { color: var(--ink); }\n"),
    });
    const cfg = config(repo, store);
    const same = (name: string) => norm(name);
    const mastersFor = [
      { name: "Acme Button", nodeId: "1:1", variants: ["primary"] },
      { name: "Acme Badge", nodeId: "1:2" },
    ];
    mkdirSync(join(repo, ".resolve"), { recursive: true });
    writeFileSync(join(repo, ".resolve", "component-map.json"), `${JSON.stringify({
      entries: [
        { figma: "Acme Button", code: "acme-button", status: "confirmed", by: "ada", at: "2026-01-15T12:00:00.000Z" },
        { figma: "Acme Badge", code: "acme-badge", status: "denied", by: "ada", at: "2026-01-15T12:00:00.000Z" },
      ],
    })}\n`);
    const catalog = buildCatalog(cfg);
    const inferred = mapReport(catalog, cfg, { suggest: true, limit: 5, masters: mastersFor, infer: true });
    writeDraft(cfg, proposalsFromReport(inferred), same, mastersFor);
    writeDraft(cfg, proposalsFromReport(inferred), same, mastersFor);
    const saved = readComponentMap(cfg).entries;
    expect(saved.filter((entry) => entry.status === "confirmed")).toEqual([
      { figma: "Acme Button", code: "acme-button", status: "confirmed", by: "ada", at: "2026-01-15T12:00:00.000Z" },
    ]);
    expect(saved.filter((entry) => entry.status === "denied")).toEqual([
      { figma: "Acme Badge", code: "acme-badge", status: "denied", by: "ada", at: "2026-01-15T12:00:00.000Z" },
    ]);
    expect(saved.some((entry) => entry.status === "proposed" && entry.figma === "Acme Button" && entry.code === "acme-button")).toBe(false);
    expect(saved.some((entry) => entry.status === "proposed" && entry.figma === "Acme Badge" && entry.code === "acme-badge")).toBe(false);
  });

  it("confirms one pair, denies one pair, and bulk-confirms only evidence", () => {
    const store = mkdtempSync(join(tmpdir(), "resolve-review-"));
    const repo = mkdtempSync(join(tmpdir(), "resolve-review-repo-"));
    tree(repo, {
      "building-blocks/acme-button/acme-button.css": css(".acme-button { color: var(--ink); }\n.acme-button--primary { color: var(--ink); }\n"),
      "building-blocks/acme-badge/acme-badge.css": css(".acme-badge { color: var(--ink); }\n"),
      "building-blocks/acme-note/acme-note.css": css(".acme-note { color: var(--ink); }\n"),
      ".resolve/component-map.json": `${JSON.stringify({
        entries: [
          { figma: "Acme Button", code: "acme-button", status: "proposed", tier: "evidence", reason: "same name and a shared variant, modifier, or description" },
          { figma: "Acme Note", code: "acme-note", status: "proposed", tier: "suggested", reason: "same words" },
          { figma: "Acme Badge", code: "acme-badge", status: "proposed", tier: "risky", reason: "same name, no evidence" },
        ],
      })}\n`,
    });
    const cfg = config(repo, store);
    const catalog = buildCatalog(cfg);
    const mastersFor = [
      { name: "Acme Button", nodeId: "1:1", variants: ["primary"] },
      { name: "Acme Badge", nodeId: "1:2" },
      { name: "Acme Note", nodeId: "1:3" },
    ];
    const same = (name: string) => norm(name);
    const shared = { cfg, masters: mastersFor, components: catalog.components, same };
    confirmComponentPairs({ ...shared, pairs: ["Acme Note=acme-note"], action: "confirm", who: "ada", at: "2026-02-01T00:00:00.000Z" });
    confirmComponentPairs({ ...shared, pairs: ["Acme Badge=acme-badge"], action: "deny", who: "ada", at: "2026-02-01T00:00:00.000Z" });
    const bulk = confirmEvidenceTier(cfg, "ada", "2026-02-02T00:00:00.000Z");
    expect(bulk.confirmed).toBe(1);
    expect(bulk.left).toBe(0);
    const saved = readComponentMap(cfg).entries;
    expect(saved.find((entry) => entry.code === "acme-button")).toMatchObject({ status: "confirmed", by: "ada", at: "2026-02-02T00:00:00.000Z", tier: "evidence" });
    expect(saved.find((entry) => entry.code === "acme-note")).toMatchObject({ status: "confirmed", by: "ada", at: "2026-02-01T00:00:00.000Z" });
    expect(saved.find((entry) => entry.code === "acme-badge")).toMatchObject({ status: "denied", by: "ada", at: "2026-02-01T00:00:00.000Z" });
  });
});

describe("component map command text", () => {
  function capture(args: string[], mastersFor?: typeof masters) {
    const lines: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => (lines.push(String(chunk)), true)) as typeof process.stdout.write;
    try {
      runLinkMap(args, mastersFor ? () => mastersFor : undefined);
    } finally {
      process.stdout.write = write;
    }
    return lines.join("");
  }

  it("prints the draft hint, then unlinked and stale once a map exists", () => {
    const store = mkdtempSync(join(tmpdir(), "resolve-acme-text-"));
    const previous = process.env["RESOLVE_HOME"];
    process.env["RESOLVE_HOME"] = store;
    try {
      const repo = mkdtempSync(join(tmpdir(), "resolve-acme-text-repo-"));
      cpSync(root, repo, { recursive: true });
      rmSync(join(repo, ".resolve", "component-map.json"));
      expect(capture(["--repo", repo, "--pairs"], masters)).toContain("No component map yet. Run code-map --draft.");
      cpSync(join(root, ".resolve", "component-map.json"), join(repo, ".resolve", "component-map.json"));
      const text = capture(["--repo", repo, "--pairs"], masters);
      expect(text).toContain("unlinked, please confirm:");
      expect(text).toContain("Acme Chip (figma)");
      expect(text).toContain("acme-chip (code)");
      expect(text).toContain("stale: Acme Ghost -> acme-ghost (both missing)");
      expect(text).toContain("conflict: Acme Banner is acme-banner in the manifest and acme-banner-alt in the map");
      expect(text).not.toContain("No component map yet");
    } finally {
      if (previous === undefined) delete process.env["RESOLVE_HOME"];
      else process.env["RESOLVE_HOME"] = previous;
    }
  });

  it("drafts proposals from the command and does not confirm them", () => {
    const store = mkdtempSync(join(tmpdir(), "resolve-draft-cli-"));
    const repo = mkdtempSync(join(tmpdir(), "resolve-draft-cli-repo-"));
    tree(repo, { "building-blocks/acme-button/acme-button.css": css(".acme-button { color: var(--ink); }\n.acme-button--primary { color: var(--ink); }\n") });
    const previous = process.env["RESOLVE_HOME"];
    process.env["RESOLVE_HOME"] = store;
    try {
      const text = capture(["--repo", repo, "--draft"], [{ name: "Acme Button", nodeId: "1:1", variants: ["primary"] }]);
      expect(text).toContain("Nothing was marked confirmed.");
      const saved = JSON.parse(readFileSync(join(repo, ".resolve", "component-map.json"), "utf8")) as { entries: Array<{ status: string; tier: string }> };
      expect(saved.entries.every((entry) => entry.status === "proposed")).toBe(true);
      expect(saved.entries.some((entry) => entry.tier === "evidence")).toBe(true);
    } finally {
      if (previous === undefined) delete process.env["RESOLVE_HOME"];
      else process.env["RESOLVE_HOME"] = previous;
    }
  });
});
