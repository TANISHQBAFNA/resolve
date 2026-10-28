import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { learnLibrary } from "@/server/learn";
import { runCodeCommand } from "@/server/code/command";
import { mapReport } from "@/server/code/map";
import { buildCatalog, type CodeCatalog } from "@/server/code/scan";
import { graphMasters } from "@/server/graphMasters";
import type { ResolveConfig } from "@/server/mode";
import { clearCache } from "@/server/store";

const css = (body: string) => body;

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

function catalog(repo: string, store: string, files: Record<string, string>): { cfg: ResolveConfig; catalog: CodeCatalog } {
  tree(repo, files);
  const cfg = config(repo, store);
  return { cfg, catalog: buildCatalog(cfg) };
}

describe("code-map pairing quality", () => {
  it("demotes a same-name hit when variants and description disagree, unless mapping.json confirms or denies", () => {
    const root = mkdtempSync(join(tmpdir(), "resolve-pair-"));
    const store = join(root, "store");
    const { cfg, catalog: built } = catalog(root, store, {
      "building-blocks/acme-clock/acme-clock.css": css("/* Picks one calendar day for a reminder. */\n.acme-clock { color: var(--ink); }\n.acme-clock--single { color: var(--ink); }\n"),
      "building-blocks/acme-badge/acme-badge.css": css(".acme-badge { color: var(--ink); }\n"),
      "building-blocks/date-time-picker/date-time-picker.css": css(".date-time-picker { color: var(--ink); }\n.date-time-picker--compact { color: var(--ink); }\n"),
      "building-blocks/acme-footer/acme-footer.css": css("/* Site links along the page bottom. */\n.acme-footer { color: var(--ink); }\n"),
      "building-blocks/time-picker/time-picker.css": css(".time-picker { color: var(--ink); }\n.time-picker--compact { color: var(--ink); }\n"),
      "building-blocks/radio-group/radio-group.css": css(".radio-group { color: var(--ink); }\n"),
      "building-blocks/button-group/button-group.css": css(".button-group { color: var(--ink); }\n"),
      "building-blocks/date-field/date-field.css": css(".date-field { color: var(--ink); }\n"),
    });
    const masters = [
      { name: "ingredients/acme-clock", nodeId: "1:1", variants: ["range"], description: "Shows a time range for a shift." },
      { name: "ingredients/acme-badge", nodeId: "1:2" },
      { name: "recipes/date-time-picker", nodeId: "1:3", variants: ["compact"] },
      { name: "recipes/acme-footer", nodeId: "1:4", description: "Site links along the page bottom." },
      { name: "recipes/picker", nodeId: "1:5", variants: ["compact"] },
      { name: "ingredients/choice-group", nodeId: "1:6" },
      { name: "ingredients/date-note", nodeId: "1:7" },
    ];
    const report = mapReport(built, cfg, { suggest: true, masters });
    expect(report.pairs.map((pair) => pair.figma)).not.toContain("ingredients/acme-clock");
    expect(report.suggestions?.some((row) => row.figma === "ingredients/acme-clock" && row.code === "acme-clock")).toBe(true);
    expect(report.pairs).toContainEqual({ figma: "ingredients/acme-badge", code: "acme-badge", confidence: "exact" });
    expect(report.pairs).toContainEqual({ figma: "recipes/date-time-picker", code: "date-time-picker", confidence: "exact" });
    expect(report.pairs).toContainEqual({ figma: "recipes/acme-footer", code: "acme-footer", confidence: "exact" });
    expect(report.pairs.map((pair) => pair.figma)).not.toContain("recipes/picker");
    expect(report.suggestions?.some((row) => row.figma === "ingredients/choice-group" && (row.code === "button-group" || row.code === "radio-group"))).toBe(false);
    expect(report.suggestions?.some((row) => row.figma === "ingredients/date-note" && row.code === "date-field")).toBe(true);

    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "mapping.json"), `${JSON.stringify({ mappings: [{ figma: "ingredients/acme-clock", code: "acme-clock" }] })}\n`);
    const confirmed = mapReport(built, cfg, { masters });
    expect(confirmed.pairs).toContainEqual({ figma: "ingredients/acme-clock", code: "acme-clock", confidence: "mapped" });

    writeFileSync(join(store, "mapping.json"), `${JSON.stringify({ mappings: [{ figma: "recipes/date-time-picker", code: "date-time-picker", deny: true }] })}\n`);
    const denied = mapReport(built, cfg, { suggest: true, masters });
    expect(denied.pairs.map((pair) => pair.figma)).not.toContain("recipes/date-time-picker");
    expect(denied.suggestions?.some((row) => row.figma === "recipes/date-time-picker")).toBe(false);
  });

  it("lists base parts under a block that has no pair, including plural, family, and compound names", () => {
    const root = mkdtempSync(join(tmpdir(), "resolve-parts-"));
    const store = join(root, "store");
    const { cfg, catalog: built } = catalog(root, store, {
      "building-blocks/tab/tab.css": css(".tab { color: var(--ink); }\n"),
      "building-blocks/stepper/stepper.css": css(".stepper { color: var(--ink); }\n"),
      "building-blocks/field/field.css": css(".field { color: var(--ink); }\n"),
      "building-blocks/dropdown/dropdown.css": css(".dropdown { color: var(--ink); }\n"),
    });
    const masters = [
      { name: "ingredients/field", nodeId: "2:1" },
      { name: "base/tabs", nodeId: "2:2" },
      { name: "base/steps-icon", nodeId: "2:3" },
      { name: "base/steps-label", nodeId: "2:4" },
      { name: "base/field-label", nodeId: "2:5" },
      { name: "base/dropdown-option", nodeId: "2:6" },
    ];
    const report = mapReport(built, cfg, { masters });
    expect(report.pairs).toContainEqual({ figma: "ingredients/field", code: "field", confidence: "exact", parts: ["base/field-label"] });
    for (const name of ["base/tabs", "base/steps-icon", "base/steps-label", "base/dropdown-option", "base/field-label"]) {
      expect(report.unmatchedFigma).not.toContain(name);
    }
    expect(report.unpairedParts).toEqual([
      { code: "dropdown", parts: ["base/dropdown-option"] },
      { code: "stepper", parts: ["base/steps-icon", "base/steps-label"] },
      { code: "tab", parts: ["base/tabs"] },
    ]);
  });

  it("skips hub pages and reports css and html counts separately", () => {
    const root = mkdtempSync(join(tmpdir(), "resolve-hub-"));
    const repo = join(root, "repo");
    const store = join(root, "store");
    tree(repo, {
      "building-blocks/button/button.css": css(".button { color: var(--ink); }\n"),
      "building-blocks/tabs/tabs.css": css(".tabs { color: var(--ink); }\n"),
      "building-blocks/banner/banner.html": '<section class="banner">Sale</section>\n',
      "building-blocks/index.html": '<a href="button/button.html">Button</a><a href="tabs/tabs.html">Tabs</a>\n',
      "building-blocks/widgets/widgets.html": '<a href="../button/button.html">Button</a><a href="../tabs/tabs.html">Tabs</a>\n',
    });
    const built = buildCatalog(config(repo, store));
    expect(built.components.map((entry) => entry.name).sort()).toEqual(["banner", "button", "tabs"]);
    expect(built.cssFiles.filter((file) => file.endsWith(".css"))).toHaveLength(2);
    expect(built.cssFiles.filter((file) => /\.html?$/i.test(file))).toHaveLength(3);

    const previous = { home: process.env["RESOLVE_HOME"], mode: process.env["RESOLVE_MODE"] };
    process.env["RESOLVE_HOME"] = store;
    process.env["RESOLVE_MODE"] = "code";
    const lines: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => (lines.push(String(chunk)), true)) as typeof process.stdout.write;
    try {
      runCodeCommand(["scan", "--repo", repo]);
    } finally {
      process.stdout.write = write;
      if (previous.home === undefined) delete process.env["RESOLVE_HOME"];
      else process.env["RESOLVE_HOME"] = previous.home;
      if (previous.mode === undefined) delete process.env["RESOLVE_MODE"];
      else process.env["RESOLVE_MODE"] = previous.mode;
    }
    expect(lines.join("")).toContain("from 2 CSS files and 3 HTML files");
  });
});

describe("page listings take publish status from the library", () => {
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

  it("excludes an unpublished page component when the library does not publish it", () => {
    const home = mkdtempSync(join(tmpdir(), "resolve-page-pub-"));
    process.env["RESOLVE_HOME"] = home;
    delete process.env["RESOLVE_MODE"];
    delete process.env["RESOLVE_INCLUDE_UNPUBLISHED"];
    clearCache();
    learnLibrary({
      fileKey: "ACME",
      role: "library",
      fileName: "Acme",
      metadataXml: `
        <frame id="1:1" name="Kit">
          <component-set id="2:1" name="Acme Button"></component-set>
          <component-set id="2:2" name="Acme Draft Knob"></component-set>
        </frame>`,
      libraries: {
        components: [
          { name: "Acme Button", nodeId: "2:1", published: true },
          { name: "Acme Draft Knob", key: "acme-draft-key", nodeId: "2:2", published: false },
        ],
      },
    });
    expect(graphMasters().map((master) => master.name)).toEqual(["Acme Button"]);
    process.env["RESOLVE_INCLUDE_UNPUBLISHED"] = "1";
    expect(graphMasters().map((master) => master.name).sort()).toEqual(["Acme Button", "Acme Draft Knob"]);
  });
});
