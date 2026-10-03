import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesignGraph, GraphEdge, GraphNode, NodeType } from "@/core/model";
import {
  advanceSoci,
  applySociDecision,
  capSociProposals,
  emptySock,
  filterAndScoreByBindRules,
  fitBindRuleWarnings,
  indexGraph,
  loadBindRulesLenient,
  parseBindRulesFile,
  recommendMasters,
  recordCousinCorrections,
  recordVerifiedUsage,
  resolveBindRules,
  starterRecipes,
  topLevelMasterIds,
  verifyFrame,
  type WorkspaceManifest,
} from "@/core/query";
import { governanceView } from "@/server/governance";
import { callTool } from "@/server/tools";
import {
  clearCache,
  commitProposalDecision,
  loadSock,
  readBindRules,
  saveGraph,
  saveSock,
  sockPath,
} from "@/server/store";
import { graph as fixtureGraph } from "./fixture";

const FROZEN = "2026-01-01T00:00:00.000Z";

function n(id: string, type: NodeType, name: string, extra: Partial<GraphNode> = {}): GraphNode {
  return { id, type, name, ...extra };
}

function e(type: GraphEdge["type"], source: string, target: string): GraphEdge {
  return { id: `${type}|${source}|${target}`, source, target, type };
}

function usage(
  sock: ReturnType<typeof emptySock>,
  screenId: string,
  screenName: string,
  masters: Array<{ id: string; name: string; overrideKeys?: string[] }>,
  extra: { slot?: string; countsTowardThreshold?: boolean; fileKey?: string; frameId?: string } = {},
) {
  return recordVerifiedUsage(sock, {
    screenId,
    screenName,
    masters: masters.map((master) => ({
      ...master,
      fileKey: extra.fileKey ?? "LIB",
      figmaNodeId: master.id.replace("node:", ""),
    })),
    slot: extra.slot,
    frameId: extra.frameId ?? screenId,
    countsTowardThreshold: extra.countsTowardThreshold,
    verifiedAt: FROZEN,
  });
}

function stepperGraph() {
  const graph: DesignGraph = {
    fileKey: "LIB",
    fileName: "DS",
    builtAt: FROZEN,
    source: { kind: "mock", ingestedAt: FROZEN },
    warnings: [],
    nodes: [
      n("file:LIB", "FILE", "DS", { fileKey: "LIB" }),
      n("node:p", "PAGE", "Lib", { parentId: "file:LIB", pageId: "node:p", fileKey: "LIB" }),
      n("node:stepper", "MAIN_COMPONENT", "Checkout Stepper", {
        parentId: "node:p",
        pageId: "node:p",
        isMainComponent: true,
        fileKey: "LIB",
        figmaNodeId: "9:1",
      }),
      n("node:old-step", "MAIN_COMPONENT", "Nav Stepper", {
        parentId: "node:p",
        pageId: "node:p",
        isMainComponent: true,
        fileKey: "LIB",
        figmaNodeId: "9:2",
      }),
      n("node:card", "MAIN_COMPONENT", "Main Card", {
        parentId: "node:p",
        pageId: "node:p",
        isMainComponent: true,
        fileKey: "LIB",
        figmaNodeId: "9:3",
      }),
    ],
    edges: [
      e("CONTAINS", "file:LIB", "node:p"),
      e("CONTAINS", "node:p", "node:stepper"),
      e("CONTAINS", "node:p", "node:old-step"),
      e("CONTAINS", "node:p", "node:card"),
    ],
  };
  return indexGraph(graph);
}

describe("SOCI v1 proposal types", () => {
  it("proposes a recipe slot change from strong verified-frame usage", () => {
    let sock = emptySock(3);
    for (const screen of ["c1", "c2", "c3"]) {
      sock = usage(sock, screen, "Checkout", [{ id: "node:stepper", name: "Checkout Stepper" }], {
        slot: "header",
        frameId: `1:${screen}`,
        fileKey: "LIB",
      });
    }
    const next = advanceSoci(sock, { recipes: starterRecipes(), now: FROZEN });
    const recipe = next.proposals.find((row) => row.type === "recipe-update");
    expect(recipe?.status).toBe("pending");
    expect(recipe?.summary).toMatch(/Stepper/i);
    expect(recipe?.suggestedRecipe).toMatchObject({
      recipeId: "checkout-summary",
      slotRole: "header",
      masterId: "node:stepper",
    });
    expect(Array.isArray(recipe?.evidence)).toBe(true);
    expect((recipe?.evidence as { frameId?: string }[]).length).toBe(3);
  });

  it("proposes a variant candidate from repeated override keys on real frames", () => {
    let sock = emptySock(3);
    for (const screen of ["s1", "s2", "s3"]) {
      sock = usage(
        sock,
        screen,
        "Account",
        [{ id: "node:card", name: "Main Card", overrideKeys: ["nested:Badge"] }],
        { frameId: screen, fileKey: "LIB" },
      );
    }
    const next = advanceSoci(sock, { now: FROZEN });
    const variant = next.proposals.find((row) => row.type === "variant-candidate");
    expect(variant?.status).toBe("pending");
    expect(variant?.summary).toMatch(/official variant/i);
    expect(variant?.suggestedVariant).toMatchObject({
      masterId: "node:card",
      overrideKey: "nested:Badge",
    });
  });

  it("skips variant proposals when no override/detach signal exists", () => {
    let sock = emptySock(3);
    for (const screen of ["s1", "s2", "s3"]) {
      sock = usage(sock, screen, "Account", [{ id: "node:card", name: "Main Card" }]);
    }
    const next = advanceSoci(sock, { now: FROZEN });
    expect(next.proposals.some((row) => row.type === "variant-candidate")).toBe(false);
  });

  it("proposes a deprecation candidate when a cousin is strong and the master has zero verified usage", () => {
    let sock = emptySock(3);
    for (const screen of ["s1", "s2", "s3"]) {
      sock = usage(sock, screen, "Checkout", [{ id: "node:stepper", name: "Checkout Stepper" }], {
        slot: "header",
      });
    }
    const next = advanceSoci(sock, { index: stepperGraph(), now: FROZEN });
    const deprecation = next.proposals.find((row) => row.type === "deprecation-candidate");
    expect(deprecation?.suggestedDeprecation).toMatchObject({
      masterId: "node:old-step",
      cousinId: "node:stepper",
    });
    expect(deprecation?.summary).toMatch(/Nav Stepper/);
  });

  it("proposes a wrong-cousin hotspot from repeated verify corrections", () => {
    let sock = emptySock(3);
    for (const screen of ["p1", "p2", "p3"]) {
      sock = recordCousinCorrections(sock, {
        screenId: screen,
        screenName: `Product ${screen}`,
        frameId: screen,
        fileKey: "PROD",
        hits: [
          {
            fromId: "node:cousin",
            fromName: "Save CTA",
            fromFileKey: "PROD",
            toId: "node:live",
            toName: "Pay CTA",
            toFileKey: "LIB",
          },
        ],
        verifiedAt: FROZEN,
      });
    }
    const next = advanceSoci(sock, {
      now: FROZEN,
      workspace: {
        version: 1,
        files: [
          { role: "library", key: "LIB", label: "Shared DS" },
          { role: "product", key: "PROD", label: "Storefront" },
        ],
      },
    });
    const row = next.proposals.find((item) => item.type === "wrong-cousin");
    expect(row?.status).toBe("pending");
    expect(row?.suggestedRule).toMatchObject({
      prefer: "Shared DS",
      over: "Storefront",
      masterId: "node:live",
      overMasterId: "node:cousin",
      screenType: "product",
    });
    expect(row?.summary).toMatch(/Prefer Pay CTA over Save CTA for product/);
  });

  it("dedupes and merges evidence when the same proposal recurs", () => {
    let sock = emptySock(3);
    for (const screen of ["c1", "c2", "c3"]) {
      sock = usage(sock, screen, "Checkout", [{ id: "node:stepper", name: "Checkout Stepper" }], {
        slot: "header",
        frameId: screen,
      });
    }
    sock = advanceSoci(sock, { recipes: starterRecipes(), now: FROZEN });
    const first = sock.proposals.filter((row) => row.type === "recipe-update");
    expect(first).toHaveLength(1);
    sock = usage(sock, "c4", "Checkout", [{ id: "node:stepper", name: "Checkout Stepper" }], {
      slot: "header",
      frameId: "c4",
    });
    sock = advanceSoci(sock, { recipes: starterRecipes(), now: "2026-01-02T00:00:00.000Z" });
    const again = sock.proposals.filter((row) => row.type === "recipe-update");
    expect(again).toHaveLength(1);
    expect(again[0]?.id).toBe(first[0]?.id);
    expect(Array.isArray(again[0]?.evidence) && again[0].evidence.length).toBe(4);
    expect(again[0]?.updatedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("caps pending proposals to top-N", () => {
    let sock = emptySock(3);
    for (let i = 0; i < 20; i += 1) {
      const key = `nested:Badge${i}`;
      for (const screen of ["a", "b", "c"]) {
        sock = usage(
          sock,
          `${screen}-${i}`,
          "Account",
          [{ id: "node:card", name: "Main Card", overrideKeys: [key] }],
          { frameId: `${screen}-${i}` },
        );
      }
    }
    const next = advanceSoci(sock, { cap: 5, now: FROZEN });
    expect(next.proposals.filter((row) => row.status === "pending")).toHaveLength(5);
    expect(capSociProposals(next, 3).proposals.filter((row) => row.status === "pending")).toHaveLength(3);
  });

  it("does not propose from list-only verifies", () => {
    let sock = emptySock(3);
    for (const screen of ["obs:a", "obs:b", "obs:c"]) {
      sock = usage(sock, screen, "Checkout", [{ id: "node:stepper", name: "Checkout Stepper" }], {
        slot: "header",
        countsTowardThreshold: false,
      });
    }
    sock = recordCousinCorrections(sock, {
      screenId: "obs:a",
      screenName: "Checkout",
      hits: [
        {
          fromId: "node:cousin",
          fromName: "Save CTA",
          toId: "node:live",
          toName: "Pay CTA",
        },
      ],
    });
    const next = advanceSoci(sock, { recipes: starterRecipes(), index: stepperGraph(), now: FROZEN });
    expect(next.proposals).toEqual([]);
  });
});

describe("SOCI approve / reject", () => {
  const previousHome = process.env["RESOLVE_HOME"];

  beforeEach(() => {
    process.env["RESOLVE_HOME"] = mkdtempSync(join(tmpdir(), "resolve-soci-"));
    clearCache();
  });

  afterEach(() => {
    clearCache();
    if (previousHome === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previousHome;
  });

  it("approve of a recipe update writes the overlay atomically and audits", () => {
    let sock = emptySock(3);
    for (const screen of ["c1", "c2", "c3"]) {
      sock = usage(sock, screen, "Checkout", [{ id: "node:stepper", name: "Checkout Stepper" }], {
        slot: "header",
      });
    }
    sock = advanceSoci(sock, { recipes: starterRecipes(), now: FROZEN });
    const proposal = sock.proposals.find((row) => row.type === "recipe-update");
    expect(proposal).toBeDefined();
    saveSock(sock);
    const decided = applySociDecision(
      sock,
      parseBindRulesFile({ rules: [] }),
      proposal!.id,
      "approve",
      "tanishk",
      FROZEN,
      { recipes: starterRecipes(), overlay: [], index: stepperGraph() },
    );
    expect(decided.audit.recipeBefore?.id).toBe("checkout-summary");
    expect(decided.audit.recipeBefore?.slots.find((slot) => slot.role === "header")?.defaultMasterId).toBeUndefined();
    expect(decided.audit.recipeAfter?.slots.find((slot) => slot.role === "header")?.defaultMasterId).toBe("node:stepper");
    expect(decided.audit.before).toEqual([]);
    expect(decided.audit.after).toEqual([]);
    expect(decided.writesRecipes).toBe(true);
    expect(decided.writesRules).toBe(false);
    expect(decided.recipeOverlay?.some((recipe) => recipe.id === "checkout-summary")).toBe(true);
    const header = decided.recipeOverlay?.find((recipe) => recipe.id === "checkout-summary")?.slots.find(
      (slot) => slot.role === "header",
    );
    expect(header?.defaultMasterId).toBe("node:stepper");
    commitProposalDecision(decided);
    const overlayPath = join(process.env["RESOLVE_HOME"]!, "recipes.json");
    expect(existsSync(overlayPath)).toBe(true);
    const written = JSON.parse(readFileSync(overlayPath, "utf8")) as {
      recipes: Array<{ id: string; slots: Array<{ role: string; defaultMasterId?: string }> }>;
    };
    expect(
      written.recipes
        .find((recipe) => recipe.id === "checkout-summary")
        ?.slots.find((slot) => slot.role === "header")?.defaultMasterId,
    ).toBe("node:stepper");
    expect(existsSync(join(process.env["RESOLVE_HOME"]!, "bind-rules.json"))).toBe(false);
    const audit = readFileSync(join(process.env["RESOLVE_HOME"]!, "bind-rules.audit.jsonl"), "utf8");
    expect(audit).toMatch(/tanishk/);
    const saved = JSON.parse(readFileSync(join(process.env["RESOLVE_HOME"]!, "sock.json"), "utf8")) as {
      proposals: Array<{ id: string; status: string }>;
    };
    expect(saved.proposals.find((row) => row.id === proposal!.id)?.status).toBe("approved");
  });

  it("variant and deprecation approvals never write rules or masters", () => {
    let sock = emptySock(3);
    for (const screen of ["s1", "s2", "s3"]) {
      sock = usage(
        sock,
        screen,
        "Account",
        [{ id: "node:card", name: "Main Card", overrideKeys: ["nested:Badge"] }],
        { frameId: screen },
      );
    }
    sock = usage(sock, "s1", "Checkout", [{ id: "node:stepper", name: "Checkout Stepper" }], { slot: "header" });
    sock = usage(sock, "s2", "Checkout", [{ id: "node:stepper", name: "Checkout Stepper" }], { slot: "header" });
    sock = usage(sock, "s3", "Checkout", [{ id: "node:stepper", name: "Checkout Stepper" }], { slot: "header" });
    sock = advanceSoci(sock, { index: stepperGraph(), now: FROZEN });
    const variant = sock.proposals.find((row) => row.type === "variant-candidate");
    const deprecation = sock.proposals.find((row) => row.type === "deprecation-candidate");
    expect(variant && deprecation).toBeTruthy();
    saveSock(sock);
    const rulesBefore = parseBindRulesFile({ rules: [{ forbid: "deprecated" }] });
    const variantDecision = applySociDecision(sock, rulesBefore, variant!.id, "approve", "tanishk", FROZEN, {
      index: stepperGraph(),
    });
    expect(variantDecision.writesRules).toBe(false);
    expect(variantDecision.writesRecipes).toBe(false);
    expect(variantDecision.rules.rules).toEqual(rulesBefore.rules);
    commitProposalDecision(variantDecision);
    expect(existsSync(join(process.env["RESOLVE_HOME"]!, "recipes.json"))).toBe(false);
    const afterVariant = JSON.parse(readFileSync(join(process.env["RESOLVE_HOME"]!, "sock.json"), "utf8")) as {
      proposals: Array<{ id: string; status: string; type?: string }>;
    };
    sock = { ...sock, proposals: afterVariant.proposals } as typeof sock;
    const depDecision = applySociDecision(sock, readBindRules(), deprecation!.id, "approve", "tanishk", FROZEN, {
      index: stepperGraph(),
    });
    expect(depDecision.writesRules).toBe(false);
    commitProposalDecision(depDecision);
    expect(existsSync(join(process.env["RESOLVE_HOME"]!, "recipes.json"))).toBe(false);
    const bindPath = join(process.env["RESOLVE_HOME"]!, "bind-rules.json");
    if (existsSync(bindPath)) {
      const onDisk = JSON.parse(readFileSync(bindPath, "utf8")) as { rules: unknown[] };
      expect(onDisk.rules).toEqual([]);
    }
  });
});

describe("card budgets include quarantine warnings", () => {
  it("truncates warnings with and K more warnings under the 600-char cap", () => {
    const warnings = Array.from({ length: 40 }, (_, i) => ({
      rule: `rule ${i + 1}`,
      reason: `unknown master "node:gone-${i}"`,
    }));
    const fitted = fitBindRuleWarnings(warnings, { intent: "pay", candidates: [{ id: "node:live", name: "Pay CTA" }] }, 600);
    expect(fitted.warningNote).toMatch(/and \d+ more warnings/);
    const payload = {
      intent: "pay",
      candidates: [{ id: "node:live", name: "Pay CTA" }],
      ...fitted,
    };
    expect(JSON.stringify(payload).length).toBeLessThanOrEqual(600);
  });

  it("keeps recommend cards under budget when many rules are quarantined", () => {
    const { index } = (() => {
      const graph: DesignGraph = {
        fileKey: "LIB",
        fileName: "Pay kit",
        builtAt: FROZEN,
        source: { kind: "mock", ingestedAt: FROZEN },
        warnings: [],
        nodes: [
          n("file:LIB", "FILE", "Pay kit", { fileKey: "LIB" }),
          n("node:p", "PAGE", "App", { parentId: "file:LIB", pageId: "node:p", fileKey: "LIB" }),
          n("node:live", "MAIN_COMPONENT", "Pay CTA", {
            parentId: "node:p",
            pageId: "node:p",
            isMainComponent: true,
            fileKey: "LIB",
            figmaNodeId: "9:1",
          }),
        ],
        edges: [e("CONTAINS", "file:LIB", "node:p"), e("CONTAINS", "node:p", "node:live")],
      };
      return { index: indexGraph(graph) };
    })();
    const bindRules = loadBindRulesLenient({
      rules: [
        { forbid: "deprecated" },
        ...Array.from({ length: 20 }, (_, i) => ({ require: `node:gone-${i}` })),
      ],
    }, { index });
    const result = recommendMasters(index, "pay cta", { bindRules });
    expect(result.cost.chars).toBeLessThan(650);
    expect(result.warningNote).toMatch(/and \d+ more warnings/);
  });
});

const preferWorkspace: WorkspaceManifest = {
  version: 1,
  files: [
    { role: "library", key: "LIB", label: "Shared DS" },
    { role: "product", key: "PROD", label: "Storefront" },
  ],
};

function payMasters(liveExtra: Partial<GraphNode> = {}, cousinExtra: Partial<GraphNode> = {}) {
  const graph: DesignGraph = {
    fileKey: "LIB",
    fileName: "DS",
    builtAt: FROZEN,
    source: { kind: "mock", ingestedAt: FROZEN },
    warnings: [],
    nodes: [
      n("file:LIB", "FILE", "DS", { fileKey: "LIB" }),
      n("node:p", "PAGE", "Lib", { parentId: "file:LIB", pageId: "node:p", fileKey: "LIB" }),
      n("node:live", "MAIN_COMPONENT", "Pay CTA", {
        parentId: "node:p",
        pageId: "node:p",
        isMainComponent: true,
        fileKey: "LIB",
        figmaNodeId: "9:1",
        ...liveExtra,
      }),
      n("node:cousin", "MAIN_COMPONENT", "Save CTA", {
        parentId: "node:p",
        pageId: "node:p",
        isMainComponent: true,
        fileKey: "PROD",
        figmaNodeId: "9:8",
        ...cousinExtra,
      }),
      n("node:other", "MAIN_COMPONENT", "Other CTA", {
        parentId: "node:p",
        pageId: "node:p",
        isMainComponent: true,
        fileKey: "LIB",
        figmaNodeId: "9:9",
      }),
    ],
    edges: [
      e("CONTAINS", "file:LIB", "node:p"),
      e("CONTAINS", "node:p", "node:live"),
      e("CONTAINS", "node:p", "node:cousin"),
      e("CONTAINS", "node:p", "node:other"),
    ],
  };
  return indexGraph(graph);
}

function scorePrefer(
  rules: ReturnType<typeof parseBindRulesFile>,
  intent: string,
) {
  const index = payMasters();
  const entries = ["node:live", "node:cousin", "node:other"].map((id) => ({
    node: index.getNode(id)!,
    score: 100,
  }));
  return filterAndScoreByBindRules(entries, rules, { intent, workspace: preferWorkspace });
}

describe("scoped wrong-cousin prefer", () => {
  const previousHome = process.env["RESOLVE_HOME"];

  beforeEach(() => {
    process.env["RESOLVE_HOME"] = mkdtempSync(join(tmpdir(), "resolve-soci-scope-"));
    clearCache();
  });

  afterEach(() => {
    clearCache();
    if (previousHome === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previousHome;
  });

  it("approves a scoped prefer and does not move the rest of the file", () => {
    let sock = emptySock(3);
    for (const screen of ["p1", "p2", "p3"]) {
      sock = recordCousinCorrections(sock, {
        screenId: screen,
        screenName: `Product ${screen}`,
        hits: [
          {
            fromId: "node:cousin",
            fromName: "Save CTA",
            fromFileKey: "PROD",
            toId: "node:live",
            toName: "Pay CTA",
            toFileKey: "LIB",
          },
        ],
        verifiedAt: FROZEN,
      });
    }
    sock = advanceSoci(sock, { now: FROZEN, workspace: preferWorkspace });
    const proposal = sock.proposals.find((row) => row.type === "wrong-cousin");
    expect(proposal?.summary).toMatch(/Prefer Pay CTA over Save CTA for product/);
    const decided = applySociDecision(
      sock,
      parseBindRulesFile({ rules: [] }),
      proposal!.id,
      "approve",
      "tanishk",
      FROZEN,
      { index: payMasters(), workspace: preferWorkspace },
    );
    commitProposalDecision(decided);
    const onDisk = JSON.parse(readFileSync(join(process.env["RESOLVE_HOME"]!, "bind-rules.json"), "utf8")) as {
      rules: Array<{ masterId?: string; overMasterId?: string; screenType?: string; prefer: string; over: string }>;
    };
    expect(onDisk.rules[0]).toMatchObject({
      prefer: "Shared DS",
      over: "Storefront",
      masterId: "node:live",
      overMasterId: "node:cousin",
      screenType: "product",
    });
    const rules = parseBindRulesFile(onDisk);
    const idle = scorePrefer(rules, "cta");
    expect(idle.map((row) => row.score)).toEqual([100, 100, 100]);
    const scoped = scorePrefer(rules, "product checkout");
    expect(scoped.find((row) => row.node.id === "node:live")?.score).toBe(148);
    expect(scoped.find((row) => row.node.id === "node:cousin")?.score).toBe(52);
    expect(scoped.find((row) => row.node.id === "node:other")?.score).toBe(100);
    const unscoped = resolveBindRules(
      parseBindRulesFile({ rules: [{ prefer: "Shared DS", over: "Storefront" }] }),
      { workspace: preferWorkspace },
    );
    const wide = scorePrefer(unscoped, "cta");
    expect(wide.find((row) => row.node.id === "node:live")?.score).toBe(148);
    expect(wide.find((row) => row.node.id === "node:other")?.score).toBe(148);
    expect(wide.find((row) => row.node.id === "node:cousin")?.score).toBe(52);
  });

  it("keeps a naming note when screens share no scope", () => {
    let sock = emptySock(3);
    for (const screen of ["Alpha", "Beta", "Gamma"]) {
      sock = recordCousinCorrections(sock, {
        screenId: screen,
        screenName: screen,
        hits: [
          {
            fromId: "node:cousin",
            fromName: "Save CTA",
            fromFileKey: "PROD",
            toId: "node:live",
            toName: "Pay CTA",
            toFileKey: "LIB",
          },
        ],
        verifiedAt: FROZEN,
      });
    }
    sock = advanceSoci(sock, { now: FROZEN, workspace: preferWorkspace });
    const proposal = sock.proposals.find((row) => row.type === "wrong-cousin");
    expect(proposal?.suggestedRule).toBeUndefined();
    expect(proposal?.summary).toMatch(/Naming fix/);
    const decided = applySociDecision(sock, parseBindRulesFile({ rules: [] }), proposal!.id, "approve", "tanishk", FROZEN, {
      index: payMasters(),
      workspace: preferWorkspace,
    });
    expect(decided.writesRules).toBe(false);
    commitProposalDecision(decided);
    expect(existsSync(join(process.env["RESOLVE_HOME"]!, "bind-rules.json"))).toBe(false);
  });
});

describe("approve refuses a stale master", () => {
  function recipeProposal() {
    let sock = emptySock(3);
    for (const screen of ["c1", "c2", "c3"]) {
      sock = usage(sock, screen, "Checkout", [{ id: "node:stepper", name: "Checkout Stepper" }], { slot: "header" });
    }
    sock = advanceSoci(sock, { recipes: starterRecipes(), now: FROZEN });
    const proposal = sock.proposals.find((row) => row.type === "recipe-update");
    return { sock, proposal: proposal! };
  }

  it("leaves a recipe proposal pending when the master is gone, deprecated, or removed", () => {
    const gone = recipeProposal();
    gone.proposal.suggestedRecipe = { ...gone.proposal.suggestedRecipe!, masterId: "node:GONE:1" };
    expect(() =>
      applySociDecision(gone.sock, parseBindRulesFile({ rules: [] }), gone.proposal.id, "approve", "tanishk", FROZEN, {
        index: stepperGraph(),
        recipes: starterRecipes(),
        overlay: [],
      }),
    ).toThrow(/not in the graph|Left pending/);
    expect(gone.proposal.status).toBe("pending");

    const deprecated = recipeProposal();
    const deprecatedIndex = stepperGraph();
    deprecatedIndex.getNode("node:stepper")!.status = "deprecated";
    expect(() =>
      applySociDecision(
        deprecated.sock,
        parseBindRulesFile({ rules: [] }),
        deprecated.proposal.id,
        "approve",
        "tanishk",
        FROZEN,
        { index: deprecatedIndex, recipes: starterRecipes(), overlay: [] },
      ),
    ).toThrow(/deprecated/);
    expect(deprecated.proposal.status).toBe("pending");

    const removed = recipeProposal();
    const removedIndex = stepperGraph();
    removedIndex.getNode("node:stepper")!.metadata = { removedByAbsence: true };
    expect(() =>
      applySociDecision(removed.sock, parseBindRulesFile({ rules: [] }), removed.proposal.id, "approve", "tanishk", FROZEN, {
        index: removedIndex,
        recipes: starterRecipes(),
        overlay: [],
      }),
    ).toThrow(/removed/);
    expect(removed.proposal.status).toBe("pending");
  });

  it("leaves variant and deprecation proposals pending when their targets are missing", () => {
    let sock = emptySock(3);
    for (const screen of ["s1", "s2", "s3"]) {
      sock = usage(sock, screen, "Account", [{ id: "node:card", name: "Main Card", overrideKeys: ["nested:Badge"] }]);
      sock = usage(sock, screen, "Checkout", [{ id: "node:stepper", name: "Checkout Stepper" }], { slot: "header" });
    }
    sock = advanceSoci(sock, { index: stepperGraph(), recipes: starterRecipes(), now: FROZEN });
    const variant = sock.proposals.find((row) => row.type === "variant-candidate")!;
    const deprecation = sock.proposals.find((row) => row.type === "deprecation-candidate")!;
    variant.suggestedVariant = { ...variant.suggestedVariant!, masterId: "node:GONE:1" };
    expect(() =>
      applySociDecision(sock, parseBindRulesFile({ rules: [] }), variant.id, "approve", "tanishk", FROZEN, {
        index: stepperGraph(),
      }),
    ).toThrow(/Left pending/);
    expect(variant.status).toBe("pending");
    deprecation.suggestedDeprecation = { ...deprecation.suggestedDeprecation!, cousinId: "node:GONE:1" };
    expect(() =>
      applySociDecision(sock, parseBindRulesFile({ rules: [] }), deprecation.id, "approve", "tanishk", FROZEN, {
        index: stepperGraph(),
      }),
    ).toThrow(/Left pending/);
    expect(deprecation.status).toBe("pending");
  });
});

describe("one recipe proposal per slot", () => {
  it("skips a tie and ignores nested masters that only inherited a frame slot", () => {
    let sock = emptySock(3);
    for (const screen of ["c1", "c2", "c3"]) {
      sock = usage(
        sock,
        screen,
        "Checkout",
        [
          { id: "node:stepper", name: "Checkout Stepper" },
          { id: "node:card", name: "Card" },
        ],
        { slot: "header" },
      );
    }
    sock = advanceSoci(sock, { recipes: starterRecipes(), now: FROZEN });
    expect(sock.proposals.filter((row) => row.type === "recipe-update")).toEqual([]);
  });

  it("keeps the master with the most screens", () => {
    let sock = emptySock(3);
    for (const screen of ["c1", "c2", "c3"]) {
      sock = usage(sock, screen, "Checkout", [{ id: "node:stepper", name: "Checkout Stepper" }], { slot: "header" });
      sock = usage(sock, screen, "Checkout", [{ id: "node:badge", name: "Badge" }]);
    }
    sock = usage(sock, "c1", "Checkout", [{ id: "node:card", name: "Card" }], { slot: "header" });
    sock = usage(sock, "c2", "Checkout", [{ id: "node:card", name: "Card" }], { slot: "header" });
    sock = advanceSoci(sock, { recipes: starterRecipes(), now: FROZEN });
    const recipes = sock.proposals.filter((row) => row.type === "recipe-update");
    expect(recipes).toHaveLength(1);
    expect(recipes[0]?.suggestedRecipe?.masterId).toBe("node:stepper");
    expect(recipes[0]?.suggestedRecipe?.slotRole).toBe("header");
  });
});

function checkoutFrameGraph(cardOn: number): DesignGraph {
  const nodes: GraphNode[] = [
    n("file:LIB", "FILE", "DS", { fileKey: "LIB" }),
    n("node:p", "PAGE", "Lib", { parentId: "file:LIB", pageId: "node:p", fileKey: "LIB" }),
    n("node:stepper", "MAIN_COMPONENT", "Checkout Stepper", {
      parentId: "node:p",
      pageId: "node:p",
      isMainComponent: true,
      fileKey: "LIB",
      figmaNodeId: "9:1",
    }),
    n("node:card", "MAIN_COMPONENT", "Card", {
      parentId: "node:p",
      pageId: "node:p",
      isMainComponent: true,
      fileKey: "LIB",
      figmaNodeId: "9:3",
    }),
    n("node:badge", "MAIN_COMPONENT", "Badge", {
      parentId: "node:p",
      pageId: "node:p",
      isMainComponent: true,
      fileKey: "LIB",
      figmaNodeId: "9:4",
    }),
  ];
  const edges: GraphEdge[] = [
    e("CONTAINS", "file:LIB", "node:p"),
    e("CONTAINS", "node:p", "node:stepper"),
    e("CONTAINS", "node:p", "node:card"),
    e("CONTAINS", "node:p", "node:badge"),
  ];
  for (let i = 1; i <= 3; i += 1) {
    const frame = `node:frame-${i}`;
    nodes.push(
      n(frame, "FRAME", `Checkout ${i}`, {
        parentId: "node:p",
        pageId: "node:p",
        fileKey: "LIB",
        figmaNodeId: `1:${i}`,
      }),
    );
    edges.push(e("CONTAINS", "node:p", frame));
    const stepInst = `node:step-inst-${i}`;
    nodes.push(
      n(stepInst, "COMPONENT_INSTANCE", "Checkout Stepper", {
        parentId: frame,
        pageId: "node:p",
        isInstance: true,
        mainComponentId: "node:stepper",
        fileKey: "LIB",
        figmaNodeId: `2:${i}`,
      }),
    );
    edges.push(e("CONTAINS", frame, stepInst), e("INSTANCE_OF", stepInst, "node:stepper"), e("NESTS", frame, stepInst));
    if (i <= cardOn) {
      const cardInst = `node:card-inst-${i}`;
      const badgeInst = `node:badge-inst-${i}`;
      nodes.push(
        n(cardInst, "COMPONENT_INSTANCE", "Card", {
          parentId: frame,
          pageId: "node:p",
          isInstance: true,
          mainComponentId: "node:card",
          fileKey: "LIB",
          figmaNodeId: `3:${i}`,
        }),
      );
      nodes.push(
        n(badgeInst, "COMPONENT_INSTANCE", "Badge", {
          parentId: cardInst,
          pageId: "node:p",
          isInstance: true,
          mainComponentId: "node:badge",
          fileKey: "LIB",
          figmaNodeId: `4:${i}`,
        }),
      );
      edges.push(
        e("CONTAINS", frame, cardInst),
        e("INSTANCE_OF", cardInst, "node:card"),
        e("NESTS", frame, cardInst),
        e("CONTAINS", cardInst, badgeInst),
        e("INSTANCE_OF", badgeInst, "node:badge"),
        e("NESTS", frame, badgeInst),
      );
    }
  }
  return {
    fileKey: "LIB",
    fileName: "DS",
    builtAt: FROZEN,
    source: { kind: "mock", ingestedAt: FROZEN },
    warnings: [],
    nodes,
    edges,
  };
}

describe("frame slot does not leak onto nested instances", () => {
  const previousHome = process.env["RESOLVE_HOME"];

  beforeEach(() => {
    process.env["RESOLVE_HOME"] = mkdtempSync(join(tmpdir(), "resolve-soci-slot-"));
    clearCache();
  });

  afterEach(() => {
    clearCache();
    if (previousHome === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previousHome;
  });

  it("verify_frame slot header proposes at most one master and skips a tie", () => {
    const tied = checkoutFrameGraph(3);
    const index = indexGraph(tied);
    expect(topLevelMasterIds(index, "node:frame-1").sort()).toEqual(["node:card", "node:stepper"]);
    saveGraph(tied);
    for (let i = 1; i <= 3; i += 1) {
      callTool("verify_frame", { frame: `node:frame-${i}`, slot: "header" });
    }
    const tiedSock = loadSock();
    expect(tiedSock?.facts.filter((fact) => fact.masterId === "node:badge").every((fact) => !fact.slot)).toBe(true);
    expect(tiedSock?.facts.filter((fact) => fact.masterId === "node:stepper").every((fact) => fact.slot === "header")).toBe(
      true,
    );
    expect(tiedSock?.proposals.filter((row) => row.type === "recipe-update")).toEqual([]);

    clearCache();
    saveGraph(checkoutFrameGraph(2));
    writeFileSync(sockPath(), `${JSON.stringify(emptySock(3))}\n`);
    clearCache();
    for (let i = 1; i <= 3; i += 1) {
      callTool("verify_frame", { frame: `node:frame-${i}`, slot: "header" });
    }
    const winner = loadSock()?.proposals.filter((row) => row.type === "recipe-update") ?? [];
    expect(winner).toHaveLength(1);
    expect(winner[0]?.suggestedRecipe).toMatchObject({ slotRole: "header", masterId: "node:stepper" });
    expect(winner.some((row) => /Badge|Card/.test(row.summary))).toBe(false);
  });
});

describe("malformed sock.json", () => {
  const previousHome = process.env["RESOLVE_HOME"];

  beforeEach(() => {
    process.env["RESOLVE_HOME"] = mkdtempSync(join(tmpdir(), "resolve-soci-sock-"));
    clearCache();
    saveGraph(fixtureGraph);
  });

  afterEach(() => {
    clearCache();
    if (previousHome === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previousHome;
  });

  it("verify, recipe, and governance survive proposals that are not a clean array", () => {
    const shapes: unknown[] = [
      "nope",
      { id: "x", status: "pending" },
      [
        null,
        { id: 1, status: "pending" },
        {
          id: "ok",
          status: "pending",
          type: "require-rule",
          summary: "keep me",
          evidence: "e",
          createdAt: FROZEN,
        },
      ],
    ];
    for (const proposals of shapes) {
      writeFileSync(
        sockPath(),
        `${JSON.stringify({
          version: 1,
          threshold: 3,
          facts: [],
          freshness: {},
          proposals,
          corrections: [null, { fromId: "a", toId: "b", screenId: "s1", fromName: "A", toName: "B", screenName: "One", verifiedAt: FROZEN }],
        })}\n`,
      );
      clearCache();
      const view = governanceView();
      expect(view.warnings.some((row) => row.rule === "sock.json")).toBe(true);
      if (Array.isArray(proposals)) {
        expect(view.proposals.map((row) => row.id)).toEqual(["ok"]);
        expect(loadSock()?.corrections).toHaveLength(1);
      } else {
        expect(view.proposals).toEqual([]);
      }
      expect(() => callTool("verify_frame", { components: ["Button"] })).not.toThrow();
      expect(() => callTool("recipe", { query: "checkout" })).not.toThrow();
    }
  });
});

describe("verify card budget includes cost", () => {
  it("stays at or under 600 chars with one component and 3 bad rules", () => {
    const graph: DesignGraph = {
      fileKey: "LIB",
      fileName: "Pay kit",
      builtAt: FROZEN,
      source: { kind: "mock", ingestedAt: FROZEN },
      warnings: [],
      nodes: [
        n("file:LIB", "FILE", "Pay kit", { fileKey: "LIB" }),
        n("node:p", "PAGE", "App", { parentId: "file:LIB", pageId: "node:p", fileKey: "LIB" }),
        n("node:live", "MAIN_COMPONENT", "Pay CTA", {
          parentId: "node:p",
          pageId: "node:p",
          isMainComponent: true,
          fileKey: "LIB",
          figmaNodeId: "9:1",
        }),
      ],
      edges: [e("CONTAINS", "file:LIB", "node:p"), e("CONTAINS", "node:p", "node:live")],
    };
    const index = indexGraph(graph);
    const bindRules = loadBindRulesLenient(
      {
        rules: [
          { require: "node:gone-1" },
          { require: "node:gone-2" },
          { require: "node:gone-3" },
        ],
      },
      { index },
    );
    expect(bindRules.warnings?.length).toBe(3);
    const result = verifyFrame(index, { components: ["Pay CTA"], bindRules });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(600);
    expect(JSON.stringify(result).length).toBeGreaterThan(500);
  });
});

describe("corrections log cap", () => {
  it("keeps the latest 200 corrections", () => {
    let sock = emptySock(3);
    for (let i = 0; i < 201; i += 1) {
      sock = recordCousinCorrections(sock, {
        screenId: `s${i}`,
        screenName: "Alpha",
        hits: [{ fromId: "node:a", fromName: "A", toId: "node:b", toName: "B" }],
        verifiedAt: FROZEN,
      });
    }
    expect(sock.corrections).toHaveLength(200);
    expect(sock.corrections?.[0]?.screenId).toBe("s1");
    expect(sock.corrections?.at(-1)?.screenId).toBe("s200");
  });
});
