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
import { briefScreen, formatHandoffScreen, handoffSheet, recommendMasters } from "@/core/query";
import { mergeRecipes, parseRecipeFile, starterRecipes } from "@/core/query/recipes";
import { loadPhraseCases, scorePhrases } from "@/core/query/phraseScore";
import { libraryCodeTargets } from "@/core/query/replacements";
import {
  scoreSuggestions,
  suggestPairs,
  wrongMappedLinks,
  type AnswerPair,
} from "@/core/query/codeMapSuggest";
import { isRetired } from "@/core/rules/retired";
import { runCli } from "@/server/cli";
import { clearCache, saveGraph } from "@/server/store";
import { callTool } from "@/server/tools";

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

/** One Material 3 button syntax: `matButton`, not the old `mat-flat-button` list mixed in. */
function reviewedSelector(component: string, raw: string): string {
  if (component === "MatButton") return "button[matButton], a[matButton]";
  const parts = raw.replace(/\s+/g, " ").split(",").map((part) => part.trim()).filter(Boolean);
  for (let count = Math.min(parts.length, 8); count >= 1; count -= 1) {
    const selector = parts.slice(0, count).join(", ");
    if (selector.length <= 200) return selector;
  }
  return parts[0] ?? raw;
}

function exportedSymbols(packageRoot: string): Map<string, string[]> {
  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    name: string;
    exports: Record<string, { types?: string }>;
  };
  const found = new Map<string, string[]>();
  for (const [key, value] of Object.entries(pkg.exports)) {
    if (!key.startsWith("./") || key.includes("*") || key.includes("testing")) continue;
    const types = value?.types;
    if (!types?.endsWith(".d.ts")) continue;
    const text = readFileSync(join(packageRoot, types), "utf8");
    const spec = `${pkg.name}/${key.slice(2)}`;
    for (const match of text.matchAll(/export\s*\{([^}]+)\}/g)) {
      for (const part of match[1]!.split(",")) {
        const symbol = part.trim().split(/\s+as\s+/).pop()?.trim() ?? "";
        if (!/^[A-Za-z_$][\w$]*$/.test(symbol)) continue;
        const list = found.get(symbol) ?? [];
        if (!list.includes(spec)) list.push(spec);
        found.set(symbol, list);
      }
    }
  }
  return found;
}

function pickSpec(symbol: string, found: Map<string, string[]>): string | undefined {
  const specs = found.get(symbol) ?? [];
  if (specs.length <= 1) return specs[0];
  const words = symbol
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "mat" && word !== "module");
  const score = (spec: string) => {
    const segment = spec.split("/").pop()?.replace(/-/g, " ") ?? "";
    return words.filter((word) => segment.includes(word)).length;
  };
  return [...specs].sort((a, b) => score(b) - score(a) || a.length - b.length)[0];
}

function specExports(packageRoot: string, spec: string, symbol: string): boolean {
  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    name: string;
    exports: Record<string, { types?: string }>;
  };
  const sub = spec.startsWith(`${pkg.name}/`) ? `./${spec.slice(pkg.name.length + 1)}` : ".";
  const types = pkg.exports[sub]?.types;
  if (!types) return false;
  const text = readFileSync(join(packageRoot, types), "utf8");
  return new RegExp(`export\\s*\\{[^}]*\\b${symbol}\\b`).test(text);
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
    expect(button?.selector).toContain("button[matButton]");
    expect(button?.selector).toContain("mat-flat-button");
    const packageRoot = join(repo, "node_modules", "@angular", "material");
    const symbols = exportedSymbols(packageRoot);
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
        const moduleName = `${code.component}Module`;
        const moduleSpec = pickSpec(moduleName, symbols);
        const classSpec = pickSpec(code.component, symbols);
        const spec = moduleSpec ?? classSpec;
        expect(spec, pair.component).toBeTruthy();
        const imported = moduleSpec ? moduleName : code.component;
        expect(specExports(packageRoot, spec!, imported), `${imported} from ${spec}`).toBe(true);
        const angular: Record<string, unknown> = {
          framework: "angular",
          import: `import { ${imported} } from '${spec}'`,
          component: code.component,
          selector: reviewedSelector(code.component, code.selector),
          ...(moduleSpec ? { module: moduleName } : { standalone: true }),
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
    const tooltip = entries.find((entry) => entry["name"] === "Tooltip");
    expect((tooltip?.["code"] as { component: string }).component).toBe("MatTooltip");
    const formField = entries.find((entry) => entry["name"] === "Form field");
    expect((formField?.["code"] as { import: string }).import).toBe("import { MatFormFieldModule } from '@angular/material/form-field'");
    expect(score.extra).toEqual([]);
    expect(score).toMatchObject({ hits: 32, proposed: 32, labelled: 40 });
    expect(score.precision).toBe(1);
    expect(score.recall).toBeCloseTo(32 / 40);
    expect(score.missed.map((pair) => `${pair.figma} → ${pair.component}`).sort()).toEqual(
      [
        "Bottom sheet → MatBottomSheet",
        "Date picker → MatDatepicker",
        "Dialog → MatDialog",
        "Extended FAB → MatFabButton",
        "Snackbar → MatSnackBar",
        "Tabs → MatTabGroup",
        "Text field → MatInput",
        "Time picker → MatTimepicker",
      ].sort(),
    );

    const home = join(tmpdir(), "resolve-material-map");
    mkdirSync(home, { recursive: true });
    process.env["RESOLVE_HOME"] = home;
    clearCache();
    const json = codeMapJson(entries, { figmaVersion: "public-spec-2026-10-20", packages: { "@angular/material": "22.2.3" } });
    writeFileSync(join(home, "code-map.json"), json);
    saveGraph(materialGraph());
    const recipes = mergeRecipes(starterRecipes(), parseRecipeFile(JSON.parse(readFileSync(join(fix, "recipes.json"), "utf8"))));
    const sheet = handoffSheet(indexGraph(materialGraph()), ["Sign in"], { recipes });
    expect(sheet.ok, sheet.ok ? "" : sheet.hint).toBe(true);
    if (!sheet.ok) return;
    const text = formatHandoffScreen(sheet.screens[0]!, false);
    expect(text).not.toContain("figma.com/design/M3SPEC");
    expect(text).toContain("example, not a real Figma file");
    const username = sheet.screens[0]?.recipe?.slots.find((slot) => slot.role === "username");
    const password = sheet.screens[0]?.recipe?.slots.find((slot) => slot.role === "password");
    expect(username?.state).toBe("placed");
    expect(password?.state).toBe("placed");
    expect(username?.component?.name).toBe("Text field");
    expect(password?.component?.name).toBe("Text field");
    const buttonRow = sheet.screens[0]?.components.find((row) => row.name === "Button");
    expect(buttonRow?.angular?.module).toBe("MatButtonModule");
    expect(buttonRow?.angular?.importPath).toBe("@angular/material/button");
    expect(buttonRow?.template).toBe("<button matButton=\"filled\"></button>");
    expect(buttonRow?.template).not.toContain("mat-flat-button");
    const field = sheet.screens[0]?.components.find((row) => row.name === "Text field");
    expect(field?.template).toBe('<mat-form-field appearance="fill"><mat-label>…</mat-label><input matInput></mat-form-field>');
    expect(field?.template).not.toContain('type="filled"');
    const sample = handoffSheet(indexGraph(materialGraph()), ["Field sample"], { recipes: starterRecipes() });
    expect(sample.ok).toBe(true);
    if (!sample.ok) return;
    const outlined = sample.screens[0]?.components.find((row) => row.name === "Text field");
    const tonal = sample.screens[0]?.components.find((row) => row.name === "Button");
    const form = sample.screens[0]?.components.find((row) => row.name === "Form field");
    expect(outlined?.template).toContain('appearance="outline"');
    expect(tonal?.template).toBe("<button matButton=\"tonal\"></button>");
    expect(form?.angular?.importPath).toBe("@angular/material/form-field");
    expect(form?.angular?.module).toBe("MatFormFieldModule");
    const legacy = index.getNodesByType("MAIN_COMPONENT").find((node) => node.name === "Legacy button");
    expect(legacy && isRetired(index, legacy)).toBe(true);
    expect(recommendMasters(index, "primary sign in button").candidates.some((row) => row.name === "Legacy button")).toBe(false);

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
      expect(savedButton?.selector).toBe(button?.selector);
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
  });

  it("scores a held-out Material set on unseen wording", () => {
    const home = join(tmpdir(), "resolve-material-heldout");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "synonyms.json"), readFileSync(join(fix, "synonyms.json")));
    process.env["RESOLVE_HOME"] = home;
    clearCache();
    const index = indexGraph(materialGraph());
    const cases = loadPhraseCases([join(repo, "scoreboard", "material-heldout")]);
    const report = scorePhrases(index, cases);
    const detail = report.misses.map((miss) => `${miss.id} ${miss.kind} ${miss.detail}`).join("\n");
    expect(report.totals.invented, detail).toBe(0);
    expect(report.skipped, detail).toEqual([]);
    expect(report.totals.correctEmpty, detail).toBe(report.totals.emptyCases);
    expect(report.totals.top1, detail).toBe(report.totals.matchCases);
    expect(report.totals.top3, detail).toBe(report.totals.matchCases);
    for (const phrase of ["primary sign in button", "data table"]) {
      const card = recommendMasters(index, phrase);
      for (const row of card.candidates) if ("id" in row && row.id) expect(index.getNode(row.id)).toBeTruthy();
    }
  });

  it("scores a fresh r2 set: descriptive phrasings, plurals, new typos, and side panels", () => {
    const home = join(tmpdir(), "resolve-material-fresh");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "synonyms.json"), readFileSync(join(fix, "synonyms.json")));
    process.env["RESOLVE_HOME"] = home;
    clearCache();
    const index = indexGraph(materialGraph());
    const report = scorePhrases(index, loadPhraseCases([join(repo, "scoreboard", "material-fresh")]));
    const detail = report.misses.map((miss) => `${miss.id} ${miss.kind} ${miss.detail}`).join("\n");
    expect(report.totals.invented, detail).toBe(0);
    expect(report.totals.wrongCousin, detail).toBe(0);
    expect(report.totals.correctEmpty, detail).toBe(report.totals.emptyCases);
    // 32 of 33. "header with a back arrow" still needs a meaning link. "a collapsible section" and "grid of photos" now lead the expected part.
    expect(report.totals.top1, detail).toBeGreaterThanOrEqual(30);
    expect(report.misses.map((miss) => miss.id).sort(), detail).toEqual(["desc-header-back"]);
  });

  it("keeps the part named before a linking word, and keeps split two-word asks empty", () => {
    const home = join(tmpdir(), "resolve-material-link");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "synonyms.json"), readFileSync(join(fix, "synonyms.json")));
    process.env["RESOLVE_HOME"] = home;
    clearCache();
    const index = indexGraph(materialGraph());
    const top = (ask: string) => recommendMasters(index, ask).candidates[0]?.name;
    const lead: Array<[string, string]> = [
      ["button to open the dialog", "Button"],
      ["card showing a chip", "Card"],
      ["dialog with a date picker", "Dialog"],
      ["toolbar with a search bar", "Toolbar"],
      ["chip for the badge", "Chip"],
      ["table with a paginator", "Table"],
      ["icon button to open the sidenav", "Icon button"],
    ];
    for (const [ask, name] of lead) expect(top(ask), ask).toBe(name);
    // Nothing before the linking word names a part: the part after it is still the ask.
    expect(top("dashboard with a table")).toBe("Table");
    // A whole-word part or a shared head noun keeps its pick.
    expect(top("menu button")).toBe("Menu");
    expect(top("search field")).toBe("Search bar");
  });

  it("sends side panels to Side sheet, and keeps longer asks that name a part", () => {
    const home = join(tmpdir(), "resolve-material-r4");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "synonyms.json"), readFileSync(join(fix, "synonyms.json")));
    process.env["RESOLVE_HOME"] = home;
    clearCache();
    const index = indexGraph(materialGraph());
    const top = (ask: string) => recommendMasters(index, ask).candidates[0]?.name;
    // Fresh wording, two and three words, with and without a tail, singular and plural.
    for (const ask of ["side panel", "a side panel", "pinned side panel", "right side panel", "side panel for map layers", "side panels", "the side panels", "docked side panels", "two side panels with filters"]) {
      expect(top(ask), ask).toBe("Side sheet");
    }
    // Plurals read their stem's synonym group for any part noun.
    expect(top("three accordions")).toBe("Expansion panel");
    expect(top("the toasts")).toBe("Snackbar");
    // An -ed or -ing word only describes the noun after it: the noun wins.
    for (const ask of ["a toggled switch", "the toggling switch"]) expect(top(ask), ask).toBe("Slide toggle");
    expect(top("checked checkboxes")).toBe("Checkbox");
    expect(top("a dimmed snackbar")).toBe("Snackbar");
    // Through stems too: an -ed/-ing word whose stem is a part (Select, Sort) still only describes the noun.
    const ranked = (ask: string) => recommendMasters(index, ask).candidates.slice(0, 3).map((row) => row.name);
    for (const [ask, name] of [["the selected tab", "Tabs"], ["selecting tab", "Tabs"], ["a sorted data table", "Table"], ["sorting table", "Table"]] as const) {
      expect(top(ask), ask).toBe(name);
      expect(ranked(ask), ask).not.toContain(name === "Tabs" ? "Select" : "Sort");
    }
    // On its own the word still names its part.
    expect(top("selected")).toBe("Select");
    // Unless the stem and the noun name a part together: an -ing form of search before a bar or field is Search bar.
    for (const ask of ["a searching bar up top", "searching field for contacts", "the searched input"]) expect(top(ask), ask).toBe("Search bar");
    // A single-word part (Select, Sort) still loses to the noun.
    expect(top("a selected button")).toBe("Button");
    // A kept word is read as its stem, so a dropped-e form still names the part.
    expect(top("a dated picker for the invoice")).toBe("Date picker");
    expect(top("the timed picker on the alarm screen")).toBe("Time picker");
    // A shared noun that is a whole part name keeps its part: an -ed form of date or time before card is Card.
    expect(top("a dated card on the statement")).toBe("Card");
    expect(top("the timed card")).toBe("Card");
    expect(top("searching field in the header")).toBe("Search bar");
    // A pick reached only through a shared noun after an -ed/-ing word is a guess: weak in recommend and brief.
    for (const [ask, name] of [["dated item", "Date picker"], ["timed bar", "Time picker"], ["searching item", "Search bar"], ["searching field", "Search bar"]] as const) {
      const card = recommendMasters(index, ask, { budgetChars: 4000 }) as { match?: string; candidates: Array<{ name?: string; why?: string }> };
      expect([card.match, card.candidates[0]?.name], ask).toEqual(["weak match", name]);
      expect(card.candidates[0]?.why, ask).toMatch(/^Weak, check:/);
      const brief = briefScreen({ request: ask, index, recipes: [] });
      expect("ready" in brief && brief.candidates[0], ask).toMatchObject({ name, weak: true });
      expect("ready" in brief && brief.assumptions.join(" "), ask).not.toMatch(/Only one candidate fits/);
      expect("ready" in brief && brief.assumptions.join(" "), ask).toMatch(/Weak, check:/);
    }
    // The guess marks only the part it pointed to. A full part name after the -ed/-ing word stays confident.
    for (const [ask, name] of [["a timed progress bar on upload", "Progress bar"], ["the dated list item", "List item"], ["timed navigation bar", "Navigation bar"], ["searching text field", "Text field"]] as const) {
      const card = recommendMasters(index, ask, { budgetChars: 4000 }) as { match?: string; candidates: Array<{ name?: string; why?: string }> };
      expect([card.match, card.candidates[0]?.name], ask).toEqual([undefined, name]);
      expect(card.candidates[0]?.why ?? "", ask).not.toMatch(/Weak, check/);
    }
    // Every weak lead carries a Weak, check reason.
    const header = recommendMasters(index, "header", { budgetChars: 4000 }) as { match?: string; candidates: Array<{ why?: string }> };
    expect(header.match).toBe("weak match");
    expect(header.candidates[0]?.why).toMatch(/^Weak, check:/);
    // Not a guess: a whole part name, a plain ask, or a stem that names the part with the noun.
    for (const [ask, name] of [["dated card", "Card"], ["pick a date", "Date picker"], ["searching bar", "Search bar"], ["dated picker", "Date picker"]] as const) {
      const card = recommendMasters(index, ask, { budgetChars: 4000 }) as { match?: string; candidates: Array<{ name?: string }> };
      expect([card.match, card.candidates[0]?.name], ask).toEqual([undefined, name]);
      const brief = briefScreen({ request: ask, index, recipes: [] });
      expect("ready" in brief && brief.candidates[0]?.weak, ask).toBeUndefined();
    }
    // A vague panel keeps a head-noun match, never a part named by the other word.
    for (const ask of ["search panel", "nav panel"]) expect(top(ask), ask).not.toMatch(/Search bar|Navigation/);
    // A known part plus a describing tail is still that part.
    expect(top("a bottom navigation with three destinations")).toBe("Navigation bar");
    expect(top("bottom navigation for the main sections")).toBe("Navigation bar");
    expect(top("a toolbar holding a title and two actions")).toBe("Toolbar");
    expect(top("toolbar holding the page actions")).toBe("Toolbar");
  });

  it("gives every weak lead a Weak, check reason at the default card size, in the CLI and MCP", async () => {
    const home = join(tmpdir(), "resolve-material-weak-default");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "synonyms.json"), readFileSync(join(fix, "synonyms.json")));
    process.env["RESOLVE_HOME"] = home;
    clearCache();
    saveGraph(materialGraph());
    const cliCard = async (ask: string) => {
      const chunks: string[] = [];
      const write = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string) => {
        chunks.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      try {
        await runCli(["recommend", ask]);
      } finally {
        process.stdout.write = write;
      }
      const text = chunks.join("");
      return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Card;
    };
    type Card = { match?: string; candidates: Array<{ name?: string; why?: string }>; cost?: { chars: number } };
    // Fresh wording: guesses through a shared noun, and a plain weak lead.
    for (const ask of ["a searching field near the top", "searching input", "the dated item", "header"]) {
      for (const card of [await cliCard(ask), callTool("recommend", { intent: ask }) as Card]) {
        expect(card.match, ask).toBe("weak match");
        expect(card.candidates[0]?.why, ask).toMatch(/^Weak, check:/);
        expect(card.cost?.chars ?? 0, ask).toBeLessThanOrEqual(600);
      }
    }
    // A confident pick gets no weak reason.
    const confident = callTool("recommend", { intent: "timed progress bar" }) as Card;
    expect(confident.match).toBeUndefined();
    expect(confident.candidates[0]?.why ?? "").not.toMatch(/Weak, check/);
  });
});
