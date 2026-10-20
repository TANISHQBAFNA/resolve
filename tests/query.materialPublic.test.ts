import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { scanAngularPackage } from "@/adapters/angular";
import { adaptFigmaRestFile } from "@/core/ingestion/adapters/figmaRest";
import { buildGraph } from "@/core/transform/buildGraph";
import { checkEntry } from "@/core/query/codeMap";
import { codeMapJson } from "@/core/query/codeMapCsv";
import { indexGraph } from "@/core/query/GraphIndex";
import { handoffSheet, recommendMasters } from "@/core/query";
import { loadPhraseCases, scorePhrases } from "@/core/query/phraseScore";
import { libraryCodeTargets } from "@/core/query/replacements";
import {
  scoreSuggestions,
  suggestPairs,
  wrongMappedLinks,
  type AnswerPair,
} from "@/core/query/codeMapSuggest";
import { isRetired } from "@/core/rules/retired";
import { clearCache, saveGraph } from "@/server/store";

const repo = join(fileURLToPath(new URL("..", import.meta.url)));
const fix = join(repo, "fixtures", "material");
const key = JSON.parse(readFileSync(join(fix, "answer-key.json"), "utf8")) as {
  version: string;
  services: Record<string, string>;
  pairs: AnswerPair[];
};
const IO_NAME = /^([A-Za-z_$][\w$]{0,39})(?:\s*:\s*([A-Za-z_$][\w$-]{0,39}))?$/;

function materialGraph() {
  const payload = JSON.parse(readFileSync(join(fix, "library.json"), "utf8")) as {
    fileKey: string;
    variables: unknown;
  };
  return buildGraph(
    adaptFigmaRestFile({
      fileKey: payload.fileKey,
      file: payload,
      variables: payload.variables,
      kind: "json",
      ingestedAt: "2026-10-20T00:00:00.000Z",
    }),
    { builtAt: "2026-10-20T00:00:00.000Z" },
  );
}

function ioList(items: { name: string; alias?: string }[] | undefined): string[] | undefined {
  const list = (items ?? [])
    .map((item) => (item.alias && item.alias !== item.name ? `${item.name}: ${item.alias}` : item.name))
    .filter((item) => IO_NAME.test(item));
  const unique = [...new Set(list)];
  return unique.length && unique.length <= 40 ? unique : undefined;
}

/** Filled button first, so the handoff template is `<button mat-flat-button>`. The scan keeps package order. */
function buttonSelector(selector: string): string {
  const parts = selector.split(",").map((part) => part.trim());
  const head = ["button[mat-flat-button]", "a[mat-flat-button]"].filter((part) => parts.includes(part));
  return [...head, ...parts.filter((part) => !head.includes(part))].join(", ");
}

describe("Angular Material public reference", () => {
  const previous = process.env["RESOLVE_HOME"];

  afterEach(() => {
    clearCache();
    if (previous === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previous;
  });

  it("learns Material 3 tokens, variants, and slots from the public spec", () => {
    const index = indexGraph(materialGraph());
    const button = index.graph.nodes.find((node) => node.type === "COMPONENT_SET" && node.name === "Button");
    expect(button?.propertyDefinitions?.some((prop) => prop.type === "VARIANT" && prop.options?.includes("Filled"))).toBe(true);
    expect(button?.propertyDefinitions?.some((prop) => prop.type === "SLOT" && prop.name === "Icon")).toBe(true);
    const primary = index.graph.nodes.find((node) => node.type === "VARIABLE" && node.name === "md.sys.color.primary");
    expect(primary).toBeTruthy();
    expect(index.graph.nodes.filter((node) => node.type === "VARIABLE").length).toBeGreaterThan(40);
    expect(index.graph.edges.some((edge) => edge.type === "USES_VARIABLE" && edge.target === primary?.id)).toBe(true);
    const names = new Set(
      index.graph.nodes.filter((node) => node.type === "COMPONENT_SET" || (node.type === "MAIN_COMPONENT" && !node.componentSetId)).map((node) => node.name),
    );
    for (const name of ["Icon button", "FAB", "Card", "Chip", "Text field", "Form field", "Select", "Checkbox", "Radio button", "Slide toggle", "Slider", "List", "List item", "Menu", "Dialog", "Bottom sheet", "Snackbar", "Tabs", "Toolbar", "Sidenav", "Table", "Paginator", "Progress bar", "Progress spinner", "Badge", "Tooltip", "Date picker", "Stepper", "Expansion panel"]) {
      expect(names.has(name), name).toBe(true);
    }
  });

  it("scans @angular/material 22.2.3 and confirms no wrong link", () => {
    const inventory = scanAngularPackage(join(repo, "node_modules", "@angular", "material"));
    expect(inventory.packageName).toBe("@angular/material");
    expect(inventory.packageVersion).toBe("22.2.3");
    const button = inventory.components.find((row) => row.component === "MatButton");
    expect(button?.importPath).toBe("@angular/material/button");
    expect(button?.module).toBe("MatButtonModule");
    expect(button?.selector).toContain("button[mat-flat-button]");
    const index = indexGraph(materialGraph());
    const targets = libraryCodeTargets(index);
    const pairs = suggestPairs(index, inventory, targets, { retired: (node) => isRetired(index, node) });
    const proposed = pairs.map((pair) => ({ figma: pair.name, component: pair.component, relation: pair.relation }));
    const score = scoreSuggestions(proposed, key.pairs);
    const byName = new Map(targets.map((target) => [target.name, target]));
    const entries = key.pairs.map((pair) => {
      const target = byName.get(pair.figma);
      expect(target, pair.figma).toBeTruthy();
      const code = inventory.components.find((row) => row.component === pair.component);
      const service = key.services[pair.component];
      const body: Record<string, unknown> = {
        fileKey: target!.fileKey,
        id: target!.id,
        name: target!.name,
        status: "mapped",
        relation: "maps",
        figmaVersion: "public-spec-2026-10-20",
        packageVersion: "22.2.3",
      };
      if (!code) {
        expect(service, pair.component).toBeTruthy();
        const source = readFileSync(join(repo, "node_modules", "@angular", "material", "types", pair.component === "MatDialog" ? "_dialog-chunk.d.ts" : pair.component === "MatSnackBar" ? "snack-bar.d.ts" : "bottom-sheet.d.ts"), "utf8");
        expect(source).toContain(`declare class ${pair.component}`);
        body["code"] = { import: `import { ${pair.component} } from '${service}'`, component: pair.component };
      } else {
        const selector = pair.component === "MatButton" ? buttonSelector(code.selector) : code.selector;
        const angular: Record<string, unknown> = {
          framework: "angular",
          import: `import { ${code.module ?? code.component} } from '${code.importPath}'`,
          component: code.component,
          selector,
          ...(code.module ? { module: code.module } : code.standalone ? { standalone: true } : {}),
        };
        const inputs = ioList(code.inputs);
        const outputs = ioList(code.outputs);
        if (inputs) angular["inputs"] = inputs;
        if (outputs) angular["outputs"] = outputs;
        body["code"] = angular;
      }
      expect(checkEntry(body), pair.figma).toBeUndefined();
      return body;
    });
    expect(wrongMappedLinks(entries, key.pairs)).toEqual([]);
    expect(score.extra.map((pair) => `${pair.figma} → ${pair.component}`)).toEqual(["Tooltip → TooltipComponent"]);
    expect(score.missed.map((pair) => `${pair.figma} → ${pair.component}`).sort()).toEqual(
      ["Bottom sheet → MatBottomSheet", "Dialog → MatDialog", "Extended FAB → MatFabButton", "Snackbar → MatSnackBar", "Tabs → MatTabGroup", "Text field → MatInput"].sort(),
    );
    expect(score).toMatchObject({ hits: 34, proposed: 35, labelled: 40 });
    expect(score.precision).toBeCloseTo(34 / 35);
    expect(score.recall).toBeCloseTo(34 / 40);

    const home = join(tmpdir(), "resolve-material-map");
    mkdirSync(home, { recursive: true });
    process.env["RESOLVE_HOME"] = home;
    clearCache();
    const json = codeMapJson(entries, { figmaVersion: "public-spec-2026-10-20", packages: { "@angular/material": "22.2.3" } });
    writeFileSync(join(home, "code-map.json"), json);
    saveGraph(materialGraph());
    const sheet = handoffSheet(indexGraph(materialGraph()), ["Sign in"]);
    expect(sheet.ok, sheet.ok ? "" : sheet.hint).toBe(true);
    if (!sheet.ok) return;
    const buttonRow = sheet.screens[0]?.components.find((row) => row.name === "Button");
    expect(buttonRow?.angular?.module).toBe("MatButtonModule");
    expect(buttonRow?.angular?.importPath).toBe("@angular/material/button");
    expect(buttonRow?.angular?.selector).toContain("button[mat-flat-button]");
    expect(buttonRow?.template).toContain("<button mat-flat-button");

    if (process.env["MATERIAL_WRITE"] === "1") {
      writeFileSync(join(fix, "scan.json"), `${JSON.stringify(inventory, null, 2)}\n`);
      writeFileSync(join(fix, "suggestions.json"), `${JSON.stringify({ package: inventory.packageName, version: inventory.packageVersion, pairs }, null, 2)}\n`);
      writeFileSync(join(fix, "code-map.json"), json);
    } else {
      const savedScan = JSON.parse(readFileSync(join(fix, "scan.json"), "utf8")) as {
        packageVersion: string;
        components: { component: string; selector?: string; importPath?: string; module?: string }[];
      };
      expect(savedScan.packageVersion).toBe("22.2.3");
      expect(savedScan.components.map((row) => row.component)).toEqual(inventory.components.map((row) => row.component));
      const savedButton = savedScan.components.find((row) => row.component === "MatButton");
      expect(savedButton).toMatchObject({ selector: button?.selector, importPath: "@angular/material/button", module: "MatButtonModule" });
      const savedSuggestions = JSON.parse(readFileSync(join(fix, "suggestions.json"), "utf8")) as { pairs: { name: string; component: string; relation: string }[] };
      expect(savedSuggestions.pairs.map((pair) => `${pair.name}|${pair.component}|${pair.relation}`)).toEqual(
        pairs.map((pair) => `${pair.name}|${pair.component}|${pair.relation}`),
      );
      expect(JSON.parse(readFileSync(join(fix, "code-map.json"), "utf8"))).toEqual(JSON.parse(json));
    }
  });

  it("scores the Material phrase board with nothing invented", () => {
    const home = join(tmpdir(), "resolve-material-phrases");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "synonyms.json"), readFileSync(join(fix, "synonyms.json")));
    process.env["RESOLVE_HOME"] = home;
    clearCache();
    const index = indexGraph(materialGraph());
    const cases = loadPhraseCases([join(repo, "scoreboard", "material-phrases")]);
    expect(cases.length).toBeGreaterThanOrEqual(40);
    const report = scorePhrases(index, cases);
    const baseline = JSON.parse(readFileSync(join(repo, "scoreboard", "material-baseline.json"), "utf8")) as {
      top1: number;
      top3: number;
      matchCases: number;
      emptyCorrect: number;
      emptyCases: number;
    };
    expect(report.totals.invented).toBe(0);
    expect(report.totals.retiredRecommended).toBe(0);
    expect(report.skipped).toEqual([]);
    expect(report.totals.top1 / report.totals.matchCases).toBeGreaterThanOrEqual(baseline.top1 / baseline.matchCases);
    expect(report.totals.top3 / report.totals.matchCases).toBeGreaterThanOrEqual(baseline.top3 / baseline.matchCases);
    expect(report.totals.correctEmpty).toBeGreaterThanOrEqual(baseline.emptyCorrect);
    expect(report.totals.emptyCases).toBeGreaterThanOrEqual(baseline.emptyCases);
    expect(report.totals).toMatchObject({ top1: 51, top3: 51, matchCases: 51, correctEmpty: 8, emptyCases: 8, invented: 0 });
    for (const phrase of ["primary sign in button", "data table with sortable columns"]) {
      const card = recommendMasters(index, phrase);
      for (const row of card.candidates) if ("id" in row && row.id) expect(index.getNode(row.id)).toBeTruthy();
    }
  });
});
