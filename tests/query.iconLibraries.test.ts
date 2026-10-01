import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesignGraph, GraphEdge, GraphNode, NodeType } from "@/core/model";
import { indexGraph, recommendMasters } from "@/core/query";
import type { WorkspaceManifest } from "@/core/query/workspace";

const FROZEN = "2026-01-01T00:00:00.000Z";

function n(id: string, type: NodeType, name: string, extra: Partial<GraphNode> = {}): GraphNode {
  return { id, type, name, ...extra };
}

function e(type: GraphEdge["type"], source: string, target: string): GraphEdge {
  return { id: `${type}|${source}|${target}`, source, target, type };
}

const workspace: WorkspaceManifest = {
  version: 1,
  files: [
    { key: "LIB", role: "library", label: "Library" },
    { key: "ICONS", role: "library", label: "Acme Icons" },
  ],
};

function twoLibraryIndex() {
  const lib = "file:LIB";
  const icons = "file:ICONS";
  const libPage = "node:lib-page";
  const iconPage = "node:icon-page";
  const toggle = "node:toggle";
  const toggleOn = "node:toggle-on";
  const searchField = "node:search-field";
  const searchFieldVar = "node:search-field-v";
  const iconToggle = "node:icon-toggle";
  const iconToggleOn = "node:icon-toggle-on";
  const iconSearch = "node:icon-search";
  const nodes: GraphNode[] = [
    n(lib, "FILE", "Library", { fileKey: "LIB" }),
    n(libPage, "PAGE", "Controls", { parentId: lib, pageId: libPage, fileKey: "LIB" }),
    n(toggle, "COMPONENT_SET", "Toggle", {
      parentId: libPage,
      pageId: libPage,
      fileKey: "LIB",
      figmaNodeId: "1:1",
    }),
    n(toggleOn, "VARIANT", "State=On", {
      parentId: toggle,
      pageId: libPage,
      componentSetId: toggle,
      fileKey: "LIB",
      figmaNodeId: "1:2",
      variantProperties: { State: "On" },
    }),
    n("node:toggle-label", "TEXT_LAYER", "On", { parentId: toggleOn, pageId: libPage, fileKey: "LIB" }),
    n(searchField, "COMPONENT_SET", "Search field", {
      parentId: libPage,
      pageId: libPage,
      fileKey: "LIB",
      figmaNodeId: "2:1",
    }),
    n(searchFieldVar, "VARIANT", "State=Default", {
      parentId: searchField,
      pageId: libPage,
      componentSetId: searchField,
      fileKey: "LIB",
      figmaNodeId: "2:2",
      variantProperties: { State: "Default" },
    }),
    n("node:search-field-t", "TEXT_LAYER", "Search", {
      parentId: searchFieldVar,
      pageId: libPage,
      fileKey: "LIB",
    }),
    n(icons, "FILE", "Acme Icons", { fileKey: "ICONS" }),
    n(iconPage, "PAGE", "Glyphs", { parentId: icons, pageId: iconPage, fileKey: "ICONS" }),
    n(iconToggle, "COMPONENT_SET", "Toggle", {
      parentId: iconPage,
      pageId: iconPage,
      fileKey: "ICONS",
      figmaNodeId: "9:1",
    }),
    n(iconToggleOn, "VARIANT", "State=On", {
      parentId: iconToggle,
      pageId: iconPage,
      componentSetId: iconToggle,
      fileKey: "ICONS",
      figmaNodeId: "9:2",
      variantProperties: { State: "On" },
    }),
    n("node:icon-toggle-v", "LAYER", "knob", { parentId: iconToggleOn, pageId: iconPage, fileKey: "ICONS" }),
    n(iconSearch, "MAIN_COMPONENT", "Search", {
      parentId: iconPage,
      pageId: iconPage,
      fileKey: "ICONS",
      figmaNodeId: "9:3",
      isMainComponent: true,
    }),
    n("node:icon-search-v", "LAYER", "glass", { parentId: iconSearch, pageId: iconPage, fileKey: "ICONS" }),
  ];
  const edges: GraphEdge[] = [
    e("CONTAINS", lib, libPage),
    e("CONTAINS", libPage, toggle),
    e("CONTAINS", toggle, toggleOn),
    e("CONTAINS", toggleOn, "node:toggle-label"),
    e("VARIANT_OF", toggleOn, toggle),
    e("CONTAINS", libPage, searchField),
    e("CONTAINS", searchField, searchFieldVar),
    e("CONTAINS", searchFieldVar, "node:search-field-t"),
    e("VARIANT_OF", searchFieldVar, searchField),
    e("CONTAINS", icons, iconPage),
    e("CONTAINS", iconPage, iconToggle),
    e("CONTAINS", iconToggle, iconToggleOn),
    e("CONTAINS", iconToggleOn, "node:icon-toggle-v"),
    e("VARIANT_OF", iconToggleOn, iconToggle),
    e("CONTAINS", iconPage, iconSearch),
    e("CONTAINS", iconSearch, "node:icon-search-v"),
  ];
  const graph: DesignGraph = {
    fileKey: "LIB",
    fileName: "Library",
    builtAt: FROZEN,
    source: { kind: "mock", ingestedAt: FROZEN },
    warnings: [],
    nodes,
    edges,
  };
  return indexGraph(graph);
}

function writeLibraries(dir: string, libraries: string[]): void {
  writeFileSync(join(dir, "icon-libraries.json"), `${JSON.stringify({ libraries }, null, 2)}\n`);
}

function topName(index: ReturnType<typeof twoLibraryIndex>, ask: string): string | undefined {
  return recommendMasters(index, ask, { workspace }).candidates[0]?.name;
}

describe("team icon-libraries.json", () => {
  const previousHome = process.env["GRAPHIFY_HOME"];
  let home: string;
  const index = twoLibraryIndex();

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "resolve-icon-libs-"));
    process.env["GRAPHIFY_HOME"] = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env["GRAPHIFY_HOME"];
    else process.env["GRAPHIFY_HOME"] = previousHome;
  });

  it("marks a listed library as icons so toggle stays the real control", () => {
    writeLibraries(home, ["  ACME   icons "]);
    expect(topName(index, "toggle")).toBe("Toggle");
    expect(recommendMasters(index, "toggle", { workspace }).candidates[0]?.id).toBe("node:toggle");
    expect(topName(index, "search")).toBe("Search field");
  });

  it("still finds Search from that library when the ask says icon", () => {
    writeLibraries(home, ["Acme Icons"]);
    expect(topName(index, "search icon")).toBe("Search");
    expect(recommendMasters(index, "search icon", { workspace }).candidates[0]?.id).toBe("node:icon-search");
  });

  it("with no config, name heuristic is unchanged and Search is not treated as an icon", () => {
    expect(topName(index, "search")).toBe("Search");
    expect(topName(index, "toggle")).toBe("Toggle");
  });

  it("two workspaces can list different icon libraries", () => {
    const other = mkdtempSync(join(tmpdir(), "resolve-icon-libs-b-"));
    writeLibraries(home, ["Acme Icons"]);
    writeLibraries(other, ["Other Glyphs"]);
    expect(topName(index, "search")).toBe("Search field");
    process.env["GRAPHIFY_HOME"] = other;
    expect(topName(index, "search")).toBe("Search");
  });

  it("re-reads the list between runs so an edit takes effect immediately", () => {
    writeLibraries(home, ["Acme Icons"]);
    expect(topName(index, "search")).toBe("Search field");
    writeLibraries(home, []);
    expect(topName(index, "search")).toBe("Search");
    writeLibraries(home, ["Acme Icons"]);
    expect(topName(index, "search")).toBe("Search field");
  });
});
