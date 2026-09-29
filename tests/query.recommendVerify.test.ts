import { describe, expect, it } from "vitest";
import type { DesignGraph, GraphEdge, GraphNode, NodeType } from "@/core/model";
import {
  indexGraph,
  parseLibraryRules,
  recommendMasters,
  verifyFrame,
} from "@/core/query";
import { ids, index as demo } from "./fixture";

const FROZEN = "2026-01-01T00:00:00.000Z";

function n(
  id: string,
  type: NodeType,
  name: string,
  extra: Partial<GraphNode> = {},
): GraphNode {
  return { id, type, name, ...extra };
}

function e(type: GraphEdge["type"], source: string, target: string): GraphEdge {
  return { id: `${type}|${source}|${target}`, source, target, type };
}

/** Live primary CTA on Checkout Summary, unused name-trap, deprecated twin. */
function rankingLab() {
  const file = "file:RANK";
  const page = "node:p";
  const section = "node:s";
  const frame = "node:f";
  const btnSet = "node:btn-set";
  const live = "node:live";
  const dead = "node:dead";
  const ghost = "node:ghost";
  const row = "node:row";
  const instBtn = "node:ib";
  const instRow = "node:ir";

  const graph: DesignGraph = {
    fileKey: "RANK",
    fileName: "Ranking lab",
    builtAt: FROZEN,
    source: { kind: "mock", ingestedAt: FROZEN },
    warnings: [],
    nodes: [
      n(file, "FILE", "Ranking lab"),
      n(page, "PAGE", "App", { parentId: file, pageId: page }),
      n(section, "SECTION", "Flows", { parentId: page, pageId: page }),
      n(frame, "FRAME", "Checkout Summary", {
        parentId: section,
        pageId: page,
        sectionId: section,
        figmaNodeId: "1:1",
      }),
      n(btnSet, "COMPONENT_SET", "Button", { parentId: page, pageId: page, figmaNodeId: "9:0" }),
      n(live, "VARIANT", "Pay CTA", {
        parentId: btnSet,
        pageId: page,
        componentSetId: btnSet,
        figmaNodeId: "9:1",
        variantProperties: { Variant: "Primary" },
      }),
      n(dead, "VARIANT", "Old Pay CTA", {
        parentId: btnSet,
        pageId: page,
        componentSetId: btnSet,
        figmaNodeId: "9:2",
        variantProperties: { Variant: "Primary" },
        status: "deprecated",
      }),
      n(ghost, "MAIN_COMPONENT", "Checkout Summary Widget", {
        parentId: page,
        pageId: page,
        figmaNodeId: "7:1",
        isMainComponent: true,
      }),
      n(row, "MAIN_COMPONENT", "Payment method row", {
        parentId: page,
        pageId: page,
        figmaNodeId: "8:1",
        isMainComponent: true,
      }),
      n(instBtn, "COMPONENT_INSTANCE", "Pay CTA", {
        parentId: frame,
        pageId: page,
        sectionId: section,
        isInstance: true,
        mainComponentId: live,
        componentSetId: btnSet,
        figmaNodeId: "1:2",
      }),
      n(instRow, "COMPONENT_INSTANCE", "Payment method row", {
        parentId: frame,
        pageId: page,
        sectionId: section,
        isInstance: true,
        mainComponentId: row,
        figmaNodeId: "1:3",
      }),
    ],
    edges: [
      e("CONTAINS", file, page),
      e("CONTAINS", page, section),
      e("CONTAINS", section, frame),
      e("CONTAINS", frame, instBtn),
      e("CONTAINS", frame, instRow),
      e("CONTAINS", page, btnSet),
      e("CONTAINS", btnSet, live),
      e("CONTAINS", btnSet, dead),
      e("CONTAINS", page, ghost),
      e("CONTAINS", page, row),
      e("VARIANT_OF", live, btnSet),
      e("VARIANT_OF", dead, btnSet),
      e("INSTANCE_OF", instBtn, live),
      e("INSTANCE_OF", instRow, row),
      e("NESTS", frame, instBtn),
      e("NESTS", frame, instRow),
    ],
  };

  return { index: indexGraph(graph), ids: { live, dead, ghost, row } };
}

describe("recommend (library ranking)", () => {
  it("ranks analog masters for an intent without requiring the component name", () => {
    const result = recommendMasters(demo, "create account buttons");
    expect(result.candidates.length).toBeGreaterThan(0);
    const lead = result.candidates[0];
    expect(lead?.id).toBe(ids.buttonPrimaryLarge);
    expect(lead && "figmaNodeId" in lead && lead.figmaNodeId).toBeTruthy();
    expect(lead && "deprecated" in lead && lead.deprecated).toBe(false);
    expect(lead && "variantProperties" in lead && lead.variantProperties?.["Variant"]).toBe("Primary");
    expect(result.cost.chars).toBeLessThan(650);
    expect(result.hint).toMatch(/Do not Read graph\.json/);
  });

  it("demotes deprecated masters below live ones", () => {
    const result = recommendMasters(demo, "banner message");
    const banner = result.candidates.find((candidate) => candidate.id === ids.banner);
    expect(banner && "deprecated" in banner && banner.deprecated).toBe(true);
    const firstDeprecated = result.candidates.findIndex(
      (candidate) => "deprecated" in candidate && candidate.deprecated,
    );
    const lastLive = result.candidates.reduce(
      (last, candidate, index) => ("deprecated" in candidate && candidate.deprecated ? last : index),
      -1,
    );
    if (firstDeprecated >= 0 && lastLive >= 0) {
      expect(lastLive).toBeLessThan(firstDeprecated);
    }
  });

  it("prefers a live used master over a weak name match and a deprecated twin", () => {
    const { index, ids: lab } = rankingLab();
    const result = recommendMasters(index, "checkout summary with primary button");

    const lead = result.candidates[0];
    expect(lead?.id).toBe(lab.live);
    expect(lead && "figmaNodeId" in lead && lead.figmaNodeId).toBe("9:1");
    expect(lead && "deprecated" in lead && lead.deprecated).toBe(false);
    expect(lead && "variantProperties" in lead && lead.variantProperties?.["Variant"]).toBe("Primary");
    expect(lead?.name).toBe("Button / Variant=Primary");
    expect(typeof lead?.why).toBe("string");

    const ghost = result.candidates.find((candidate) => candidate.id === lab.ghost);
    const dead = result.candidates.find((candidate) => candidate.id === lab.dead);
    expect(result.candidates.findIndex((candidate) => candidate.id === lab.live)).toBe(0);
    if (ghost && "instances" in ghost) {
      expect(ghost.instances).toBe(0);
      expect(ghost.why).toBe("not verified on a screen yet");
    }
    if (dead && "deprecated" in dead) {
      expect(dead.deprecated).toBe(true);
      expect(result.candidates.findIndex((candidate) => candidate.id === lab.dead)).toBeGreaterThan(0);
    }
    expect(result.cost.chars).toBeLessThan(650);
  });

  it("boosts masters that co-occur with brief siblings on the same frame", () => {
    const { index, ids: lab } = rankingLab();
    const result = recommendMasters(index, "checkout with primary button and payment row", {
      budgetChars: 2000,
    });
    const live = result.candidates.find((candidate) => candidate.id === lab.live);
    const row = result.candidates.find((candidate) => candidate.id === lab.row);
    expect(live).toBeDefined();
    expect(row).toBeDefined();
    expect(live?.id).not.toBe(lab.ghost);
    expect(row?.id).toBe(lab.row);
    expect(result.candidates[0]?.id).not.toBe(lab.ghost);
    expect(result.candidates[0]?.id).not.toBe(lab.dead);
  });

  it("does not recommend invents or non-masters", () => {
    const result = recommendMasters(demo, "quantum flux capacitor widget");
    expect(result.candidates).toEqual([]);
    const live = recommendMasters(demo, "create account buttons");
    for (const candidate of live.candidates) {
      const node = demo.getNode(candidate.id);
      expect(node).toBeDefined();
      expect(["COMPONENT_SET", "MAIN_COMPONENT", "VARIANT"]).toContain(node?.type);
    }
    expect(live.candidates.some((candidate) => demo.getNode(candidate.id)?.type === "FRAME")).toBe(false);
  });

  it("ranks an exact name match first (Button / Avatar must not swap)", () => {
    const button = recommendMasters(demo, "Button");
    expect(button.candidates[0]?.name.toLowerCase()).toBe("button");
    expect(button.candidates.map((row) => row.name)).not.toEqual(["Avatar"]);

    const avatar = recommendMasters(demo, "avatar");
    expect(avatar.candidates[0]?.name.toLowerCase()).toBe("avatar");
    expect(avatar.candidates.map((row) => row.name)).not.toEqual(["Button"]);
  });
});

describe("verify_frame (invent detection)", () => {
  it("passes a frame that only nests live library masters", () => {
    const result = verifyFrame(demo, { frame: "Create account" });
    expect(result.unresolved).toEqual([]);
    expect(result.invents).toEqual([]);
    expect(result.deprecated).toEqual([]);
    expect(result.pass).toBe(true);
    expect(result.approved).toBeGreaterThan(0);
    expect(result.cost.chars).toBeLessThan(650);
  });

  it("flags proposed names that are not in the graph as invents", () => {
    const result = verifyFrame(demo, { components: ["Button", "MadeUpWidget"] });
    expect(result.pass).toBe(false);
    expect(result.invents.some((hit) => hit.name === "MadeUpWidget" && hit.reason === "not-in-graph")).toBe(
      true,
    );
    expect(result.approved).toBeGreaterThan(0);
  });

  it("flags deprecated masters and unresolved instances", () => {
    const deprecated = verifyFrame(demo, { components: [ids.banner] });
    expect(deprecated.pass).toBe(false);
    expect(deprecated.deprecated).toHaveLength(1);
    expect(deprecated.deprecated[0]?.id).toBe(ids.banner);

    const receipt = verifyFrame(demo, { frame: "Receipt" });
    expect(receipt.pass).toBe(false);
    expect(receipt.unresolved.length).toBeGreaterThan(0);
    expect(receipt.unresolved.every((hit) => hit.reason === "unresolved-instance")).toBe(true);
  });

  it("treats allow/deny rules as the approved set when a rules file is supplied", () => {
    const rules = parseLibraryRules({ allow: ["Button"], deny: ["Card"] });
    const result = verifyFrame(demo, { components: ["Button", "Card"], rules });
    expect(result.pass).toBe(false);
    expect(result.invents.some((hit) => hit.reason === "denied" && hit.name === "Card")).toBe(true);
  });

  it("stamps fileKey next to figmaNodeId on frame, invent, deprecated, and unresolved cards", () => {
    const { index } = rankingLab();
    const ok = verifyFrame(index, { frame: "Checkout Summary" });
    expect(ok.frame?.figmaNodeId).toBe("1:1");
    expect(ok.frame?.fileKey).toBe("RANK");

    const denied = verifyFrame(index, { components: ["Pay CTA"], rules: { deny: ["Pay CTA"] } });
    expect(denied.invents[0]?.figmaNodeId).toBe("9:1");
    expect(denied.invents[0]?.fileKey).toBe("RANK");
    expect(denied.invents[0]?.reason).toBe("denied");

    const deprecated = verifyFrame(demo, { components: [ids.banner] });
    expect(deprecated.deprecated[0]?.figmaNodeId).toBeTruthy();
    expect(deprecated.deprecated[0]?.fileKey).toBe("TESTKEY");

    const receipt = verifyFrame(demo, { frame: "Receipt" });
    expect(receipt.unresolved.length).toBeGreaterThan(0);
    expect(receipt.unresolved.every((hit) => hit.reason === "unresolved-instance")).toBe(true);
    expect(receipt.unresolved.every((hit) => hit.fileKey === "TESTKEY")).toBe(true);
    expect(receipt.unresolved.every((hit) => Boolean(hit.figmaNodeId))).toBe(true);
    expect(receipt.frame?.fileKey).toBe("TESTKEY");
    expect(receipt.frame?.figmaNodeId).toBeTruthy();
  });
});

/**
 * Small Material-like library: private `.Header`, public app bar, page-level
 * Search docked layout. Reproduces the live-kit invent risks.
 */
function materialLab() {
  const file = "file:M3";
  const page = "node:p";
  const privateHeader = "node:dot-header";
  const publicBar = "node:app-bar";
  const searchSet = "node:search-docked";
  const searchVariant = "node:search-var";

  const graph: DesignGraph = {
    fileKey: "M3",
    fileName: "Material 3 kit",
    builtAt: FROZEN,
    source: { kind: "mock", ingestedAt: FROZEN },
    warnings: [],
    nodes: [
      n(file, "FILE", "Material 3 kit", { fileKey: "M3" }),
      n(page, "PAGE", "Search", { parentId: file, pageId: page, fileKey: "M3" }),
      n(privateHeader, "MAIN_COMPONENT", ".Header", {
        parentId: page,
        pageId: page,
        figmaNodeId: "4:10",
        fileKey: "M3",
        isMainComponent: true,
      }),
      n(publicBar, "MAIN_COMPONENT", "App header", {
        parentId: page,
        pageId: page,
        figmaNodeId: "4:20",
        fileKey: "M3",
        isMainComponent: true,
      }),
      n(searchSet, "COMPONENT_SET", "Search docked layout", {
        parentId: page,
        pageId: page,
        figmaNodeId: "12:0",
        fileKey: "M3",
      }),
      n(searchVariant, "VARIANT", "Density=Default", {
        parentId: searchSet,
        pageId: page,
        componentSetId: searchSet,
        figmaNodeId: "12:1",
        fileKey: "M3",
        variantProperties: { Density: "Default" },
      }),
    ],
    edges: [
      e("CONTAINS", file, page),
      e("CONTAINS", page, privateHeader),
      e("CONTAINS", page, publicBar),
      e("CONTAINS", page, searchSet),
      e("CONTAINS", searchSet, searchVariant),
      e("VARIANT_OF", searchVariant, searchSet),
    ],
  };

  return { index: indexGraph(graph), ids: { privateHeader, publicBar, searchSet, searchVariant } };
}

describe("verify exact names — no fuzzy approve (Material invent)", () => {
  it("does not approve Header via fuzzy .Header, and echoes the given name", () => {
    const { index, ids: lab } = materialLab();
    const result = verifyFrame(index, { components: ["Header"] });

    expect(result.pass).toBe(false);
    expect(result.approved).toBe(0);
    expect(result.invents.some((hit) => hit.name === "Header" && hit.reason === "not-in-graph")).toBe(
      false,
    );
    const near = result.unresolved.find((hit) => hit.given === "Header" || hit.name === "Header");
    expect(near).toBeDefined();
    expect(near?.reason).toBe("not-exact");
    expect(near?.didYouMean?.name).toBe(".Header");
    expect(near?.didYouMean?.id).toBe(lab.privateHeader);
    expect(near?.didYouMean?.fileKey).toBe("M3");

    const echoed = result.resolved?.find((row) => row.given === "Header");
    expect(echoed?.given).toBe("Header");
    expect(echoed?.name).toBeUndefined();
    expect(echoed?.id).toBeUndefined();
  });

  it("does not approve Search layout as the Search docked layout set", () => {
    const { index } = materialLab();
    const result = verifyFrame(index, { components: ["Search layout"] });
    expect(result.pass).toBe(false);
    expect(result.approved).toBe(0);
    expect(result.unresolved.some((hit) => hit.reason === "not-exact" && hit.didYouMean?.name)).toBe(
      true,
    );
  });

  it("approves an exact name and echoes given, name, id, fileKey", () => {
    const { index, ids: lab } = materialLab();
    const result = verifyFrame(index, { components: ["App header"] });
    expect(result.pass).toBe(false);
    expect(JSON.stringify(result)).toContain('"result":"nothing checked"');
    expect(result.hint).not.toMatch(/verified/i);
    expect(result.approved).toBe(1);
    expect(result.resolved).toEqual([
      expect.objectContaining({
        given: "App header",
        name: "App header",
        id: lab.publicBar,
        fileKey: "M3",
      }),
    ]);
  });

  it("accepts a stamped fileKey:nodeId and does not report not-in-graph", () => {
    const { index, ids: lab } = materialLab();
    const result = verifyFrame(index, { components: ["M3:4:20"] });
    expect(result.pass).toBe(true);
    expect(result.approved).toBe(1);
    expect(result.resolved?.[0]).toEqual(
      expect.objectContaining({
        given: "M3:4:20",
        name: "App header",
        id: lab.publicBar,
        fileKey: "M3",
      }),
    );
  });

  it("does not approve a name-guessed product instance as a library master", () => {
    const { index } = materialLab();
    index.graph.nodes.push(
      n("node:fancy", "MAIN_COMPONENT", "Fancy Pay Button", {
        figmaNodeId: "mcp-name:Fancy Pay Button",
        fileKey: "M3",
        isMainComponent: true,
        metadata: { identity: "inferred-from-name" },
      }),
    );
    const result = verifyFrame(indexGraph(index.graph), { components: ["Fancy Pay Button"] });
    expect(result.pass).toBe(false);
    expect(result.approved).toBe(0);
    expect(result.invents.some((hit) => hit.name === "Fancy Pay Button" && hit.reason === "not-a-master")).toBe(
      true,
    );
  });

  it("flags an exact private master instead of approving it", () => {
    const { index, ids: lab } = materialLab();
    const result = verifyFrame(index, { components: [".Header"] });
    expect(result.pass).toBe(false);
    expect(result.approved).toBe(0);
    expect(result.invents.some((hit) => hit.reason === "private" && hit.id === lab.privateHeader)).toBe(
      true,
    );
  });
});

describe("recommend hides private masters and keeps search as a term", () => {
  it("does not return .Header for page header; prefers the public bar", () => {
    const { index, ids: lab } = materialLab();
    const result = recommendMasters(index, "page header");
    expect(result.candidates.every((candidate) => candidate.id !== lab.privateHeader)).toBe(true);
    expect(result.candidates.every((candidate) => !candidate.name.startsWith("."))).toBe(true);
    expect(result.candidates.some((candidate) => candidate.id === lab.publicBar)).toBe(true);
  });

  it("recommend search finds Search docked layout", () => {
    const { index, ids: lab } = materialLab();
    const result = recommendMasters(index, "search");
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(
      result.candidates.some(
        (candidate) => candidate.id === lab.searchSet || candidate.id === lab.searchVariant,
      ),
    ).toBe(true);
    expect(result.candidates.some((candidate) => candidate.name.includes("Search docked layout"))).toBe(
      true,
    );
    expect(result.cost.chars).toBeLessThanOrEqual(600);
  });
});

describe("card budgets with long variant labels", () => {
  it("keeps recommend and a four-name verify_frame within 600 characters", () => {
    const label = `Type=Primary, Note=${"x".repeat(180)}`;
    const nodes: GraphNode[] = [
      n("file:LIB", "FILE", "Long labels", { fileKey: "LIB" }),
      n("node:set", "COMPONENT_SET", "Button", { figmaNodeId: "1:1", fileKey: "LIB" }),
    ];
    const ids = ["1:2", "1:3", "1:4", "1:5"];
    for (const id of ids) {
      nodes.push(
        n(`node:${id}`, "VARIANT", label, {
          componentSetId: "node:set",
          figmaNodeId: id,
          fileKey: "LIB",
          variantProperties: { Type: "Primary", Note: "x".repeat(180) },
        }),
      );
    }
    const graph: DesignGraph = {
      fileKey: "LIB",
      fileName: "Long labels",
      builtAt: FROZEN,
      source: { kind: "mock", ingestedAt: FROZEN },
      warnings: [],
      nodes,
      edges: [],
    };
    const index = indexGraph(graph);
    const recommended = recommendMasters(index, "primary");
    expect(recommended.candidates.length).toBeGreaterThan(0);
    expect(recommended.cost.chars).toBeLessThanOrEqual(600);
    expect(JSON.stringify(recommended).length).toBeGreaterThan(200);

    const verified = verifyFrame(index, {
      components: ids.map((id) => `node:${id}`),
    });
    expect(verified.pass).toBe(true);
    expect(verified.approved).toBe(4);
    expect(verified.cost.chars).toBeLessThanOrEqual(600);
    expect(JSON.stringify(verified).length).toBeLessThanOrEqual(600);
  });

  it("fits a 213-character variant label plus three fake names in 600 characters", () => {
    const label = `Type=${"P".repeat(208)}`;
    expect(label).toHaveLength(213);
    const graph: DesignGraph = {
      fileKey: "LIB",
      fileName: "Long labels",
      builtAt: FROZEN,
      source: { kind: "mock", ingestedAt: FROZEN },
      warnings: [],
      nodes: [
        n("file:LIB", "FILE", "Long labels", { fileKey: "LIB" }),
        n("node:set", "COMPONENT_SET", "Button", { figmaNodeId: "1:1", fileKey: "LIB" }),
        n("node:variant", "VARIANT", label, {
          componentSetId: "node:set",
          figmaNodeId: "1:2",
          fileKey: "LIB",
          variantProperties: { Type: "P".repeat(208) },
        }),
      ],
      edges: [],
    };
    const verified = verifyFrame(indexGraph(graph), {
      components: [label, "Nope Alpha", "Nope Beta", "Nope Gamma"],
    });
    expect(verified.cost.chars).toBeLessThanOrEqual(600);
    expect(JSON.stringify(verified).length).toBeLessThanOrEqual(600);
  });

  it("fits four 213-character names in 600 characters", () => {
    const names = ["A", "B", "C", "D"].map((prefix) => `${prefix}${"y".repeat(212)}`);
    expect(names.every((name) => name.length === 213)).toBe(true);
    const graph: DesignGraph = {
      fileKey: "LIB",
      fileName: "Long labels",
      builtAt: FROZEN,
      source: { kind: "mock", ingestedAt: FROZEN },
      warnings: [],
      nodes: [n("file:LIB", "FILE", "Long labels", { fileKey: "LIB" })],
      edges: [],
    };
    const verified = verifyFrame(indexGraph(graph), { components: names });
    expect(verified.pass).toBe(false);
    expect(verified.cost.chars).toBeLessThanOrEqual(600);
    expect(JSON.stringify(verified).length).toBeLessThanOrEqual(600);
  });
});
