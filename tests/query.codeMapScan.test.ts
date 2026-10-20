import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanAngularPackage, selectorWords } from "@/adapters/angular";
import type { ComponentProperty } from "@/core/model/componentProperties";
import type { DesignGraph, GraphEdge, GraphNode } from "@/core/model";
import { tidySelector } from "@/core/query/codeMap";
import { codeMapJson, readCodeMapDocument } from "@/core/query/codeMapCsv";
import { indexGraph } from "@/core/query/GraphIndex";
import { codeMapCard, codeMapView, libraryCodeTargets } from "@/core/query/replacements";
import {
  mergeSuggestions,
  scoreSuggestions,
  suggestionEntries,
  suggestPairs,
  wrongMappedLinks,
  type AnswerPair,
} from "@/core/query/codeMapSuggest";
import { importReview } from "@/server/codeMapCommand";
import { runCli } from "@/server/cli";
import { listToolDefinitions } from "@/server/tools";
import { clearCache, saveGraph } from "@/server/store";

const root = join(__dirname, "..", "fixtures", "acme-ui-angular");
const answer = JSON.parse(readFileSync(join(root, "answer-key.json"), "utf8")) as { pairs: AnswerPair[] };
const FROZEN = "2026-01-01T00:00:00.000Z";

function prop(name: string, type: ComponentProperty["type"]): ComponentProperty {
  return type === "VARIANT" ? { name, type, options: ["One", "Two"] } : { name, type };
}

function master(id: string, name: string, props: ComponentProperty[] = []): GraphNode {
  return {
    id: `node:${id}`,
    figmaNodeId: id,
    fileKey: "ACMEUI",
    type: "COMPONENT_SET",
    name,
    ...(props.length ? { propertyDefinitions: props } : {}),
  };
}

function nest(parent: GraphNode, child: GraphNode, n: number): { node: GraphNode; edge: GraphEdge } {
  const node: GraphNode = {
    id: `node:nest:${n}`,
    figmaNodeId: `nest:${n}`,
    fileKey: "ACMEUI",
    type: "COMPONENT_INSTANCE",
    name: child.name,
    isInstance: true,
    mainComponentId: child.id,
  };
  return { node, edge: { id: `edge:nest:${n}`, source: parent.id, target: node.id, type: "NESTS" } };
}

function library(): DesignGraph {
  const button = master("30:10", "Button", [prop("Variant", "VARIANT"), prop("Size", "VARIANT"), prop("Disabled", "BOOLEAN")]);
  const icon = master("30:11", "Icon button", [prop("Icon", "TEXT"), prop("Disabled", "BOOLEAN")]);
  const field = master("30:12", "Text field", [prop("Label", "TEXT"), prop("Value", "TEXT"), prop("Error", "TEXT")]);
  const payee = master("30:13", "Payee picker", [prop("Payees", "TEXT"), prop("Selected", "TEXT")]);
  const card = master("30:14", "Card", [prop("Title", "TEXT")]);
  const old = master("30:15", "Old Button", [prop("Label", "TEXT")]);
  const banner = master("30:16", "Banner", [prop("Tone", "VARIANT"), prop("Size", "VARIANT")]);
  const dialog = master("30:17", "Dialog", [prop("Title", "TEXT")]);
  const avatar = master("30:18", "Avatar");
  const group = master("30:19", "Button group");
  const spacer = master("30:20", "Spacer");
  const payeeNest = nest(payee, field, 1);
  const dialogNest = nest(dialog, button, 2);
  return {
    fileKey: "ACMEUI",
    fileName: "Acme UI",
    schemaVersion: 1,
    builtAt: FROZEN,
    source: { kind: "mock", ingestedAt: FROZEN, version: "2026.10.1" },
    nodes: [button, icon, field, payee, card, old, banner, dialog, avatar, group, spacer, payeeNest.node, dialogNest.node],
    edges: [payeeNest.edge, dialogNest.edge],
    warnings: [],
  };
}

describe("code map scan, suggest, review", () => {
  const previousHome = process.env["RESOLVE_HOME"];
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "resolve-code-map-"));
    process.env["RESOLVE_HOME"] = home;
    clearCache();
    saveGraph(library());
  });

  afterEach(() => {
    clearCache();
    process.exitCode = undefined;
    if (previousHome === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previousHome;
  });

  it("reads Ivy metadata and falls back to the component decorator, including attribute and class selectors", () => {
    const inventory = scanAngularPackage(root);
    expect(inventory.packageName).toBe("@acme/ui-angular");
    expect(inventory.packageVersion).toBe("1.4.0");
    const button = inventory.components.find((row) => row.component === "AcmeButtonComponent");
    expect(button).toMatchObject({
      selector: "button[acme-button], a[acme-button]",
      module: "AcmeButtonModule",
      from: "dts",
      inputs: [
        { name: "variant" },
        { name: "size" },
        { name: "disabled", signal: true },
      ],
      outputs: [{ name: "pressed" }],
    });
    expect(button?.standalone).toBeUndefined();
    const card = inventory.components.find((row) => row.component === "AcmeCardComponent");
    expect(card).toMatchObject({ selector: ".acme-card", standalone: true, from: "source", inputs: [{ name: "title", signal: true }] });
    expect(tidySelector(".x")).toBe(".x");
    expect(tidySelector("button[mat-button]")).toBe("button[mat-button]");
    expect(selectorWords("button[mat-button]")).toEqual(["mat", "button"]);
    const probe = mkdtempSync(join(tmpdir(), "acme-probe-"));
    writeFileSync(join(probe, "package.json"), JSON.stringify({ name: "@acme/probe", version: "0.0.1" }));
    writeFileSync(
      join(probe, "index.d.ts"),
      `export declare class AcmeProbeComponent { static ɵcmp: i0.ɵɵComponentDeclaration<AcmeProbeComponent, "button[mat-button], .x", never, { "disabled": { "alias": "disabled"; "required": false; "isSignal": true; }; }, {}, never, never, true, never>; }\n`,
    );
    const probed = scanAngularPackage(probe);
    expect(probed.components[0]).toMatchObject({ selector: "button[mat-button], .x", standalone: true, inputs: [{ name: "disabled", signal: true }] });
  });

  it("suggests pairs without treating them as mapped, and the labelled key has no wrong mapped link", () => {
    const index = indexGraph(library());
    const inventory = scanAngularPackage(root);
    const pairs = suggestPairs(index, inventory, libraryCodeTargets(index));
    expect(pairs.every((pair) => pair.status === "suggested" || pair.status === "partial")).toBe(true);
    expect(pairs.map((pair) => pair.status)).not.toContain("mapped");
    const score = scoreSuggestions(
      pairs.map((pair) => ({ figma: pair.name, component: pair.component, relation: pair.relation })),
      answer.pairs,
    );
    expect(score.extra).toEqual([]);
    expect(score.missed).toEqual([]);
    expect(score.precision).toBe(1);
    expect(score.recall).toBe(1);
    expect(score).toMatchObject({ proposed: 9, labelled: 9, hits: 9 });
    const banner = pairs.find((pair) => pair.name === "Banner");
    expect(banner?.status).toBe("partial");
    const entries = suggestionEntries(pairs);
    expect(entries.every((entry) => entry["status"] !== "mapped")).toBe(true);
    writeFileSync(join(home, "code-map.json"), codeMapJson(entries, { figmaVersion: "2026.10.1", packageVersion: inventory.packageVersion }));
    clearCache();
    const view = codeMapView(index);
    const button = index.graph.nodes.find((node) => node.name === "Button");
    expect(button).toBeTruthy();
    expect(view?.twin(button!)).toBeUndefined();
    const report = codeMapCard(() => index);
    expect(report.suggested?.length).toBeGreaterThan(0);
    expect(report.counts.mapped).toBe(0);
    const confirmed = entries.map((entry) => {
      const hit = answer.pairs.some(
        (pair) => pair.figma === entry["name"] && pair.component === (entry["code"] as { component: string }).component && pair.relation === entry["relation"],
      );
      return hit ? { ...entry, status: "mapped" } : entry;
    });
    const reviewed = importReview(toCsv(confirmed));
    expect(reviewed.ok).toBe(true);
    if (!reviewed.ok) return;
    writeFileSync(reviewed.path, codeMapJson(reviewed.merged.entries, reviewed.previous));
    expect(wrongMappedLinks(reviewed.merged.entries, answer.pairs)).toEqual([]);
    const planted = [...reviewed.merged.entries, { fileKey: "ACMEUI", id: "30:18", name: "Avatar", status: "mapped", code: { import: "import { AcmeChipComponent } from '@acme/ui-angular'", component: "AcmeChipComponent" } }];
    expect(wrongMappedLinks(planted, answer.pairs)).toEqual([{ figma: "Avatar", component: "AcmeChipComponent", relation: "maps" }]);
    clearCache();
    const mappedView = codeMapView(indexGraph(library()));
    const mappedButton = mappedView?.twin(index.graph.nodes.find((node) => node.name === "Button")!);
    expect(mappedButton?.line).toContain("AcmeButtonComponent");
    const chip = pairs.find((pair) => pair.component === "AcmeChipComponent");
    expect(chip).toBeUndefined();
  });

  it("keeps entries the CSV does not mention, and refuses to overwrite a broken map", async () => {
    const extra = { fileKey: "OTHERLIB", id: "9:9", name: "Chip", code: { import: "import { Chip } from '@acme/ui'", component: "Chip" } };
    writeFileSync(join(home, "code-map.json"), JSON.stringify({ entries: [extra] }));
    const csv = join(home, "review.csv");
    writeFileSync(csv, "fileKey,id,name,component,importPath,status\nACMEUI,30:10,Button,AcmeButtonComponent,@acme/ui-angular,mapped\n");
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
    try {
      await runCli(["code-map", "review", "--import", csv]);
    } finally {
      process.stdout.write = write;
    }
    expect(out.join("")).toContain("Kept 1 existing entry");
    expect(readCodeMapDocument(join(home, "code-map.json")).entries).toContainEqual(extra);
    const broken = join(home, "code-map.json");
    writeFileSync(broken, "{");
    await expect(runCli(["code-map", "--import", csv, "--force"])).rejects.toThrow("Nothing was written");
    expect(readFileSync(broken, "utf8")).toBe("{");
  });

  it("flags an entry when the Figma library version or the package version changes", () => {
    const index = indexGraph(library());
    const entry = {
      fileKey: "ACMEUI",
      id: "30:10",
      name: "Button",
      status: "mapped",
      figmaVersion: "2026.01.1",
      packageVersion: "1.0.0",
      code: { import: "import { AcmeButtonComponent } from '@acme/ui-angular'", component: "AcmeButtonComponent", framework: "angular", selector: "acme-button" },
    };
    writeFileSync(join(home, "code-map.json"), codeMapJson([entry], { figmaVersion: "2026.10.1", packageVersion: "1.4.0" }));
    clearCache();
    const report = codeMapCard(() => index);
    expect(report.needsReview?.map((item) => item.reason).join(" ")).toContain("Figma library version changed from 2026.01.1 to 2026.10.1");
    expect(report.needsReview?.map((item) => item.reason).join(" ")).toContain("package version changed from 1.0.0 to 1.4.0");
    const kept = mergeSuggestions([entry, { ...entry, id: "30:11", status: "suggested" }], suggestionEntries(suggestPairs(index, scanAngularPackage(root), libraryCodeTargets(index))));
    expect(kept.filter((row) => (row as { status?: string }).status === "mapped")).toHaveLength(1);
  });

  it("keeps every class that repeats a selector and flags the conflict", () => {
    const probe = mkdtempSync(join(tmpdir(), "acme-lite-"));
    writeFileSync(join(probe, "package.json"), JSON.stringify({ name: "@acme/lite", version: "0.1.0" }));
    writeFileSync(
      join(probe, "index.d.ts"),
      `export declare class HarborComponent { static ɵcmp: i0.ɵɵComponentDeclaration<HarborComponent, "acme-harbor", never, {}, {}, never, never, true, never>; }
export declare class HarborLiteComponent { static ɵcmp: i0.ɵɵComponentDeclaration<HarborLiteComponent, "acme-harbor", never, {}, {}, never, never, true, never>; }
`,
    );
    const scanned = scanAngularPackage(probe);
    const names = scanned.components.map((row) => row.component);
    expect(names).toEqual(["HarborComponent", "HarborLiteComponent"]);
    expect(scanned.components.find((row) => row.component === "HarborComponent")?.selectorConflict).toEqual(["HarborLiteComponent"]);
    expect(scanned.components.find((row) => row.component === "HarborLiteComponent")?.selectorConflict).toEqual(["HarborComponent"]);
  });

  it("prints a selector conflict in the plain scan listing", async () => {
    const probe = mkdtempSync(join(tmpdir(), "acme-lite-text-"));
    writeFileSync(join(probe, "package.json"), JSON.stringify({ name: "@acme/lite", version: "0.1.0" }));
    writeFileSync(
      join(probe, "index.d.ts"),
      `export declare class HarborComponent { static ɵcmp: i0.ɵɵComponentDeclaration<HarborComponent, "acme-harbor", never, {}, {}, never, never, true, never>; }
export declare class HarborLiteComponent { static ɵcmp: i0.ɵɵComponentDeclaration<HarborLiteComponent, "acme-harbor", never, {}, {}, never, never, true, never>; }
`,
    );
    const capture = async (argv: string[]) => {
      const out: string[] = [];
      const write = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string | Uint8Array) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
      try {
        await runCli(argv);
      } finally {
        process.stdout.write = write;
      }
      return out.join("");
    };
    const text = await capture(["code-map", "scan", probe]);
    expect(text).toContain("HarborComponent  acme-harbor  standalone  (dts)  selector conflict: HarborLiteComponent");
    expect(text).toContain("HarborLiteComponent  acme-harbor  standalone  (dts)  selector conflict: HarborComponent");
    expect(text).not.toContain('"selectorConflict"');
    const json = JSON.parse(await capture(["code-map", "scan", probe, "--json"])) as {
      components: { component: string; selectorConflict?: string[] }[];
    };
    expect(json.components.find((row) => row.component === "HarborComponent")?.selectorConflict).toEqual(["HarborLiteComponent"]);
  });

  it("prints the class name in the suggest reason, in plain text and in json", async () => {
    const capture = async (argv: string[]) => {
      const out: string[] = [];
      const write = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string | Uint8Array) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
      try {
        await runCli(argv);
      } finally {
        process.stdout.write = write;
      }
      return out.join("");
    };
    const reason = "name matches AcmeButtonComponent; Figma properties match its inputs";
    const text = await capture(["code-map", "suggest", root]);
    expect(text).toContain(`Button -> AcmeButtonComponent (maps, suggested) ${reason}`);
    expect(text).toContain("name matches AcmeBannerComponent; some Figma properties have no input");
    expect(text).not.toContain("[object Object]");
    const json = JSON.parse(await capture(["code-map", "suggest", root, "--json"])) as {
      suggestions: { name: string; component: string; relation: string; because: string }[];
    };
    const button = json.suggestions.find((pair) => pair.name === "Button" && pair.component === "AcmeButtonComponent" && pair.relation === "maps");
    expect(button?.because).toBe(reason);
    expect(JSON.stringify(json)).not.toContain("[object Object]");
  });

  it("keeps code-map tools off the default list", () => {
    expect(listToolDefinitions(false)).toHaveLength(8);
    expect(listToolDefinitions(false).map((tool) => tool.name)).not.toContain("code_map_scan");
    expect(listToolDefinitions(true).map((tool) => tool.name)).toEqual(expect.arrayContaining(["code_map_scan", "code_map_suggest", "code_map_review"]));
  });
});

function toCsv(entries: Record<string, unknown>[]): string {
  const head = "fileKey,id,name,component,importPath,framework,selector,module,standalone,inputs,outputs,status,replacedBy,relation,figmaVersion,packageVersion";
  const lines = entries.map((entry) => {
    const code = entry["code"] as Record<string, unknown>;
    const imported = String(code["import"] ?? "");
    const marker = " from '";
    const at = imported.lastIndexOf(marker);
    const path = at < 0 ? "" : imported.slice(at + marker.length, imported.lastIndexOf("'"));
    const cell = (value: unknown) => {
      const text = Array.isArray(value) ? value.join(" ") : value === undefined || value === null ? "" : String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    return [
      entry["fileKey"],
      entry["id"],
      entry["name"],
      code["component"],
      path,
      code["framework"] ?? "",
      code["selector"] ?? "",
      code["module"] ?? "",
      code["standalone"] === true ? "true" : "",
      code["inputs"] ?? "",
      code["outputs"] ?? "",
      entry["status"] ?? "",
      entry["replacedBy"] ?? "",
      entry["relation"] ?? "",
      entry["figmaVersion"] ?? "",
      entry["packageVersion"] ?? "",
    ].map(cell).join(",");
  });
  return `${head}\n${lines.join("\n")}\n`;
}
