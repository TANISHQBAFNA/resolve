import { describe, expect, it } from "vitest";
import type { DesignGraph, GraphEdge, GraphNode, NodeType } from "@/core/model";
import {
  componentUsageCard,
  indexGraph,
  preferNamedMaster,
  recommendMasters,
  verifyFrame,
} from "@/core/query";
import { initGoldenCases, resolveMasterByName, scoreGraph } from "@/core/query/scoreboard";
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
    { key: "APP", role: "product", label: "App" },
  ],
};

const ids = {
  button: "node:button",
  stub: "node:button-stub",
  table: "node:table",
  tableIcon: "node:icon-table",
  search: "node:search",
  searchIcon: "node:icon-search",
  dropdown: "node:dropdown",
  baseMenu: "node:base-menu",
  oldBanner: "node:old-banner",
  oldBannerVar: "node:old-banner-v",
  banner: "node:banner",
  page: "node:page",
};

function realLibraryShape() {
  const file = "file:LIB";
  const page = ids.page;
  const button = ids.button;
  const primary = "node:button-p";
  const secondary = "node:button-s";
  const small = "node:button-sm";
  const stub = ids.stub;
  const table = ids.table;
  const tableDefault = "node:table-d";
  const tableDense = "node:table-n";
  const dropdown = ids.dropdown;
  const dropdownDef = "node:dropdown-d";
  const search = ids.search;
  const searchDef = "node:search-d";
  const tagA = "node:tag";
  const tagAVar = "node:tag-v";
  const tagB = "node:tag-other";
  const tagBVar = "node:tag-other-v";
  const tableIcon = ids.tableIcon;
  const searchIcon = ids.searchIcon;
  const baseMenu = ids.baseMenu;
  const baseMenuVar = "node:base-menu-v";
  const oldBanner = ids.oldBanner;
  const oldBannerVar = ids.oldBannerVar;
  const banner = ids.banner;
  const screen = "node:screen";
  const inst = "node:inst-btn";

  const nodes: GraphNode[] = [
    n(file, "FILE", "Library", { fileKey: "LIB" }),
    n(page, "PAGE", "Components", { parentId: file, pageId: page, fileKey: "LIB", figmaNodeId: "1:0" }),
    n(button, "COMPONENT_SET", "Button", {
      parentId: page,
      pageId: page,
      fileKey: "LIB",
      figmaNodeId: "10:1",
    }),
    n(primary, "VARIANT", "Style=Primary, Size=Medium", {
      parentId: button,
      pageId: page,
      componentSetId: button,
      fileKey: "LIB",
      figmaNodeId: "10:2",
      variantProperties: { Style: "Primary", Size: "Medium" },
    }),
    n(secondary, "VARIANT", "Style=Secondary, Size=Medium", {
      parentId: button,
      pageId: page,
      componentSetId: button,
      fileKey: "LIB",
      figmaNodeId: "10:3",
      variantProperties: { Style: "Secondary", Size: "Medium" },
    }),
    n(small, "VARIANT", "Style=Primary, Size=Small", {
      parentId: button,
      pageId: page,
      componentSetId: button,
      fileKey: "LIB",
      figmaNodeId: "10:4",
      variantProperties: { Style: "Primary", Size: "Small" },
    }),
    n(stub, "COMPONENT_SET", "Button", {
      parentId: page,
      pageId: page,
      fileKey: "APP",
      figmaNodeId: "99:1",
      isRemote: true,
    }),
    n(table, "COMPONENT_SET", "Table", { parentId: page, pageId: page, fileKey: "LIB", figmaNodeId: "11:1" }),
    n(tableDefault, "VARIANT", "Type=Default", {
      parentId: table,
      pageId: page,
      componentSetId: table,
      fileKey: "LIB",
      figmaNodeId: "11:2",
      variantProperties: { Type: "Default" },
    }),
    n(tableDense, "VARIANT", "Type=Dense", {
      parentId: table,
      pageId: page,
      componentSetId: table,
      fileKey: "LIB",
      figmaNodeId: "11:3",
      variantProperties: { Type: "Dense" },
    }),
    n(dropdown, "COMPONENT_SET", "Dropdown", {
      parentId: page,
      pageId: page,
      fileKey: "LIB",
      figmaNodeId: "12:1",
    }),
    n(dropdownDef, "VARIANT", "State=Default", {
      parentId: dropdown,
      pageId: page,
      componentSetId: dropdown,
      fileKey: "LIB",
      figmaNodeId: "12:2",
      variantProperties: { State: "Default" },
    }),
    n(search, "COMPONENT_SET", "Search field", {
      parentId: page,
      pageId: page,
      fileKey: "LIB",
      figmaNodeId: "13:1",
    }),
    n(searchDef, "VARIANT", "State=Default", {
      parentId: search,
      pageId: page,
      componentSetId: search,
      fileKey: "LIB",
      figmaNodeId: "13:2",
      variantProperties: { State: "Default" },
    }),
    n("node:search-text", "TEXT_LAYER", "Query", {
      parentId: searchDef,
      pageId: page,
      fileKey: "LIB",
    }),
    n(tagA, "COMPONENT_SET", "Tag", { parentId: page, pageId: page, fileKey: "LIB", figmaNodeId: "14:1" }),
    n(tagAVar, "VARIANT", "Size=M", {
      parentId: tagA,
      pageId: page,
      componentSetId: tagA,
      fileKey: "LIB",
      figmaNodeId: "14:2",
      variantProperties: { Size: "M" },
    }),
    n(tagB, "COMPONENT_SET", "Tag", { parentId: page, pageId: page, fileKey: "LIB", figmaNodeId: "15:1" }),
    n(tagBVar, "VARIANT", "Size=L", {
      parentId: tagB,
      pageId: page,
      componentSetId: tagB,
      fileKey: "LIB",
      figmaNodeId: "15:2",
      variantProperties: { Size: "L" },
    }),
    n(tableIcon, "MAIN_COMPONENT", "database-28-table", {
      parentId: page,
      pageId: page,
      fileKey: "LIB",
      figmaNodeId: "20:1",
      isMainComponent: true,
    }),
    n("node:icon-table-v", "LAYER", "shape", { parentId: tableIcon, pageId: page, fileKey: "LIB" }),
    n(searchIcon, "MAIN_COMPONENT", "system-550-search", {
      parentId: page,
      pageId: page,
      fileKey: "LIB",
      figmaNodeId: "21:1",
      isMainComponent: true,
    }),
    n("node:icon-search-v", "LAYER", "shape", { parentId: searchIcon, pageId: page, fileKey: "LIB" }),
    n(baseMenu, "COMPONENT_SET", "base/menu-button", {
      parentId: page,
      pageId: page,
      fileKey: "LIB",
      figmaNodeId: "22:1",
    }),
    n(baseMenuVar, "VARIANT", "State=Default", {
      parentId: baseMenu,
      pageId: page,
      componentSetId: baseMenu,
      fileKey: "LIB",
      figmaNodeId: "22:2",
      variantProperties: { State: "Default" },
    }),
    n(oldBanner, "COMPONENT_SET", "Old Banner", {
      parentId: page,
      pageId: page,
      fileKey: "LIB",
      figmaNodeId: "30:1",
      description: "do not use",
      status: "deprecated",
    }),
    n(oldBannerVar, "VARIANT", "Tone=Info", {
      parentId: oldBanner,
      pageId: page,
      componentSetId: oldBanner,
      fileKey: "LIB",
      figmaNodeId: "30:2",
      variantProperties: { Tone: "Info" },
    }),
    n(banner, "MAIN_COMPONENT", "Banner", {
      parentId: page,
      pageId: page,
      fileKey: "LIB",
      figmaNodeId: "31:1",
      isMainComponent: true,
    }),
    n(screen, "FRAME", "Home", { parentId: page, pageId: page, fileKey: "APP", figmaNodeId: "40:1" }),
    n(inst, "COMPONENT_INSTANCE", "Button", {
      parentId: screen,
      pageId: page,
      fileKey: "APP",
      figmaNodeId: "40:2",
      mainComponentId: primary,
      isInstance: true,
    }),
  ];

  const edges: GraphEdge[] = [
    e("CONTAINS", file, page),
    e("CONTAINS", page, button),
    e("CONTAINS", button, primary),
    e("CONTAINS", button, secondary),
    e("CONTAINS", button, small),
    e("VARIANT_OF", primary, button),
    e("VARIANT_OF", secondary, button),
    e("VARIANT_OF", small, button),
    e("CONTAINS", page, stub),
    e("CONTAINS", page, table),
    e("CONTAINS", table, tableDefault),
    e("CONTAINS", table, tableDense),
    e("VARIANT_OF", tableDefault, table),
    e("VARIANT_OF", tableDense, table),
    e("CONTAINS", page, dropdown),
    e("CONTAINS", dropdown, dropdownDef),
    e("VARIANT_OF", dropdownDef, dropdown),
    e("CONTAINS", page, search),
    e("CONTAINS", search, searchDef),
    e("VARIANT_OF", searchDef, search),
    e("CONTAINS", searchDef, "node:search-text"),
    e("CONTAINS", page, tagA),
    e("CONTAINS", tagA, tagAVar),
    e("VARIANT_OF", tagAVar, tagA),
    e("CONTAINS", page, tagB),
    e("CONTAINS", tagB, tagBVar),
    e("VARIANT_OF", tagBVar, tagB),
    e("CONTAINS", page, tableIcon),
    e("CONTAINS", tableIcon, "node:icon-table-v"),
    e("CONTAINS", page, searchIcon),
    e("CONTAINS", searchIcon, "node:icon-search-v"),
    e("CONTAINS", page, baseMenu),
    e("CONTAINS", baseMenu, baseMenuVar),
    e("VARIANT_OF", baseMenuVar, baseMenu),
    e("CONTAINS", page, oldBanner),
    e("CONTAINS", oldBanner, oldBannerVar),
    e("VARIANT_OF", oldBannerVar, oldBanner),
    e("CONTAINS", page, banner),
    e("CONTAINS", page, screen),
    e("CONTAINS", screen, inst),
    e("INSTANCE_OF", inst, primary),
    e("USED_IN", primary, inst),
    e("NESTS", screen, inst),
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

describe("real-library shape", () => {
  const index = realLibraryShape();

  it("name lookup picks the populated Button, not the empty stub", () => {
    const resolved = componentUsageCard(index, "Button", { workspace });
    expect(resolved.found).toBe(true);
    if (!resolved.found || resolved.kind !== "component") return;
    expect(resolved.component.id).toBe(ids.button);
    expect(resolved.instances).toBe(1);
    expect(resolved.note).toBeUndefined();
    const recommended = recommendMasters(index, "Button", { workspace });
    expect(recommended.candidates[0]?.id).toBe(ids.button);
    expect(preferNamedMaster(index, [index.getNode(ids.stub)!, index.getNode(ids.button)!])?.id).toBe(
      ids.button,
    );
    const tag = componentUsageCard(index, "Tag", { workspace });
    expect(tag.found).toBe(true);
    if (!tag.found || tag.kind !== "component") return;
    expect(tag.note).toMatch(/same name/i);
    expect(recommendMasters(index, "Tag", { workspace }).note).toMatch(/same name/i);
  });

  it("verify of a real master id stays on that master when a stub shares the name", () => {
    const byId = verifyFrame(index, { components: ["10:1"], workspace });
    expect(byId.resolved[0]?.id).toBe(ids.button);
    expect(byId.deprecated).toEqual([]);
    expect(byId.invents).toEqual([]);
    expect(byId.pass).toBe(true);
    const byName = verifyFrame(index, { components: ["Button"], workspace });
    expect(byName.resolved[0]?.id).toBe(ids.button);
  });

  it("ranks Table, Search field, and Dropdown over icons and base/ parts", () => {
    expect(recommendMasters(index, "data table").candidates[0]?.name).toBe("Table");
    expect(recommendMasters(index, "search bar").candidates[0]?.name).toBe("Search field");
    expect(recommendMasters(index, "select box").candidates[0]?.name).toBe("Dropdown");
    expect(recommendMasters(index, "select box").candidates.map((row) => row.name)).not.toContain(
      "base/menu-button",
    );
    expect(recommendMasters(index, "search icon").candidates[0]?.name).toBe("system-550-search");
    const exactBase = componentUsageCard(index, "base/menu-button");
    expect(exactBase.found).toBe(true);
    if (!exactBase.found || exactBase.kind !== "component") return;
    expect(exactBase.component.name).toBe("base/menu-button");
  });

  it("retired set variants are not recommended and fail verify", () => {
    const recommended = recommendMasters(index, "banner");
    expect(recommended.candidates[0]?.name).toBe("Banner");
    expect(recommended.candidates.some((row) => row.name === "Old Banner")).toBe(false);
    expect(recommended.candidates.some((row) => /Tone=Info/.test(row.name))).toBe(false);
    const old = recommendMasters(index, "Old Banner");
    expect(old.candidates[0]?.name).toBe("Banner");
    const verified = verifyFrame(index, { components: [ids.oldBannerVar] });
    expect(verified.pass).toBe(false);
    expect(verified.deprecated.some((hit) => hit.id === ids.oldBannerVar || hit.id === ids.oldBanner)).toBe(
      true,
    );
  });

  it("recommend cards name the set and keep three distinct families under 600", () => {
    const primary = recommendMasters(index, "primary button");
    expect(primary.candidates[0]?.name).toBe("Button");
    expect(primary.match).not.toBe("weak match");
    expect(primary.candidates[0] && "settings" in primary.candidates[0]).toBe(true);
    expect(JSON.stringify(primary.candidates[0])).not.toMatch(/Size=Small/);
    const secondary = recommendMasters(index, "secondary button");
    expect(secondary.candidates[0]?.name).toBe("Button");
    const field = recommendMasters(index, "search field");
    expect(field.candidates[0]?.name).toBe("Search field");
    expect(field.match).not.toBe("weak match");
    const mixed = recommendMasters(index, "button");
    const names = [...new Set(mixed.candidates.map((row) => row.name.split(" / ")[0]))];
    expect(names.length).toBe(mixed.candidates.length);
    expect(mixed.candidates.length).toBeGreaterThan(0);
    expect(mixed.candidates.length).toBeLessThanOrEqual(3);
    expect(mixed.cost.chars).toBeLessThanOrEqual(600);
  });

  it("score --init skips ambiguous names and the scorer does not throw", () => {
    const skipped: string[] = [];
    const cases = initGoldenCases(index, skipped);
    expect(skipped.map((name) => name.toLowerCase())).toContain("tag");
    expect(cases.some((row) => row.intent.toLowerCase() === "tag")).toBe(false);
    expect(resolveMasterByName(index, "Button").id).toBe(ids.button);
    expect(() =>
      scoreGraph(index, [{ id: "dup-button", intent: "Button", expected: "Button", expect: "master" }], {
        workspace,
      }),
    ).not.toThrow();
  });

  it("verify on a library page says this is not a screen", () => {
    const result = verifyFrame(index, { frame: "Components" });
    expect(result.pass).toBe(false);
    expect(JSON.stringify(result)).toContain('"result":"nothing checked"');
    expect(result.hint).toMatch(/library node/i);
    expect(result.hint).toMatch(/product frame/i);
  });
});
