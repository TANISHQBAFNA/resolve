import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SourceDocumentSchema, type SourceDocument } from "@/core/ingestion";
import type { DesignGraph, GraphEdge, GraphNode, NodeType } from "@/core/model";
import { buildGraph } from "@/core/transform/buildGraph";
import { fillRecipe, indexGraph, mergeWorkspaceGraphs, recommendMasters, starterRecipes } from "@/core/query";
import { mastersToRank } from "@/core/query/recommendLexicon";
import { runCli } from "@/server/cli";
import { clearCache, loadGraph, saveIngestedFile, writeWorkspace } from "@/server/store";
import { callTool, encodeToolResult } from "@/server/tools";

const FROZEN = "2026-01-01T00:00:00.000Z";

function doc(fileKey: string, fileName: string, extra: Partial<SourceDocument>): SourceDocument {
  return SourceDocumentSchema.parse({
    fileKey,
    fileName,
    root: { id: "0:0", name: fileName, type: "DOCUMENT", children: [] },
    components: {},
    componentSets: {},
    styles: {},
    variables: {},
    variableCollections: {},
    libraries: {},
    source: { kind: "mock", ingestedAt: FROZEN },
    ...extra,
  });
}

function baseDoc(): SourceDocument {
  return doc("ACMEDS", "Acme DS", {
    root: {
      id: "0:0",
      name: "Acme DS",
      type: "DOCUMENT",
      children: [
        {
          id: "1:1",
          name: "Components",
          type: "CANVAS",
          children: [
            {
              id: "10:1",
              name: "Button",
              type: "COMPONENT_SET",
              children: [
                {
                  id: "10:2",
                  name: "Type=Primary, Size=Large",
                  type: "COMPONENT",
                  componentSetId: "10:1",
                  variantProperties: { Type: "Primary", Size: "Large" },
                },
              ],
            },
            { id: "10:3", name: "Card", type: "COMPONENT" },
            { id: "10:4", name: "Radio", type: "COMPONENT" },
          ],
        },
      ],
    },
    components: {
      "10:2": { id: "10:2", name: "Type=Primary, Size=Large", key: "acme-btn-primary", componentSetId: "10:1" },
      "10:3": { id: "10:3", name: "Card", key: "acme-card" },
      "10:4": { id: "10:4", name: "Radio", key: "acme-radio" },
    },
    componentSets: {
      "10:1": { id: "10:1", name: "Button", key: "acme-btn-set" },
    },
  });
}

function productDoc(): SourceDocument {
  return doc("ACMEAPP", "Acme App", {
    libraries: {
      ds: { id: "ds", name: "Acme DS", fileKey: "ACMEDS" },
    },
    root: {
      id: "0:0",
      name: "Acme App",
      type: "DOCUMENT",
      children: [
        {
          id: "2:1",
          name: "Patterns",
          type: "CANVAS",
          children: [
            {
              id: "20:1",
              name: "Bottom action bar",
              type: "COMPONENT",
              children: [
                { id: "20:11", name: "Button", type: "INSTANCE", componentId: "10:2" },
              ],
            },
            {
              id: "20:2",
              name: "Party card",
              type: "COMPONENT",
              children: [{ id: "20:21", name: "Card", type: "INSTANCE", componentId: "10:3" }],
            },
            {
              id: "20:3",
              name: "button-group",
              type: "COMPONENT",
              children: [{ id: "20:31", name: "Radio", type: "INSTANCE", componentId: "10:4" }],
            },
            {
              id: "20:9",
              name: "Sign in",
              type: "FRAME",
              children: [{ id: "20:91", name: "Button", type: "INSTANCE", componentId: "10:2" }],
            },
          ],
        },
      ],
    },
    components: {
      "10:2": {
        id: "10:2",
        name: "Type=Primary, Size=Large",
        key: "acme-btn-primary",
        componentSetId: "10:1",
        remote: true,
        sourceFileKey: "ACMEDS",
        sourceFileName: "Acme DS",
        libraryId: "ds",
      },
      "10:3": {
        id: "10:3",
        name: "Card",
        key: "acme-card",
        remote: true,
        sourceFileKey: "ACMEDS",
        sourceFileName: "Acme DS",
        libraryId: "ds",
      },
      "10:4": {
        id: "10:4",
        name: "Radio",
        key: "acme-radio",
        remote: true,
        sourceFileKey: "ACMEDS",
        sourceFileName: "Acme DS",
        libraryId: "ds",
      },
      "20:1": { id: "20:1", name: "Bottom action bar", key: "acme-bar" },
      "20:2": { id: "20:2", name: "Party card", key: "acme-party" },
      "20:3": { id: "20:3", name: "button-group", key: "acme-button-group" },
    },
    componentSets: {
      "10:1": {
        id: "10:1",
        name: "Button",
        key: "acme-btn-set",
        remote: true,
        sourceFileKey: "ACMEDS",
        sourceFileName: "Acme DS",
        libraryId: "ds",
      },
    },
  });
}

const bothLibraries = {
  version: 1 as const,
  files: [
    { role: "library" as const, key: "ACMEAPP", label: "Acme App" },
    { role: "library" as const, key: "ACMEDS", label: "Acme DS" },
  ],
};

function node(id: string, type: NodeType, name: string, extra: Partial<GraphNode> = {}): GraphNode {
  return { id, type, name, ...extra };
}

function edge(type: GraphEdge["type"], source: string, target: string): GraphEdge {
  return { id: `${type}|${source}|${target}`, source, target, type };
}

function placedScreen(): DesignGraph {
  return {
    fileKey: "ACMEUI",
    fileName: "Acme",
    builtAt: FROZEN,
    source: { kind: "mock", ingestedAt: FROZEN },
    warnings: [],
    nodes: [
      node("file", "FILE", "Acme", { fileKey: "ACMEUI" }),
      node("screen", "FRAME", "Checkout", { fileKey: "ACMEUI", figmaNodeId: "8:1" }),
      node("button", "MAIN_COMPONENT", "Button", { fileKey: "ACMEUI", figmaNodeId: "1:1" }),
      node("field", "MAIN_COMPONENT", "Text field", { fileKey: "ACMEUI", figmaNodeId: "1:2" }),
      node("link", "MAIN_COMPONENT", "Link", { fileKey: "ACMEUI", figmaNodeId: "1:3" }),
      node("icon", "MAIN_COMPONENT", "Icon", { fileKey: "ACMEUI", figmaNodeId: "1:4" }),
      node("b", "COMPONENT_INSTANCE", "Button", { parentId: "screen", fileKey: "ACMEUI", mainComponentId: "button", figmaNodeId: "8:2" }),
      node("f", "COMPONENT_INSTANCE", "Text field", { parentId: "screen", fileKey: "ACMEUI", mainComponentId: "field", figmaNodeId: "8:3" }),
      node("l", "COMPONENT_INSTANCE", "Link", { parentId: "screen", fileKey: "ACMEUI", mainComponentId: "link", figmaNodeId: "8:4" }),
      node("i", "COMPONENT_INSTANCE", "Icon", { parentId: "b", fileKey: "ACMEUI", mainComponentId: "icon", figmaNodeId: "8:5" }),
    ],
    edges: [
      edge("CONTAINS", "screen", "b"),
      edge("CONTAINS", "screen", "f"),
      edge("CONTAINS", "screen", "l"),
      edge("CONTAINS", "screen", "i"),
      edge("CONTAINS", "b", "i"),
      edge("INSTANCE_OF", "b", "button"),
      edge("INSTANCE_OF", "f", "field"),
      edge("INSTANCE_OF", "l", "link"),
      edge("INSTANCE_OF", "i", "icon"),
    ],
  };
}

function olderStore(): DesignGraph {
  return {
    fileKey: "ACMEUI",
    fileName: "Acme UI",
    builtAt: FROZEN,
    source: { kind: "mock", ingestedAt: FROZEN },
    warnings: [],
    nodes: [
      node("file", "FILE", "Acme UI", { fileKey: "ACMEUI" }),
      node("page", "PAGE", "Artwork", { parentId: "file", fileKey: "ACMEUI" }),
      node("pdf", "MAIN_COMPONENT", "PDF", {
        parentId: "page",
        pageId: "page",
        fileKey: "ACMEUI",
        figmaNodeId: "4:1",
        isRemote: true,
        isMainComponent: true,
      }),
      node("alert", "MAIN_COMPONENT", "Alert", { parentId: "page", fileKey: "ACMEUI", figmaNodeId: "4:2" }),
    ],
    edges: [
      edge("CONTAINS", "file", "page"),
      edge("CONTAINS", "page", "pdf"),
      edge("CONTAINS", "page", "alert"),
    ],
  };
}

async function capture(args: string[]): Promise<string> {
  const chunks: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await runCli(args);
  } finally {
    process.stdout.write = write;
  }
  return chunks.join("");
}

const previousHome = process.env["RESOLVE_HOME"];

afterEach(() => {
  if (previousHome === undefined) delete process.env["RESOLVE_HOME"];
  else process.env["RESOLVE_HOME"] = previousHome;
  clearCache();
});

describe("two Acme libraries in one workspace", () => {
  it("unions base Button and Card before ranking", () => {
    const base = buildGraph(baseDoc(), { builtAt: FROZEN });
    const product = buildGraph(productDoc(), { builtAt: FROZEN });
    const workspace = {
      version: 1 as const,
      files: [
        { role: "library" as const, key: "ACMEAPP", label: "Acme App" },
        { role: "library" as const, key: "ACMEDS", label: "Acme DS" },
      ],
    };
    const merged = mergeWorkspaceGraphs(
      [
        { graph: product, role: "library" },
        { graph: base, role: "library" },
      ],
      workspace,
    );
    const index = indexGraph(merged);
    const pool = mastersToRank(index, workspace, index.graph.fileKey).map((node) => `${node.fileKey}:${node.name}:${node.isRemote ? "remote" : "local"}`);
    const button = recommendMasters(index, "primary button", { workspace });
    const large = recommendMasters(index, "large primary button", { workspace });
    const card = recommendMasters(index, "card", { workspace });
    const radio = recommendMasters(index, "radio group", { workspace });
    const alone = recommendMasters(indexGraph(base), "primary button");
    expect(alone.candidates[0]?.name).toBe("Button");
    expect(pool.join(" | ")).toContain("Button");
    expect(button.candidates[0]?.name).toBe("Button");
    expect(button.candidates[0]?.fileKey).toBe("ACMEDS");
    expect(large.candidates[0]?.name).toBe("Button");
    expect(card.candidates[0]?.name).toBe("Card");
    expect(card.candidates[0]?.fileKey).toBe("ACMEDS");
    expect(radio.candidates[0]?.name).toBe("Radio");
    const recipe = starterRecipes().find((row) => row.id === "sign-in");
    const filled = fillRecipe(index, recipe!, undefined, undefined, workspace);
    const slot = filled.slots.find((row) => row.role === "primary-cta");
    expect(slot?.status).toBe("filled");
    expect(slot?.master?.name).toBe("Button");
  });

  it("recommends the base button through the stored workspace, CLI, and MCP", async () => {
    process.env["RESOLVE_HOME"] = mkdtempSync(join(tmpdir(), "resolve-two-lib-"));
    clearCache();
    saveIngestedFile(buildGraph(productDoc(), { builtAt: FROZEN }), { role: "library", label: "Acme App" });
    clearCache();
    saveIngestedFile(buildGraph(baseDoc(), { builtAt: FROZEN }), { role: "library", label: "Acme DS" });
    clearCache();
    const loaded = loadGraph();
    expect(loaded).toBeDefined();
    const card = recommendMasters(loaded!.index, "primary button", { workspace: { version: 1, files: [
      { role: "library", key: "ACMEAPP", label: "Acme App" },
      { role: "library", key: "ACMEDS", label: "Acme DS" },
    ] } });
    expect(card.candidates[0]?.name).toBe("Button");
    expect(card.candidates[0]?.fileKey).toBe("ACMEDS");

    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runCli(["recommend", "card"]);
    } finally {
      process.stdout.write = write;
    }
    const cli = JSON.parse(chunks.join("")) as { candidates: Array<{ name?: string; fileKey?: string }> };
    expect(cli.candidates[0]?.name).toBe("Card");
    expect(cli.candidates[0]?.fileKey).toBe("ACMEDS");

    const mcp = callTool("recommend", { intent: "large primary button" }) as {
      candidates: Array<{ name?: string; fileKey?: string }>;
    };
    expect(mcp.candidates[0]?.name).toBe("Button");
    expect(mcp.candidates[0]?.fileKey).toBe("ACMEDS");
  });

  it("ranks remote base masters when the product file is the only graph", async () => {
    const product = buildGraph(productDoc(), { builtAt: FROZEN });
    const merged = mergeWorkspaceGraphs([{ graph: product, role: "library" }], bothLibraries);
    const index = indexGraph(merged);
    const pool = mastersToRank(index, bothLibraries, index.graph.fileKey, "primary button").map((row) => row.name);
    expect(pool).toContain("Button");
    expect(pool).toContain("Card");
    const alone = recommendMasters(indexGraph(buildGraph(baseDoc(), { builtAt: FROZEN })), "primary button");
    expect(alone.candidates[0]?.name).toBe("Button");
    for (const ask of ["primary button", "large primary button"]) {
      const card = recommendMasters(index, ask, { workspace: bothLibraries });
      expect(card.candidates[0]?.name, ask).toBe("Button");
      expect(card.candidates[0]?.fileKey, ask).toBe("ACMEDS");
    }
    const card = recommendMasters(index, "card", { workspace: bothLibraries });
    expect(card.candidates[0]?.name).toBe("Card");
    expect(card.candidates[0]?.fileKey).toBe("ACMEDS");
    const radio = recommendMasters(index, "radio group", { workspace: bothLibraries });
    expect(radio.candidates[0]?.name).toBe("Radio");
    expect(radio.candidates[0]?.name).not.toBe("button-group");
    const recipe = starterRecipes().find((row) => row.id === "sign-in");
    const filled = fillRecipe(index, recipe!, undefined, undefined, bothLibraries);
    expect(filled.slots.find((row) => row.role === "primary-cta")?.master?.name).toBe("Button");

    process.env["RESOLVE_HOME"] = mkdtempSync(join(tmpdir(), "resolve-two-lib-"));
    clearCache();
    saveIngestedFile(product, { role: "library", label: "Acme App" });
    writeWorkspace(bothLibraries);
    clearCache();
    const cliRadio = JSON.parse(await capture(["recommend", "radio group"])) as {
      candidates: Array<{ name?: string }>;
    };
    expect(cliRadio.candidates[0]?.name).toBe("Radio");
    const cliCard = JSON.parse(await capture(["recommend", "card"])) as {
      candidates: Array<{ name?: string; fileKey?: string }>;
    };
    expect(cliCard.candidates[0]?.name).toBe("Card");
    expect(cliCard.candidates[0]?.fileKey).toBe("ACMEDS");
    const mcp = callTool("recommend", { intent: "primary button" }) as {
      candidates: Array<{ name?: string; fileKey?: string }>;
    };
    expect(mcp.candidates[0]?.name).toBe("Button");
    expect(mcp.candidates[0]?.fileKey).toBe("ACMEDS");
  });
});

describe("CLI and MCP still see the check card", () => {
  it("counts three placed components and keeps the proper-use line", async () => {
    process.env["RESOLVE_HOME"] = mkdtempSync(join(tmpdir(), "resolve-placed-"));
    clearCache();
    saveIngestedFile(placedScreen(), { role: "library", label: "Acme" });
    clearCache();
    const cli = JSON.parse(await capture(["verify", "8:1"])) as { approved?: number };
    expect(cli.approved).toBe(3);
    const mcp = callTool("verify_frame", { frame: "8:1" }) as { approved?: number };
    expect(mcp.approved).toBe(3);

    const names = ["A", "B", "C", "D"].map((prefix) => `${prefix}${"y".repeat(212)}`);
    const headline = (await capture(["check", "--components", names.join(",")])).split("\n")[0] ?? "";
    expect(headline).toContain("Components:");
    expect(headline).toContain("Proper use");
    expect(headline).not.toBe("PASS");
    expect(headline).not.toBe("FAIL");
    const markdown = encodeToolResult(
      callTool("verify_frame", { components: names }),
      "markdown",
      "verify_frame",
    );
    const first = markdown.split("\n")[0] ?? "";
    expect(first).toContain("Components:");
    expect(first).toContain("Proper use");
    expect(first).not.toBe("PASS");
  });

  it("finds a remote pdf icon and flags alert banner through CLI and MCP", async () => {
    process.env["RESOLVE_HOME"] = mkdtempSync(join(tmpdir(), "resolve-older-"));
    clearCache();
    saveIngestedFile(olderStore(), { role: "library", label: "Acme UI" });
    clearCache();
    const cliPdf = JSON.parse(await capture(["recommend", "pdf icon"])) as {
      candidates: Array<{ name?: string }>;
      match?: string;
    };
    expect(cliPdf.candidates[0]?.name).toBe("PDF");
    expect(cliPdf.match).not.toBe("weak match");
    const mcpBanner = callTool("recommend", { intent: "alert banner" }) as {
      candidates: Array<{ name?: string }>;
      match?: string;
    };
    expect(mcpBanner.candidates[0]?.name).toBe("Alert");
    expect(mcpBanner.match).toBe("weak match");
  });
});
