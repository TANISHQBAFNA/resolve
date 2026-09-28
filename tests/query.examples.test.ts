import { describe, expect, it } from "vitest";
import type { DesignGraph, GraphEdge, GraphNode, NodeType } from "@/core/model";
import { adaptFigmaMcpMetadata } from "@/core/ingestion";
import { buildGraph } from "@/core/transform";
import {
  componentUsageCard,
  exampleCard,
  exampleFactForMasterOnFrame,
  examplePointer,
  fillRecipe,
  frameContentWarnings,
  getExample,
  indexGraph,
  NO_EXAMPLE,
  recommendMasters,
  resetDescribeCalls,
  takeDescribeCalls,
  TEXT_DEFAULT_UNKNOWN,
  TEXT_NO_FRAME,
  TEXT_NO_LAYERS,
  TEXT_UNCHECKED_REASON,
  verifyFrame,
  CLONE_INSTRUCTION,
} from "@/core/query";
import { TextInputError } from "@/core/ingestion/textStamps";
import { emptySock, recordVerifiedUsage } from "@/core/query/sock";
import { inventsInCard } from "@/core/query/scoreboard";

const FROZEN = "2026-01-01T00:00:00.000Z";

function n(id: string, type: NodeType, name: string, extra: Partial<GraphNode> = {}): GraphNode {
  return { id, type, name, ...extra };
}

function e(type: GraphEdge["type"], source: string, target: string): GraphEdge {
  return { id: `${type}|${source}|${target}`, source, target, type };
}

function graphOf(nodes: GraphNode[], edges: GraphEdge[], fileKey = "BENE"): ReturnType<typeof indexGraph> {
  const graph: DesignGraph = {
    fileKey,
    fileName: "Bene lab",
    builtAt: FROZEN,
    source: { kind: "mock", ingestedAt: FROZEN },
    warnings: [],
    nodes,
    edges,
  };
  return indexGraph(graph);
}

/** Bare default with leftover template text, plus a populated clone on another screen. */
function beneLab() {
  const file = "file:BENE";
  const page = "node:page";
  const pay = "node:pay";
  const ben = "node:ben";
  const legacy = "node:legacy";
  const set = "node:bene-set";
  const def = "node:bene-default";
  const defText = "node:bene-default-text";
  const quiet = "node:quiet";
  const old = "node:old";
  const secret = "node:secret";
  const payInst = "node:pay-dd";
  const payText = "node:pay-text";
  const benInst = "node:ben-dd";
  const oldInst = "node:old-dd";
  const secretInst = "node:secret-dd";

  const fixed = {
    layoutMode: "VERTICAL",
    layoutSizingVertical: "FIXED",
    minHeight: 320,
  };
  const hug = { layoutMode: "VERTICAL", layoutSizingVertical: "HUG" };

  const nodes: GraphNode[] = [
    n(file, "FILE", "Bene lab", { fileKey: "BENE" }),
    n(page, "PAGE", "Payments", { parentId: file, pageId: page, fileKey: "BENE" }),
    n(pay, "FRAME", "Payment", { parentId: page, pageId: page, figmaNodeId: "1:1", fileKey: "BENE" }),
    n(ben, "FRAME", "Beneficiary", { parentId: page, pageId: page, figmaNodeId: "2:1", fileKey: "BENE" }),
    n(legacy, "FRAME", "Legacy", { parentId: page, pageId: page, figmaNodeId: "3:1", fileKey: "BENE" }),
    n(set, "COMPONENT_SET", "Bene Dropdown", { parentId: page, pageId: page, figmaNodeId: "9:1", fileKey: "BENE" }),
    n(def, "VARIANT", "Type=Default", {
      parentId: set,
      pageId: page,
      componentSetId: set,
      figmaNodeId: "9:2",
      fileKey: "BENE",
      variantProperties: { Type: "Default" },
      bounds: { x: 0, y: 0, width: 320, height: 320 },
      metadata: fixed,
    }),
    n(defText, "TEXT_LAYER", "Request Bank Certificate", {
      parentId: def,
      pageId: page,
      bounds: { x: 0, y: 0, width: 200, height: 24 },
      metadata: { text: "Request Bank Certificate" },
    }),
    n(quiet, "MAIN_COMPONENT", "Quiet Toggle", {
      parentId: page,
      pageId: page,
      figmaNodeId: "9:9",
      fileKey: "BENE",
      isMainComponent: true,
    }),
    n(old, "MAIN_COMPONENT", "Old Dropdown", {
      parentId: page,
      pageId: page,
      figmaNodeId: "9:8",
      fileKey: "BENE",
      status: "deprecated",
      isMainComponent: true,
    }),
    n(secret, "MAIN_COMPONENT", "_Secret Row", {
      parentId: page,
      pageId: page,
      figmaNodeId: "9:7",
      fileKey: "BENE",
      isMainComponent: true,
    }),
    n(payInst, "COMPONENT_INSTANCE", "Bene Dropdown", {
      parentId: pay,
      pageId: page,
      isInstance: true,
      mainComponentId: def,
      componentSetId: set,
      figmaNodeId: "1:2",
      fileKey: "BENE",
      bounds: { x: 0, y: 0, width: 320, height: 320 },
      metadata: fixed,
    }),
    n(payText, "TEXT_LAYER", "Request Bank Certificate", {
      parentId: payInst,
      pageId: page,
      bounds: { x: 0, y: 8, width: 200, height: 24 },
      metadata: { text: "Request Bank Certificate" },
    }),
    n(benInst, "COMPONENT_INSTANCE", "Bene Dropdown", {
      parentId: ben,
      pageId: page,
      isInstance: true,
      mainComponentId: def,
      componentSetId: set,
      figmaNodeId: "2:2",
      fileKey: "BENE",
      bounds: { x: 0, y: 0, width: 320, height: 168 },
      metadata: hug,
    }),
    n("node:tab", "GROUP", "Radio Button Tab", {
      parentId: benInst,
      bounds: { x: 0, y: 0, width: 320, height: 40 },
    }),
    n("node:div1", "GROUP", "Title", {
      parentId: benInst,
      bounds: { x: 0, y: 40, width: 320, height: 16 },
    }),
    n("node:div2", "GROUP", "Title", {
      parentId: benInst,
      bounds: { x: 0, y: 56, width: 320, height: 16 },
    }),
    n("node:row1", "GROUP", "Dropdown Information", {
      parentId: benInst,
      bounds: { x: 0, y: 72, width: 320, height: 32 },
    }),
    n("node:row1t", "TEXT_LAYER", "Account 102938", {
      parentId: "node:row1",
      metadata: { text: "Account 102938" },
    }),
    n("node:row2", "GROUP", "Dropdown Information", {
      parentId: benInst,
      bounds: { x: 0, y: 104, width: 320, height: 32 },
    }),
    n("node:row2t", "TEXT_LAYER", "Swift BIC ABCD", {
      parentId: "node:row2",
      metadata: { text: "Swift BIC ABCD" },
    }),
    n("node:row3", "GROUP", "Dropdown Information", {
      parentId: benInst,
      bounds: { x: 0, y: 136, width: 320, height: 32 },
    }),
    n("node:row3t", "TEXT_LAYER", "Bank of Example", {
      parentId: "node:row3",
      metadata: { text: "Bank of Example" },
    }),
    n(oldInst, "COMPONENT_INSTANCE", "Old Dropdown", {
      parentId: legacy,
      pageId: page,
      isInstance: true,
      mainComponentId: old,
      figmaNodeId: "3:2",
      fileKey: "BENE",
    }),
    n("node:old-text", "TEXT_LAYER", "Retired template sentence here", {
      parentId: oldInst,
      metadata: { text: "Retired template sentence here" },
    }),
    n(secretInst, "COMPONENT_INSTANCE", "_Secret Row", {
      parentId: legacy,
      pageId: page,
      isInstance: true,
      mainComponentId: secret,
      figmaNodeId: "3:3",
      fileKey: "BENE",
    }),
  ];

  const contains: Array<[string, string]> = [
    [file, page],
    [page, pay],
    [page, ben],
    [page, legacy],
    [page, set],
    [page, quiet],
    [page, old],
    [page, secret],
    [set, def],
    [def, defText],
    [pay, payInst],
    [payInst, payText],
    [ben, benInst],
    [benInst, "node:tab"],
    [benInst, "node:div1"],
    [benInst, "node:div2"],
    [benInst, "node:row1"],
    [benInst, "node:row2"],
    [benInst, "node:row3"],
    ["node:row1", "node:row1t"],
    ["node:row2", "node:row2t"],
    ["node:row3", "node:row3t"],
    [legacy, oldInst],
    [legacy, secretInst],
    [oldInst, "node:old-text"],
  ];

  const edges: GraphEdge[] = [
    ...contains.map(([source, target]) => e("CONTAINS", source, target)),
    e("VARIANT_OF", def, set),
    e("INSTANCE_OF", payInst, def),
    e("INSTANCE_OF", benInst, def),
    e("INSTANCE_OF", oldInst, old),
    e("INSTANCE_OF", secretInst, secret),
    e("NESTS", pay, payInst),
    e("NESTS", ben, benInst),
    e("NESTS", legacy, oldInst),
    e("NESTS", legacy, secretInst),
  ];

  return {
    index: graphOf(nodes, edges),
    ids: { set, def, quiet, old, secret, payInst, benInst, pay, ben },
  };
}

describe("real example with every pick", () => {
  it("points recommend at the populated Bene Dropdown and says when none is known", () => {
    const { index, ids } = beneLab();
    const picked = recommendMasters(index, "bene dropdown");
    const lead = picked.candidates[0];
    expect(lead?.id).toBe(ids.set);
    expect(lead && "ex" in lead && lead.ex).toBe("2:2");
    expect(picked.cost.chars).toBeLessThanOrEqual(600);
    expect(inventsInCard(picked, index)).toEqual([]);

    const full = exampleCard(index, "Bene Dropdown");
    expect(full.found).toBe(true);
    if (!full.found) return;
    expect(full.nodeId).toBe("2:2");
    expect(full.fileKey).toBe("BENE");
    expect(full.screen).toBe("Beneficiary");
    expect(full.summary).toMatch(/Radio Button Tab/);
    expect(full.summary).toMatch(/Title×2/);
    expect(full.summary).toMatch(/Dropdown Information×3/);
    expect(full.summary).toMatch(/hug/);
    expect(full.instruction).toBe(CLONE_INSTRUCTION);
    expect(full.preferred).toBe(false);

    const none = recommendMasters(index, "quiet toggle");
    const noneLead = none.candidates[0];
    expect(noneLead && "ex" in noneLead && noneLead.ex).toBe("none");
    expect(noneLead && "exWhy" in noneLead && noneLead.exWhy).toBe("not on any screen");
    expect(none.cost.chars).toBeLessThanOrEqual(600);
    const missing = getExample(index, index.getNode(ids.quiet)!);
    expect(missing).toEqual({ found: false, reason: "not on any screen" });
    const missingCard = exampleCard(index, "Quiet Toggle");
    expect(missingCard.found).toBe(false);
    if (!missingCard.found) {
      expect(missingCard.ex).toBe("none");
      expect(missingCard.example).toBe(NO_EXAMPLE);
    }
    expect(inventsInCard(none, index)).toEqual([]);
  });

  it("does not use a retired or private component as the example", () => {
    const { index, ids } = beneLab();
    expect(getExample(index, index.getNode(ids.old)!)).toEqual({
      found: false,
      reason: "use the live replacement",
    });
    expect(getExample(index, index.getNode(ids.secret)!)).toEqual({
      found: false,
      reason: "not on any screen",
    });
    expect(getExample(index, index.getNode("node:pay")!)).toEqual({
      found: false,
      reason: "no such component — call recommend",
    });
    const live = getExample(index, index.getNode(ids.set)!);
    expect(live.found).toBe(true);
    if (live.found) {
      expect(live.example.nodeId).not.toBe("3:2");
      expect(live.example.nodeId).not.toBe("3:3");
    }
  });
});

describe("verify leftover text and sizing", () => {
  it("warns on the bare Bene default and passes a cloned populated instance", () => {
    const { index } = beneLab();
    const team = ["Request Bank Certificate"];
    const bare = verifyFrame(index, { frame: "Payment", placeholders: team });
    expect(bare.pass).toBe(false);
    const warnings = bare.warnings ?? [];
    expect(warnings.map((warning) => warning.kind).sort()).toEqual(["oversized-height", "placeholder"]);
    expect(warnings.every((warning) => warning.reason.split("\n").length === 1)).toBe(true);
    expect(warnings.find((warning) => warning.kind === "placeholder")?.reason).toMatch(/Request Bank Certificate/);
    expect(warnings.find((warning) => warning.kind === "oversized-height")?.reason).toMatch(/320/);
    expect(bare.cost.chars).toBeLessThanOrEqual(600);
    expect(JSON.stringify(bare).length).toBeLessThanOrEqual(600);
    expect(inventsInCard(bare, index)).toEqual([]);

    const cloned = verifyFrame(index, { frame: "Beneficiary" });
    expect(cloned.pass).toBe(true);
    expect(cloned.warnings).toBeUndefined();
    expect(cloned.cost.chars).toBeLessThanOrEqual(600);
    expect(inventsInCard(cloned, index)).toEqual([]);
  });

  it("warns when default copy survives and stays quiet on filled text", () => {
    const file = "file:L";
    const page = "node:p";
    const frame = "node:f";
    const master = "node:m";
    const masterText = "node:mt";
    const inst = "node:i";
    const text = "node:t";
    const index = graphOf(
      [
        n(file, "FILE", "Labels", { fileKey: "L" }),
        n(page, "PAGE", "App", { parentId: file, pageId: page }),
        n(frame, "FRAME", "Ship", { parentId: page, pageId: page, figmaNodeId: "4:1", fileKey: "L" }),
        n(master, "MAIN_COMPONENT", "Address Block", {
          parentId: page,
          pageId: page,
          figmaNodeId: "8:1",
          fileKey: "L",
          isMainComponent: true,
        }),
        n(masterText, "TEXT_LAYER", "Shipping address goes here", {
          parentId: master,
          metadata: { text: "Shipping address goes here" },
        }),
        n(inst, "COMPONENT_INSTANCE", "Address Block", {
          parentId: frame,
          pageId: page,
          isInstance: true,
          mainComponentId: master,
          figmaNodeId: "4:2",
          fileKey: "L",
          bounds: { x: 0, y: 0, width: 200, height: 40 },
          metadata: { layoutMode: "VERTICAL", layoutSizingVertical: "HUG" },
        }),
        n(text, "TEXT_LAYER", "Shipping address goes here", {
          parentId: inst,
          bounds: { x: 0, y: 0, width: 180, height: 40 },
          metadata: { text: "Shipping address goes here" },
        }),
      ],
      [
        e("CONTAINS", file, page),
        e("CONTAINS", page, frame),
        e("CONTAINS", page, master),
        e("CONTAINS", master, masterText),
        e("CONTAINS", frame, inst),
        e("CONTAINS", inst, text),
        e("INSTANCE_OF", inst, master),
        e("NESTS", frame, inst),
      ],
      "L",
    );
    const leftover = verifyFrame(index, { frame: "Ship" });
    expect(leftover.pass).toBe(true);
    expect(leftover.warnings?.map((warning) => warning.kind)).toEqual(["leftover-text"]);
    expect(leftover.warnings?.[0]?.reason).toMatch(/Shipping address goes here/);

    const filledText = index.getNode(text)!;
    filledText.name = "221B Baker Street";
    filledText.metadata = { text: "221B Baker Street" };
    const filled = verifyFrame(index, { frame: "Ship" });
    expect(filled.pass).toBe(true);
    expect(filled.warnings).toBeUndefined();
  });
});

describe("preferred example after verified use", () => {
  it("uses the configuration seen on 3 verified screens, else the best single instance", () => {
    const card = "node:card";
    const frames = ["node:a", "node:b", "node:c", "node:d"] as const;
    const names = ["Alpha", "Beta", "Gamma", "Wire"];
    const nodes: GraphNode[] = [
      n("file:S", "FILE", "Sock lab", { fileKey: "S" }),
      n("node:page", "PAGE", "Use", { parentId: "file:S", pageId: "node:page" }),
      n(card, "MAIN_COMPONENT", "Card", {
        parentId: "node:page",
        pageId: "node:page",
        figmaNodeId: "8:1",
        fileKey: "S",
        isMainComponent: true,
      }),
    ];
    const edges: GraphEdge[] = [e("CONTAINS", "file:S", "node:page"), e("CONTAINS", "node:page", card)];
    frames.forEach((frame, index) => {
      const rows = frame === "node:d" ? 5 : 2;
      nodes.push(
        n(frame, "FRAME", names[index]!, {
          parentId: "node:page",
          pageId: "node:page",
          figmaNodeId: `5:${index + 1}`,
          fileKey: "S",
        }),
      );
      const inst = `node:inst-${index}`;
      nodes.push(
        n(inst, "COMPONENT_INSTANCE", "Card", {
          parentId: frame,
          pageId: "node:page",
          isInstance: true,
          mainComponentId: card,
          figmaNodeId: `6:${index + 1}`,
          fileKey: "S",
          metadata: { layoutMode: "VERTICAL", layoutSizingVertical: "HUG" },
          bounds: { x: 0, y: 0, width: 200, height: rows * 20 },
        }),
      );
      edges.push(e("CONTAINS", "node:page", frame), e("CONTAINS", frame, inst), e("INSTANCE_OF", inst, card), e("NESTS", frame, inst));
      for (let row = 0; row < rows; row += 1) {
        const id = `node:row-${index}-${row}`;
        nodes.push(n(id, "GROUP", "Dropdown Information", { parentId: inst }));
        edges.push(e("CONTAINS", inst, id));
      }
    });
    const index = graphOf(nodes, edges, "S");
    const alone = getExample(index, index.getNode(card)!);
    expect(alone.found).toBe(true);
    if (alone.found) {
      expect(alone.example.preferred).toBe(false);
      expect(alone.example.nodeId).toBe("6:4");
    }

    let sock = emptySock();
    for (const frame of ["node:a", "node:b"] as const) {
      const fact = exampleFactForMasterOnFrame(index, frame, card);
      expect(fact?.configKey).toBeTruthy();
      sock = recordVerifiedUsage(sock, {
        screenId: frame,
        screenName: index.getNode(frame)!.name,
        countsTowardThreshold: true,
        masters: [{ id: card, name: "Card", ...fact }],
      });
    }
    const two = getExample(index, index.getNode(card)!, { sock });
    expect(two.found).toBe(true);
    if (two.found) expect(two.example.preferred).toBe(false);

    const gamma = exampleFactForMasterOnFrame(index, "node:c", card);
    sock = recordVerifiedUsage(sock, {
      screenId: "node:c",
      screenName: "Gamma",
      countsTowardThreshold: true,
      masters: [{ id: card, name: "Card", ...gamma }],
    });
    const three = getExample(index, index.getNode(card)!, { sock });
    expect(three.found).toBe(true);
    if (three.found) {
      expect(three.example.preferred).toBe(true);
      expect(three.example.nodeId).not.toBe("6:4");
      expect(three.example.summary).toMatch(/Dropdown Information×2/);
    }
    expect(inventsInCard(recommendMasters(index, "card", { sock }), index)).toEqual([]);
  });
});

const TEAM = ["Request Bank Certificate"];

describe("example pointer review fixes", () => {
  it("stamps the example file when the instance lives in another file", () => {
    const master = "node:btn";
    const screen = "node:screen";
    const inst = "node:inst";
    const index = graphOf(
      [
        n("file:LIB", "FILE", "Library", { fileKey: "LIB" }),
        n("node:page", "PAGE", "Components", { parentId: "file:LIB", pageId: "node:page", fileKey: "LIB" }),
        n(master, "MAIN_COMPONENT", "Button", {
          parentId: "node:page",
          pageId: "node:page",
          figmaNodeId: "9:1",
          fileKey: "LIB",
          isMainComponent: true,
        }),
        n(screen, "FRAME", "Checkout", { parentId: "node:page", pageId: "node:page", figmaNodeId: "2:1", fileKey: "APP" }),
        n(inst, "COMPONENT_INSTANCE", "Button", {
          parentId: screen,
          pageId: "node:page",
          isInstance: true,
          mainComponentId: master,
          figmaNodeId: "2:2",
          fileKey: "APP",
          metadata: { layoutMode: "HORIZONTAL", layoutSizingHorizontal: "HUG" },
          bounds: { x: 0, y: 0, width: 120, height: 40 },
        }),
        n("node:label", "TEXT_LAYER", "Pay the invoice today", {
          parentId: inst,
          metadata: { text: "Pay the invoice today" },
        }),
      ],
      [
        e("CONTAINS", "file:LIB", "node:page"),
        e("CONTAINS", "node:page", master),
        e("CONTAINS", "node:page", screen),
        e("CONTAINS", screen, inst),
        e("CONTAINS", inst, "node:label"),
        e("INSTANCE_OF", inst, master),
        e("NESTS", screen, inst),
      ],
      "LIB",
    );
    const button = index.getNode(master)!;
    const pointer = examplePointer(index, button, { graphFileKey: "LIB" }, "id");
    expect(pointer.ex).toBe("APP:2:2");
    expect(pointer.exFileKey).toBe("APP");
    const screenPointer = examplePointer(index, button, { graphFileKey: "LIB" }, "screen");
    expect(screenPointer.ex).toBe("APP:2:2@Checkout");
    expect(screenPointer.exFileKey).toBe("APP");

    const picked = recommendMasters(index, "button");
    const lead = picked.candidates[0];
    expect(lead && "fileKey" in lead && lead.fileKey).toBe("LIB");
    expect(lead && "ex" in lead && lead.ex).toBe("APP:2:2");
    expect(lead && "exFileKey" in lead && lead.exFileKey).toBe("APP");

    const resolved = componentUsageCard(index, "Button");
    expect(resolved.found).toBe(true);
    if (resolved.found && resolved.kind === "component") {
      expect(resolved.ex).toBe("APP:2:2@Checkout");
      expect(resolved.exFileKey).toBe("APP");
    }

    const filled = fillRecipe(index, {
      id: "pay",
      title: "Pay",
      intentAliases: ["pay"],
      slots: [{ role: "button", required: true, hints: ["button"], defaultMasterId: master }],
    });
    expect(filled.slots[0]?.master?.ex).toBe("APP:2:2@Checkout");
    expect(filled.slots[0]?.master?.exFileKey).toBe("APP");
    expect(filled.slots[0]?.master?.fileKey).toBe("LIB");
  });

  it("does not point a variant at a different variant's instance", () => {
    const set = "node:set";
    const primary = "node:primary";
    const danger = "node:danger";
    const screen = "node:screen";
    const inst = "node:inst";
    const index = graphOf(
      [
        n("file:B", "FILE", "Buttons", { fileKey: "B" }),
        n("node:page", "PAGE", "UI", { parentId: "file:B", pageId: "node:page", fileKey: "B" }),
        n(set, "COMPONENT_SET", "Button", { parentId: "node:page", pageId: "node:page", figmaNodeId: "9:1", fileKey: "B" }),
        n(primary, "VARIANT", "Type=Primary", {
          parentId: set,
          pageId: "node:page",
          componentSetId: set,
          figmaNodeId: "9:2",
          fileKey: "B",
          variantProperties: { Type: "Primary" },
        }),
        n(danger, "VARIANT", "Type=Destructive", {
          parentId: set,
          pageId: "node:page",
          componentSetId: set,
          figmaNodeId: "9:3",
          fileKey: "B",
          variantProperties: { Type: "Destructive" },
        }),
        n(screen, "FRAME", "Pay", { parentId: "node:page", pageId: "node:page", figmaNodeId: "1:1", fileKey: "B" }),
        n(inst, "COMPONENT_INSTANCE", "Button", {
          parentId: screen,
          pageId: "node:page",
          isInstance: true,
          mainComponentId: danger,
          componentSetId: set,
          figmaNodeId: "1:2",
          fileKey: "B",
          variantProperties: { Type: "Destructive" },
          metadata: { layoutMode: "HORIZONTAL", layoutSizingHorizontal: "HUG" },
        }),
        n("node:t", "TEXT_LAYER", "Delete this account now", {
          parentId: inst,
          metadata: { text: "Delete this account now" },
        }),
      ],
      [
        e("CONTAINS", "file:B", "node:page"),
        e("CONTAINS", "node:page", set),
        e("CONTAINS", "node:page", screen),
        e("CONTAINS", set, primary),
        e("CONTAINS", set, danger),
        e("VARIANT_OF", primary, set),
        e("VARIANT_OF", danger, set),
        e("CONTAINS", screen, inst),
        e("CONTAINS", inst, "node:t"),
        e("INSTANCE_OF", inst, danger),
        e("NESTS", screen, inst),
      ],
      "B",
    );
    const primaryNode = index.getNode(primary)!;
    expect(getExample(index, primaryNode)).toEqual({ found: false, reason: "not on any screen" });
    const picked = recommendMasters(index, "Button / Type=Primary");
    const lead = picked.candidates.find((row) => row.id === primary) ?? picked.candidates[0];
    expect(lead?.id).toBe(primary);
    expect(lead && "ex" in lead && lead.ex).toBe("none");
    expect(lead && "exWhy" in lead && lead.exWhy).toBe("not on any screen");

    const dangerExample = getExample(index, index.getNode(danger)!);
    expect(dangerExample.found).toBe(true);
    if (dangerExample.found) expect(dangerExample.example.nodeId).toBe("1:2");

    let sock = emptySock();
    for (const id of ["s1", "s2", "s3"]) {
      const fact = exampleFactForMasterOnFrame(index, screen, danger);
      sock = recordVerifiedUsage(sock, {
        screenId: id,
        screenName: "Pay",
        countsTowardThreshold: true,
        masters: [{ id: danger, name: "Type=Destructive", ...fact }],
      });
    }
    const learned = getExample(index, primaryNode, { sock });
    expect(learned).toEqual({ found: false, reason: "not on any screen" });
    const dangerLearned = getExample(index, index.getNode(danger)!, { sock });
    expect(dangerLearned.found).toBe(true);
    if (dangerLearned.found) expect(dangerLearned.example.preferred).toBe(true);
  });

  it("never picks an instance whose text is lorem filler", () => {
    const master = "node:m";
    const loremScreen = "node:lorem-screen";
    const realScreen = "node:real-screen";
    const loremInst = "node:lorem";
    const realInst = "node:real";
    const index = graphOf(
      [
        n("file:L", "FILE", "Copy", { fileKey: "L" }),
        n("node:page", "PAGE", "Screens", { parentId: "file:L", pageId: "node:page", fileKey: "L" }),
        n(master, "MAIN_COMPONENT", "Note", {
          parentId: "node:page",
          pageId: "node:page",
          figmaNodeId: "8:1",
          fileKey: "L",
          isMainComponent: true,
        }),
        n("node:md", "TEXT_LAYER", "Note", { parentId: master, metadata: { text: "Note" } }),
        n(loremScreen, "FRAME", "Draft", { parentId: "node:page", pageId: "node:page", figmaNodeId: "1:1", fileKey: "L" }),
        n(loremInst, "COMPONENT_INSTANCE", "Note", {
          parentId: loremScreen,
          pageId: "node:page",
          isInstance: true,
          mainComponentId: master,
          figmaNodeId: "1:2",
          fileKey: "L",
          metadata: { layoutMode: "VERTICAL", layoutSizingVertical: "HUG" },
        }),
        n("node:lt", "TEXT_LAYER", "Lorem ipsum dolor sit amet", {
          parentId: loremInst,
          metadata: { text: "Lorem ipsum dolor sit amet" },
        }),
        n(realScreen, "FRAME", "Live", { parentId: "node:page", pageId: "node:page", figmaNodeId: "2:1", fileKey: "L" }),
        n(realInst, "COMPONENT_INSTANCE", "Note", {
          parentId: realScreen,
          pageId: "node:page",
          isInstance: true,
          mainComponentId: master,
          figmaNodeId: "2:2",
          fileKey: "L",
          metadata: { layoutMode: "VERTICAL", layoutSizingVertical: "HUG" },
        }),
        n("node:rt", "TEXT_LAYER", "Wire arrived this morning", {
          parentId: realInst,
          metadata: { text: "Wire arrived this morning" },
        }),
      ],
      [
        e("CONTAINS", "file:L", "node:page"),
        e("CONTAINS", "node:page", master),
        e("CONTAINS", master, "node:md"),
        e("CONTAINS", "node:page", loremScreen),
        e("CONTAINS", "node:page", realScreen),
        e("CONTAINS", loremScreen, loremInst),
        e("CONTAINS", loremInst, "node:lt"),
        e("CONTAINS", realScreen, realInst),
        e("CONTAINS", realInst, "node:rt"),
        e("INSTANCE_OF", loremInst, master),
        e("INSTANCE_OF", realInst, master),
        e("NESTS", loremScreen, loremInst),
        e("NESTS", realScreen, realInst),
      ],
      "L",
    );
    const example = getExample(index, index.getNode(master)!);
    expect(example.found).toBe(true);
    if (example.found) expect(example.example.nodeId).toBe("2:2");
    const dirty = verifyFrame(index, { frame: "Draft" });
    expect(dirty.pass).toBe(false);
    expect(dirty.warnings?.some((warning) => warning.kind === "placeholder")).toBe(true);
    const clean = verifyFrame(index, { frame: "Live" });
    expect(clean.pass).toBe(true);
  });

  it("fails Request Bank Certificate only when the team list says so", () => {
    const { index } = beneLab();
    const open = verifyFrame(index, { frame: "Payment" });
    expect(open.pass).toBe(true);
    expect(open.warnings?.map((warning) => warning.kind).sort()).toEqual(["leftover-text", "oversized-height"]);
    const listed = verifyFrame(index, { frame: "Payment", placeholders: TEAM });
    expect(listed.pass).toBe(false);
    expect(listed.warnings?.some((warning) => warning.kind === "placeholder")).toBe(true);

    const titled = graphOf(
      [
        n("file:BANK", "FILE", "Bank", { fileKey: "BANK" }),
        n("node:page", "PAGE", "Move", { parentId: "file:BANK", pageId: "node:page", fileKey: "BANK" }),
        n("node:frame", "FRAME", "Request Bank Certificate", {
          parentId: "node:page",
          pageId: "node:page",
          figmaNodeId: "4:1",
          fileKey: "BANK",
        }),
        n("node:m", "MAIN_COMPONENT", "Title", {
          parentId: "node:page",
          pageId: "node:page",
          figmaNodeId: "8:1",
          fileKey: "BANK",
          isMainComponent: true,
        }),
        n("node:md", "TEXT_LAYER", "Heading", { parentId: "node:m", metadata: { text: "Heading" } }),
        n("node:i", "COMPONENT_INSTANCE", "Title", {
          parentId: "node:frame",
          pageId: "node:page",
          isInstance: true,
          mainComponentId: "node:m",
          figmaNodeId: "4:2",
          fileKey: "BANK",
          metadata: { layoutMode: "HORIZONTAL", layoutSizingHorizontal: "HUG" },
          bounds: { x: 0, y: 0, width: 240, height: 32 },
        }),
        n("node:t", "TEXT_LAYER", "Request Bank Certificate", {
          parentId: "node:i",
          metadata: { text: "Request Bank Certificate" },
        }),
      ],
      [
        e("CONTAINS", "file:BANK", "node:page"),
        e("CONTAINS", "node:page", "node:frame"),
        e("CONTAINS", "node:page", "node:m"),
        e("CONTAINS", "node:m", "node:md"),
        e("CONTAINS", "node:frame", "node:i"),
        e("CONTAINS", "node:i", "node:t"),
        e("INSTANCE_OF", "node:i", "node:m"),
        e("NESTS", "node:frame", "node:i"),
      ],
      "BANK",
    );
    const bank = verifyFrame(titled, { frame: "Request Bank Certificate", placeholders: TEAM });
    expect(bank.pass).toBe(true);
    expect(bank.warnings?.some((warning) => warning.kind === "placeholder")).toBeFalsy();
  });

  it("hard-fails the word Placeholder only when it is the master default", () => {
    const build = (defaultText: string, instanceText: string) => {
      const index = graphOf(
        [
          n("file:P", "FILE", "P", { fileKey: "P" }),
          n("node:page", "PAGE", "P", { parentId: "file:P", pageId: "node:page", fileKey: "P" }),
          n("node:f", "FRAME", "Form", { parentId: "node:page", pageId: "node:page", figmaNodeId: "1:1", fileKey: "P" }),
          n("node:m", "MAIN_COMPONENT", "Label", {
            parentId: "node:page",
            pageId: "node:page",
            figmaNodeId: "8:1",
            fileKey: "P",
            isMainComponent: true,
          }),
          n("node:md", "TEXT_LAYER", defaultText, { parentId: "node:m", metadata: { text: defaultText } }),
          n("node:i", "COMPONENT_INSTANCE", "Label", {
            parentId: "node:f",
            pageId: "node:page",
            isInstance: true,
            mainComponentId: "node:m",
            figmaNodeId: "1:2",
            fileKey: "P",
            metadata: { layoutMode: "HORIZONTAL", layoutSizingHorizontal: "HUG" },
          }),
          n("node:t", "TEXT_LAYER", instanceText, { parentId: "node:i", metadata: { text: instanceText } }),
        ],
        [
          e("CONTAINS", "file:P", "node:page"),
          e("CONTAINS", "node:page", "node:f"),
          e("CONTAINS", "node:page", "node:m"),
          e("CONTAINS", "node:m", "node:md"),
          e("CONTAINS", "node:f", "node:i"),
          e("CONTAINS", "node:i", "node:t"),
          e("INSTANCE_OF", "node:i", "node:m"),
          e("NESTS", "node:f", "node:i"),
        ],
        "P",
      );
      return verifyFrame(index, { frame: "Form" });
    };
    const asDefault = build("Placeholder", "Placeholder");
    expect(asDefault.pass).toBe(false);
    expect(asDefault.warnings?.some((warning) => warning.kind === "placeholder")).toBe(true);
    const asCopy = build("Heading", "Placeholder");
    expect(asCopy.pass).toBe(true);
    expect(asCopy.warnings?.some((warning) => warning.kind === "placeholder")).toBeFalsy();
  });

  it("picks the known product before a preferred shape from another product", () => {
    const card = "node:card";
    const nodes: GraphNode[] = [
      n("file:S", "FILE", "Products", { fileKey: "S" }),
      n("node:page", "PAGE", "Use", { parentId: "file:S", pageId: "node:page", fileKey: "S" }),
      n(card, "MAIN_COMPONENT", "Summary", {
        parentId: "node:page",
        pageId: "node:page",
        figmaNodeId: "8:1",
        fileKey: "S",
        isMainComponent: true,
      }),
    ];
    const edges: GraphEdge[] = [e("CONTAINS", "file:S", "node:page"), e("CONTAINS", "node:page", card)];
    const screens = [
      { id: "node:l1", name: "Loans one", fig: "1:1", inst: "5:1", rows: 2 },
      { id: "node:l2", name: "Loans two", fig: "1:2", inst: "5:2", rows: 2 },
      { id: "node:l3", name: "Loans three", fig: "1:3", inst: "5:3", rows: 2 },
      { id: "node:cards", name: "Cards home", fig: "2:1", inst: "6:1", rows: 1 },
    ];
    for (const screen of screens) {
      nodes.push(
        n(screen.id, "FRAME", screen.name, {
          parentId: "node:page",
          pageId: "node:page",
          figmaNodeId: screen.fig,
          fileKey: "S",
        }),
      );
      const inst = `node:${screen.inst}`;
      nodes.push(
        n(inst, "COMPONENT_INSTANCE", "Summary", {
          parentId: screen.id,
          pageId: "node:page",
          isInstance: true,
          mainComponentId: card,
          figmaNodeId: screen.inst,
          fileKey: "S",
          metadata: { layoutMode: "VERTICAL", layoutSizingVertical: "HUG" },
          bounds: { x: 0, y: 0, width: 200, height: screen.rows * 24 },
        }),
      );
      edges.push(
        e("CONTAINS", "node:page", screen.id),
        e("CONTAINS", screen.id, inst),
        e("INSTANCE_OF", inst, card),
        e("NESTS", screen.id, inst),
      );
      for (let row = 0; row < screen.rows; row += 1) {
        const id = `node:row-${screen.inst}-${row}`;
        nodes.push(n(id, "GROUP", "Dropdown Information", { parentId: inst }));
        edges.push(e("CONTAINS", inst, id));
      }
    }
    const index = graphOf(nodes, edges, "S");
    let sock = emptySock();
    for (const screen of screens.slice(0, 3)) {
      const fact = exampleFactForMasterOnFrame(index, screen.id, card);
      sock = recordVerifiedUsage(sock, {
        screenId: screen.id,
        screenName: screen.name,
        countsTowardThreshold: true,
        product: "Loans",
        masters: [{ id: card, name: "Summary", ...fact }],
      });
    }
    const cards = getExample(index, index.getNode(card)!, { sock, product: "Cards" });
    expect(cards.found).toBe(true);
    if (cards.found) {
      expect(cards.example.nodeId).toBe("6:1");
      expect(cards.example.preferred).toBe(false);
      expect(cards.example.exNote).toBeUndefined();
    }
    const other = getExample(index, index.getNode(card)!, { sock, product: "Treasury" });
    expect(other.found).toBe(true);
    if (other.found) expect(other.example.exNote).toBe("other product");
  });

  it("ranks a real screen above a docs frame and matches shape words on boundaries", () => {
    const master = "node:dd";
    const index = graphOf(
      [
        n("file:D", "FILE", "Docs", { fileKey: "D" }),
        n("node:page", "PAGE", "Lib", { parentId: "file:D", pageId: "node:page", fileKey: "D" }),
        n(master, "MAIN_COMPONENT", "Dropdown", {
          parentId: "node:page",
          pageId: "node:page",
          figmaNodeId: "8:1",
          fileKey: "D",
          isMainComponent: true,
        }),
        n("node:docs", "FRAME", "Dropdown — Docs & usage", {
          parentId: "node:page",
          pageId: "node:page",
          figmaNodeId: "1:1",
          fileKey: "D",
        }),
        n("node:docs-i", "COMPONENT_INSTANCE", "Dropdown", {
          parentId: "node:docs",
          pageId: "node:page",
          isInstance: true,
          mainComponentId: master,
          figmaNodeId: "1:2",
          fileKey: "D",
          metadata: { layoutMode: "VERTICAL", layoutSizingVertical: "HUG" },
        }),
        n("node:docs-t", "TEXT_LAYER", "Sample account", { parentId: "node:docs-i", metadata: { text: "Sample account" } }),
        n("node:arrow", "GROUP", "Arrow", { parentId: "node:docs-i" }),
        n("node:table", "GROUP", "Table", { parentId: "node:docs-i" }),
        n("node:live", "FRAME", "Checkout", {
          parentId: "node:page",
          pageId: "node:page",
          figmaNodeId: "2:1",
          fileKey: "D",
        }),
        n("node:live-i", "COMPONENT_INSTANCE", "Dropdown", {
          parentId: "node:live",
          pageId: "node:page",
          isInstance: true,
          mainComponentId: master,
          figmaNodeId: "2:2",
          fileKey: "D",
          metadata: { layoutMode: "VERTICAL", layoutSizingVertical: "HUG" },
        }),
        n("node:live-t", "TEXT_LAYER", "Checking", { parentId: "node:live-i", metadata: { text: "Checking" } }),
        n("node:tab", "GROUP", "Radio Button Tab", { parentId: "node:live-i" }),
      ],
      [
        e("CONTAINS", "file:D", "node:page"),
        e("CONTAINS", "node:page", master),
        e("CONTAINS", "node:page", "node:docs"),
        e("CONTAINS", "node:page", "node:live"),
        e("CONTAINS", "node:docs", "node:docs-i"),
        e("CONTAINS", "node:docs-i", "node:docs-t"),
        e("CONTAINS", "node:docs-i", "node:arrow"),
        e("CONTAINS", "node:docs-i", "node:table"),
        e("CONTAINS", "node:live", "node:live-i"),
        e("CONTAINS", "node:live-i", "node:live-t"),
        e("CONTAINS", "node:live-i", "node:tab"),
        e("INSTANCE_OF", "node:docs-i", master),
        e("INSTANCE_OF", "node:live-i", master),
        e("NESTS", "node:docs", "node:docs-i"),
        e("NESTS", "node:live", "node:live-i"),
      ],
      "D",
    );
    const example = getExample(index, index.getNode(master)!);
    expect(example.found).toBe(true);
    if (example.found) {
      expect(example.example.nodeId).toBe("2:2");
      expect(example.example.screen).toBe("Checkout");
      expect(example.example.summary).toMatch(/Radio Button Tab/);
      expect(example.example.summary).not.toMatch(/Arrow/);
      expect(example.example.summary).not.toMatch(/Table/);
    }
  });

  it("skips oversized warnings when peers share the fixed height, and skips input hints", () => {
    const banner = "node:banner";
    const input = "node:input";
    const index = graphOf(
      [
        n("file:H", "FILE", "Hints", { fileKey: "H" }),
        n("node:page", "PAGE", "UI", { parentId: "file:H", pageId: "node:page", fileKey: "H" }),
        n("node:frame", "FRAME", "Home", { parentId: "node:page", pageId: "node:page", figmaNodeId: "1:1", fileKey: "H" }),
        n(banner, "MAIN_COMPONENT", "Promo Banner", {
          parentId: "node:page",
          pageId: "node:page",
          figmaNodeId: "8:1",
          fileKey: "H",
          isMainComponent: true,
          metadata: { layoutMode: "VERTICAL", layoutSizingVertical: "FIXED" },
          bounds: { x: 0, y: 0, width: 320, height: 120 },
        }),
        n("node:bt", "TEXT_LAYER", "Promo", { parentId: banner, metadata: { text: "Promo" }, bounds: { x: 0, y: 0, width: 80, height: 24 } }),
        n(input, "MAIN_COMPONENT", "Email Input", {
          parentId: "node:page",
          pageId: "node:page",
          figmaNodeId: "8:2",
          fileKey: "H",
          isMainComponent: true,
        }),
        n("node:ih", "TEXT_LAYER", "Hint", { parentId: input, metadata: { text: "Enter your email" } }),
        n("node:b1", "COMPONENT_INSTANCE", "Promo Banner", {
          parentId: "node:frame",
          pageId: "node:page",
          isInstance: true,
          mainComponentId: banner,
          figmaNodeId: "1:2",
          fileKey: "H",
          metadata: { layoutMode: "VERTICAL", layoutSizingVertical: "FIXED" },
          bounds: { x: 0, y: 0, width: 320, height: 120 },
        }),
        n("node:b1t", "TEXT_LAYER", "New card offer today", {
          parentId: "node:b1",
          metadata: { text: "New card offer today" },
          bounds: { x: 0, y: 8, width: 80, height: 24 },
        }),
        n("node:b2", "COMPONENT_INSTANCE", "Promo Banner", {
          parentId: "node:frame",
          pageId: "node:page",
          isInstance: true,
          mainComponentId: banner,
          figmaNodeId: "1:3",
          fileKey: "H",
          metadata: { layoutMode: "VERTICAL", layoutSizingVertical: "FIXED" },
          bounds: { x: 0, y: 140, width: 320, height: 120 },
        }),
        n("node:b2t", "TEXT_LAYER", "Rewards landed today", {
          parentId: "node:b2",
          metadata: { text: "Rewards landed today" },
          bounds: { x: 0, y: 8, width: 80, height: 24 },
        }),
        n("node:ii", "COMPONENT_INSTANCE", "Email Input", {
          parentId: "node:frame",
          pageId: "node:page",
          isInstance: true,
          mainComponentId: input,
          figmaNodeId: "1:4",
          fileKey: "H",
          metadata: { layoutMode: "VERTICAL", layoutSizingVertical: "HUG" },
          bounds: { x: 0, y: 280, width: 240, height: 40 },
        }),
        n("node:iit", "TEXT_LAYER", "Hint", {
          parentId: "node:ii",
          metadata: { text: "Enter your email" },
          bounds: { x: 0, y: 0, width: 160, height: 20 },
        }),
      ],
      [
        e("CONTAINS", "file:H", "node:page"),
        e("CONTAINS", "node:page", "node:frame"),
        e("CONTAINS", "node:page", banner),
        e("CONTAINS", "node:page", input),
        e("CONTAINS", banner, "node:bt"),
        e("CONTAINS", input, "node:ih"),
        e("CONTAINS", "node:frame", "node:b1"),
        e("CONTAINS", "node:frame", "node:b2"),
        e("CONTAINS", "node:frame", "node:ii"),
        e("CONTAINS", "node:b1", "node:b1t"),
        e("CONTAINS", "node:b2", "node:b2t"),
        e("CONTAINS", "node:ii", "node:iit"),
        e("INSTANCE_OF", "node:b1", banner),
        e("INSTANCE_OF", "node:b2", banner),
        e("INSTANCE_OF", "node:ii", input),
        e("NESTS", "node:frame", "node:b1"),
        e("NESTS", "node:frame", "node:b2"),
        e("NESTS", "node:frame", "node:ii"),
      ],
      "H",
    );
    const warnings = frameContentWarnings(index, "node:frame").warnings;
    expect(warnings.some((warning) => warning.kind === "oversized-height")).toBe(false);
    expect(warnings.some((warning) => warning.kind === "leftover-text")).toBe(false);
  });
});

const BENE_MCP = `
<frame id="0:1" name="Kit" x="0" y="0" width="400" height="80">
  <component id="9:1" name="Bene Dropdown" x="0" y="0" width="320" height="48">
    <text id="9:2" name="Label" x="8" y="8" width="280" height="24" characters="Request Bank Certificate" />
  </component>
</frame>
<frame id="1:1" name="Payment" x="0" y="120" width="400" height="80">
  <instance id="1:2" name="Bene Dropdown" x="8" y="8" width="320" height="48">
    <text id="1:3" name="Request Bank Certificate" x="8" y="8" width="280" height="24" />
  </instance>
</frame>
`;

const BENE_DESIGN_CONTEXT = `
export default function Payment() {
  return (
    <div data-node-id="1:1" data-name="Payment">
      <div data-node-id="1:2" data-name="Bene Dropdown">
        <p data-node-id="1:3">Request Bank Certificate</p>
      </div>
    </div>
  );
}
`;

describe("verify reads Figma MCP text, not layer names", () => {
  function beneIndex() {
    const graph = buildGraph(
      adaptFigmaMcpMetadata({
        fileKey: "BENE",
        fileName: "Bene",
        metadataXml: BENE_MCP,
        ingestedAt: "2026-01-01T00:00:00.000Z",
      }),
      { builtAt: "2026-01-01T00:00:00.000Z" },
    );
    return indexGraph(graph);
  }

  it("stays silent on names alone and catches the Bene default once characters arrive", () => {
    const index = beneIndex();
    const bare = index.allNodes.find((node) => node.figmaNodeId === "1:3");
    expect(bare?.type).toBe("TEXT_LAYER");
    expect(bare?.metadata?.["text"]).toBeUndefined();

    const silent = verifyFrame(index, { frame: "Payment" });
    expect(silent.textChecked).toBe(false);
    expect(silent.textReason).toBe(TEXT_UNCHECKED_REASON);
    expect(
      (silent.warnings ?? []).some((warning) => warning.kind === "leftover-text" || warning.kind === "placeholder"),
    ).toBe(false);
    expect(silent.pass).toBe(true);

    const caught = verifyFrame(index, { frame: "Payment", designContext: BENE_DESIGN_CONTEXT });
    expect(caught.textChecked).toBe(true);
    expect(caught.textReason).toBeUndefined();
    expect(caught.warnings?.map((warning) => warning.kind)).toContain("leftover-text");
    expect(caught.warnings?.find((warning) => warning.kind === "leftover-text")?.reason).toMatch(
      /Request Bank Certificate/,
    );
    expect(caught.cost.chars).toBeLessThanOrEqual(600);

    const filled = verifyFrame(index, {
      frame: "Payment",
      texts: { "1:3": "Account 102938 paid" },
    });
    expect(filled.textChecked).toBe(true);
    expect((filled.warnings ?? []).some((warning) => warning.kind === "leftover-text")).toBe(false);
    expect(filled.pass).toBe(true);
  });
});

function fixedFarm(count: number) {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const file = "file:F";
  const page = "node:page";
  const master = "node:button";
  const masterText = "node:button-text";
  nodes.push(
    n(file, "FILE", "Farm", { fileKey: "FARM" }),
    n(page, "PAGE", "Screens", { parentId: file, pageId: page, fileKey: "FARM" }),
    n(master, "MAIN_COMPONENT", "Button", {
      parentId: page,
      pageId: page,
      figmaNodeId: "9:1",
      fileKey: "FARM",
      isMainComponent: true,
      metadata: { layoutMode: "VERTICAL", layoutSizingVertical: "FIXED" },
      bounds: { x: 0, y: 0, width: 200, height: 48 },
    }),
    n(masterText, "TEXT_LAYER", "Label", {
      parentId: master,
      metadata: { text: "Click here please" },
      bounds: { x: 0, y: 0, width: 120, height: 20 },
    }),
  );
  edges.push(e("CONTAINS", file, page), e("CONTAINS", page, master), e("CONTAINS", master, masterText));
  for (let i = 0; i < count; i += 1) {
    const frame = `node:f:${i}`;
    const inst = `node:i:${i}`;
    const text = `node:t:${i}`;
    nodes.push(
      n(frame, "FRAME", `Screen ${i}`, { parentId: page, pageId: page, figmaNodeId: `1:${i}`, fileKey: "FARM" }),
      n(inst, "COMPONENT_INSTANCE", "Button", {
        parentId: frame,
        pageId: page,
        isInstance: true,
        mainComponentId: master,
        figmaNodeId: `2:${i}`,
        fileKey: "FARM",
        bounds: { x: 0, y: 0, width: 200, height: 160 },
        metadata: { layoutMode: "VERTICAL", layoutSizingVertical: "FIXED" },
      }),
      n(text, "TEXT_LAYER", "Label", {
        parentId: inst,
        metadata: { text: `Pay invoice number ${i} today` },
        bounds: { x: 8, y: 8, width: 160, height: 24 },
      }),
    );
    edges.push(
      e("CONTAINS", page, frame),
      e("CONTAINS", frame, inst),
      e("CONTAINS", inst, text),
      e("INSTANCE_OF", inst, master),
      e("NESTS", frame, inst),
    );
  }
  return graphOf(nodes, edges, "FARM");
}

describe("verify text is honest about what was read", () => {
  const MASTER_ONLY = `
<frame id="0:1" name="Kit" x="0" y="0" width="400" height="80">
  <component id="9:1" name="Bene Dropdown" x="0" y="0" width="320" height="48">
    <text id="9:2" name="Label" x="8" y="8" width="280" height="24" />
  </component>
</frame>
<frame id="1:1" name="Payment" x="0" y="120" width="400" height="80">
  <instance id="1:2" name="Bene Dropdown" x="8" y="8" width="320" height="48">
    <text id="1:3" name="Label" x="8" y="8" width="280" height="24" />
  </instance>
</frame>
`;

  function mcpIndex(xml: string) {
    return indexGraph(
      buildGraph(
        adaptFigmaMcpMetadata({
          fileKey: "BENE",
          fileName: "Bene",
          metadataXml: xml,
          ingestedAt: "2026-01-01T00:00:00.000Z",
        }),
        { builtAt: "2026-01-01T00:00:00.000Z" },
      ),
    );
  }

  it("does not claim textChecked when the instance was read but the default was not learned", () => {
    const index = mcpIndex(MASTER_ONLY);
    const card = verifyFrame(index, {
      frame: "Payment",
      designContext: `<p data-node-id="1:3">Request Bank Certificate</p>`,
    });
    expect(card.textChecked).toBe("partial");
    expect(card.textReason).toBe(TEXT_DEFAULT_UNKNOWN);
    expect((card.warnings ?? []).some((warning) => warning.kind === "leftover-text")).toBe(false);
    expect(card.pass).toBe(true);
  });

  it("reports partial coverage when only some text layers were read", () => {
    const xml = `
<frame id="0:1" name="Kit" x="0" y="0" width="400" height="80">
  <component id="9:1" name="Bene Dropdown" x="0" y="0" width="320" height="80">
    <text id="9:2" name="Title" x="8" y="8" width="280" height="24" characters="Payee" />
    <text id="9:4" name="Body" x="8" y="36" width="280" height="24" characters="Request Bank Certificate" />
  </component>
</frame>
<frame id="1:1" name="Payment" x="0" y="120" width="400" height="80">
  <instance id="1:2" name="Bene Dropdown" x="8" y="8" width="320" height="80">
    <text id="1:3" name="Title" x="8" y="8" width="280" height="24" />
    <text id="1:5" name="Body" x="8" y="36" width="280" height="24" />
  </instance>
</frame>`;
    const index = mcpIndex(xml);
    const card = verifyFrame(index, {
      frame: "Payment",
      texts: { "1:3": "Payee" },
    });
    expect(card.textChecked).toBe("partial");
    expect(card.textReason).toBe("partial: 1 of 2 text layers read");
  });

  it("lets texts fill an empty layer and refuses to hide stored failures", () => {
    const index = mcpIndex(`
<frame id="0:1" name="Kit" x="0" y="0" width="400" height="80">
  <component id="9:1" name="Bene Dropdown" x="0" y="0" width="320" height="48">
    <text id="9:2" name="Label" x="8" y="8" width="280" height="24" characters="Request Bank Certificate" />
  </component>
</frame>
<frame id="1:1" name="Payment" x="0" y="120" width="400" height="80">
  <instance id="1:2" name="Bene Dropdown" x="8" y="8" width="320" height="48">
    <text id="I1:10;9:2" name="Label" x="8" y="8" width="280" height="24" characters="Lorem ipsum dolor sit amet" />
  </instance>
</frame>`);
    const hidden = verifyFrame(index, {
      frame: "Payment",
      texts: { "I1:10;9:2": "Real copy here now" },
    });
    expect(hidden.pass).toBe(false);
    expect(hidden.warnings?.some((warning) => warning.kind === "placeholder")).toBe(true);
    expect(hidden.textOverrides).toBeUndefined();

    const listed = verifyFrame(index, {
      frame: "Payment",
      placeholders: ["Lorem ipsum dolor sit amet"],
      texts: { "I1:10;9:2": "Real copy here now" },
    });
    expect(listed.warnings?.some((warning) => warning.kind === "placeholder")).toBe(true);

    const replaced = verifyFrame(index, {
      frame: "Payment",
      designContext: `<p data-node-id="I1:10;9:2">Real copy here now</p>`,
    });
    expect((replaced.warnings ?? []).some((warning) => warning.kind === "placeholder")).toBe(false);
    expect(replaced.textOverrides).toBe(1);
    expect(replaced.textChecked).toBe(true);
  });

  it("does not let texts clear a stored team placeholder", () => {
    const index = mcpIndex(`
<frame id="0:1" name="Kit" x="0" y="0" width="400" height="80">
  <component id="9:1" name="Bene Dropdown" x="0" y="0" width="320" height="48">
    <text id="9:2" name="Label" x="8" y="8" width="280" height="24" characters="Request Bank Certificate" />
  </component>
</frame>
<frame id="1:1" name="Payment" x="0" y="120" width="400" height="80">
  <instance id="1:2" name="Bene Dropdown" x="8" y="8" width="320" height="48">
    <text id="1:3" name="Label" x="8" y="8" width="280" height="24" characters="Request Bank Certificate" />
  </instance>
</frame>`);
    const card = verifyFrame(index, {
      frame: "Payment",
      placeholders: ["Request Bank Certificate"],
      texts: { "1:3": "Account paid in full" },
    });
    expect(card.pass).toBe(false);
    expect(card.warnings?.some((warning) => warning.kind === "placeholder")).toBe(true);
    expect(card.textOverrides).toBeUndefined();
  });

  it("does not let supplied text rewrite a component default outside the frame", () => {
    const index = mcpIndex(BENE_MCP);
    const before = verifyFrame(index, {
      frame: "Payment",
      designContext: BENE_DESIGN_CONTEXT,
    });
    expect(before.warnings?.some((warning) => warning.kind === "leftover-text")).toBe(true);
    const rewritten = verifyFrame(index, {
      frame: "Payment",
      designContext: BENE_DESIGN_CONTEXT,
      texts: { "9:2": "Account paid in full today" },
    });
    expect(rewritten.warnings?.some((warning) => warning.kind === "leftover-text")).toBe(true);
    expect(rewritten.textOverrides).toBeUndefined();
  });

  it("ignores text aimed at a layer in another file", () => {
    const index = mcpIndex(MASTER_ONLY);
    const layer = index.allNodes.find((node) => node.figmaNodeId === "1:3");
    expect(layer).toBeTruthy();
    layer!.fileKey = "OTHER";
    const card = verifyFrame(index, { frame: "Payment", texts: { "1:3": "Request Bank Certificate" } });
    expect(card.textChecked).toBe(false);
    expect(card.textReason).toBe(TEXT_UNCHECKED_REASON);
  });

  it("says n/a when the frame has no text layers and false when there is no frame", () => {
    const index = mcpIndex(`
<frame id="0:1" name="Kit" x="0" y="0" width="400" height="40">
  <component id="9:1" name="Spacer" x="0" y="0" width="40" height="40" />
</frame>
<frame id="1:1" name="Payment" x="0" y="80" width="400" height="40">
  <instance id="1:2" name="Spacer" x="0" y="0" width="40" height="40" />
</frame>`);
    const empty = verifyFrame(index, { frame: "Payment" });
    expect(empty.textChecked).toBe("n/a");
    expect(empty.textReason).toBe(TEXT_NO_LAYERS);
    const list = verifyFrame(index, { components: ["Spacer"] });
    expect(list.textChecked).toBe(false);
    expect(list.textReason).toBe(TEXT_NO_FRAME);
  });

  it("rejects oversized texts maps", () => {
    const index = mcpIndex(MASTER_ONLY);
    const huge: Record<string, string> = {};
    for (let i = 0; i < 2001; i += 1) huge[`1:${i}`] = "Pay now";
    expect(() => verifyFrame(index, { frame: "Payment", texts: huge })).toThrow(TextInputError);
    expect(() => verifyFrame(index, { frame: "Payment", texts: { "1:3": "x".repeat(2001) } })).toThrow(
      /maximum is 2000/,
    );
  });
});

describe("example describe stays linear", () => {
  it("describes each instance once per request, including a second lookup", () => {
    const small = fixedFarm(40);
    const large = fixedFarm(80);
    const masterSmall = small.getNode("node:button")!;
    const masterLarge = large.getNode("node:button")!;
    const query: { placeholders?: string[] } = {};
    resetDescribeCalls();
    getExample(small, masterSmall, query);
    const first = takeDescribeCalls();
    getExample(small, masterSmall, query);
    expect(takeDescribeCalls()).toBe(0);
    resetDescribeCalls();
    getExample(large, masterLarge, {});
    const second = takeDescribeCalls();
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(40 * 2);
    expect(second).toBeLessThanOrEqual(first * 2 + 8);
    expect(second).toBeLessThan(80 * 40);
  });
});
