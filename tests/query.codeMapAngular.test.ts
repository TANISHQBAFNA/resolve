import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import acmeFile from "../docs/examples/acme-ui.json";
import angularMap from "../docs/examples/acme-code-map-angular.json";
import { adaptFigmaRestFile } from "@/core/ingestion";
import { adaptFigmaMcpMetadata } from "@/core/ingestion/adapters/figmaMcp";
import { buildGraph } from "@/core/transform";
import {
  angularText,
  codeMapCard,
  codeMapFromCsv,
  codeMapRows,
  codeMapTemplate,
  componentUsageCard,
  formatCodeMapReport,
  formatIngredientCard,
  indexGraph,
  ingredientCard,
  parseCsv,
  recommendMasters,
  verifyFrame,
} from "@/core/query";
import { runCli } from "@/server/cli";
import { callTool, INGREDIENTS_MCP_MAX_CHARS, listToolDefinitions } from "@/server/tools";
import { clearCache, saveGraph } from "@/server/store";

const FROZEN = "2026-01-01T00:00:00.000Z";
const acmeGraph = () => buildGraph(adaptFigmaRestFile({ fileKey: "ACMEUI", file: acmeFile, kind: "mock", ingestedAt: FROZEN }), { builtAt: FROZEN });
const acme = () => indexGraph(acmeGraph());
const CSV = join(__dirname, "..", "docs", "examples", "acme-code-map-angular.csv");

/** The README's React map, read from the README so the docs and the test cannot drift. */
function readmeReactMap(): string {
  const readme = readFileSync(join(__dirname, "..", "README.md"), "utf8");
  const at = readme.indexOf("#### `.resolve/code-map.json`");
  const block = readme.slice(at).match(/```json\n([\s\S]*?)```/);
  if (!block?.[1]) throw new Error("README code map example missing");
  return block[1];
}

type Card = ReturnType<typeof ingredientCard>;
const found = (card: Card) => {
  if (!card.found) throw new Error(`not found: ${card.hint}`);
  return card;
};

describe("Angular fields in the code map", () => {
  const previousHome = process.env["RESOLVE_HOME"];
  let home: string;
  const put = (map: unknown) => writeFileSync(join(home, "code-map.json"), typeof map === "string" ? map : JSON.stringify(map));
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "resolve-angular-"));
    process.env["RESOLVE_HOME"] = home;
    clearCache();
  });
  afterEach(() => {
    clearCache();
    process.exitCode = undefined;
    if (previousHome === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previousHome;
  });

  it("the Acme Angular map loads with nothing ignored; the report counts its Angular fields", () => {
    put(angularMap);
    const report = codeMapCard(() => acme());
    expect(report.counts).toMatchObject({ masters: 6, mapped: 3, retired: 1, unmapped: 2, ignored: 0, conflict: 0 });
    expect(report.angular).toEqual({ mapped: 4, standalone: 2, module: 2, inputsOrOutputs: 3 });
    const text = formatCodeMapReport(report);
    expect(text).toContain("Angular: 4 mapped components have a selector (2 standalone, 2 with a module, 3 list inputs or outputs).");
    expect(text).toContain("Retired: Old Button [ACMEUI 30:50] -> use Button (code: AcmeOldButtonComponent from '@acme/ui-angular-legacy', <acme-old-button>, AcmeLegacyModule)");
    expect(report.retired[0]?.angular).toMatchObject({ selector: "acme-old-button", module: "AcmeLegacyModule" });
  });

  it("a React-only map reads exactly as before: no angular key, no Angular line", () => {
    put(readmeReactMap());
    const report = codeMapCard(() => acme());
    expect(report).not.toHaveProperty("angular");
    expect(formatCodeMapReport(report)).not.toContain("Angular");
    const card = found(ingredientCard(acme(), "Payee picker"));
    expect(card).not.toHaveProperty("angular");
    expect(card.parts.every((p) => !("angular" in p))).toBe(true);
    expect(formatIngredientCard(card)).not.toContain("Angular");
    expect(componentUsageCard(acme(), "Button")).not.toHaveProperty("angular");
    expect(recommendMasters(acme(), "primary button")).not.toHaveProperty("angular");
  });

  it("bad Angular values are refused with a reason, never changed", () => {
    const ng = (extra: object) => ({
      fileKey: "ACMEUI",
      id: "30:10",
      code: { import: "import { AcmeButtonComponent } from '@acme/ui-angular'", component: "AcmeButtonComponent", ...extra },
    });
    const cases: [object, string][] = [
      [{ framework: "vue" }, "framework must be angular or react"],
      [{ framework: "angular" }, "an angular entry needs a selector"],
      [{ framework: "react", selector: "acme-button" }, "'selector' is an Angular field; set framework to angular"],
      [{ module: "AcmeButtonModule" }, "'module' needs an Angular selector"],
      [{ selector: "AcmeButton" }, "selector must look like acme-button or [acmeTooltip]"],
      [{ selector: "acme" }, "selector must look like acme-button or [acmeTooltip]"],
      [{ selector: "<acme-button>" }, "selector must look like acme-button or [acmeTooltip]"],
      [{ selector: "acme-button", module: "Acme.Module" }, "module must be a plain name like AcmeButtonModule"],
      [{ selector: "acme-button", standalone: "yes" }, "standalone must be true or false"],
      [{ selector: "acme-button", module: "AcmeButtonModule", standalone: true }, "use module or standalone: true, not both"],
      [{ selector: "acme-button", inputs: "variant" }, "inputs must be a list of plain names like variant"],
      [{ selector: "acme-button", outputs: ["on click"] }, "outputs must be a list of plain names like pressed"],
      [{ selector: "acme-button", props: ["x"] }, "unsupported field 'code.props'"],
    ];
    put({ entries: cases.map(([extra]) => ng(extra)) });
    const report = codeMapCard(() => acme());
    expect(report.ignored.map((i) => i.reason)).toEqual(cases.map(([, why]) => why));
    // Attribute and element+attribute selectors are fine.
    put({ entries: [ng({ selector: "[acmeTooltip]" }), { ...ng({ selector: "button[acme-button]" }), id: "30:20" }] });
    expect(codeMapCard(() => acme()).counts).toMatchObject({ mapped: 2, ignored: 0 });
    expect(angularText({ selector: "[acmeTooltip]", importPath: "x" })).toBe("[acmeTooltip]");
  });

  it("a React and an Angular entry for one component is a conflict that says why", () => {
    const react = JSON.parse(readmeReactMap()).entries[0];
    put({ entries: [react, angularMap.entries[0]] });
    const report = codeMapCard(() => acme());
    expect(report.conflicts).toEqual([
      { name: "Button", fileKey: "ACMEUI", id: "30:10", reason: "a React and an Angular entry disagree; keep one entry per component" },
    ]);
  });

  it("the ingredient card shows selector, module or standalone, import path, inputs and outputs (text and JSON)", () => {
    put(angularMap);
    const card = found(ingredientCard(acme(), "Payee picker"));
    expect(card.code).toBe("AcmePayeePickerComponent from '@acme/payments-angular'");
    expect(card.angular).toEqual({
      selector: "acme-payee-picker",
      standalone: true,
      importPath: "@acme/payments-angular",
      inputs: ["payees", "selected"],
      outputs: ["selectedChange"],
    });
    const button = card.parts.find((p) => p.name.startsWith("Button"));
    expect(button?.angular).toMatchObject({ selector: "acme-button", module: "AcmeButtonModule", importPath: "@acme/ui-angular" });
    expect(formatIngredientCard(card)).toBe(
      [
        "Payee picker [ACMEUI 30:30]",
        "Code: AcmePayeePickerComponent from '@acme/payments-angular'",
        "Angular: <acme-payee-picker>, standalone; inputs: payees, selected; outputs: selectedChange",
        "Inside it:",
        "  - Avatar [30:40] (code: no code link yet)",
        "  - Button / Variant=Primary, Size=Medium [30:11] (code: AcmeButtonComponent from '@acme/ui-angular', <acme-button>, AcmeButtonModule)",
        "Payee picker is built from 2 parts. 1 linked to code, 1 with no code link yet.",
      ].join("\n"),
    );
  });

  it("a retired part shows its own Angular code and the replacement's", () => {
    put(angularMap);
    const card = found(ingredientCard(acme(), "Old Button"));
    expect(card.angular).toMatchObject({ selector: "acme-old-button", module: "AcmeLegacyModule" });
    expect(card.component).toMatchObject({ use: "Button", useCode: "AcmeButtonComponent from '@acme/ui-angular'", useAngular: { selector: "acme-button" } });
    const text = formatIngredientCard(card);
    expect(text).toContain("Code: AcmeOldButtonComponent from '@acme/ui-angular-legacy' (retired; use Button, code: AcmeButtonComponent from '@acme/ui-angular', <acme-button>, AcmeButtonModule)");
    expect(text).toContain("Angular: <acme-old-button>, AcmeLegacyModule");
  });

  it("resolve, recommend and verify carry the Angular fields next to the code line", () => {
    put(angularMap);
    const resolved = componentUsageCard(acme(), "Button") as { code?: string; angular?: object };
    expect(resolved.code).toBe("AcmeButtonComponent from '@acme/ui-angular'");
    expect(resolved.angular).toMatchObject({ selector: "acme-button", module: "AcmeButtonModule", inputs: ["variant", "size", "disabled"], outputs: ["pressed"] });
    const rec = recommendMasters(acme(), "primary button") as { code?: string; angular?: string; cost: { chars: number } };
    expect(rec).toMatchObject({ code: "AcmeButtonComponent from '@acme/ui-angular'", angular: "<acme-button>, AcmeButtonModule" });
    expect(rec.cost.chars).toBeLessThanOrEqual(600);
    const verify = verifyFrame(acme(), { components: ["Old Button"] }) as { retired?: string[] };
    expect(verify.retired).toEqual(["retired Old Button -> use Button (code: AcmeOldButtonComponent from '@acme/ui-angular-legacy', <acme-old-button>, AcmeLegacyModule)"]);
  });

  it("CSV: the template lists every component, filled where the map knows it; the Acme CSV imports to the Acme JSON", () => {
    put(angularMap);
    const template = codeMapTemplate(codeMapRows(acme()));
    const rows = parseCsv(template);
    expect(rows[0]).toEqual(["fileKey", "id", "name", "component", "importPath", "framework", "selector", "module", "standalone", "inputs", "outputs", "status", "replacedBy"]);
    expect(rows).toHaveLength(7);
    expect(template).toBe(readFileSync(CSV, "utf8"));
    const imported = codeMapFromCsv(readFileSync(CSV, "utf8"));
    expect(imported).toMatchObject({ skipped: 2, errors: [] });
    expect({ entries: imported.entries }).toEqual(angularMap);
  });

  it("CSV: bad rows are reported by row number; quoted cells and React rows work", () => {
    const head = "fileKey,id,name,component,importPath,framework,selector,module,standalone,inputs,outputs,status,replacedBy";
    const bad = codeMapFromCsv(
      [head, "ACMEUI,30:10,Button,AcmeButtonComponent,@acme/ui-angular,angular,AcmeButton,,,,,,", "ACMEUI,30:20,Text field,AcmeTextField,,,,,,,,,", "ACMEUI,30:30,Payee picker,P,@acme/x,,,,maybe,,,,"].join("\n"),
    );
    expect(bad.errors).toEqual([
      "row 2: selector must look like acme-button or [acmeTooltip]",
      "row 3: needs both component and importPath",
      "row 4: standalone must be true or false",
    ]);
    expect(codeMapFromCsv("fileKey,id,colour\nA,1,red").errors).toEqual([
      "unknown column 'colour'; columns are fileKey, id, name, component, importPath, framework, selector, module, standalone, inputs, outputs, status, replacedBy",
    ]);
    const ok = codeMapFromCsv(`${head}\r\nACMEUI,30:10,Button,Button,@acme/ui,,,,,,,,\r\nACMEUI,30:20,Text field,AcmeTextFieldComponent,@acme/ui-angular,angular,acme-text-field,,true,"label, value",,,\r\n`);
    expect(ok.errors).toEqual([]);
    expect(ok.entries[0]).toEqual({ fileKey: "ACMEUI", id: "30:10", code: { import: "import { Button } from '@acme/ui'", component: "Button" } });
    expect(ok.entries[1]).toMatchObject({ code: { inputs: ["label", "value"], standalone: true } });
    expect(() => parseCsv('a,"b')).toThrow("a quoted cell is not closed");
  });
});

describe("code-map --init / --import and MCP size guard", () => {
  const previousHome = process.env["RESOLVE_HOME"];
  const previousAdvanced = process.env["RESOLVE_MCP_ADVANCED"];
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "resolve-angular-cli-"));
    process.env["RESOLVE_HOME"] = home;
    clearCache();
    saveGraph(acmeGraph());
  });
  afterEach(() => {
    clearCache();
    process.exitCode = undefined;
    if (previousHome === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previousHome;
    if (previousAdvanced === undefined) delete process.env["RESOLVE_MCP_ADVANCED"];
    else process.env["RESOLVE_MCP_ADVANCED"] = previousAdvanced;
  });
  async function cli(argv: string[]): Promise<string> {
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string | Uint8Array) => (out.push(String(c)), true)) as typeof process.stdout.write;
    try {
      await runCli(argv);
    } finally {
      process.stdout.write = write;
    }
    return out.join("");
  }

  it("--init writes a template next to code-map.json and never overwrites without --force", async () => {
    expect(await cli(["code-map", "--init"])).toContain("6 components, 0 already mapped");
    const csv = join(home, "code-map.csv");
    expect(readFileSync(csv, "utf8").split("\n")[1]).toBe("ACMEUI,30:10,Button,,,,,,,,,,");
    await expect(cli(["code-map", "--init"])).rejects.toThrow("already exists. Add --force to replace it.");
    expect(await cli(["code-map", "--init", "--force", "--out", join(home, "other.csv")])).toContain("other.csv");
  });

  it("--import checks every row, writes code-map.json once, and refuses to overwrite without --force", async () => {
    const dry = await cli(["code-map", "--import", CSV, "--dry-run"]);
    expect(JSON.parse(dry)).toEqual(angularMap);
    expect(existsSync(join(home, "code-map.json"))).toBe(false);
    const wrote = await cli(["code-map", "--import", CSV]);
    expect(wrote).toContain("4 entries (2 empty rows skipped)");
    expect(wrote).toContain("Angular: 4 mapped components have a selector");
    await expect(cli(["code-map", "--import", CSV])).rejects.toThrow("already exists. Add --force");
    const bad = join(home, "bad.csv");
    writeFileSync(bad, "fileKey,id,component,importPath,selector\nACMEUI,30:10,AcmeButtonComponent,@acme/ui-angular,Bad\n");
    expect(await cli(["code-map", "--import", bad, "--force"])).toContain("Nothing written. Fix these rows");
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(readFileSync(join(home, "code-map.json"), "utf8"))).toEqual(angularMap);
    await expect(cli(["code-map", "--import"])).rejects.toThrow("Usage: resolve code-map --import");
  });

  it("MCP get_ingredients cuts a big card (less deep first) and says so; the default surface stays at 7", () => {
    delete process.env["RESOLVE_MCP_ADVANCED"];
    expect(listToolDefinitions(false)).toHaveLength(7);
    process.env["RESOLVE_MCP_ADVANCED"] = "1";
    expect(INGREDIENTS_MCP_MAX_CHARS).toBe(12_000);
    const small = callTool("get_ingredients", { name: "Payee picker", depth: 2 }) as { cut?: unknown };
    expect(small.cut).toBeUndefined();
    const big = ingredientCard(acme(), "Payee picker", { depth: 2, maxChars: 300 });
    if (!big.found) throw new Error("not found");
    expect(big.cut).toMatchObject({ maxChars: 300, askedDepth: 2, depth: 1 });
    expect(big.note).toContain("Cut to stay small: the full card is over 300 characters, so it shows only the parts directly inside (asked for 2). Ask a part by its name or id for its own card.");
    expect(big.parts.length).toBeGreaterThan(0);
    // Without maxChars (the CLI), nothing is cut.
    expect(found(ingredientCard(acme(), "Payee picker", { depth: 2 }))).not.toHaveProperty("cut");
  });

  it("a guessed placed copy with no parts says only that its parts are unknown", () => {
    const graph = buildGraph(
      adaptFigmaMcpMetadata({
        fileKey: "ACMEXML",
        fileName: "Acme XML",
        metadataXml:
          '<canvas id="0:1" name="Page"><symbol id="2:1" name="Card"><instance id="2:2" name="Badge" /></symbol><symbol id="3:1" name="Badge" /><frame id="4:1" name="Home"><instance id="4:2" name="Card" /></frame></canvas>',
      }),
      { builtAt: FROZEN },
    );
    const card = found(ingredientCard(indexGraph(graph), "ACMEXML:4:2"));
    expect(card.note).toContain("parts are unknown");
    expect(card.note).not.toContain("Parts read from this placed copy");
  });
});
