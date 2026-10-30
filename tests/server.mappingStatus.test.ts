import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mappingAliasGroups } from "@/core/query/mappingAliases";
import { linkFigma, mapReport, readMapping, writeMappings } from "@/server/code/map";
import { buildCatalog } from "@/server/code/scan";
import type { ResolveConfig } from "@/server/mode";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "resolve-status-"));
  const store = join(root, "store");
  for (const name of ["acme-button", "acme-badge", "acme-card"]) {
    mkdirSync(join(root, "building-blocks", name), { recursive: true });
    writeFileSync(join(root, "building-blocks", name, `${name}.css`), `.${name} { color: var(--ink); }\n`);
  }
  mkdirSync(store, { recursive: true });
  const cfg: ResolveConfig = { mode: "both", modeSource: "env", repoPath: root, localPrefixes: [], storeDir: store };
  const masters = [
    { name: "Acme Button", nodeId: "1:1" },
    { name: "Acme Badge", nodeId: "1:2" },
    { name: "Acme Card", nodeId: "1:3" },
  ];
  const write = (mappings: unknown[]) => writeFileSync(join(store, "mapping.json"), `${JSON.stringify({ mappings })}\n`);
  return { cfg, catalog: buildCatalog(cfg), masters, write, file: join(store, "mapping.json") };
}

describe("mapping.json review status", () => {
  it("joins confirmed and status-less lines, and lists proposed lines as awaiting review only", () => {
    const { cfg, catalog, masters, write } = setup();
    write([
      { figma: "Acme Button", code: "acme-button", status: "confirmed" },
      { figma: "Acme Badge", code: "acme-badge" },
      { figma: "Acme Card", code: "acme-card", status: "proposed", aliases: ["tile"] },
    ]);
    const report = mapReport(catalog, cfg, { masters });
    expect(report.pairs.map((pair) => `${pair.figma}=${pair.code}:${pair.confidence}`)).toEqual(["Acme Badge=acme-badge:mapped", "Acme Button=acme-button:mapped"]);
    expect(report.awaitingReview).toEqual([{ figma: "Acme Card", code: ["acme-card"] }]);
    expect(report.unmatchedFigma).toContain("Acme Card");
    expect(report.unmatchedCode).toContain("acme-card");
    expect(report.problems).toBeUndefined();
    expect(readMapping(cfg).rules.find((rule) => rule.figma === "Acme Card")?.proposed).toBe(true);
  });

  it("never links a proposed line onto the catalog, and gives it no aliases", () => {
    const { cfg, catalog, masters, write } = setup();
    write([{ figma: "Acme Card", code: "acme-card", status: "proposed", aliases: ["tile"] }]);
    linkFigma(catalog, cfg, masters);
    const card = catalog.components.find((entry) => entry.name === "acme-card");
    expect(card?.matchedBy).toBeUndefined();
    expect(card?.aliases).toBeUndefined();
  });

  it("reads an unknown status as proposed and lists it as a problem", () => {
    const { cfg, catalog, masters, write } = setup();
    write([{ figma: "Acme Button", code: "acme-button", status: "unconfirmed" }]);
    const report = mapReport(catalog, cfg, { masters });
    expect(report.pairs).toEqual([]);
    expect(report.awaitingReview).toEqual([{ figma: "Acme Button", code: ["acme-button"] }]);
    expect(report.problems?.some((line) => line.includes('"unconfirmed"'))).toBe(true);
  });

  it("warns when a mapping line names a Figma component that is not learned, and still uses the other lines", () => {
    const { cfg, catalog, masters, write } = setup();
    write([
      { figma: "Acme Buton", code: "acme-button" },
      { figma: "Acme Badge", code: "acme-badge" },
      { figma: "Acme Ghost", code: "acme-card", status: "proposed" },
    ]);
    const report = mapReport(catalog, cfg, { masters });
    expect(report.pairs.map((pair) => pair.figma)).toEqual(["Acme Badge"]);
    expect(report.problems).toEqual([
      'mapping figma "Acme Buton" is not a learned Figma component. next: fix the name in mapping.json or learn the library that has it.',
    ]);
    expect(mapReport(catalog, cfg, { masters: [] }).problems ?? []).not.toContainEqual(expect.stringContaining("not a learned Figma component"));
  });

  it("treats status denied like deny: true", () => {
    const { cfg, catalog, masters, write } = setup();
    write([{ figma: "Acme Button", code: "acme-button" }, { figma: "Acme Button", code: "acme-button", status: "denied" }]);
    const report = mapReport(catalog, cfg, { suggest: true, masters });
    expect(report.pairs).toEqual([]);
    expect(report.awaitingReview).toBeUndefined();
  });

  it("code-map --write confirms a proposed line in place instead of adding a second line", () => {
    const { cfg, catalog, masters, write, file } = setup();
    write([{ figma: "Acme Card", code: "acme-card", status: "proposed" }]);
    catalog.figmaMasters = masters;
    const done = writeMappings(cfg, catalog, ["Acme Card=acme-card"]);
    expect(done.added).toEqual([{ figma: "Acme Card", code: "acme-card" }]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ mappings: [{ figma: "Acme Card", code: "acme-card", status: "confirmed" }] });
    expect(mapReport(catalog, cfg, { masters }).pairs).toContainEqual({ figma: "Acme Card", code: "acme-card", confidence: "mapped" });
    expect(writeMappings(cfg, catalog, ["Acme Card=acme-card"]).added).toEqual([]);
  });

  it("leaves a proposed line's aliases out of the Figma-side pick", () => {
    const { cfg, write } = setup();
    write([{ figma: "Acme Card", aliases: ["tile"], status: "proposed" }, { figma: "Acme Badge", aliases: ["pill"] }]);
    const previous = { home: process.env["RESOLVE_HOME"], on: process.env["RESOLVE_MAPPING_ALIASES"] };
    process.env["RESOLVE_HOME"] = cfg.storeDir;
    process.env["RESOLVE_MAPPING_ALIASES"] = "1";
    try {
      expect(mappingAliasGroups()).toEqual([["acme badge", "pill"]]);
    } finally {
      for (const [key, value] of [["RESOLVE_HOME", previous.home], ["RESOLVE_MAPPING_ALIASES", previous.on]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
