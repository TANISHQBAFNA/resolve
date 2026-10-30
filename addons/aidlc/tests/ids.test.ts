import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import acmeFile from "../../../docs/examples/acme-ui.json";
import codeMap from "../../../docs/examples/acme-code-map-selectors.json";
import { adaptFigmaRestFile } from "@/core/ingestion";
import { buildGraph } from "@/core/transform";
import { registerAddonCommand } from "@/server/addonHook";
import { runCli } from "@/server/cli";
import { clearCache, saveGraph } from "@/server/store";
import { compareVersions, idsInText, idsReport, parseComponentId, readIdsConfig, type IdSighting } from "../src/ids";
import { runExport } from "../src/exportCommand";
import { callTool } from "../src/mcp";

registerAddonCommand("export", runExport);

const FROZEN = "2026-01-01T00:00:00.000Z";

describe("parse component ids", () => {
  it("reads major.minor and major.minor.patch ids, and recipe as recipes", () => {
    expect(parseComponentId("ds@1.2.ingredients.button")).toEqual({
      ok: true,
      id: { raw: "ds@1.2.ingredients.button", prefix: "ds", version: { major: 1, minor: 2 }, versionText: "1.2", tier: "ingredients", name: "button", key: "ingredients.button" },
    });
    const patch = parseComponentId("ds@1.2.1.ingredients.button");
    expect(patch.ok && patch.id.version).toEqual({ major: 1, minor: 2, patch: 1 });
    expect(patch.ok && patch.id.key).toBe("ingredients.button");
    const recipe = parseComponentId("acme-ds@0.10.recipe.send-money");
    expect(recipe.ok && [recipe.id.prefix, recipe.id.tier, recipe.id.key]).toEqual(["acme-ds", "recipes", "recipes.send-money"]);
    const base = parseComponentId("ds@3.0.0.base.icon-close");
    expect(base.ok && base.id.key).toBe("base.icon-close");
  });

  it("gives a clear error for each malformed id", () => {
    const cases: Array<[string, string]> = [
      ["1.2.ingredients.button", "needs a prefix and @"],
      ["DS@1.2.ingredients.button", 'the prefix "DS"'],
      ["ds@1.ingredients.button", "major.minor or major.minor.patch"],
      ["ds@1.2.3.4.ingredients.button", "major.minor or major.minor.patch"],
      ["ds@01.2.ingredients.button", "cannot start with 0"],
      ["ds@1.2.widgets.button", 'the tier "widgets"'],
      ["ds@1.2.ingredients.Primary_Button", "kebab-case"],
      ["ds@1.2.ingredients.button.large", "cannot contain dots"],
      ["ds@1.2.ingredients", "needs a tier and a name"],
    ];
    for (const [raw, why] of cases) {
      const parsed = parseComponentId(raw);
      expect(parsed.ok, raw).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error).toContain(why);
        expect(parsed.error).toContain("for example ds@1.2.ingredients.button");
      }
    }
  });

  it("finds ids in free text, not e-mail addresses or package scopes, and drops end punctuation", () => {
    const found = idsInText("Primary action. Id: ds@1.2.ingredients.button. Ask ada@example.com; import from '@acme/ui'.");
    expect(found.map((row) => (row.ok ? row.id.raw : row.error))).toEqual(["ds@1.2.ingredients.button"]);
    expect(idsInText("Old: ds@1.x.base.icon")[0]?.ok).toBe(false);
  });
});

describe("join and drift", () => {
  const figma = (text: string, from = "Figma"): IdSighting => ({ side: "figma", text, from });
  const code = (text: string, from = "code"): IdSighting => ({ side: "code", text, from });

  it("joins on tier.name with the same prefix, never on the whole string", () => {
    const report = idsReport(
      [
        figma("ds@1.3.ingredients.button"),
        code("ds@1.2.ingredients.button"),
        figma("ds@1.0.recipe.send-money"),
        code("ds@1.0.recipes.send-money"),
        figma("ds@1.0.base.card"),
        code("ds@1.0.ingredients.card"),
        figma("ds@2.0.ingredients.chip"),
        code("acme@2.0.ingredients.chip"),
      ],
      "ds",
    );
    expect(report.pairs.map((row) => `${row.key}:${row.change}`)).toEqual(["ingredients.button:minor", "recipes.send-money:same"]);
    expect(report.figmaOnly.map((row) => row.id)).toEqual(["ds@1.0.base.card", "ds@2.0.ingredients.chip"]);
    expect(report.codeOnly.map((row) => row.id)).toEqual(["ds@1.0.ingredients.card"]);
    expect(report.otherPrefix).toEqual([{ id: "acme@2.0.ingredients.chip", side: "code", from: ["code"] }]);
  });

  it("reports same, patch (info), minor (warning) and major (warning, strongest) drift, and code ahead as info", () => {
    expect(compareVersions({ major: 1, minor: 2 }, { major: 1, minor: 2, patch: 0 })).toEqual({ change: "same", direction: "same" });
    const report = idsReport(
      [
        figma("ds@1.2.ingredients.same"),
        code("ds@1.2.0.ingredients.same"),
        figma("ds@1.2.3.ingredients.padded"),
        code("ds@1.2.1.ingredients.padded"),
        figma("ds@1.4.ingredients.tabs"),
        code("ds@1.2.9.ingredients.tabs"),
        figma("ds@3.0.ingredients.dialog"),
        code("ds@2.7.ingredients.dialog"),
        figma("ds@1.0.ingredients.toast"),
        code("ds@1.1.ingredients.toast"),
      ],
      "ds",
    );
    const by = Object.fromEntries(report.pairs.map((row) => [row.key, row]));
    expect([by["ingredients.same"]?.level, by["ingredients.same"]?.change]).toEqual(["ok", "same"]);
    expect([by["ingredients.padded"]?.level, by["ingredients.padded"]?.change, by["ingredients.padded"]?.direction]).toEqual(["info", "patch", "behind"]);
    expect(by["ingredients.padded"]?.message).toContain("padding or radius");
    expect([by["ingredients.tabs"]?.level, by["ingredients.tabs"]?.change]).toEqual(["warning", "minor"]);
    expect(by["ingredients.tabs"]?.message).toContain("new variant or property");
    expect([by["ingredients.dialog"]?.level, by["ingredients.dialog"]?.change]).toEqual(["warning", "major"]);
    expect(by["ingredients.dialog"]?.message).toMatch(/^MAJOR: .*removed variant, a renamed property or changed behaviour/);
    expect([by["ingredients.toast"]?.level, by["ingredients.toast"]?.direction]).toEqual(["info", "ahead"]);
    expect(report.summary).toMatchObject({ pairs: 5, same: 1, patch: 1, minor: 1, major: 1, ahead: 1 });
    expect(report.pairs.every((row) => row.level !== ("error" as string))).toBe(true);
    expect(report.blocks).toBe(false);
  });

  it("lists malformed ids and a key seen at two versions as problems, and still reports the rest", () => {
    const report = idsReport([figma("ds@1.2.widgets.button", "part Button"), figma("ds@1.2.ingredients.tag"), figma("ds@1.3.ingredients.tag"), code("ds@1.3.ingredients.tag")], "ds");
    expect(report.problems[0]).toContain('part Button: "ds@1.2.widgets.button" is not a component id');
    expect(report.problems.some((line) => line.includes("ingredients.tag at more than one version (1.2, 1.3)"))).toBe(true);
    expect(report.pairs.map((row) => `${row.key}:${row.change}`)).toEqual(["ingredients.tag:same"]);
  });
});

describe("ids from a handoff folder never block", () => {
  const previous = { home: process.env["RESOLVE_HOME"], advanced: process.env["RESOLVE_MCP_ADVANCED"] };
  let home: string;
  let work: string;
  let repo: string;

  async function cli(argv: string[]): Promise<string> {
    const writes: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => (writes.push(String(chunk)), true)) as typeof process.stdout.write;
    try {
      await runCli(argv);
    } finally {
      process.stdout.write = write;
    }
    return writes.join("");
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "resolve-ids-home-"));
    work = mkdtempSync(join(tmpdir(), "resolve-ids-out-"));
    repo = mkdtempSync(join(tmpdir(), "resolve-ids-code-"));
    process.env["RESOLVE_HOME"] = home;
    clearCache();
    saveGraph(buildGraph(adaptFigmaRestFile({ fileKey: "ACMEUI", file: acmeFile, kind: "mock", ingestedAt: FROZEN }), { builtAt: FROZEN }));
    writeFileSync(join(home, "code-map.json"), JSON.stringify(codeMap));
  });

  afterEach(() => {
    clearCache();
    process.exitCode = undefined;
    for (const [key, value] of [["RESOLVE_HOME", previous.home], ["RESOLVE_MCP_ADVANCED", previous.advanced]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function manifest(folder: string, body: unknown) {
    mkdirSync(join(repo, folder), { recursive: true });
    writeFileSync(join(repo, folder, "component.json"), typeof body === "string" ? body : JSON.stringify(body));
  }

  it("reports major drift with exit 0, from the CLI and MCP, and the normal export is unchanged", async () => {
    await cli(["handoff", "Confirm payment", "--out", work]);
    const plain = await cli(["export", "aidlc", work]);
    expect(process.exitCode ?? 0).toBe(0);

    const handoffPath = join(work, "handoff.json");
    const pack = JSON.parse(readFileSync(handoffPath, "utf8")) as { screens: Array<{ components: Array<{ name: string }> }> };
    const button = pack.screens[0]!.components.find((part) => part.name === "Button")!;
    const original = readFileSync(handoffPath, "utf8");
    writeFileSync(join(home, "aidlc.json"), JSON.stringify({ idPrefix: "ds", codeRepo: repo }));
    manifest("acme-button", { id: "acme-button", figma: { name: "Button" }, resolveId: "ds@1.4.ingredients.button" });
    manifest("acme-chip", { id: "acme-chip", figma: { name: "Chip" }, resolveId: "ds@1.0.ingredients.Chip" });
    manifest("broken", "{ not json");

    // The normal export ignores ids: same output and exit code with a config, manifests and a bad id present.
    expect(await cli(["export", "aidlc", work])).toBe(plain);
    expect(process.exitCode ?? 0).toBe(0);

    button.name = "Button ds@2.0.ingredients.button";
    writeFileSync(handoffPath, JSON.stringify(pack));
    const report = JSON.parse(await cli(["export", "aidlc", work, "--ids", "--json"])) as {
      kind: string;
      blocks: boolean;
      pairs: Array<{ key: string; change: string; level: string; codeFrom: string[] }>;
      problems: string[];
    };
    expect(process.exitCode ?? 0).toBe(0);
    expect(report.kind).toBe("resolve.aidlc.ids");
    expect(report.blocks).toBe(false);
    expect(report.pairs).toMatchObject([{ key: "ingredients.button", change: "major", level: "warning", codeFrom: [join("acme-button", "component.json")] }]);
    expect(report.problems.some((line) => line.includes("ds@1.0.ingredients.Chip") && line.includes("kebab-case"))).toBe(true);
    expect(report.problems.some((line) => line.includes("broken") && line.includes("not JSON"))).toBe(true);

    const text = await cli(["export", "aidlc", work, "--ids"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(text).toContain("1 major behind");
    expect(text).toContain("WARNING ingredients.button: MAJOR:");
    expect(text).toContain("Advisory only: nothing is blocked.");

    const out = join(work, "ids.json");
    await cli(["export", "aidlc", work, "--ids", "--out", out]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({ kind: "resolve.aidlc.ids", summary: { major: 1 } });

    process.env["RESOLVE_MCP_ADVANCED"] = "1";
    const { cost: _cost, ...viaMcp } = callTool("export_aidlc", { folder: work, ids: true }) as { cost: unknown };
    expect(viaMcp).toEqual(report);
    writeFileSync(handoffPath, original);
  });

  it("uses the default prefix ds, and a bad config prefix is a problem, not an error", () => {
    expect(readIdsConfig([work], {}).prefix).toBe("ds");
    writeFileSync(join(home, "aidlc.json"), JSON.stringify({ idPrefix: "Bad Prefix" }));
    const config = readIdsConfig([work], { RESOLVE_HOME: home });
    expect(config.prefix).toBe("ds");
    expect(config.problems[0]).toContain("idPrefix must be lowercase");
    writeFileSync(join(home, "aidlc.json"), JSON.stringify({ idPrefix: "acme" }));
    expect(readIdsConfig([work], { RESOLVE_HOME: home }).prefix).toBe("acme");
    const project = mkdtempSync(join(tmpdir(), "resolve-ids-project-"));
    mkdirSync(join(project, ".resolve"), { recursive: true });
    mkdirSync(join(project, "deep", "folder"), { recursive: true });
    writeFileSync(join(project, ".resolve", "aidlc.json"), JSON.stringify({ idPrefix: "team", codeRepo: "packages/ui" }));
    expect(readIdsConfig([join(project, "deep", "folder")], {})).toMatchObject({ prefix: "team", codeRepo: join(project, "packages", "ui") });
  });
});
