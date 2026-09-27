import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesignGraph, GraphEdge, GraphNode, NodeType } from "@/core/model";
import {
  advanceSoci,
  applySociDecision,
  capSociProposals,
  emptySock,
  fitBindRuleWarnings,
  indexGraph,
  loadBindRulesLenient,
  parseBindRulesFile,
  recommendMasters,
  recordCousinCorrections,
  recordVerifiedUsage,
  starterRecipes,
} from "@/core/query";
import { clearCache, commitProposalDecision, readBindRules, saveSock } from "@/server/store";

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
    expect(row?.suggestedRule).toMatchObject({ prefer: "Shared DS", over: "Storefront" });
    expect(row?.summary).toMatch(/Prefer Pay CTA/);
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
  const previousHome = process.env["GRAPHIFY_HOME"];

  beforeEach(() => {
    process.env["GRAPHIFY_HOME"] = mkdtempSync(join(tmpdir(), "resolve-soci-"));
    clearCache();
  });

  afterEach(() => {
    clearCache();
    if (previousHome === undefined) delete process.env["GRAPHIFY_HOME"];
    else process.env["GRAPHIFY_HOME"] = previousHome;
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
      { recipes: starterRecipes(), overlay: [] },
    );
    expect(decided.writesRecipes).toBe(true);
    expect(decided.writesRules).toBe(false);
    expect(decided.recipeOverlay?.some((recipe) => recipe.id === "checkout-summary")).toBe(true);
    const header = decided.recipeOverlay?.find((recipe) => recipe.id === "checkout-summary")?.slots.find(
      (slot) => slot.role === "header",
    );
    expect(header?.defaultMasterId).toBe("node:stepper");
    commitProposalDecision(decided);
    const overlayPath = join(process.env["GRAPHIFY_HOME"]!, "recipes.json");
    expect(existsSync(overlayPath)).toBe(true);
    const written = JSON.parse(readFileSync(overlayPath, "utf8")) as {
      recipes: Array<{ id: string; slots: Array<{ role: string; defaultMasterId?: string }> }>;
    };
    expect(
      written.recipes
        .find((recipe) => recipe.id === "checkout-summary")
        ?.slots.find((slot) => slot.role === "header")?.defaultMasterId,
    ).toBe("node:stepper");
    expect(existsSync(join(process.env["GRAPHIFY_HOME"]!, "bind-rules.json"))).toBe(false);
    const audit = readFileSync(join(process.env["GRAPHIFY_HOME"]!, "bind-rules.audit.jsonl"), "utf8");
    expect(audit).toMatch(/tanishk/);
    const saved = JSON.parse(readFileSync(join(process.env["GRAPHIFY_HOME"]!, "sock.json"), "utf8")) as {
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
    const variantDecision = applySociDecision(sock, rulesBefore, variant!.id, "approve", "tanishk", FROZEN);
    expect(variantDecision.writesRules).toBe(false);
    expect(variantDecision.writesRecipes).toBe(false);
    expect(variantDecision.rules.rules).toEqual(rulesBefore.rules);
    commitProposalDecision(variantDecision);
    expect(existsSync(join(process.env["GRAPHIFY_HOME"]!, "recipes.json"))).toBe(false);
    const afterVariant = JSON.parse(readFileSync(join(process.env["GRAPHIFY_HOME"]!, "sock.json"), "utf8")) as {
      proposals: Array<{ id: string; status: string; type?: string }>;
    };
    sock = { ...sock, proposals: afterVariant.proposals } as typeof sock;
    const depDecision = applySociDecision(sock, readBindRules(), deprecation!.id, "approve", "tanishk", FROZEN);
    expect(depDecision.writesRules).toBe(false);
    commitProposalDecision(depDecision);
    expect(existsSync(join(process.env["GRAPHIFY_HOME"]!, "recipes.json"))).toBe(false);
    const bindPath = join(process.env["GRAPHIFY_HOME"]!, "bind-rules.json");
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
