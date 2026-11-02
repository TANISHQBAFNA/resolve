import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { dsIdOf, parseDsId, sameButVersion } from "@/core/rules/dsId";
import { mapReport, norm } from "@/server/code/map";
import { confirmEvidenceTier, proposalsFromReport, readComponentMap, writeDraft } from "@/server/componentMap";
import { buildCatalog } from "@/server/code/scan";
import type { ResolveConfig } from "@/server/mode";

function repo(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "resolve-dsid-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  const cfg: ResolveConfig = { mode: "both", modeSource: "env", repoPath: root, localPrefixes: [], storeDir: join(root, "store") };
  return { cfg, catalog: buildCatalog(cfg) };
}

const css = (name: string) => `.${name} { color: var(--ink); }\n`;

describe("shared ID ds@semver.tier.name", () => {
  it("reads the ID from text and compares it exactly", () => {
    expect(parseDsId("Primary action. ds@1.4.0.Core.Button.")?.id).toBe("ds@1.4.0.core.button");
    expect(parseDsId("ds@1.4.0.core")).toBeUndefined();
    expect(parseDsId("myds@1.4.0.core.button")).toBeUndefined();
    expect(dsIdOf(undefined, "Button ds@2.0.0.core.button")?.version).toBe("2.0.0");
    expect(sameButVersion(parseDsId("ds@1.0.0.core.button")!, parseDsId("ds@1.1.0.core.button")!)).toBe(true);
  });

  it("links on the ID from data-ds-id even when the names share nothing", () => {
    const { cfg, catalog } = repo({
      "building-blocks/cta/cta.css": css("cta"),
      "building-blocks/cta/cta.html": `<button class="cta" data-ds-id="ds@1.4.0.core.button">Go</button>\n`,
      "building-blocks/button/button.css": css("button"),
    });
    expect(catalog.components.find((entry) => entry.name === "cta")?.dsId).toBe("ds@1.4.0.core.button");
    const report = mapReport(catalog, cfg, { suggest: true, masters: [{ name: "Button", nodeId: "1:1", description: "ds@1.4.0.core.button" }] });
    expect(report.pairs).toEqual([{ figma: "Button", code: "cta", confidence: "mapped", source: "id" }]);
    expect(report.suggestions ?? []).toEqual([]);
  });

  it("links on the ID from a component.json manifest", () => {
    const { cfg, catalog } = repo({
      "building-blocks/chip/chip.css": css("chip"),
      "building-blocks/chip/component.json": `${JSON.stringify({ id: "chip", figma: { name: "Tag" }, dsId: "ds@3.0.0.core.tag" })}\n`,
    });
    const report = mapReport(catalog, cfg, { masters: [{ name: "Tag", nodeId: "2:1", description: "Use for filters. ds@3.0.0.core.tag" }] });
    expect(report.pairs).toEqual([{ figma: "Tag", code: "chip", confidence: "mapped", source: "id" }]);
  });

  it("warns, and does not link, when only the version differs", () => {
    const { cfg, catalog } = repo({
      "building-blocks/cta/cta.css": css("cta"),
      "building-blocks/cta/cta.html": `<a class="cta" data-ds-id="ds@1.5.0.core.button">Go</a>\n`,
    });
    const report = mapReport(catalog, cfg, { masters: [{ name: "Primary", nodeId: "1:1", description: "ds@1.4.0.core.button" }] });
    expect(report.pairs).toEqual([]);
    expect(report.problems?.some((line) => line.includes("differ only by version") && line.includes("next:"))).toBe(true);
  });

  it("lets a deny line in mapping.json beat the ID", () => {
    const { cfg, catalog } = repo({
      "building-blocks/cta/cta.css": css("cta"),
      "building-blocks/cta/cta.html": `<a class="cta" data-ds-id="ds@1.4.0.core.button">Go</a>\n`,
    });
    mkdirSync(cfg.storeDir, { recursive: true });
    writeFileSync(join(cfg.storeDir, "mapping.json"), `${JSON.stringify({ mappings: [{ figma: "Button", code: "cta", deny: true }] })}\n`);
    const report = mapReport(catalog, cfg, { masters: [{ name: "Button", nodeId: "1:1", description: "ds@1.4.0.core.button" }] });
    expect(report.pairs).toEqual([]);
  });

  it("joins a confirmed mapping.json pair after the ID step, and never on a name", () => {
    const { cfg, catalog } = repo({
      "building-blocks/cta/cta.css": css("cta"),
      "building-blocks/cta/cta.html": `<a class="cta" data-ds-id="ds@1.4.0.core.button">Go</a>\n`,
      "building-blocks/chip/chip.css": css("chip"),
      "building-blocks/card/card.css": css("card"),
    });
    const masters = [
      { name: "Button", nodeId: "1:1", description: "ds@1.4.0.core.button" },
      { name: "Tag", nodeId: "1:2" },
      { name: "Card", nodeId: "1:3", variants: ["elevated"] },
    ];
    expect(mapReport(catalog, cfg, { masters }).pairs).toEqual([{ figma: "Button", code: "cta", confidence: "mapped", source: "id" }]);
    mkdirSync(cfg.storeDir, { recursive: true });
    writeFileSync(join(cfg.storeDir, "mapping.json"), `${JSON.stringify({ mappings: [{ figma: "Tag", code: "chip" }] })}\n`);
    const report = mapReport(catalog, cfg, { masters });
    expect(report.pairs).toEqual([
      { figma: "Button", code: "cta", confidence: "mapped", source: "id" },
      { figma: "Tag", code: "chip", confidence: "mapped" },
    ]);
    expect(report.unmatchedFigma).toEqual(["Card"]);
  });

  it("drafts an unmatched same name for review, with a reason, and never links or bulk-confirms it", () => {
    const { cfg, catalog } = repo({
      "building-blocks/acme-badge/acme-badge.css": `.acme-badge { color: var(--ink); }\n.acme-badge--pill { color: var(--ink); }\n`,
    });
    const masters = [{ name: "Acme Badge", nodeId: "1:1", variants: ["pill"], description: "Shows a count." }];
    const report = mapReport(catalog, cfg, { suggest: true, masters, infer: true });
    expect(report.pairs).toEqual([]);
    expect(report.unmatchedFigma).toEqual(["Acme Badge"]);
    expect(report.bulkConfirm).toEqual([]);
    const row = report.suggestions?.find((item) => item.figma === "Acme Badge" && item.code === "acme-badge");
    expect(row?.confidence).toBe("risky: same name only");
    expect(row?.reasons.join("; ")).toMatch(/same name, no evidence; confirm it or add the shared ID/);
    const drafts = proposalsFromReport(report);
    expect(drafts).toEqual([expect.objectContaining({ figma: "Acme Badge", code: "acme-badge", status: "proposed", tier: "risky" })]);
    writeDraft(cfg, drafts, (name) => norm(name), masters);
    expect(confirmEvidenceTier(cfg, "ada", "2026-11-02T00:00:00.000Z").confirmed).toBe(0);
    expect(readComponentMap(cfg).entries.every((entry) => entry.status === "proposed")).toBe(true);
    expect(mapReport(catalog, cfg, { masters }).pairs).toEqual([]);
  });
});
