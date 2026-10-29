import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { learnLibrary } from "@/server/learn";
import { runCodeCommand, runLinkMap } from "@/server/code/command";
import { confirmBulk, mapReport, writeMappings } from "@/server/code/map";
import { buildCatalog, type CatalogEntry, type CodeCatalog } from "@/server/code/scan";
import { secondSignal } from "@/server/mapPair";
import { readConfig } from "@/server/mode";
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
      "building-blocks/acme-switch/acme-switch.css": css(".acme-switch { color: var(--ink); }\n.acme-switch--disabled { color: var(--ink); }\n"),
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
      { name: "ingredients/acme-switch", nodeId: "1:8", variants: ["disabled"] },
      { name: "recipes/date-time-picker", nodeId: "1:3", variants: ["compact"] },
      { name: "recipes/acme-footer", nodeId: "1:4", description: "Site links along the page bottom." },
      { name: "recipes/picker", nodeId: "1:5", variants: ["compact"] },
      { name: "ingredients/choice-group", nodeId: "1:6" },
      { name: "ingredients/date-note", nodeId: "1:7" },
    ];
    const report = mapReport(built, cfg, { suggest: true, masters });
    expect(report.pairs.map((pair) => pair.figma)).not.toContain("ingredients/acme-clock");
    expect(report.suggestions?.some((row) => row.figma === "ingredients/acme-clock" && row.code === "acme-clock")).toBe(true);
    expect(report.pairs.map((pair) => pair.figma)).not.toContain("ingredients/acme-badge");
    expect(report.suggestions?.some((row) => row.figma === "ingredients/acme-badge" && row.code === "acme-badge" && row.reasons.includes("same name, no evidence"))).toBe(true);
    expect(report.suggestions?.find((row) => row.figma === "ingredients/acme-badge" && row.code === "acme-badge")?.confidence).toBe("risky: same name only");
    expect(report.bulkConfirm).not.toContain("ingredients/acme-badge=acme-badge");
    expect(report.bulkConfirm).not.toContain("ingredients/acme-clock=acme-clock");
    expect(report.bulkConfirm).toContain("ingredients/date-note=date-field");
    expect(report.pairs.map((pair) => pair.figma)).not.toContain("ingredients/acme-switch");
    expect(report.suggestions?.some((row) => row.figma === "ingredients/acme-switch" && row.code === "acme-switch" && row.reasons.includes("same name, no evidence"))).toBe(true);
    expect(report.suggestions?.find((row) => row.figma === "ingredients/acme-switch")?.confidence).toBe("risky: same name only");
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

    built.figmaMasters = masters;
    const bulk = confirmBulk(cfg, built, ["ingredients/acme-badge=acme-badge", "ingredients/acme-switch=acme-switch", "ingredients/date-note=date-field"]);
    expect(bulk.added.map((row) => row.figma)).toEqual(["ingredients/date-note"]);
    expect(writeMappings(cfg, built, ["ingredients/acme-badge=acme-badge"]).added).toEqual([{ figma: "ingredients/acme-badge", code: "acme-badge" }]);
  });

  it("auto-links tabs from matching parts, and refuses a stepper trap and a configured name-only deny", () => {
    const root = mkdtempSync(join(tmpdir(), "resolve-evidence-"));
    const store = join(root, "store");
    const { cfg, catalog: built } = catalog(root, store, {
      "building-blocks/tabs/tabs.css": css(".tabs { color: var(--ink); }\n.tabs__tab { color: var(--ink); }\n.tabs__tab-item { color: var(--ink); }\n"),
      "building-blocks/stepper/stepper.css": css("/* Multi-step navigation. */\n.stepper { color: var(--ink); }\n"),
      "building-blocks/navigator/navigator.css": css("/* This is navigation. */\n.navigator { color: var(--ink); }\n.navigator--compact { color: var(--ink); }\n"),
      "building-blocks/acme-knob/acme-knob.css": css(".acme-knob { color: var(--ink); }\n.acme-knob__disabled { color: var(--ink); }\n"),
      "building-blocks/acme-badge/acme-badge.css": css(".acme-badge { color: var(--ink); }\n"),
    });
    const masters = [
      { name: "ingredients/tabs", nodeId: "9:1" },
      { name: "base/tab", nodeId: "9:2" },
      { name: "base/tab-item", nodeId: "9:3" },
      { name: "ingredients/stepper", nodeId: "9:4", description: "Avoid: multi-step navigation" },
      { name: "ingredients/navigator", nodeId: "9:5", description: "Navigation." },
      { name: "ingredients/acme-knob", nodeId: "9:6", variants: ["disabled"] },
      { name: "ingredients/acme-badge", nodeId: "9:7" },
    ];
    const bare = (name: string, description: string) => ({ name, description, variants: [], kind: "block", rules: [] }) as CatalogEntry;
    expect(secondSignal(bare("alpha", "multi-step"), bare("beta", "stepper")).agree).toBe(false);
    expect(secondSignal(bare("alpha", "Avoid: multi-step navigation"), bare("beta", "Multi-step navigation.")).agree).toBe(false);
    expect(secondSignal(bare("alpha", "Don't use multi-step navigation"), bare("beta", "Multi-step navigation.")).agree).toBe(false);
    expect(secondSignal(bare("alpha", "Do not use multi-step navigation"), bare("beta", "Multi-step navigation.")).agree).toBe(false);
    expect(secondSignal(bare("alpha", "Skip it, instead use multi-step navigation."), bare("beta", "Multi-step navigation.")).agree).toBe(false);
    expect(secondSignal(bare("alpha", "Multi-step navigation."), bare("beta", "Use multi-step navigation.")).agree).toBe(true);

    const report = mapReport(built, cfg, { suggest: true, masters });
    expect(report.pairs).toContainEqual({ figma: "ingredients/tabs", code: "tabs", confidence: "exact", parts: ["base/tab", "base/tab-item"] });
    expect(report.pairs.map((pair) => pair.figma)).not.toContain("ingredients/stepper");
    expect(report.pairs).toContainEqual({ figma: "ingredients/navigator", code: "navigator", confidence: "exact" });
    expect(report.pairs.map((pair) => pair.figma)).not.toContain("ingredients/acme-knob");
    expect(report.suggestions?.find((row) => row.figma === "ingredients/acme-knob")?.confidence).toBe("risky: same name only");
    expect(report.suggestions?.find((row) => row.figma === "ingredients/acme-badge")?.reasons).toContain("risky: same name only");

    const deniedCfg = { ...cfg, pairDeny: ["navigator"] };
    const denied = mapReport(built, deniedCfg, { suggest: true, masters });
    expect(denied.pairs.map((pair) => pair.figma)).not.toContain("ingredients/navigator");
    expect(denied.suggestions?.find((row) => row.figma === "ingredients/navigator")?.confidence).toBe("risky: same name only");
    const evidenced = mapReport(built, deniedCfg, { masters: masters.map((master) => master.name === "ingredients/navigator" ? { ...master, variants: ["compact"] } : master) });
    expect(evidenced.pairs).toContainEqual({ figma: "ingredients/navigator", code: "navigator", confidence: "exact" });

    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "mapping.json"), `${JSON.stringify({ mappings: [{ figma: "ingredients/stepper", code: "stepper" }, { figma: "ingredients/stepper", code: "stepper", deny: true }] })}\n`);
    expect(mapReport(built, cfg, { suggest: true, masters }).pairs.map((pair) => pair.figma)).not.toContain("ingredients/stepper");
    expect(mapReport(built, cfg, { suggest: true, masters }).suggestions?.some((row) => row.figma === "ingredients/stepper")).toBe(false);
    writeFileSync(join(store, "mapping.json"), `${JSON.stringify({ mappings: [{ figma: "ingredients/stepper", code: "stepper" }] })}\n`);
    expect(mapReport(built, cfg, { masters }).pairs).toContainEqual({ figma: "ingredients/stepper", code: "stepper", confidence: "mapped" });

    const previous = { home: process.env["RESOLVE_HOME"], mode: process.env["RESOLVE_MODE"], deny: process.env["RESOLVE_PAIR_DENY"] };
    process.env["RESOLVE_HOME"] = store;
    process.env["RESOLVE_MODE"] = "code";
    delete process.env["RESOLVE_PAIR_DENY"];
    const lines: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => (lines.push(String(chunk)), true)) as typeof process.stdout.write;
    try {
      runLinkMap(["--repo", root, "--suggest"], () => masters);
      const text = lines.join("");
      expect(text).toContain("risky: same name only ingredients/acme-badge -> acme-badge");
      expect(text).toContain("exact     ingredients/tabs -> tabs");
      lines.length = 0;
      runLinkMap(["--repo", root, "--suggest", "--json"], () => masters);
      const json = JSON.parse(lines.join("")) as { suggestions: Array<{ figma: string; code: string; confidence: string; reasons: string[] }>; bulkConfirm: string[] };
      const badge = json.suggestions.find((row) => row.figma === "ingredients/acme-badge");
      expect(badge?.confidence).toBe("risky: same name only");
      expect(badge?.reasons).toContain("risky: same name only");
      expect(json.bulkConfirm).not.toContain("ingredients/acme-badge=acme-badge");
      writeFileSync(join(store, "config.json"), JSON.stringify({ pairDeny: ["navigator"] }));
      expect(readConfig().pairDeny).toEqual(["navigator"]);
      process.env["RESOLVE_PAIR_DENY"] = "wizard";
      expect(readConfig().pairDeny).toEqual(["wizard"]);
    } finally {
      process.stdout.write = write;
      const restore = (key: "RESOLVE_HOME" | "RESOLVE_MODE" | "RESOLVE_PAIR_DENY", value: string | undefined) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      };
      restore("RESOLVE_HOME", previous.home);
      restore("RESOLVE_MODE", previous.mode);
      restore("RESOLVE_PAIR_DENY", previous.deny);
    }
  });

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
