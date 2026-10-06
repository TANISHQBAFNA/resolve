import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import acmeFile from "../docs/examples/acme-ui.json";
import type { DesignGraph, GraphNode } from "@/core/model";
import { adaptFigmaRestFile } from "@/core/ingestion";
import { adaptFigmaMcpMetadata } from "@/core/ingestion/adapters/figmaMcp";
import { buildGraph } from "@/core/transform";
import {
  directPartInstances,
  formatIngredientCard,
  formatIngredientCoverage,
  indexGraph,
  ingredientCard,
  ingredientCoverage,
  PART_GUESS,
} from "@/core/query";
import { runCli } from "@/server/cli";
import { callTool, listToolDefinitions, TOOLS } from "@/server/tools";
import { clearCache, saveGraph } from "@/server/store";

const FROZEN = "2026-01-01T00:00:00.000Z";
const rest = (fileKey: string, file: unknown) =>
  buildGraph(adaptFigmaRestFile({ fileKey, file, kind: "mock", ingestedAt: FROZEN }), { builtAt: FROZEN });

const acmeGraph = () => rest("ACMEUI", acmeFile);
const acme = () => indexGraph(acmeGraph());

/** The README's code map: Button set, Payee picker by name, retired Old Button. */
function readmeCodeMap(): string {
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
const names = (card: Card) => found(card).parts.map((p) => p.name);

/* A small made-up library that covers every part status. */
const inst = (id: string, name: string, componentId: string, extra: object = {}) => ({ id, name, type: "INSTANCE", componentId, ...extra });
const comp = (id: string, name: string, children: unknown[] = [], extra: object = {}) => ({ id, name, type: "COMPONENT", children, ...extra });
const kitFile = {
  name: "Acme Kit",
  document: {
    id: "0:0",
    name: "Document",
    type: "DOCUMENT",
    children: [
      {
        id: "1:0",
        name: "Parts",
        type: "CANVAS",
        children: [
          comp("1:1", "Label", [{ id: "1:11", name: "Text", type: "TEXT", characters: "Label" }]),
          comp("1:2", "Icon"),
          comp("1:3", "Chip"),
          comp("1:4", "Old Chip", [], { description: "status: deprecated\nreplacedBy: Chip" }),
          comp("1:5", "_Base"),
          {
            id: "2:0",
            name: "Field",
            type: "COMPONENT_SET",
            children: [
              comp("2:1", "Kind=Plain", [inst("2:11", "Label", "1:1")]),
              comp("2:2", "Kind=Icon", [
                { id: "2:20", name: "Row", type: "FRAME", children: [inst("2:21", "Label", "1:1"), inst("2:22", "Icon", "1:2")] },
              ]),
            ],
          },
          comp("3:1", "List row", [inst("3:11", "Field", "2:2"), inst("3:12", "Field", "2:2"), inst("3:13", "_Base", "1:5")]),
          comp("4:1", "Toolbar", [
            inst("4:11", "Old Chip", "1:4"),
            inst("4:12", "Chip", "1:3", { visible: false }),
            inst("4:13", "Brand mark", "9:9"),
            inst("4:14", "Ghost", "8:8"),
          ]),
        ],
      },
      {
        id: "5:0",
        name: "Screens",
        type: "CANVAS",
        children: [
          {
            id: "5:1",
            name: "Profile",
            type: "FRAME",
            children: [inst("5:11", "List row", "3:1", { children: [inst("5:12", "Chip", "1:3")] })],
          },
        ],
      },
    ],
  },
  components: {
    "1:1": { key: "label-key", name: "Label", description: "" },
    "1:2": { key: "icon-key", name: "Icon", description: "" },
    "1:3": { key: "chip-key", name: "Chip", description: "" },
    "1:4": { key: "old-chip-key", name: "Old Chip", description: "status: deprecated\nreplacedBy: Chip" },
    "1:5": { key: "base-key", name: "_Base", description: "" },
    "2:1": { key: "field-plain-key", name: "Kind=Plain", description: "", componentSetId: "2:0" },
    "2:2": { key: "field-icon-key", name: "Kind=Icon", description: "", componentSetId: "2:0" },
    "3:1": { key: "row-key", name: "List row", description: "" },
    "4:1": { key: "toolbar-key", name: "Toolbar", description: "" },
    "9:9": { key: "brand-key", name: "Brand mark", description: "", remote: true },
  },
  componentSets: { "2:0": { key: "field-set-key", name: "Field", description: "" } },
  styles: {},
};
const kit = () => indexGraph(rest("KIT", kitFile));

describe("ingredient card", () => {
  const previousHome = process.env["RESOLVE_HOME"];
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "resolve-ingredients-"));
    process.env["RESOLVE_HOME"] = home;
    clearCache();
  });
  afterEach(() => {
    clearCache();
    if (previousHome === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previousHome;
  });

  it("Payee picker lists its parts from NESTS links, each with code or null", () => {
    const card = found(ingredientCard(acme(), "Payee picker"));
    expect(card.component).toMatchObject({ name: "Payee picker", figmaNodeId: "30:30", fileKey: "ACMEUI", status: "current" });
    expect(names(card)).toEqual(["Avatar", "Button / Variant=Primary, Size=Medium"]);
    expect(card.parts.every((p) => p.code === null && p.status === "current")).toBe(true);
    expect(card.codeMap).toBe(false);
    expect(card.code).toBeNull();
    expect(card.summary).toEqual({ parts: 2, linkedToCode: 0, missingCode: 2, retired: 0, nameGuessed: 0, otherLibrary: 0, notFound: 0 });
    expect(card.note).toContain("No code map yet");
  });

  it("with a code map: mapped parts show code (a variant uses its set's), an unmapped part stays null", () => {
    writeFileSync(join(home, "code-map.json"), readmeCodeMap());
    const card = found(ingredientCard(acme(), "Payee picker"));
    expect(card.code).toBe("PayeePicker from '@acme/payments'");
    expect(card.parts.find((p) => p.name === "Avatar")?.code).toBeNull();
    expect(card.parts.find((p) => p.name.startsWith("Button"))?.code).toBe("Button from '@acme/ui'");
    expect(card.summary).toMatchObject({ parts: 2, linkedToCode: 1, missingCode: 1 });
    expect(formatIngredientCard(card)).toContain("Avatar [30:40] (code: no code link yet)");
  });

  it("finds by exact name in any letter case, graph id, figma id, or fileKey:nodeId; never by a fuzzy word", () => {
    const index = acme();
    for (const ask of ["payee PICKER", "node:30:30", "30:30", "30-30", "ACMEUI:30:30"]) {
      expect(found(ingredientCard(index, ask)).component.figmaNodeId).toBe("30:30");
    }
    for (const ask of ["payee", "payee picker please", "", "   "]) {
      const card = ingredientCard(index, ask);
      expect(card.found).toBe(false);
    }
    const screen = ingredientCard(index, "Send money");
    expect(screen.found).toBe(false);
    expect(!screen.found && screen.hint).toContain("is a screen");
  });

  it("a set follows its first variant unless one is asked for, and says when variants differ", () => {
    const index = kit();
    const plain = found(ingredientCard(index, "Field"));
    expect(plain.variant).toMatchObject({ name: "Field / Kind=Plain", how: "default, first in the set" });
    expect(names(plain)).toEqual(["Label"]);
    expect(plain.otherVariants).toEqual({ total: 1, sameParts: 0, differentParts: 1, examples: ["Kind=Icon"] });
    expect(plain.note).toContain("1 other variant uses a different set of parts");

    const icon = found(ingredientCard(index, "Field", { variant: "kind=icon" }));
    expect(icon.variant).toMatchObject({ name: "Field / Kind=Icon", how: "asked" });
    expect(names(icon)).toEqual(["Label", "Icon"]);
    expect(found(ingredientCard(index, "Field / Kind=Icon")).variant?.how).toBe("asked");

    const none = ingredientCard(index, "Field", { variant: "Kind=Huge" });
    expect(none.found).toBe(false);
    expect(!none.found && "variants" in none && none.variants).toEqual(["Kind=Plain", "Kind=Icon"]);
    const many = ingredientCard(acme(), "Button", { variant: "Variant=Primary" });
    expect(!many.found && many.hint).toContain("matches 2 variants");
    expect(ingredientCard(index, "Chip", { variant: "Kind=Icon" }).found).toBe(false);
  });

  it("lists only parts directly inside; deeper parts show as a count or with depth", () => {
    const index = kit();
    const row = found(ingredientCard(index, "List row"));
    expect(row.parts.map((p) => [p.name, p.count])).toEqual([
      ["Field / Kind=Icon", 2],
      ["_Base", 1],
    ]);
    expect(row.parts[0]).toMatchObject({ inside: 2 });
    expect(row.parts[0]?.parts).toBeUndefined();
    expect(row.parts[1]).toMatchObject({ internal: true });
    const deep = found(ingredientCard(index, "List row", { depth: 2 }));
    expect(deep.parts[0]?.parts?.map((p) => p.name)).toEqual(["Label", "Icon"]);
    expect(deep.parts[0]?.inside).toBeUndefined();
    const row3 = directPartInstances(index, "node:3:1").map((n) => n.figmaNodeId);
    expect(row3).toEqual(["3:11", "3:12", "3:13"]);
  });

  it("labels retired, hidden, other-library and missing parts; never invents a code line", () => {
    writeFileSync(
      join(home, "code-map.json"),
      JSON.stringify({
        entries: [
          { fileKey: "KIT", id: "1:3", code: { import: "import { Chip } from '@acme/ui'", component: "Chip" } },
          { fileKey: "KIT", id: "1:4", status: "retired", code: { import: "import { OldChip } from '@acme/old'", component: "OldChip" } },
        ],
      }),
    );
    const card = found(ingredientCard(kit(), "Toolbar"));
    const by = Object.fromEntries(card.parts.map((p) => [p.name, p]));
    expect(by["Old Chip"]).toMatchObject({ status: "retired", code: null, use: "Chip" });
    expect(by["Chip"]).toMatchObject({ status: "current", code: "Chip from '@acme/ui'", hidden: true });
    expect(by["Brand mark"]).toMatchObject({ status: "other-library", code: null });
    expect(by["Ghost"]).toMatchObject({ status: "not-found", code: null });
    expect(card.summary).toEqual({ parts: 4, linkedToCode: 1, missingCode: 0, retired: 1, nameGuessed: 0, otherLibrary: 1, notFound: 1 });
    const text = formatIngredientCard(card);
    expect(text).toContain("retired, use Chip");
    expect(text).toContain("hidden by default");
    expect(text).not.toContain("OldChip");
  });

  it("a retired composite says so and names its replacement", () => {
    const card = found(ingredientCard(acme(), "Old Button"));
    expect(card.component).toMatchObject({ status: "retired", use: "Button" });
    expect(card.note).toContain("Old Button is retired. Use Button instead.");
  });

  it("a placed copy uses its own parts, so a swap on the screen shows", () => {
    const index = kit();
    const card = found(ingredientCard(index, "KIT:5:11"));
    expect(card.instance).toMatchObject({ name: "List row", figmaNodeId: "5:11" });
    expect(card.variant).toBeUndefined();
    expect(names(card)).toEqual(["Chip"]);
    expect(card.note).toContain("swaps made on the screen");
    // A placed copy with no children read falls back to the component's own parts.
    const placed = found(ingredientCard(acme(), "20:41"));
    expect(names(placed)).toEqual(["Avatar", "Button / Variant=Primary, Size=Medium"]);
  });

  it("a part known only from a layer name is labelled a guess with no code", () => {
    const graph = buildGraph(
      adaptFigmaMcpMetadata({
        fileKey: "MCP",
        fileName: "Acme MCP",
        metadataXml: '<canvas id="0:1" name="Page"><symbol id="2:1" name="Card"><instance id="2:2" name="Badge" /></symbol></canvas>',
      }),
      { builtAt: FROZEN },
    );
    const card = found(ingredientCard(indexGraph(graph), "Card"));
    expect(card.parts).toHaveLength(1);
    expect(card.parts[0]).toMatchObject({ name: "Badge", status: "unconfirmed", identity: PART_GUESS, code: null });
    expect(card.parts[0]?.figmaNodeId).toBeUndefined();
    expect(card.summary.nameGuessed).toBe(1);
    expect(formatIngredientCard(card)).toContain(PART_GUESS);
  });

  it("a stub from another file follows the learned library part by exact component key", () => {
    const base = acmeGraph();
    const stub: GraphNode = { id: "node:PROD:7:1", figmaNodeId: "7:1", fileKey: "PROD", type: "MAIN_COMPONENT", name: "Payee picker", isRemote: true, isMainComponent: true, metadata: { key: "payee-picker-key", remote: true } };
    const placed: GraphNode = { id: "node:PROD:7:2", figmaNodeId: "7:2", fileKey: "PROD", type: "COMPONENT_INSTANCE", name: "Payee picker", isInstance: true, mainComponentId: stub.id };
    const graph: DesignGraph = {
      ...base,
      nodes: [...base.nodes.map((n) => ({ ...n, fileKey: n.fileKey ?? "ACMEUI" })), stub, placed],
      edges: [...base.edges, { id: "e-prod", source: placed.id, target: stub.id, type: "INSTANCE_OF" }],
    };
    const card = found(ingredientCard(indexGraph(graph), "PROD:7:2"));
    expect(card.component).toMatchObject({ figmaNodeId: "30:30", fileKey: "ACMEUI", status: "current" });
    expect(names(card)).toEqual(["Avatar", "Button / Variant=Primary, Size=Medium"]);
    // A key that matches nothing stays a stub: no parts, said plainly.
    const lone: DesignGraph = { ...graph, nodes: graph.nodes.map((n) => (n.id === stub.id ? { ...n, metadata: { key: "nope", remote: true } } : n)) };
    const other = found(ingredientCard(indexGraph(lone), "PROD:7:2"));
    expect(other.component.status).toBe("other-library");
    expect(other.parts).toEqual([]);
  });

  it("two components with one name are listed, not guessed", () => {
    const base = acmeGraph();
    const twin: GraphNode = { id: "node:B:1:1", figmaNodeId: "1:1", fileKey: "B", type: "MAIN_COMPONENT", name: "Avatar", isMainComponent: true };
    const card = ingredientCard(indexGraph({ ...base, nodes: [...base.nodes.map((n) => ({ ...n, fileKey: n.fileKey ?? "ACMEUI" })), twin] }), "Avatar");
    expect(card.found).toBe(false);
    expect(!card.found && "ambiguous" in card && card.ambiguous?.map((a) => a.fileKey)).toEqual(["ACMEUI", "B"]);
  });

  it("library-wide counts", () => {
    const acmeCounts = ingredientCoverage(acme());
    expect(acmeCounts).toMatchObject({ components: 6, composites: 2, compositesFullyIdentified: 2, ingredients: 4, linkedToCode: 0, missingCode: 4, distinctParts: 3 });
    writeFileSync(join(home, "code-map.json"), readmeCodeMap());
    expect(ingredientCoverage(acme())).toMatchObject({ codeMap: true, linkedToCode: 2, missingCode: 2, distinctPartsLinkedToCode: 2 });
    const kitCounts = ingredientCoverage(kit());
    expect(kitCounts).toMatchObject({ composites: 3, compositesFullyIdentified: 2, retired: 1, otherLibrary: 1, notFound: 1, internal: 1 });
    expect(formatIngredientCoverage(kitCounts)).toContain("3 of 7 components are built from other parts");
  });

  it("adds nothing to other cards: no ranking file is touched", () => {
    const before = JSON.stringify(acme().graph);
    ingredientCard(acme(), "Payee picker");
    expect(JSON.stringify(acme().graph)).toBe(before);
  });
});

describe("ingredients command and MCP tool", () => {
  const previousHome = process.env["RESOLVE_HOME"];
  const previousAdvanced = process.env["RESOLVE_MCP_ADVANCED"];
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "resolve-ingredients-cli-"));
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

  it("prints a plain card, JSON, and library counts", async () => {
    writeFileSync(join(home, "code-map.json"), readmeCodeMap());
    const text = await cli(["ingredients", "Payee picker"]);
    expect(text).toContain("Payee picker [30:30]");
    expect(text).toContain("Code: PayeePicker from '@acme/payments'");
    expect(text).toContain("- Button / Variant=Primary, Size=Medium [30:11] (code: Button from '@acme/ui')");
    expect(text).toContain("1 linked to code, 1 with no code link yet.");
    const json = JSON.parse(await cli(["ingredients", "--json", "Payee picker"]));
    expect(json.found).toBe(true);
    expect(json.parts).toHaveLength(2);
    expect(await cli(["ingredients", "Button", "--variant", "Variant=Danger"])).toContain("Variant: Button / Variant=Danger, Size=Medium (asked)");
    expect(await cli(["ingredients", "--all"])).toContain("2 of 6 components are built from other parts");
    expect(JSON.parse(await cli(["ingredients", "--all", "--json"]))).toMatchObject({ composites: 2, linkedToCode: 2 });
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("a miss exits 1 with one plain line; bad options are refused", async () => {
    expect(await cli(["ingredients", "Payee"])).toContain('Nothing named "Payee"');
    expect(process.exitCode).toBe(1);
    await expect(cli(["ingredients"])).rejects.toThrow("Usage: resolve ingredients");
    await expect(cli(["ingredients", "Payee picker", "--depth", "5"])).rejects.toThrow("--depth must be 1, 2 or 3.");
    await expect(cli(["ingredients", "Payee picker", "--deep"])).rejects.toThrow('Unknown ingredients option "--deep"');
    await expect(cli(["ingredients", "Payee picker", "--all"])).rejects.toThrow("either --all or a component name");
    await expect(cli(["ingredients", "Button", "--variant"])).rejects.toThrow("--variant needs a value");
  });

  it("get_ingredients is advanced only; the default MCP surface stays at 7 tools", () => {
    delete process.env["RESOLVE_MCP_ADVANCED"];
    expect(listToolDefinitions(false)).toHaveLength(7);
    expect(listToolDefinitions(false).map((t) => t.name)).not.toContain("get_ingredients");
    expect(() => callTool("get_ingredients", { name: "Payee picker" })).toThrow("not on the default MCP surface");
    process.env["RESOLVE_MCP_ADVANCED"] = "1";
    expect(TOOLS.map((t) => t.name)).toContain("get_ingredients");
    const card = callTool("get_ingredients", { name: "Payee picker", depth: 9 }) as { found: boolean; parts: unknown[] };
    expect(card.found).toBe(true);
    expect(card.parts).toHaveLength(2);
    expect(() => callTool("get_ingredients", {})).toThrow("`name` is required.");
  });
});
