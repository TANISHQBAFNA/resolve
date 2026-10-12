import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { adaptFigmaMcpMetadata, adaptFigmaRestFile } from "@/core/ingestion";
import { DesignGraphSchema, GRAPH_SCHEMA_VERSION } from "@/core/model";
import { cleanPropertyName } from "@/core/model/componentProperties";
import {
  componentUsageCard,
  handoffSheet,
  indexGraph,
  ingredientCard,
  recommendMasters,
  verifyFrame,
} from "@/core/query";
import {
  formatPropertyLines,
  propertyBlock,
} from "@/core/query/componentProperties";
import { presentToolResult } from "@/server/cards";
import { DEFAULT_TOOL_NAMES } from "@/server/tools";
import { buildGraph } from "@/core/transform";
import { clearCache } from "@/server/store";

const acmeDefs = {
  "Variant#1:1": { type: "VARIANT", defaultValue: "Primary", variantOptions: ["Primary", "Secondary", "Tertiary"] },
  "Size#1:2": { type: "VARIANT", defaultValue: "Medium", variantOptions: ["Small", "Medium", "Large"] },
  "State#1:3": { type: "VARIANT", defaultValue: "Enabled", variantOptions: ["Enabled", "Disabled"] },
  "Has icon#1:4": { type: "BOOLEAN", defaultValue: false },
  "Icon#12:3": {
    type: "INSTANCE_SWAP",
    defaultValue: "40:1",
    preferredValues: [
      { type: "COMPONENT", key: "icon-check" },
      { type: "COMPONENT", key: "icon-close" },
      { type: "COMPONENT", key: "missing-icon" },
    ],
  },
  "Label#1:0": { type: "TEXT", defaultValue: "Button", description: "The visible label." },
  "Property 1#9:9": { type: "TEXT", defaultValue: "Hello" },
};

function acmeFile(instanceProps?: Record<string, unknown>, labelText = "Get started") {
  return {
    name: "Acme UI",
    document: {
      id: "0:0",
      type: "DOCUMENT",
      children: [
        {
          id: "1:1",
          type: "CANVAS",
          name: "Components",
          children: [
            {
              id: "30:10",
              type: "COMPONENT_SET",
              name: "Button",
              componentPropertyDefinitions: acmeDefs,
              children: [
                {
                  id: "30:11",
                  type: "COMPONENT",
                  name: "Variant=Primary, Size=Medium, State=Enabled",
                },
              ],
            },
            { id: "40:1", type: "COMPONENT", name: "Check" },
            { id: "40:2", type: "COMPONENT", name: "Close" },
            {
              id: "2:1",
              type: "FRAME",
              name: "Checkout",
              children: [
                {
                  id: "2:2",
                  type: "INSTANCE",
                  name: "Button",
                  componentId: "30:11",
                  componentProperties: instanceProps,
                  children: [
                    { id: "2:3", type: "TEXT", name: "Label", characters: labelText },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    components: {
      "30:11": { key: "btn-primary", name: "Variant=Primary, Size=Medium, State=Enabled", componentSetId: "30:10" },
      "40:1": { key: "icon-check", name: "Check" },
      "40:2": { key: "icon-close", name: "Close" },
    },
    componentSets: {
      "30:10": { key: "button-set", name: "Button" },
    },
  };
}

function acmeIndex(instanceProps?: Record<string, unknown>, labelText?: string) {
  const doc = adaptFigmaRestFile({
    fileKey: "ACMEUI",
    file: acmeFile(instanceProps, labelText),
    kind: "mock",
    ingestedAt: "2026-01-01T00:00:00.000Z",
  });
  return indexGraph(buildGraph(doc, { builtAt: "2026-01-01T00:00:00.000Z" }));
}

describe("component properties", () => {
  const previousHome = process.env["RESOLVE_HOME"];
  afterEach(() => {
    if (previousHome === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previousHome;
    clearCache();
  });

  it("cleans Figma ids and flags placeholder names", () => {
    expect(cleanPropertyName("Label#1:0")).toEqual({ name: "Label" });
    expect(cleanPropertyName("Icon#12:3")).toEqual({ name: "Icon" });
    expect(cleanPropertyName("Property 1")).toEqual({
      name: "Property 1",
      rename: 'Rename "Property 1" in Figma. It is a placeholder.',
    });
  });

  it("ingests every property type and does not invent swap names", () => {
    const index = acmeIndex();
    expect(index.graph.schemaVersion).toBe(GRAPH_SCHEMA_VERSION);
    const button = index.graph.nodes.find((node) => node.name === "Button" && node.type === "COMPONENT_SET");
    const defs = button?.propertyDefinitions ?? [];
    expect(defs.map((row) => row.type)).toEqual([
      "VARIANT",
      "VARIANT",
      "VARIANT",
      "BOOLEAN",
      "INSTANCE_SWAP",
      "TEXT",
      "TEXT",
    ]);
    const icon = defs.find((row) => row.name === "Icon");
    expect(icon?.options).toEqual(["Check", "Close"]);
    expect(icon?.defaultValue).toBe("Check");
    expect(icon?.unresolvedPreferred).toBe(1);
    expect(icon?.keys).toContain("missing-icon");
    const shown = formatPropertyLines(
      propertyBlock(index, button!, "outline button with icon")?.properties ?? [],
    ).join("\n");
    expect(shown).not.toContain("missing-icon");
    expect(shown).not.toContain("40:1");
    const label = defs.find((row) => row.name === "Label");
    expect(label?.description).toBe("The visible label.");
    expect(defs.find((row) => row.name === "Property 1")?.rename).toMatch(/placeholder/);
    const variant = index.graph.nodes.find((node) => node.type === "VARIANT");
    expect(variant?.propertyDefinitions).toBeUndefined();
  });

  it("keeps an older graph readable and does not call it the new version", () => {
    const parsed = DesignGraphSchema.parse({
      fileKey: "OLD",
      fileName: "Old",
      builtAt: "2020-01-01T00:00:00.000Z",
      source: { kind: "json", ingestedAt: "2020-01-01T00:00:00.000Z" },
      nodes: [],
      edges: [],
      warnings: [],
    });
    expect(parsed.schemaVersion).toBeUndefined();
    expect(DesignGraphSchema.parse({ ...parsed, schemaVersion: 2 }).schemaVersion).toBe(2);
  });

  it("marks MCP variant defaults unknown and does not invent other property types", () => {
    const graph = buildGraph(
      adaptFigmaMcpMetadata({
        fileKey: "ACMEUI",
        fileName: "Acme",
        metadataXml: `<component_set id="4:0" name="Button">
          <component id="4:1" name="Variant=Primary, Size=Small" />
          <component id="4:2" name="Variant=Secondary, Size=Medium" />
        </component_set>`,
      }),
      { builtAt: "2026-01-01T00:00:00.000Z" },
    );
    const button = graph.nodes.find((node) => node.type === "COMPONENT_SET");
    expect(button?.propertyDefinitions?.map((row) => row.name)).toEqual(["Variant", "Size"]);
    expect(button?.propertyDefinitions?.every((row) => row.type === "VARIANT" && row.defaultUnknown)).toBe(true);
    expect(button?.propertyDefinitions?.some((row) => row.type === "BOOLEAN" || row.type === "TEXT" || row.type === "INSTANCE_SWAP")).toBe(false);
  });

  it("prints a Properties section on recommend, resolve, ingredients, and handoff", () => {
    const index = acmeIndex({ "Label#1:0": { type: "TEXT", value: "Pay now" } }, "Pay now");
    const recommend = recommendMasters(index, "outline button with icon");
    const resolve = componentUsageCard(index, "Button");
    const parts = ingredientCard(index, "Button");
    const handoff = handoffSheet(index, ["Checkout"]);
    for (const card of [recommend, resolve, parts]) {
      expect(JSON.stringify(card)).toContain('"properties"');
    }
    const sheet = handoff.ok ? handoff.screens[0] : undefined;
    expect(sheet?.components.some((row) => row.properties?.some((prop) => prop.property === "Label"))).toBe(true);
    const markdown = [
      presentToolResult(recommend, "markdown", "recommend"),
      presentToolResult(resolve, "markdown", "resolve"),
      presentToolResult(parts, "markdown", "get_ingredients"),
      presentToolResult(handoff, "markdown", "get_handoff"),
    ].join("\n");
    expect(markdown).toContain("Properties:");
    expect(markdown).toContain("To apply: set Variant=Secondary, Has icon=true");
    expect(markdown).not.toContain("Neon");
    const lead = recommend.candidates[0];
    expect(lead && "properties" in lead && lead.properties?.find((row) => row.property === "Variant")?.angular).toBe("unmapped");
  });

  it("maps Angular inputs and never suggests a value that is not allowed", () => {
    const index = acmeIndex();
    const button = index.graph.nodes.find((node) => node.name === "Button" && node.type === "COMPONENT_SET")!;
    const block = propertyBlock(
      index,
      button,
      "outline button with icon neon",
      { selector: "acme-button", importPath: "@acme/ui-angular", inputs: ["variant", "size", "disabled"] },
      [{ says: "neon", value: "Neon" }, { says: "outline", value: "Tertiary" }],
    );
    expect(block?.apply).toBe("To apply: set Variant=Tertiary, Has icon=true");
    const byName = Object.fromEntries((block?.properties ?? []).map((row) => [row.property, row]));
    expect(byName["Variant"]?.angular).toBe("variant");
    expect(byName["Size"]?.angular).toBe("size");
    expect(byName["State"]?.angular).toBe("disabled");
    expect(byName["Label"]?.angular).toBe("unmapped");
    expect(byName["Has icon"]?.angular).toBe("unmapped");
    expect(JSON.stringify(block)).not.toContain("Neon");
    expect(byName["Variant"]?.values).toEqual(["Primary (default)", "Secondary", "Tertiary"]);
    expect(byName["Property 1"]?.note).toBe('Rename "Property 1" in Figma. It is a placeholder.');
  });

  it("reads a team hints file and still refuses values outside the allowed list", () => {
    const home = mkdtempSync(join(tmpdir(), "resolve-hints-"));
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "property-hints.json"),
      JSON.stringify({ version: 1, hints: [{ says: "quiet", value: "Secondary" }, { says: "loud", value: "Screaming" }] }),
    );
    process.env["RESOLVE_HOME"] = home;
    const index = acmeIndex();
    const button = index.graph.nodes.find((node) => node.name === "Button" && node.type === "COMPONENT_SET")!;
    const block = propertyBlock(index, button, "quiet loud button");
    expect(JSON.stringify(block)).not.toContain("Screaming");
    expect(block?.properties.find((row) => row.property === "Variant")?.designerSays).toBe("quiet → Secondary");
  });

  it("flags a value that is not allowed, and a default label is only a note", () => {
    const bad = verifyFrame(
      acmeIndex({
        "Variant#1:1": { type: "VARIANT", value: "Huge" },
        "Label#1:0": { type: "TEXT", value: "Button" },
      }),
      { frame: "Checkout" },
    );
    expect(bad.pass).toBe(false);
    expect(bad.propertyFlags).toEqual([{ property: "Variant", value: "Huge", allowed: ["Primary", "Secondary", "Tertiary"] }]);
    expect(bad.propertyNotes?.map((note) => note.note)).toEqual(['Label is still the default "Button".']);

    const noted = verifyFrame(
      acmeIndex({ "Label#1:0": { type: "TEXT", value: "Button" } }, "Button"),
      { frame: "Checkout" },
    );
    expect(noted.pass).toBe(true);
    expect(noted.propertyFlags).toBeUndefined();
    expect(noted.propertyNotes?.[0]?.note).toBe('Label is still the default "Button".');
  });

  it("keeps the Acme Button properties section compact", () => {
    const index = acmeIndex();
    const button = index.graph.nodes.find((node) => node.name === "Button" && node.type === "COMPONENT_SET")!;
    const block = propertyBlock(index, button, "outline button with icon", {
      selector: "acme-button",
      importPath: "@acme/ui-angular",
      inputs: ["variant", "size", "disabled"],
    });
    const shown = block!.properties.filter((row) => row.property !== "Property 1");
    const section = ["Properties:", ...formatPropertyLines(shown), block!.apply ?? ""].filter(Boolean).join("\n");
    expect(section.length).toBeLessThan(800);
    expect(Math.ceil(JSON.stringify({ properties: shown, apply: block!.apply }).length / 4)).toBeLessThan(200);
    expect(section).toContain("Primary (default)");
    expect(section).toContain("designer says: outline → Secondary");
    expect(section).toContain("To apply: set Variant=Secondary, Has icon=true");
  });

  it("does not add a default MCP tool", () => {
    expect(DEFAULT_TOOL_NAMES).toEqual([
      "learn_library",
      "recipe",
      "recommend",
      "resolve",
      "get_example",
      "verify_frame",
      "check_cousins",
    ]);
  });
});
