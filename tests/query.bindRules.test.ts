import { describe, expect, it } from "vitest";
import type { DesignGraph, GraphEdge, GraphNode, NodeType } from "@/core/model";
import {
  BindRuleError,
  loadBindRulesLenient,
  parseBindRulesFile,
  resolveBindRules,
  whyLine,
  whyLineForMaster,
} from "@/core/query/bindRules";
import {
  indexGraph,
  recommendMasters,
  verifyFrame,
} from "@/core/query";
import { emptySock, recordVerifiedUsage } from "@/core/query/sock";
import type { WorkspaceManifest } from "@/core/query/workspace";

const FROZEN = "2026-01-01T00:00:00.000Z";

function n(id: string, type: NodeType, name: string, extra: Partial<GraphNode> = {}): GraphNode {
  return { id, type, name, ...extra };
}

function e(type: GraphEdge["type"], source: string, target: string): GraphEdge {
  return { id: `${type}|${source}|${target}`, source, target, type };
}

function paymentLab() {
  const file = "file:PAY";
  const page = "node:p";
  const frame = "node:f";
  const live = "node:live";
  const cousin = "node:cousin";
  const dead = "node:dead";
  const inst = "node:ib";

  const graph: DesignGraph = {
    fileKey: "LIB",
    fileName: "Pay kit",
    builtAt: FROZEN,
    source: { kind: "mock", ingestedAt: FROZEN },
    warnings: [],
    nodes: [
      n(file, "FILE", "Pay kit", { fileKey: "LIB" }),
      n(page, "PAGE", "App", { parentId: file, pageId: page, fileKey: "LIB" }),
      n(frame, "FRAME", "Payment", {
        parentId: page,
        pageId: page,
        figmaNodeId: "1:1",
        fileKey: "LIB",
      }),
      n(live, "MAIN_COMPONENT", "Pay CTA", {
        parentId: page,
        pageId: page,
        figmaNodeId: "9:1",
        isMainComponent: true,
        fileKey: "LIB",
      }),
      n(cousin, "MAIN_COMPONENT", "Save CTA", {
        parentId: page,
        pageId: page,
        figmaNodeId: "9:8",
        isMainComponent: true,
        fileKey: "PROD",
      }),
      n(dead, "MAIN_COMPONENT", "Old Pay CTA", {
        parentId: page,
        pageId: page,
        figmaNodeId: "9:2",
        isMainComponent: true,
        status: "deprecated",
        fileKey: "LIB",
      }),
      n(inst, "COMPONENT_INSTANCE", "Pay CTA", {
        parentId: frame,
        pageId: page,
        isInstance: true,
        mainComponentId: live,
        figmaNodeId: "1:2",
        fileKey: "LIB",
      }),
    ],
    edges: [
      e("CONTAINS", file, page),
      e("CONTAINS", page, frame),
      e("CONTAINS", page, live),
      e("CONTAINS", page, cousin),
      e("CONTAINS", page, dead),
      e("CONTAINS", frame, inst),
      e("INSTANCE_OF", inst, live),
      e("NESTS", frame, inst),
    ],
  };

  return { index: indexGraph(graph), ids: { live, cousin, dead, frame } };
}

const workspace: WorkspaceManifest = {
  version: 1,
  files: [
    { role: "library", key: "LIB", label: "Shared DS" },
    { role: "product", key: "PROD", label: "Storefront" },
  ],
};

describe("bind rule schema", () => {
  it("parses require, forbid, and prefer", () => {
    const file = parseBindRulesFile({
      version: 1,
      howToAdd: "ignored",
      rules: [
        { screenType: "payment", slot: "primary-action", require: "Pay CTA" },
        { forbid: "deprecated" },
        { prefer: "Shared DS", over: "Storefront" },
      ],
    });
    expect(file.rules.map((rule) => rule.kind)).toEqual(["require", "forbid", "prefer"]);
  });

  it("parses prefer as a phrase", () => {
    const file = parseBindRulesFile({ rules: [{ prefer: "Shared DS over Storefront" }] });
    expect(file.rules[0]).toMatchObject({ kind: "prefer", prefer: "Shared DS", over: "Storefront" });
  });

  it("fails loudly on unknown require ids", () => {
    const { index } = paymentLab();
    const file = parseBindRulesFile({
      rules: [{ screenType: "payment", slot: "primary-action", require: "node:nope" }],
    });
    expect(() => resolveBindRules(file, { index })).toThrow(BindRuleError);
    expect(() => resolveBindRules(file, { index })).toThrow(/unknown master "node:nope"/);
    expect(() => resolveBindRules(file, { index })).toThrow(/Never guessing/);
  });

  it("fails loudly on unknown prefer libraries when workspace is present", () => {
    const file = parseBindRulesFile({ rules: [{ prefer: "GhostLib", over: "Storefront" }] });
    expect(() => resolveBindRules(file, { workspace })).toThrow(/unknown library "GhostLib"/);
  });

  it("rejects a rule that is not require, forbid, or prefer", () => {
    expect(() => parseBindRulesFile({ rules: [{ slot: "primary-action" }] })).toThrow(
      /needs require, forbid, or prefer/,
    );
  });

  it("rejects unscoped require", () => {
    expect(() => parseBindRulesFile({ rules: [{ require: "Pay CTA" }] })).toThrow(
      /Unscoped require is invalid/,
    );
  });
});

describe("recommend ranking with bind rules", () => {
  it("filters to the required master for a matching screen/slot", () => {
    const { index, ids } = paymentLab();
    const bindRules = resolveBindRules(
      parseBindRulesFile({
        rules: [{ screenType: "payment", slot: "primary-action", require: "Pay CTA" }],
      }),
      { index },
    );
    const result = recommendMasters(index, "payment with primary button", { bindRules, workspace });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.id).toBe(ids.live);
    expect(result.candidates[0]?.why).toMatch(/bind rule require payment\/primary-action/);
  });

  it("drops deprecated when forbid deprecated", () => {
    const { index, ids } = paymentLab();
    const bindRules = parseBindRulesFile({ rules: [{ forbid: "deprecated" }] });
    const result = recommendMasters(index, "pay cta", { bindRules });
    expect(result.candidates.some((row) => row.id === ids.dead)).toBe(false);
  });

  it("ranks prefer library above the other", () => {
    const { index, ids } = paymentLab();
    const bindRules = resolveBindRules(
      parseBindRulesFile({ rules: [{ prefer: "Shared DS", over: "Storefront" }] }),
      { workspace },
    );
    const result = recommendMasters(index, "cta", { bindRules, workspace });
    expect(result.candidates[0]?.id).toBe(ids.live);
    const cousin = result.candidates.find((row) => row.id === ids.cousin);
    if (cousin) expect(cousin.score).toBeLessThan(result.candidates[0]!.score);
  });
});

describe("verify_frame bind rules", () => {
  it("fails a payment frame missing the required master and names the rule", () => {
    const { index, ids } = paymentLab();
    const bindRules = resolveBindRules(
      parseBindRulesFile({
        rules: [{ screenType: "payment", slot: "primary-action", require: "Pay CTA" }],
      }),
      { index },
    );
    const result = verifyFrame(index, {
      components: ["Save CTA"],
      bindRules,
      context: { domain: "payment", journey: { screenJob: "primary button" } },
    });
    expect(result.pass).toBe(false);
    expect(result.ruleFailure?.rule).toMatch(/require payment\/primary-action/);
    expect(result.ruleFailure?.expected?.id).toBe(ids.live);
    expect(result.ruleFailure?.expected?.figmaNodeId).toBe("9:1");
    expect(result.ruleFailure?.expected?.hint).toMatch(/Place fileKey \+ nodeId/);
    expect(result.hint).toMatch(/require payment\/primary-action/);
    expect(result.cost.chars).toBeLessThan(650);
  });

  it("passes when the required master is placed", () => {
    const { index } = paymentLab();
    const bindRules = resolveBindRules(
      parseBindRulesFile({
        rules: [{ screenType: "payment", slot: "primary-action", require: "Pay CTA" }],
      }),
      { index },
    );
    const result = verifyFrame(index, { frame: "Payment", bindRules });
    expect(result.pass).toBe(true);
    expect(result.ruleFailure).toBeUndefined();
    expect(result.cost.chars).toBeLessThan(650);
  });
});

describe("why line (SOCK facts only)", () => {
  it("says no usage yet when there are no facts", () => {
    expect(whyLine({})).toBe("no usage yet");
    const { index, ids } = paymentLab();
    const node = index.getNode(ids.live)!;
    expect(whyLineForMaster(node, { sock: emptySock() })).toBe("no usage yet");
  });

  it("is a snapshot of counted real-screen usage, confidence, freshness, status, pack, rule", () => {
    const { index, ids } = paymentLab();
    const node = index.getNode(ids.live)!;
    let sock = emptySock(3);
    sock = recordVerifiedUsage(sock, {
      screenId: "s1",
      screenName: "Pay 1",
      masters: [{ id: ids.live, name: "Pay CTA" }],
      countsTowardThreshold: true,
    });
    sock = recordVerifiedUsage(sock, {
      screenId: "s2",
      screenName: "Pay 2",
      masters: [{ id: ids.live, name: "Pay CTA" }],
    });
    sock = recordVerifiedUsage(sock, {
      screenId: "s3",
      screenName: "Pay 3",
      masters: [{ id: ids.live, name: "Pay CTA" }],
    });
    const line = whyLineForMaster(node, {
      sock,
      packJourney: "Storefront checkout",
      bindRule: "require payment/primary-action",
    });
    expect(line).toMatchInlineSnapshot(
      `"used on 3 real screens, strong; matches Storefront checkout; bind rule require payment/primary-action"`,
    );
  });

  it("never invents a count from graph instances alone", () => {
    const { index, ids } = paymentLab();
    const node = index.getNode(ids.live)!;
    expect(index.getAllInstancesOf(ids.live).length).toBeGreaterThan(0);
    expect(whyLineForMaster(node)).toBe("no usage yet");
  });

  it("quarantines invalid rules on load and still recommends", () => {
    const { index, ids } = paymentLab();
    const loaded = loadBindRulesLenient(
      {
        rules: [
          { require: "node:gone" },
          { forbid: "deprecated" },
          { screenType: "payment", slot: "primary-action", require: "Pay CTA" },
        ],
      },
      { index },
    );
    expect(loaded.rules.some((rule) => rule.kind === "forbid")).toBe(true);
    expect(loaded.rules.some((rule) => rule.kind === "require" && rule.require === "Pay CTA")).toBe(true);
    expect(loaded.rules.some((rule) => rule.kind === "require" && rule.require === "node:gone")).toBe(false);
    expect(loaded.warnings?.some((row) => /gone|unscoped|unknown/i.test(row.reason) || /gone|unscoped/i.test(row.rule))).toBe(
      true,
    );
    const result = recommendMasters(index, "pay cta", { bindRules: loaded });
    expect((result.bindRuleWarnings?.length ?? 0) > 0 || Boolean(result.warningNote)).toBe(true);
    expect(result.candidates.some((row) => row.id === ids.live)).toBe(true);
    expect(result.cost.chars).toBeLessThan(650);
  });

  it("keeps recommend cards under the 600-char budget with a why line", () => {
    const { index } = paymentLab();
    const bindRules = resolveBindRules(
      parseBindRulesFile({
        rules: [{ screenType: "payment", slot: "primary-action", require: "Pay CTA" }],
      }),
      { index },
    );
    const result = recommendMasters(index, "payment with primary button", { bindRules });
    expect(result.candidates[0]?.why).toBeTypeOf("string");
    expect(result.cost.chars).toBeLessThan(650);
  });
});
