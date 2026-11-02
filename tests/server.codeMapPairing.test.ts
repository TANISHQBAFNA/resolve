import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { learnLibrary } from "@/server/learn";
import { runCodeCommand, runLinkMap } from "@/server/code/command";
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

  it("lists base parts under a block that has no pair, including plural, family, and compound names", () => {
    const root = mkdtempSync(join(tmpdir(), "resolve-parts-"));
    const store = join(root, "store");
    const { cfg, catalog: built } = catalog(root, store, {
      "building-blocks/tab/tab.css": css(".tab { color: var(--ink); }\n"),
      "building-blocks/stepper/stepper.css": css(".stepper { color: var(--ink); }\n"),
      "building-blocks/field/field.css": css(".field { color: var(--ink); }\n.field--stacked { color: var(--ink); }\n"),
      "building-blocks/dropdown/dropdown.css": css(".dropdown { color: var(--ink); }\n"),
    });
    const masters = [
      { name: "ingredients/field", nodeId: "2:1", variants: ["stacked"] },
      { name: "base/tabs", nodeId: "2:2" },
      { name: "base/steps-icon", nodeId: "2:3" },
      { name: "base/steps-label", nodeId: "2:4" },
      { name: "base/field-label", nodeId: "2:5" },
      { name: "base/dropdown-option", nodeId: "2:6" },
    ];
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "mapping.json"), `${JSON.stringify({ mappings: [{ figma: "ingredients/field", code: "field" }] })}\n`);
    const report = mapReport(built, cfg, { masters });
    expect(report.pairs).toContainEqual({ figma: "ingredients/field", code: "field", confidence: "mapped", parts: ["base/field-label"] });
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
      "building-blocks/banner/banner.html": '<a href="../button/button.html">Button</a>\n<section class="banner">Sale</section>\n',
      "building-blocks/quote/quote.html": '<a href="../button/button.html">Button</a>\n<link rel="stylesheet" href="quote.css">\n<blockquote class="pull-quote">Words</blockquote>\n',
      "building-blocks/marker/index.html": '<a href="../button/button.html">Button</a>\n<section class="marker">Mark</section>\n',
      "building-blocks/index.html": '<a href="button/button.html">Button</a><a href="tabs/tabs.html">Tabs</a>\n',
      "building-blocks/widgets/widgets.html": '<a href="../button/button.html">Button</a><a href="../tabs/tabs.html">Tabs</a>\n',
    });
    const built = buildCatalog(config(repo, store));
    expect(built.components.map((entry) => entry.name).sort()).toEqual(["banner", "button", "marker", "quote", "tabs"]);
    expect(built.components.map((entry) => entry.name)).not.toContain("index");
    expect(built.components.map((entry) => entry.name)).not.toContain("widgets");
    expect(built.cssFiles.filter((file) => file.endsWith(".css"))).toHaveLength(2);
    expect(built.cssFiles.filter((file) => /\.html?$/i.test(file))).toHaveLength(5);

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
    expect(lines.join("")).toContain("from 2 CSS files and 5 HTML files");
  });

  it("prints base parts on each pair and block, and the Figma total adds up", () => {
    const root = mkdtempSync(join(tmpdir(), "resolve-total-"));
    const repo = join(root, "repo");
    const store = join(root, "store");
    tree(repo, {
      "building-blocks/field/field.css": css(".field { color: var(--ink); }\n.field--stacked { color: var(--ink); }\n"),
      "building-blocks/tab/tab.css": css(".tab { color: var(--ink); }\n"),
      "building-blocks/note/note.css": css(".note { color: var(--ink); }\n"),
    });
    const masters = [
      { name: "ingredients/field", nodeId: "4:1", variants: ["stacked"] },
      { name: "base/field-label", nodeId: "4:2" },
      { name: "base/tabs", nodeId: "4:3" },
      { name: "ingredients/ghost", nodeId: "4:4" },
    ];
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "mapping.json"), `${JSON.stringify({ mappings: [{ figma: "ingredients/field", code: "field" }] })}\n`);
    const previous = { home: process.env["RESOLVE_HOME"], mode: process.env["RESOLVE_MODE"] };
    process.env["RESOLVE_HOME"] = store;
    process.env["RESOLVE_MODE"] = "code";
    const lines: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => (lines.push(String(chunk)), true)) as typeof process.stdout.write;
    try {
      runLinkMap(["--repo", repo, "--pairs", "--unmatched"], () => masters);
    } finally {
      process.stdout.write = write;
      if (previous.home === undefined) delete process.env["RESOLVE_HOME"];
      else process.env["RESOLVE_HOME"] = previous.home;
      if (previous.mode === undefined) delete process.env["RESOLVE_MODE"];
      else process.env["RESOLVE_MODE"] = previous.mode;
    }
    const text = lines.join("");
    expect(text).toContain("parts: base/field-label");
    expect(text).toContain("tab: base/tabs");
    const match = text.match(/(\d+) Figma components \((\d+) paired \+ (\d+) parts \+ (\d+) unmatched = (\d+)\)/);
    expect(match).not.toBeNull();
    const total = Number(match?.[1]);
    const paired = Number(match?.[2]);
    const parts = Number(match?.[3]);
    const unmatched = Number(match?.[4]);
    const sum = Number(match?.[5]);
    expect(sum).toBe(total);
    expect(paired + parts + unmatched).toBe(total);
    expect(total).toBe(4);
    expect(paired).toBe(1);
    expect(parts).toBe(2);
    expect(unmatched).toBe(1);
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
