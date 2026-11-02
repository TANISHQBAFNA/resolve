import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { dsIdOf, parseDsId, sameButVersion } from "@/core/rules/dsId";
import { mapReport } from "@/server/code/map";
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
});
