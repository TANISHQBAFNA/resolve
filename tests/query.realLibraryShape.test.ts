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

function realLibraryShape(options: { textField?: boolean } = {}) {
  const includeTextField = options.textField !== false;
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
    n("node:button-g", "VARIANT", "Style=Ghost, Size=Medium", {
      parentId: button,
      pageId: page,
      componentSetId: button,
      fileKey: "LIB",
      figmaNodeId: "10:5",
      variantProperties: { Style: "Ghost", Size: "Medium" },
    }),
    n(stub, "COMPONENT_SET", "Button", {
      parentId: page,
      pageId: page,
      fileKey: "APP",
      figmaNodeId: "99:1",
      isRemote: true,
    }),
    n("node:button-stub-thin", "COMPONENT_SET", "Button", {
      parentId: page,
      pageId: page,
      fileKey: "APP",
      figmaNodeId: "99:2",
      isRemote: true,
    }),
    n("node:button-stub-thin-g", "VARIANT", "Style=Ghost", {
      parentId: "node:button-stub-thin",
      pageId: page,
      componentSetId: "node:button-stub-thin",
      fileKey: "APP",
      figmaNodeId: "99:3",
      isRemote: true,
      variantProperties: { Style: "Ghost" },
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
    n(tableIcon, "MAIN_COMPONENT", "glyph-12-table", {
      parentId: page,
      pageId: page,
      fileKey: "LIB",
      figmaNodeId: "20:1",
      isMainComponent: true,
    }),
    n("node:icon-table-v", "LAYER", "shape", { parentId: tableIcon, pageId: page, fileKey: "LIB" }),
    n(searchIcon, "MAIN_COMPONENT", "glyph-24-search", {
      parentId: page,
      pageId: page,
      fileKey: "LIB",
      figmaNodeId: "21:1",
      isMainComponent: true,
    }),
    n("node:icon-search-v", "LAYER", "shape", { parentId: searchIcon, pageId: page, fileKey: "LIB" }),
    n(baseMenu, "COMPONENT_SET", "base/nav-chip", {
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
    ...(includeTextField
      ? [
          n("node:text-field", "COMPONENT_SET", "Text field", {
            parentId: page,
            pageId: page,
            fileKey: "LIB",
            figmaNodeId: "32:1",
          }),
          n("node:text-field-v", "VARIANT", "State=Default", {
            parentId: "node:text-field",
            pageId: page,
            componentSetId: "node:text-field",
            fileKey: "LIB",
            figmaNodeId: "32:2",
            variantProperties: { State: "Default" },
          }),
        ]
      : []),
    n("node:steps", "COMPONENT_SET", "Track dots", {
      parentId: page,
      pageId: page,
      fileKey: "LIB",
      figmaNodeId: "33:1",
    }),
    n("node:steps-v", "VARIANT", "State=Default", {
      parentId: "node:steps",
      pageId: page,
      componentSetId: "node:steps",
      fileKey: "LIB",
      figmaNodeId: "33:2",
      variantProperties: { State: "Default" },
    }),
    n("node:steps-private", "COMPONENT_SET", ".track-dots", {
      parentId: page,
      pageId: page,
      fileKey: "LIB",
      figmaNodeId: "33:3",
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
    e("CONTAINS", button, "node:button-g"),
    e("VARIANT_OF", primary, button),
    e("VARIANT_OF", secondary, button),
    e("VARIANT_OF", small, button),
    e("VARIANT_OF", "node:button-g", button),
    e("CONTAINS", page, stub),
    e("CONTAINS", page, "node:button-stub-thin"),
    e("CONTAINS", "node:button-stub-thin", "node:button-stub-thin-g"),
    e("VARIANT_OF", "node:button-stub-thin-g", "node:button-stub-thin"),
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
    ...(includeTextField
      ? [
          e("CONTAINS", page, "node:text-field"),
          e("CONTAINS", "node:text-field", "node:text-field-v"),
          e("VARIANT_OF", "node:text-field-v", "node:text-field"),
        ]
      : []),
    e("CONTAINS", page, "node:steps"),
    e("CONTAINS", "node:steps", "node:steps-v"),
    e("VARIANT_OF", "node:steps-v", "node:steps"),
    e("CONTAINS", page, "node:steps-private"),
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
    expect(resolved.note).toMatch(/populated local set/i);
    expect(resolved.note).not.toMatch(/same name as/i);
    const recommended = recommendMasters(index, "Button", { workspace });
    expect(recommended.candidates[0]?.id).toBe(ids.button);
    expect(recommended.note).toMatch(/populated local set/i);
    expect(recommended.note).not.toMatch(/same name as/i);
    expect(preferNamedMaster(index, [index.getNode(ids.stub)!, index.getNode(ids.button)!])?.id).toBe(
      ids.button,
    );
    const tag = componentUsageCard(index, "Tag", { workspace });
    expect(tag.found).toBe(true);
    if (!tag.found || tag.kind !== "component") return;
    expect(tag.note).toMatch(/same name/i);
    expect(tag.note).not.toMatch(/populated local set/i);
    expect(recommendMasters(index, "Tag", { workspace }).note).toMatch(/same name/i);
    expect(recommendMasters(index, "Tag", { workspace }).note).not.toMatch(/populated local set/i);
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
      "base/nav-chip",
    );
    expect(recommendMasters(index, "search icon").candidates[0]?.name).toBe("glyph-24-search");
    const exactBase = componentUsageCard(index, "base/nav-chip");
    expect(exactBase.found).toBe(true);
    if (!exactBase.found || exactBase.kind !== "component") return;
    expect(exactBase.component.name).toBe("base/nav-chip");
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

  it("icon button and ghost button pick the populated Button over empty and thin stubs", () => {
    for (const ask of ["icon button", "ghost button"]) {
      const recommended = recommendMasters(index, ask, { workspace });
      expect(recommended.candidates[0]?.id, ask).toBe(ids.button);
      expect(recommended.candidates[0]?.name, ask).toBe("Button");
      const resolved = componentUsageCard(index, "Button", { workspace });
      expect(resolved.found).toBe(true);
      if (!resolved.found || resolved.kind !== "component") return;
      expect(resolved.component.id, ask).toBe(ids.button);
    }
    expect(
      preferNamedMaster(
        index,
        [
          index.getNode("node:button-stub-thin")!,
          index.getNode(ids.stub)!,
          index.getNode(ids.button)!,
        ],
        workspace,
        "ghost button",
      )?.id,
    ).toBe(ids.button);
  });

  it("resolve and recommend pick the same master on same-name sets", () => {
    const resolved = componentUsageCard(index, "Button", { workspace });
    const recommended = recommendMasters(index, "Button", { workspace });
    expect(resolved.found).toBe(true);
    if (!resolved.found || resolved.kind !== "component") return;
    expect(recommended.candidates[0]?.id).toBe(resolved.component.id);
    const ghostResolved = componentUsageCard(index, "Button", { workspace });
    const ghostRecommended = recommendMasters(index, "ghost button", { workspace });
    expect(ghostResolved.found).toBe(true);
    if (!ghostResolved.found || ghostResolved.kind !== "component") return;
    expect(ghostRecommended.candidates[0]?.id).toBe(ghostResolved.component.id);
    const tagResolved = componentUsageCard(index, "Tag", { workspace });
    const tagRecommended = recommendMasters(index, "Tag", { workspace });
    expect(tagResolved.found).toBe(true);
    if (!tagResolved.found || tagResolved.kind !== "component") return;
    expect(tagRecommended.candidates[0]?.id).toBe(tagResolved.component.id);
  });

  it("with-icon asks rank the host, not a base/ part or bare icon", () => {
    const expectHost = (graph: ReturnType<typeof realLibraryShape>, ask: string, host: RegExp) => {
      const top = recommendMasters(graph, ask, { workspace }).candidates[0];
      expect(top?.name, ask).toMatch(host);
      expect(top?.name, ask).not.toMatch(/^base\//);
      expect(top?.name, ask).not.toMatch(/^glyph-/);
      expect(top?.name, ask).not.toMatch(/^\./);
    };
    const withField = realLibraryShape();
    expectHost(withField, "field with icon", /field/i);
    expectHost(withField, "button with icon", /^Button$/);
    expectHost(withField, "tag with icon", /^Tag$/);
    expect(recommendMasters(withField, "field with icon", { workspace }).candidates[0]?.name).toBe(
      "Text field",
    );
    const withoutField = realLibraryShape({ textField: false });
    expect(withoutField.getNode("node:text-field")).toBeUndefined();
    expectHost(withoutField, "field with icon", /field/i);
    expect(recommendMasters(withoutField, "field with icon", { workspace }).candidates[0]?.name).toBe(
      "Search field",
    );
    expectHost(withoutField, "button with icon", /^Button$/);
    expectHost(withoutField, "tag with icon", /^Tag$/);
  });

  it("prints a substitution note for a .track-dots private name", () => {
    const recommended = recommendMasters(index, "track-dots", { workspace });
    expect(recommended.candidates[0]?.name).toBe("Track dots");
    expect(recommended.note).toMatch(/substituted "\.track-dots"/i);
    const resolved = componentUsageCard(index, "track-dots", { workspace });
    expect(resolved.found).toBe(true);
    if (!resolved.found || resolved.kind !== "component") return;
    expect(resolved.component.name).toBe("Track dots");
    expect(resolved.note).toMatch(/substituted "\.track-dots"/i);
  });

  it("verify on a library page says this is not a screen", () => {
    const result = verifyFrame(index, { frame: "Components" });
    expect(result.pass).toBe(false);
    expect(JSON.stringify(result)).toContain('"result":"nothing checked"');
    expect(result.hint).toMatch(/library node/i);
    expect(result.hint).toMatch(/product frame/i);
  });
});

function vectorControlIndex() {
  const file = "file:LIB";
  const page = "node:page";
  const toggle = "node:toggle";
  const on = "node:toggle-on";
  const off = "node:toggle-off";
  const box = "node:toggle-box";
  const boxVar = "node:toggle-box-v";
  const loading = "node:loading";
  const radio = "node:radio";
  const radioIcon = "node:radio-icon";
  const nodes: GraphNode[] = [
    n(file, "FILE", "Library", { fileKey: "LIB" }),
    n(page, "PAGE", "Controls", { parentId: file, pageId: page, fileKey: "LIB" }),
    n(toggle, "COMPONENT_SET", "Toggle", { parentId: page, pageId: page, fileKey: "LIB", figmaNodeId: "1:1" }),
    n(on, "VARIANT", "State=On", {
      parentId: toggle,
      pageId: page,
      componentSetId: toggle,
      fileKey: "LIB",
      figmaNodeId: "1:2",
      variantProperties: { State: "On" },
    }),
    n("node:toggle-on-v", "LAYER", "knob", { parentId: on, pageId: page, fileKey: "LIB" }),
    n(off, "VARIANT", "State=Off", {
      parentId: toggle,
      pageId: page,
      componentSetId: toggle,
      fileKey: "LIB",
      figmaNodeId: "1:3",
      variantProperties: { State: "Off" },
    }),
    n("node:toggle-off-v", "LAYER", "track", { parentId: off, pageId: page, fileKey: "LIB" }),
    n(box, "COMPONENT_SET", "Toggle container", {
      parentId: page,
      pageId: page,
      fileKey: "LIB",
      figmaNodeId: "2:1",
    }),
    n(boxVar, "VARIANT", "State=Default", {
      parentId: box,
      pageId: page,
      componentSetId: box,
      fileKey: "LIB",
      figmaNodeId: "2:2",
      variantProperties: { State: "Default" },
    }),
    n("node:toggle-box-t", "TEXT_LAYER", "Label", { parentId: boxVar, pageId: page, fileKey: "LIB" }),
    n(loading, "MAIN_COMPONENT", "Loading", {
      parentId: page,
      pageId: page,
      fileKey: "LIB",
      figmaNodeId: "3:1",
      isMainComponent: true,
    }),
    n("node:loading-v", "LAYER", "arc", { parentId: loading, pageId: page, fileKey: "LIB" }),
    n(radio, "MAIN_COMPONENT", "Radio", {
      parentId: page,
      pageId: page,
      fileKey: "LIB",
      figmaNodeId: "4:1",
      isMainComponent: true,
    }),
    n("node:radio-v", "LAYER", "dot", { parentId: radio, pageId: page, fileKey: "LIB" }),
    n(radioIcon, "MAIN_COMPONENT", "glyph-16-radio", {
      parentId: page,
      pageId: page,
      fileKey: "LIB",
      figmaNodeId: "5:1",
      isMainComponent: true,
    }),
    n("node:radio-icon-v", "LAYER", "glyph", { parentId: radioIcon, pageId: page, fileKey: "LIB" }),
  ];
  const edges: GraphEdge[] = [
    e("CONTAINS", file, page),
    e("CONTAINS", page, toggle),
    e("CONTAINS", toggle, on),
    e("CONTAINS", on, "node:toggle-on-v"),
    e("VARIANT_OF", on, toggle),
    e("CONTAINS", toggle, off),
    e("CONTAINS", off, "node:toggle-off-v"),
    e("VARIANT_OF", off, toggle),
    e("CONTAINS", page, box),
    e("CONTAINS", box, boxVar),
    e("CONTAINS", boxVar, "node:toggle-box-t"),
    e("VARIANT_OF", boxVar, box),
    e("CONTAINS", page, loading),
    e("CONTAINS", loading, "node:loading-v"),
    e("CONTAINS", page, radio),
    e("CONTAINS", radio, "node:radio-v"),
    e("CONTAINS", page, radioIcon),
    e("CONTAINS", radioIcon, "node:radio-icon-v"),
  ];
  return indexGraph({
    fileKey: "LIB",
    fileName: "Library",
    builtAt: FROZEN,
    source: { kind: "mock", ingestedAt: FROZEN },
    warnings: [],
    nodes,
    edges,
  });
}

describe("vector-only controls are not icons", () => {
  const index = vectorControlIndex();

  it("ranks Toggle over Toggle container for switch asks", () => {
    for (const ask of ["switch", "toggle switch", "on off switch"]) {
      expect(recommendMasters(index, ask).candidates[0]?.name, ask).toBe("Toggle");
    }
  });

  it("still finds vector-only Loading and Radio", () => {
    expect(recommendMasters(index, "loading").candidates[0]?.name).toBe("Loading");
    expect(recommendMasters(index, "radio").candidates[0]?.name).toBe("Radio");
  });

  it("still demotes a coded icon name unless the ask says icon", () => {
    expect(recommendMasters(index, "radio").candidates[0]?.name).not.toBe("glyph-16-radio");
    expect(recommendMasters(index, "radio icon").candidates[0]?.name).toBe("glyph-16-radio");
  });
});

function notedLiveIndex() {
  const file = "file:LIB";
  const page = "node:page";
  const rows: Array<{ id: string; name: string; description: string; live: boolean }> = [
    { id: "node:a", name: "Alpha", description: "no legacy support needed", live: true },
    { id: "node:b", name: "Bravo", description: "Supports legacy browsers", live: true },
    { id: "node:c", name: "Charlie", description: "Please do not use outside marketing", live: true },
    { id: "node:d", name: "Delta", description: "Do not use inside tables", live: true },
    { id: "node:e", name: "Old Echo", description: "do not use", live: false },
    { id: "node:f", name: "Echo", description: "Live notice", live: true },
    { id: "node:g", name: "Golf", description: "Do not use outside profile cards", live: true },
    { id: "node:h", name: "Hotel", description: "Do not use for errors", live: true },
    { id: "node:i", name: "India", description: "Retired users, shown in admin table", live: true },
    { id: "node:j", name: "Juliett", description: "Obsolete data warning banner", live: true },
    { id: "node:k", name: "Old Kilo", description: "**Deprecated**", live: false },
    { id: "node:l", name: "Kilo", description: "Current kilo", live: true },
    { id: "node:m", name: "Old Mike", description: "Use Kilo. Deprecated.", live: false },
    { id: "node:n", name: "Mike", description: "Current mike", live: true },
    { id: "node:o", name: "Old Oscar", description: "This component is deprecated, use tab-bar instead", live: false },
  ];
  const extraLive = [
    n("node:p", "MAIN_COMPONENT", "Oscar", {
      parentId: page,
      pageId: page,
      fileKey: "LIB",
      isMainComponent: true,
      description: "Current oscar",
    }),
  ];
  const nodes: GraphNode[] = [
    n(file, "FILE", "Library", { fileKey: "LIB" }),
    n(page, "PAGE", "Notes", { parentId: file, pageId: page, fileKey: "LIB" }),
    ...rows.map((row) =>
      n(row.id, "MAIN_COMPONENT", row.name, {
        parentId: page,
        pageId: page,
        fileKey: "LIB",
        isMainComponent: true,
        description: row.description,
      }),
    ),
    ...extraLive,
  ];
  const edges: GraphEdge[] = [
    e("CONTAINS", file, page),
    ...rows.map((row) => e("CONTAINS", page, row.id)),
    e("CONTAINS", page, "node:p"),
  ];
  return {
    index: indexGraph({
      fileKey: "LIB",
      fileName: "Library",
      builtAt: FROZEN,
      source: { kind: "mock", ingestedAt: FROZEN },
      warnings: [],
      nodes,
      edges,
    }),
    rows,
  };
}

describe("description retire false positives stay live", () => {
  const { index, rows } = notedLiveIndex();

  it("15-set fixture keeps live notes and retires clause notes 15/15", () => {
    expect(rows).toHaveLength(15);
    for (const row of rows) {
      const card = recommendMasters(index, row.name);
      if (row.live) {
        expect(card.candidates[0]?.name, row.name).toBe(row.name);
        expect(card.candidates[0] && "deprecated" in card.candidates[0] && card.candidates[0].deprecated).toBe(
          false,
        );
      } else {
        expect(card.candidates.some((hit) => hit.name === row.name), row.name).toBe(false);
      }
    }
  });

  it("still retires a description that starts with do not use", () => {
    const card = recommendMasters(index, "Old Echo");
    expect(card.candidates[0]?.name).toBe("Echo");
    expect(card.candidates.some((row) => row.name === "Old Echo")).toBe(false);
  });
});
