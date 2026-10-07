import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import acmeFile from "../docs/examples/acme-ui.json";
import angularMap from "../docs/examples/acme-code-map-angular.json";
import { adaptFigmaRestFile } from "@/core/ingestion";
import { buildGraph } from "@/core/transform";
import {
  checkCousins,
  componentUsageCard,
  exampleCard,
  handoffSheet,
  indexGraph,
  ingredientCard,
  listRecipes,
  recommendMasters,
  recipeCard,
  screenPartsCard,
  starterRecipes,
  verifyFrame,
  type GraphIndex,
} from "@/core/query";
import { cardTokens, presentToolResult, stripFiller } from "@/server/cards";
import { runCli } from "@/server/cli";
import { TOOLS, listToolDefinitions, toolCardFormat } from "@/server/tools";
import { clearCache, saveGraph } from "@/server/store";

const FROZEN = "2026-01-01T00:00:00.000Z";

function graphOf(file: unknown) {
  return buildGraph(adaptFigmaRestFile({ fileKey: "ACMEUI", file, kind: "mock", ingestedAt: FROZEN }), { builtAt: FROZEN });
}

/** Acme with the retired Old Button copy on Send money (20:43) swapped for Button. */
function fixedAcmeFile(): unknown {
  const file = structuredClone(acmeFile) as { document: unknown };
  const swap = (node: { id?: string; name?: string; componentId?: string; children?: unknown[] }) => {
    if (node.id === "20:43") {
      node.name = "Button";
      node.componentId = "30:13";
    }
    for (const child of (node.children ?? []) as (typeof node)[]) swap(child);
  };
  swap(file.document as Parameters<typeof swap>[0]);
  return file;
}

/**
 * Independent of stripFiller. Today's JSON minus the filler the product decision names.
 * cost block, numeric score, `node:` id beside a Figma id, the graph.json sentence,
 * learn's save-state checkpoint, and a parts list already nested on each component.
 */
function specStrip(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/ ?Do not Read (?:`\.resolve\/graph\.json`|graph\.json)\.?/g, "").replace(/[ \t]{2,}/g, " ").trim();
  }
  if (Array.isArray(value)) return value.map((item) => specStrip(item));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const dropIngredients =
    (Array.isArray(record["screens"]) && Array.isArray(record["ingredients"])) ||
    (Array.isArray(record["components"]) && Array.isArray(record["ingredients"]));
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (key === "cost" && raw && typeof raw === "object" && "chars" in raw && "approxTokens" in raw) continue;
    if (key === "score" && typeof raw === "number") continue;
    if (key === "checkpoint" && raw && typeof raw === "object" && ("completedHashes" in raw || "mastersByUnit" in raw)) continue;
    if (dropIngredients && key === "ingredients") continue;
    if (
      key === "id" &&
      typeof raw === "string" &&
      raw.startsWith("node:") &&
      (typeof record["figmaNodeId"] === "string" || typeof record["nodeId"] === "string")
    ) {
      continue;
    }
    const next = specStrip(raw);
    if (key === "hint" && next === "") continue;
    out[key] = next;
  }
  return out;
}

function tokens(value: unknown): number {
  return cardTokens(typeof value === "string" ? value : JSON.stringify(value));
}

const ID_KEYS = ["fileKey", "figmaNodeId", "componentKey", "ex", "exampleId"] as const;

function collectIds(value: unknown, out: Array<{ key: string; value: string }>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectIds(item, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const key of ID_KEYS) {
    const raw = record[key];
    if (typeof raw === "string" && raw && raw !== "none") out.push({ key, value: raw });
  }
  for (const item of Object.values(record)) collectIds(item, out);
}

describe("Acme markdown cards", () => {
  const previousHome = process.env["RESOLVE_HOME"];
  const home = mkdtempSync(join(tmpdir(), "resolve-acme-cards-"));
  writeFileSync(join(home, "code-map.json"), JSON.stringify(angularMap));
  process.env["RESOLVE_HOME"] = home;
  afterAll(() => {
    if (previousHome === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previousHome;
  });

  const recipes = starterRecipes();
  const original = indexGraph(graphOf(acmeFile));
  const fixed = indexGraph(graphOf(fixedAcmeFile()));

  function cards(index: GraphIndex, handoffIndex: GraphIndex): Array<{ name: string; tool?: string; value: unknown }> {
    return [
      { name: "recommend payee picker", tool: "recommend", value: recommendMasters(index, "payee picker") },
      { name: "recommend primary button", tool: "recommend", value: recommendMasters(index, "primary button") },
      { name: "recommend old button", tool: "recommend", value: recommendMasters(index, "old button") },
      { name: "resolve Payee picker", tool: "resolve", value: componentUsageCard(index, "Payee picker") },
      { name: "resolve Button", tool: "resolve", value: componentUsageCard(index, "Button") },
      { name: "resolve Old Button", tool: "resolve", value: componentUsageCard(index, "Old Button") },
      { name: "example Payee picker", tool: "get_example", value: exampleCard(index, "Payee picker") },
      { name: "verify Send money", tool: "verify_frame", value: verifyFrame(original, { frame: "Send money" }) },
      { name: "verify Confirm payment", tool: "verify_frame", value: verifyFrame(index, { frame: "Confirm payment" }) },
      { name: "recipe confirm-dialog", tool: "recipe", value: recipeCard(recipes, "confirm-dialog", index) },
      { name: "recipe list", tool: "list_recipes", value: listRecipes(recipes, index) },
      { name: "cousins Send money", tool: "check_cousins", value: checkCousins(index, { frame: "Send money" }) },
      { name: "ingredients Payee picker", tool: "get_ingredients", value: ingredientCard(index, "Payee picker") },
      { name: "handoff Send money", tool: "get_handoff", value: handoffSheet(handoffIndex, ["Send money"], { recipes }) },
    ];
  }

  const set = cards(fixed, fixed);

  it("cuts tokens on the Acme set and locks the count", () => {
    let before = 0;
    let after = 0;
    let filler = 0;
    for (const card of set) {
      before += tokens(card.value);
      filler += tokens(specStrip(card.value));
      after += tokens(presentToolResult(card.value, "markdown", card.tool));
    }
    // Locked on the Acme set below (14 cards, file key ACMEUI, Angular code map).
    // Tokens are ceil(chars/4), the same count as cost.approxTokens, summed per card.
    // Before is today's JSON.stringify. Filler is that JSON with cost, score, duplicate
    // node: ids, the graph.json hint, and the repeated parts list removed. After is Markdown.
    expect({ before, filler, after, cards: set.length }).toEqual({ before: 4434, filler: 3876, after: 3269, cards: 14 });
    const removed = before - after;
    const fromFiller = before - filler;
    expect(fromFiller).toBeGreaterThan(removed * 0.35);
    expect(fromFiller).toBeLessThan(removed * 0.65);
  });

  it("keeps every required id on each Markdown card", () => {
    for (const card of set) {
      const markdown = presentToolResult(card.value, "markdown", card.tool);
      const ids: Array<{ key: string; value: string }> = [];
      collectIds(specStrip(card.value), ids);
      for (const id of ids) {
        expect(markdown, `${card.name} ${id.key}`).toContain(id.value);
      }
      expect(markdown, card.name).not.toMatch(/Do not Read/);
      expect(markdown, card.name).not.toContain("approxTokens");
      expect(markdown, card.name).not.toMatch(/"node:/);
    }
  });

  it("format json equals today's JSON minus the filler", () => {
    for (const card of set) {
      const json = presentToolResult(card.value, "json", card.tool);
      expect(json, card.name).toBe(JSON.stringify(specStrip(card.value)));
      expect(json, card.name).toBe(JSON.stringify(stripFiller(card.value)));
      expect(json, card.name).not.toContain("\n");
      const parsed = JSON.parse(json) as Record<string, unknown>;
      expect(parsed, card.name).not.toHaveProperty("cost");
    }
    const handoff = JSON.parse(presentToolResult(set.find((card) => card.tool === "get_handoff")!.value, "json", "get_handoff")) as {
      ingredients?: unknown;
      screens: Array<{ ingredients?: unknown; components: Array<{ parts?: unknown }> }>;
    };
    expect(handoff).not.toHaveProperty("ingredients");
    expect(handoff.screens[0]).not.toHaveProperty("ingredients");
    expect(Array.isArray(handoff.screens[0]?.components[0]?.parts)).toBe(true);
  });

  it("verify cards lead with PASS or FAIL and keep textChecked", () => {
    const send = presentToolResult(verifyFrame(original, { frame: "Send money" }), "markdown", "verify_frame");
    const confirm = presentToolResult(verifyFrame(fixed, { frame: "Confirm payment" }), "markdown", "verify_frame");
    expect(send.startsWith("FAIL")).toBe(true);
    expect(confirm.startsWith("PASS")).toBe(true);
    expect(send).toMatch(/textChecked: /);
    expect(confirm).toMatch(/textChecked: /);
  });

  it("echoes designer context with its source label", () => {
    const card = recommendMasters(fixed, "primary button", {
      budgetChars: 2000,
      context: {
        audience: "returning customer",
        constraints: { a11y: "wcag-aa" },
        sources: { audience: "document", a11y: "pack acme-pay" },
      },
    });
    const markdown = presentToolResult(card, "markdown", "recommend");
    expect(markdown).toContain("audience: returning customer (document)");
    expect(markdown).toContain("a11y: wcag-aa (pack acme-pay)");
    const json = JSON.parse(presentToolResult(card, "json", "recommend")) as { context?: Record<string, string> };
    expect(json.context?.["audienceFrom"]).toBe("document");
    expect(json.context?.["a11yFrom"]).toBe("pack acme-pay");
  });

  it("names a retired pick and the replacement, and a slot's next recommend", () => {
    const old = presentToolResult(recommendMasters(fixed, "old button"), "markdown", "recommend");
    expect(old.toLowerCase()).toMatch(/retired|deprecated/);
    expect(old).toContain("Button");
    const recipe = presentToolResult(recipeCard(recipes, "confirm-dialog", fixed), "markdown", "recipe");
    expect(recipe).toMatch(/nextRecommend: /);
  });

  it("renders code-map statuses with the designer sentence and exit code", () => {
    const rows = [
      { status: "ok", message: "Mapped.", exitCode: 0, query: "Button" },
      { status: "retired", message: "Don't use. Use Button.", exitCode: 2, query: "Old Button", use: "Button" },
      { status: "not-in-handoff", message: "Real component, but not on this screen. Ask the designer.", exitCode: 3, query: "Avatar" },
      { status: "unmapped", message: "On the screen, no code yet. Build it or ask.", exitCode: 4, query: "Chip" },
      { status: "not-found", message: "Not in the design system or on this screen. Don't invent it.", exitCode: 5, query: "Made up" },
      { status: "other-library", message: "On the screen, from another library, no code twin.", exitCode: 6, query: "Brand mark" },
    ];
    for (const row of rows) {
      const markdown = presentToolResult(row, "markdown");
      expect(markdown.startsWith(`${row.status} (exit ${row.exitCode})`)).toBe(true);
      expect(markdown).toContain(row.message);
      if ("use" in row && row.use) expect(markdown).toContain(`use: ${row.use}`);
    }
  });

  it("labels an other-library part unknown, not unmapped, on the parts card", () => {
    const parts = screenPartsCard(fixed, "Payment methods");
    expect(parts.ok).toBe(true);
    if (!parts.ok) return;
    const brand = parts.parts.find((part) => part.name === "Brand mark");
    expect(brand).toMatchObject({ code: "unknown", status: "other-library" });
    const markdown = presentToolResult(parts, "markdown");
    expect(markdown).toContain("other-library");
    expect(markdown).toContain("code: unknown");
    expect(markdown).not.toMatch(/Brand mark[\s\S]{0,80}unmapped/);
  });

  it("keeps a .resolve path when the graph hint shares the string", () => {
    const text = "Add the shared DS to .resolve/workspace.json. Do not Read graph.json.";
    expect(stripFiller(text)).toBe("Add the shared DS to .resolve/workspace.json.");
    expect(presentToolResult({ hint: text }, "markdown")).toContain(".resolve/workspace.json");
  });

  it("drops learn save-state and the repeated graph hint in both formats", () => {
    const learned = {
      ok: true,
      report: { told: "Learned 4 components, 1 retired. Saved." },
      checkpoint: { completedHashes: ["abc"], mastersByUnit: { "10:1": ["node:30:10"] } },
      hint: "Place fileKey+nodeId. Do not Read graph.json.",
    };
    const json = presentToolResult(learned, "json", "learn_library");
    expect(json).toBe(JSON.stringify({ ok: true, report: { told: "Learned 4 components, 1 retired. Saved." }, hint: "Place fileKey+nodeId." }));
    const markdown = presentToolResult(learned, "markdown", "learn_library");
    expect(markdown).toContain("told: Learned 4 components, 1 retired. Saved.");
    expect(markdown).not.toContain("completedHashes");
    expect(markdown).not.toContain("graph.json");
  });

  it("advertises format on every tool and adds no tool", () => {
    expect(TOOLS).toHaveLength(27);
    expect(listToolDefinitions(false)).toHaveLength(7);
    expect(listToolDefinitions(true)).toHaveLength(27);
    for (const tool of listToolDefinitions(true)) {
      const properties = (tool.inputSchema["properties"] ?? {}) as Record<string, { enum?: string[] }>;
      expect(properties["format"]?.enum, tool.name).toEqual(["markdown", "json"]);
    }
    expect(TOOLS.some((tool) => "format" in ((tool.inputSchema["properties"] ?? {}) as object))).toBe(false);
    expect(toolCardFormat(undefined)).toBe("markdown");
    expect(toolCardFormat("json")).toBe("json");
    expect(() => toolCardFormat("yaml")).toThrow(/markdown/);
  });
});

describe("CLI compact JSON", () => {
  let previousHome: string | undefined;
  let home: string;

  beforeEach(() => {
    previousHome = process.env["RESOLVE_HOME"];
    home = mkdtempSync(join(tmpdir(), "resolve-cards-cli-"));
    process.env["RESOLVE_HOME"] = home;
    clearCache();
    saveGraph(graphOf(acmeFile));
  });

  afterEach(() => {
    clearCache();
    process.exitCode = undefined;
    if (previousHome === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previousHome;
  });

  async function capture(argv: string[]): Promise<{ text: string; code: number | undefined }> {
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    const before = process.exitCode;
    process.exitCode = undefined;
    try {
      await runCli(argv);
    } finally {
      process.stdout.write = write;
    }
    const code = process.exitCode;
    process.exitCode = before;
    return { text: chunks.join(""), code };
  }

  it("prints one compact line, and --pretty indents, with the same exit", async () => {
    const compact = await capture(["recommend", "payee picker"]);
    const pretty = await capture(["recommend", "payee picker", "--pretty"]);
    expect(compact.code).toBe(pretty.code);
    expect(compact.text.endsWith("\n")).toBe(true);
    expect(compact.text.trim()).not.toContain("\n");
    expect(pretty.text).toContain("\n  ");
    expect(JSON.parse(compact.text)).toEqual(JSON.parse(pretty.text));
    expect(compact.text.length).toBeLessThan(pretty.text.length);
  });
});
