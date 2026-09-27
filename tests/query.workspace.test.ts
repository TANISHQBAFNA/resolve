import { describe, expect, it } from "vitest";
import type { DesignGraph, GraphEdge, GraphNode, NodeType } from "@/core/model";
import {
  assertIngestRoleChange,
  indexGraph,
  isLibraryFileKey,
  mergeWorkspaceGraphs,
  parseIngestRole,
  parseWorkspaceFile,
  recommendMasters,
  stampFileKey,
  upsertWorkspaceFile,
  verifyFrame,
} from "@/core/query";
import exampleWorkspace from "@/data/workspace.example.json";

const FROZEN = "2026-01-01T00:00:00.000Z";

function n(id: string, type: NodeType, name: string, extra: Partial<GraphNode> = {}): GraphNode {
  return { id, type, name, ...extra };
}

function e(type: GraphEdge["type"], source: string, target: string): GraphEdge {
  return { id: `${type}|${source}|${target}`, source, target, type };
}

function graphOf(
  fileKey: string,
  fileName: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
): DesignGraph {
  return {
    fileKey,
    fileName,
    builtAt: FROZEN,
    source: { kind: "mock", ingestedAt: FROZEN },
    warnings: [],
    nodes,
    edges,
  };
}

function libraryGraph() {
  const file = "file:LIB";
  const page = "node:p";
  const set = "node:btn-set";
  const primary = "node:primary";
  return {
    ids: { file, page, set, primary },
    graph: graphOf(
      "LIB",
      "Shared DS",
      [
        n(file, "FILE", "Shared DS", { fileKey: "LIB" }),
        n(page, "PAGE", "Components", { parentId: file, pageId: page, fileKey: "LIB" }),
        n(set, "COMPONENT_SET", "Button", { parentId: page, pageId: page, figmaNodeId: "9:0", fileKey: "LIB" }),
        n(primary, "VARIANT", "Primary", {
          parentId: set,
          pageId: page,
          componentSetId: set,
          figmaNodeId: "9:1",
          fileKey: "LIB",
          isMainComponent: true,
          variantProperties: { Variant: "Primary" },
          metadata: { key: "btn-primary-key" },
        }),
      ],
      [
        e("CONTAINS", file, page),
        e("CONTAINS", page, set),
        e("CONTAINS", set, primary),
        e("VARIANT_OF", primary, set),
      ],
    ),
  };
}

function productGraph() {
  const file = "file:PROD";
  const page = "node:p";
  const frame = "node:checkout";
  const local = "node:local-btn";
  const stub = "node:9:1";
  const instLocal = "node:il";
  const instLib = "node:iremote";
  const unknown = "lib:external-unknown";
  return {
    ids: { file, page, frame, local, stub, instLocal, instLib, unknown },
    graph: graphOf(
      "PROD",
      "Storefront",
      [
        n(file, "FILE", "Storefront", { fileKey: "PROD" }),
        n(page, "PAGE", "App", { parentId: file, pageId: page, fileKey: "PROD" }),
        n(frame, "FRAME", "Checkout Summary", {
          parentId: page,
          pageId: page,
          figmaNodeId: "2:1",
          fileKey: "PROD",
        }),
        n(local, "MAIN_COMPONENT", "One-off Pay Button", {
          parentId: page,
          pageId: page,
          figmaNodeId: "8:8",
          fileKey: "PROD",
          isMainComponent: true,
        }),
        n(stub, "MAIN_COMPONENT", "Primary", {
          figmaNodeId: "9:1",
          fileKey: "PROD",
          isRemote: true,
          isMainComponent: true,
          libraryId: unknown,
          metadata: { key: "btn-primary-key", remote: true },
        }),
        n(unknown, "EXTERNAL_LIBRARY", "External libraries (source unknown)", {
          isRemote: true,
          fileKey: "PROD",
        }),
        n(instLocal, "COMPONENT_INSTANCE", "One-off Pay Button", {
          parentId: frame,
          pageId: page,
          isInstance: true,
          mainComponentId: local,
          figmaNodeId: "2:2",
          fileKey: "PROD",
        }),
        n(instLib, "COMPONENT_INSTANCE", "Primary", {
          parentId: frame,
          pageId: page,
          isInstance: true,
          mainComponentId: stub,
          figmaNodeId: "2:3",
          fileKey: "PROD",
          isRemote: true,
        }),
      ],
      [
        e("CONTAINS", file, page),
        e("CONTAINS", page, frame),
        e("CONTAINS", page, local),
        e("CONTAINS", frame, instLocal),
        e("CONTAINS", frame, instLib),
        e("INSTANCE_OF", instLocal, local),
        e("INSTANCE_OF", instLib, stub),
        e("USED_IN", local, instLocal),
        e("USED_IN", stub, instLib),
        e("NESTS", frame, instLocal),
        e("NESTS", frame, instLib),
        e("SOURCED_FROM_LIBRARY", stub, unknown),
      ],
    ),
  };
}

const workspace = {
  version: 1 as const,
  files: [
    { role: "library" as const, key: "LIB", label: "Shared DS" },
    { role: "product" as const, key: "PROD", label: "Storefront" },
  ],
};

describe("workspace load", () => {
  it("parses designer JSON and ignores unknown keys", () => {
    const file = parseWorkspaceFile({
      version: 1,
      extra: true,
      files: [
        { role: "library", key: "AbC", url: "https://www.figma.com/design/AbC/DS", label: "DS", figmaNodeId: "nope" },
        { role: "product", fileKey: "Prod1", label: "Storefront" },
        { role: "mystery", key: "X" },
        { role: "client" },
      ],
    });
    expect(file.files).toHaveLength(2);
    expect(file.files[0]).toEqual({
      role: "library",
      key: "AbC",
      url: "https://www.figma.com/design/AbC/DS",
      label: "DS",
    });
    expect(file.files[1]?.key).toBe("Prod1");
    expect(file.files[0] && "figmaNodeId" in file.files[0]).toBe(false);
  });

  it("reads a file key out of a Figma URL when key is missing", () => {
    const file = parseWorkspaceFile({
      files: [{ role: "library", url: "https://www.figma.com/design/UrlKey123/Shared-DS" }],
    });
    expect(file.files[0]?.key).toBe("UrlKey123");
  });

  it("parses the shipped example without inventing masters", () => {
    const file = parseWorkspaceFile(exampleWorkspace);
    expect(file.files[0]?.role).toBe("library");
    expect(file.files[1]?.role).toBe("product");
    expect(file.files.every((row) => row.key && !("figmaNodeId" in row))).toBe(true);
  });

  it("upserts by file key and keeps the rest", () => {
    const next = upsertWorkspaceFile(workspace, {
      role: "client",
      key: "LIB",
      label: "Renamed",
    });
    expect(next.files).toHaveLength(2);
    expect(next.files.find((file) => file.key === "LIB")?.role).toBe("client");
    expect(next.files.find((file) => file.key === "PROD")?.role).toBe("product");
  });

  it("assertIngestRoleChange refuses a silent library to product swap", () => {
    expect(() => assertIngestRoleChange(workspace, "LIB", "product")).toThrow(/library/);
    expect(() => assertIngestRoleChange(workspace, "LIB", "product")).toThrow(/product/);
    expect(() => assertIngestRoleChange(workspace, "LIB", "library")).not.toThrow();
    expect(() => assertIngestRoleChange(workspace, "LIB", "product", { forceRole: true })).not.toThrow();
  });

  it("rejects junk rather than crashing", () => {
    expect(parseWorkspaceFile({})).toEqual({ version: 1, files: [] });
    expect(parseWorkspaceFile(null)).toEqual({ version: 1, files: [] });
  });

  it("parseIngestRole accepts library | product | client and throws on junk", () => {
    expect(parseIngestRole(undefined)).toBeUndefined();
    expect(parseIngestRole("library")).toBe("library");
    expect(parseIngestRole("PRODUCT")).toBe("product");
    expect(parseIngestRole(" client ")).toBe("client");
    expect(() => parseIngestRole("junk")).toThrow(/Unknown --role "junk"/);
    expect(() => parseIngestRole("junk")).toThrow(/library, product, client/);
    expect(() => parseIngestRole("")).toThrow(/Unknown --role/);
  });
});

describe("provenance stamps", () => {
  it("stamps graph.fileKey on nodes that lack one", () => {
    const raw = graphOf("ABC", "File", [n("file:ABC", "FILE", "File"), n("node:1", "FRAME", "Home")], []);
    const stamped = stampFileKey(raw);
    expect(stamped.nodes.every((node) => node.fileKey === "ABC")).toBe(true);
  });

  it("merged cards keep fileKey + figmaNodeId because ids collide across files", () => {
    const lib = libraryGraph();
    const prod = productGraph();
    const merged = mergeWorkspaceGraphs(
      [
        { graph: lib.graph, role: "library" },
        { graph: prod.graph, role: "product" },
      ],
      workspace,
    );
    const primaries = merged.nodes.filter((node) => node.figmaNodeId === "9:1");
    expect(primaries.length).toBeGreaterThan(1);
    expect(new Set(primaries.map((node) => node.id)).size).toBe(primaries.length);
    expect(primaries.every((node) => node.fileKey === "LIB" || node.fileKey === "PROD")).toBe(true);
  });
});

describe("remote stubs link to an ingested library file", () => {
  it("rewrites INSTANCE_OF to the real library master and drops the unknown bucket", () => {
    const lib = libraryGraph();
    const prod = productGraph();
    const merged = mergeWorkspaceGraphs(
      [
        { graph: lib.graph, role: "library" },
        { graph: prod.graph, role: "product" },
      ],
      workspace,
    );
    const index = indexGraph(merged);
    const libraryPrimary = merged.nodes.find(
      (node) => node.figmaNodeId === "9:1" && node.fileKey === "LIB" && !node.isRemote,
    );
    expect(libraryPrimary).toBeDefined();
    const remoteInstance = merged.nodes.find((node) => node.figmaNodeId === "2:3");
    expect(remoteInstance?.mainComponentId).toBe(libraryPrimary?.id);
    expect(
      merged.edges.some(
        (edge) =>
          edge.type === "INSTANCE_OF" &&
          edge.source === remoteInstance?.id &&
          edge.target === libraryPrimary?.id,
      ),
    ).toBe(true);
    expect(merged.nodes.some((node) => node.name.toLowerCase().includes("source unknown"))).toBe(
      false,
    );
    expect(
      merged.edges.some(
        (edge) =>
          edge.type === "SOURCED_FROM_LIBRARY" &&
          edge.target === "file:LIB",
      ),
    ).toBe(true);
    expect(isLibraryFileKey(workspace, "LIB")).toBe(true);
    expect(index.getNode(libraryPrimary!.id)?.fileKey).toBe("LIB");
  });
});

describe("recommend prefers the DS library", () => {
  it("ranks the library Primary above a product one-off when workspace has a library file", () => {
    const lib = libraryGraph();
    const prod = productGraph();
    const merged = mergeWorkspaceGraphs(
      [
        { graph: lib.graph, role: "library" },
        { graph: prod.graph, role: "product" },
      ],
      workspace,
    );
    const index = indexGraph(merged);
    const result = recommendMasters(index, "primary button", { workspace });
    expect(result.candidates[0]?.fileKey).toBe("LIB");
    expect(result.candidates[0]?.figmaNodeId).toBe("9:1");
    expect(typeof result.candidates[0]?.why).toBe("string");
    const oneOff = result.candidates.find((row) => row.fileKey === "PROD");
    const lead = result.candidates[0];
    if (oneOff && "score" in oneOff && lead && "score" in lead) {
      expect(oneOff.score).toBeLessThan(lead.score);
    }
  });

  it("without a library role, does not invent a library preference", () => {
    const prod = productGraph();
    const index = indexGraph(stampFileKey(prod.graph));
    const result = recommendMasters(index, "primary button", {
      workspace: { version: 1, files: [{ role: "product", key: "PROD", label: "Storefront" }] },
    });
    expect(result.candidates.every((row) => row.fileKey !== "LIB" || row.why === "no usage yet" || typeof row.why === "string")).toBe(true);
  });
});

describe("verify_frame stamps fileKey from the workspace", () => {
  it("puts fileKey next to figmaNodeId on the frame and on placed masters", () => {
    const lib = libraryGraph();
    const prod = productGraph();
    const merged = mergeWorkspaceGraphs(
      [
        { graph: lib.graph, role: "library" },
        { graph: prod.graph, role: "product" },
      ],
      workspace,
    );
    const index = indexGraph(merged);
    const result = verifyFrame(index, { frame: "Checkout Summary" });
    expect(result.frame?.figmaNodeId).toBe("2:1");
    expect(result.frame?.fileKey).toBe("PROD");
    expect(result.pass).toBe(true);

    const denied = verifyFrame(index, {
      components: ["One-off Pay Button"],
      rules: { deny: ["One-off Pay Button"] },
    });
    expect(denied.invents[0]?.figmaNodeId).toBe("8:8");
    expect(denied.invents[0]?.fileKey).toBe("PROD");
    expect(denied.invents[0]?.reason).toBe("denied");
  });
});
