import { describe, expect, it } from "vitest";
import type { DesignGraph, GraphEdge, GraphNode, NodeType } from "@/core/model";
import {
  exampleCard,
  exampleFactForMasterOnFrame,
  getExample,
  indexGraph,
  NO_EXAMPLE,
  recommendMasters,
  verifyFrame,
  CLONE_INSTRUCTION,
} from "@/core/query";
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
    n("node:row1t", "TEXT_LAYER", "Account 102938", { parentId: "node:row1" }),
    n("node:row2", "GROUP", "Dropdown Information", {
      parentId: benInst,
      bounds: { x: 0, y: 104, width: 320, height: 32 },
    }),
    n("node:row2t", "TEXT_LAYER", "Swift BIC ABCD", { parentId: "node:row2" }),
    n("node:row3", "GROUP", "Dropdown Information", {
      parentId: benInst,
      bounds: { x: 0, y: 136, width: 320, height: 32 },
    }),
    n("node:row3t", "TEXT_LAYER", "Bank of Example", { parentId: "node:row3" }),
    n(oldInst, "COMPONENT_INSTANCE", "Old Dropdown", {
      parentId: legacy,
      pageId: page,
      isInstance: true,
      mainComponentId: old,
      figmaNodeId: "3:2",
      fileKey: "BENE",
    }),
    n("node:old-text", "TEXT_LAYER", "Retired template sentence here", { parentId: oldInst }),
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
    expect(none.candidates[0] && "ex" in none.candidates[0] && none.candidates[0].ex).toBe(NO_EXAMPLE);
    expect(none.cost.chars).toBeLessThanOrEqual(600);
    const missing = getExample(index, index.getNode(ids.quiet)!);
    expect(missing).toEqual({ found: false, example: NO_EXAMPLE });
    expect(inventsInCard(none, index)).toEqual([]);
  });

  it("does not use a retired or private component as the example", () => {
    const { index, ids } = beneLab();
    expect(getExample(index, index.getNode(ids.old)!).found).toBe(false);
    expect(getExample(index, index.getNode(ids.secret)!).example).toBe(NO_EXAMPLE);
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
    const bare = verifyFrame(index, { frame: "Payment" });
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
        n(masterText, "TEXT_LAYER", "Shipping address goes here", { parentId: master }),
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
    const three = getExample(index, index.getNode(card)!, { sock, product: "Wire" });
    expect(three.found).toBe(true);
    if (three.found) {
      expect(three.example.preferred).toBe(true);
      expect(three.example.nodeId).not.toBe("6:4");
      expect(three.example.summary).toMatch(/Dropdown Information×2/);
    }
    expect(inventsInCard(recommendMasters(index, "card", { sock }), index)).toEqual([]);
  });
});
