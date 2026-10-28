import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { adaptFigmaMcpMetadata } from "@/core/ingestion";
import type { DesignGraph } from "@/core/model";
import { indexGraph } from "@/core/query";
import { buildGraph } from "@/core/transform";
import { linkFigma, mapReport, mappingPath, writeMappings } from "@/server/code/map";
import { buildCatalog, type CodeCatalog } from "@/server/code/scan";
import { graphMasters } from "@/server/graphMasters";
import type { ResolveConfig } from "@/server/mode";
import { clearCache, saveGraph } from "@/server/store";

const css = (name: string, body: string) => body || `.${name} { color: var(--ink); }\n`;

function tree(root: string, files: Record<string, string>) {
  for (const [rel, body] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
  }
}

function config(repo: string, store: string, figmaNamespaces?: string[]): ResolveConfig {
  return {
    mode: "both",
    modeSource: "env",
    repoPath: repo,
    localPrefixes: [],
    storeDir: store,
    ...(figmaNamespaces ? { figmaNamespaces } : {}),
  };
}

function catalog(repo: string, store: string, files: Record<string, string>, figmaNamespaces?: string[]): { cfg: ResolveConfig; catalog: CodeCatalog } {
  tree(repo, files);
  const cfg = config(repo, store, figmaNamespaces);
  return { cfg, catalog: buildCatalog(cfg) };
}

describe("namespaced Figma names join the coded component", () => {
  it("matches the name after the namespace and refuses a recipe that only shares the last word", () => {
    const root = mkdtempSync(join(tmpdir(), "resolve-ns-"));
    const store = join(root, "store");
    const { cfg, catalog: built } = catalog(root, store, {
      "building-blocks/button/button.css": ".button { color: var(--ink); }\n.button--primary { color: var(--ink); }\n",
      "building-blocks/text-field/text-field.css": ".text-field { color: var(--ink); }\n.text-field--outline { color: var(--ink); }\n",
      "building-blocks/header/header.css": ".header { color: var(--ink); }\n.header--wide { color: var(--ink); }\n",
      "building-blocks/card-recipes/card-recipes.css": ".card-recipes { color: var(--ink); }\n",
      "building-blocks/banner/banner.html": '<section class="banner banner--wide">Sale</section>\n',
      "recipes/header/header.css": ".header { color: var(--ink); }\n.header--wide { color: var(--ink); }\n",
      "building-blocks/status/status.css": ".status { color: var(--ink); }\n.status--pill { color: var(--ink); }\n",
      "recipes/status/status.css": ".status { color: var(--ink); }\n",
    });
    const masters = [
      { name: "ingredients/button", nodeId: "1:1", variants: ["primary"] },
      { name: "ingredients/text-field", nodeId: "1:2", variants: ["outline"] },
      { name: "recipes/button", nodeId: "1:3" },
      { name: "recipes/header", nodeId: "1:4", variants: ["wide"] },
      { name: "recipes/footer", nodeId: "1:5" },
      { name: "base/button-content", nodeId: "1:6" },
      { name: "Status", nodeId: "1:7", variants: ["pill"] },
    ];
    const report = mapReport(built, cfg, { suggest: true, masters });
    expect(report.pairs).toContainEqual({ figma: "ingredients/button", code: "button", confidence: "exact", parts: ["base/button-content"] });
    expect(report.pairs).toContainEqual({ figma: "ingredients/text-field", code: "text-field", confidence: "exact" });
    expect(report.pairs).toContainEqual({ figma: "recipes/header", code: "header", confidence: "exact" });
    expect(report.pairs).toContainEqual({ figma: "Status", code: "status", confidence: "exact" });
    expect(report.pairs.map((pair) => pair.figma)).not.toContain("recipes/button");
    expect(report.pairs.map((pair) => pair.figma)).not.toContain("base/button-content");
    expect(report.unmatchedFigma).not.toContain("base/button-content");
    expect(report.unmatchedFigma).toContain("recipes/button");
    const header = built.components.find((entry) => entry.kind === "recipe" && entry.name === "header");
    const blockHeader = built.components.find((entry) => entry.kind === "block" && entry.name === "header");
    expect(report.pairs.filter((pair) => pair.code === "header" && pair.figma === "recipes/header")).toHaveLength(1);
    expect(header?.name).toBe("header");
    expect(blockHeader?.name).toBe("header");
    const status = report.pairs.find((pair) => pair.figma === "Status");
    expect(built.components.find((entry) => entry.kind === "block" && entry.name === "status")?.variants).toContain("pill");
    expect(status?.code).toBe("status");
    expect(report.suggestions?.filter((row) => row.code === "card-recipes" || row.figma.startsWith("base/"))).toEqual([]);
    expect(report.suggestions?.some((row) => row.figma === "recipes/button" && row.code === "button")).toBe(false);
    linkFigma(built, cfg, masters);
    expect(built.components.find((entry) => entry.kind === "recipe" && entry.name === "header")?.figma?.name).toBe("recipes/header");
    expect(built.components.find((entry) => entry.kind === "block" && entry.name === "header")?.figma).toBeUndefined();
    expect(built.components.find((entry) => entry.kind === "block" && entry.name === "status")?.figma?.name).toBe("Status");
    expect(built.components.find((entry) => entry.kind === "recipe" && entry.name === "status")?.figma).toBeUndefined();
    expect(built.components.find((entry) => entry.name === "button")?.parts).toEqual(["base/button-content"]);
    const banner = built.components.find((entry) => entry.name === "banner");
    expect(banner).toMatchObject({ kind: "block", variants: ["wide"] });
    expect(banner?.code?.cssFiles.every((file) => !file.endsWith(".css"))).toBe(true);
    expect(built.components.map((entry) => entry.name)).toContain("banner");
    built.figmaMasters = masters;
    writeMappings(cfg, built, ["recipes/header=header"]);
    linkFigma(built, cfg, masters);
    expect(built.components.find((entry) => entry.kind === "recipe" && entry.name === "header")?.matchedBy).toBe("mapped");
    expect(built.components.find((entry) => entry.kind === "block" && entry.name === "header")?.figma).toBeUndefined();
  });

  it("keeps the full Figma name on --write and does not fan one rule out across a prefix", () => {
    const root = mkdtempSync(join(tmpdir(), "resolve-write-"));
    const store = join(root, "store");
    const { cfg, catalog: built } = catalog(root, store, {
      "building-blocks/btn/btn.css": css("btn", ".btn { color: var(--ink); }\n"),
    });
    built.figmaMasters = [
      { name: "ingredients/button", nodeId: "1:1" },
      { name: "ingredients/text-field", nodeId: "1:2" },
      { name: "recipes/button", nodeId: "1:3" },
    ];
    const written = writeMappings(cfg, built, ["ingredients/button=btn"]);
    expect(written.added).toEqual([{ figma: "ingredients/button", code: "btn" }]);
    expect(JSON.parse(readFileSync(mappingPath(cfg), "utf8")).mappings).toEqual([{ figma: "ingredients/button", code: "btn" }]);
    writeMappings(cfg, built, ["recipes/button=btn"]);
    const report = mapReport(built, cfg);
    expect(report.pairs).toEqual([
      { figma: "ingredients/button", code: "btn", confidence: "mapped" },
      { figma: "recipes/button", code: "btn", confidence: "mapped" },
    ]);
    expect(report.pairs.map((pair) => pair.figma)).not.toContain("ingredients/text-field");
  });

  it("uses a configured namespace and ignores one that is not configured", () => {
    const root = mkdtempSync(join(tmpdir(), "resolve-ns-cfg-"));
    const store = join(root, "store");
    const files = { "building-blocks/toggle/toggle.css": ".toggle { color: var(--ink); }\n.toggle--compact { color: var(--ink); }\n" };
    const plain = catalog(root, store, files);
    expect(mapReport(plain.catalog, plain.cfg, { masters: [{ name: "widgets/toggle", nodeId: "8:1", variants: ["compact"] }] }).pairs).toEqual([]);
    expect(mapReport(plain.catalog, plain.cfg, { masters: [{ name: "Toggle/Primary", nodeId: "8:2", variants: ["compact"] }] }).pairs).toEqual([
      { figma: "Toggle/Primary", code: "toggle", confidence: "exact" },
    ]);
    const custom = catalog(join(root, "b"), join(root, "store-b"), files, ["widgets"]);
    expect(mapReport(custom.catalog, custom.cfg, { masters: [{ name: "widgets/toggle", nodeId: "8:1", variants: ["compact"] }] }).pairs).toEqual([
      { figma: "widgets/toggle", code: "toggle", confidence: "exact" },
    ]);
  });

  it("skips an unpublished master and keeps a published sibling", () => {
    const root = mkdtempSync(join(tmpdir(), "resolve-pub-"));
    const store = join(root, "store");
    const { cfg, catalog: built } = catalog(root, store, {
      "building-blocks/button/button.css": ".button { color: var(--ink); }\n.button--primary { color: var(--ink); }\n",
      "building-blocks/draft-knob/draft-knob.css": ".draft-knob { color: var(--ink); }\n",
    });
    const report = mapReport(built, cfg, {
      masters: [
        { name: "ingredients/button", nodeId: "3:1", published: true, variants: ["primary"] },
        { name: "ingredients/draft-knob", nodeId: "3:2", published: false },
      ],
    });
    expect(report.pairs.map((pair) => pair.figma)).toEqual(["ingredients/button"]);
    expect(report.unmatchedFigma).not.toContain("ingredients/draft-knob");
    expect(report.figmaComponents).toBe(1);
  });
});

describe("page listings keep a component set that has no variants", () => {
  function kinds(xml: string): string[] {
    const graph = buildGraph(adaptFigmaMcpMetadata({ fileKey: "ACME", fileName: "Acme", metadataXml: xml }));
    return indexGraph(graph)
      .getNodesByType("COMPONENT_SET", "MAIN_COMPONENT", "FRAME")
      .map((node) => `${node.type}:${node.name}`)
      .sort();
  }

  it("keeps a namespaced set whose variants were left off the page", () => {
    expect(kinds(`
      <frame id="9:1" name="ingredients/button" x="0" y="0" width="120" height="40" />
      <component-set id="9:2" name="ingredients/text-field" x="140" y="0" width="120" height="40"></component-set>
      <frame id="9:3" name="Home" x="0" y="80" width="400" height="800"></frame>
    `)).toEqual(["COMPONENT_SET:ingredients/button", "COMPONENT_SET:ingredients/text-field", "FRAME:Home"]);
  });
});

describe("learned libraries skip unpublished components", () => {
  const previous = { home: process.env["RESOLVE_HOME"], mode: process.env["RESOLVE_MODE"], unpublished: process.env["RESOLVE_INCLUDE_UNPUBLISHED"] };

  afterEach(() => {
    clearCache();
    const restore = (key: "RESOLVE_HOME" | "RESOLVE_MODE" | "RESOLVE_INCLUDE_UNPUBLISHED", value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore("RESOLVE_HOME", previous.home);
    restore("RESOLVE_MODE", previous.mode);
    restore("RESOLVE_INCLUDE_UNPUBLISHED", previous.unpublished);
  });

  it("drops a master with no published key when a sibling is published", () => {
    const home = mkdtempSync(join(tmpdir(), "resolve-masters-"));
    process.env["RESOLVE_HOME"] = home;
    delete process.env["RESOLVE_MODE"];
    delete process.env["RESOLVE_INCLUDE_UNPUBLISHED"];
    clearCache();
    const graph: DesignGraph = {
      fileKey: "ACME",
      fileName: "Acme",
      schemaVersion: 1,
      builtAt: "2026-01-01T00:00:00.000Z",
      source: { kind: "mock", ingestedAt: "2026-01-01T00:00:00.000Z" },
      nodes: [
        { id: "node:1:1", figmaNodeId: "1:1", fileKey: "ACME", type: "COMPONENT_SET", name: "ingredients/button", metadata: { key: "acme-button" } },
        { id: "node:1:2", figmaNodeId: "1:2", fileKey: "ACME", type: "COMPONENT_SET", name: "ingredients/draft-knob" },
      ],
      edges: [],
      warnings: [],
    };
    saveGraph(graph);
    expect(graphMasters().map((master) => master.name)).toEqual(["ingredients/button"]);
    process.env["RESOLVE_INCLUDE_UNPUBLISHED"] = "1";
    expect(graphMasters().map((master) => master.name).sort()).toEqual(["ingredients/button", "ingredients/draft-knob"]);
  });
});
