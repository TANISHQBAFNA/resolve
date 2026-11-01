import { describe, expect, it } from "vitest";
import {
  applyFreshness,
  emptyDsck,
  isRealVerifiedFrame,
  listDsci,
  newlyStrongPatterns,
  patternFor,
  patternsOf,
  proposeRuleChange,
  proposeStrongPatterns,
  recordVerifiedUsage,
  scopeFromUsageFacts,
  usageAllowsRecipeFill,
} from "@/core/query/dsck";

const master = (id: string, name: string, extra: { deprecated?: boolean; private?: boolean } = {}) => ({
  id,
  name,
  figmaNodeId: id.replace("node:", ""),
  fileKey: "LIB",
  ...extra,
});

describe("DSCK usage facts", () => {
  it("learns on verify: one screen is low-confidence and does not drive recipes", () => {
    let dsck = emptyDsck();
    dsck = recordVerifiedUsage(dsck, {
      screenId: "screen:1",
      screenName: "Checkout",
      masters: [master("node:btn", "Button")],
      verifiedAt: "2026-01-01T00:00:00.000Z",
    });
    const pattern = patternFor(dsck, "node:btn");
    expect(pattern?.screens).toEqual(["screen:1"]);
    expect(pattern?.confidence).toBe("low");
    expect(usageAllowsRecipeFill(dsck, "node:btn", 0)).toBe(false);
  });

  it("marks a pattern strong only after N distinct verified screens", () => {
    let dsck = emptyDsck(3);
    dsck = recordVerifiedUsage(dsck, {
      screenId: "s1",
      screenName: "One",
      masters: [master("node:card", "Main Card")],
    });
    dsck = recordVerifiedUsage(dsck, {
      screenId: "s2",
      screenName: "Two",
      masters: [master("node:card", "Main Card")],
    });
    expect(patternFor(dsck, "node:card")?.confidence).toBe("low");
    dsck = recordVerifiedUsage(dsck, {
      screenId: "s3",
      screenName: "Three",
      masters: [master("node:card", "Main Card")],
    });
    const pattern = patternFor(dsck, "node:card");
    expect(pattern?.confidence).toBe("strong");
    expect(pattern?.screens).toHaveLength(3);
    expect(usageAllowsRecipeFill(dsck, "node:card", 0)).toBe(true);
  });

  it("records deprecated usage but never promotes it", () => {
    let dsck = emptyDsck(1);
    dsck = recordVerifiedUsage(dsck, {
      screenId: "s1",
      screenName: "Legacy",
      masters: [master("node:old", "Old Banner", { deprecated: true })],
    });
    const pattern = patternFor(dsck, "node:old");
    expect(dsck.facts[0]?.promoted).toBe(false);
    expect(pattern?.promoted).toBe(false);
    expect(pattern?.confidence).toBe("low");
    expect(usageAllowsRecipeFill(dsck, "node:old", 99)).toBe(false);
  });

  it("does not auto-write rules — DSCI proposals stay pending", () => {
    let dsck = emptyDsck();
    dsck = proposeRuleChange(dsck, "Deny Banner", "Seen on 4 verified screens as deprecated");
    expect(listDsci(dsck)).toHaveLength(1);
    expect(listDsci(dsck)[0]?.status).toBe("pending");
    expect(listDsci(dsck)[0]?.kind).toBe("rule");
  });

  it("does not count component-list observations toward the N=3 threshold", () => {
    let dsck = emptyDsck(3);
    for (const order of ["Button", "Card,Button", "Button,Card"]) {
      dsck = recordVerifiedUsage(dsck, {
        screenId: `obs:${order}`,
        screenName: "observation",
        masters: [master("node:btn", "Button")],
        countsTowardThreshold: false,
      });
    }
    expect(patternFor(dsck, "node:btn")?.confidence).toBe("low");
    expect(patternFor(dsck, "node:btn")?.screens).toEqual([]);
    expect(dsck.facts).toHaveLength(3);
    expect(usageAllowsRecipeFill(dsck, "node:btn", 0)).toBe(false);
  });

  it("only treats fileKey + frame nodeId as a real verified frame", () => {
    expect(isRealVerifiedFrame({ fileKey: "LIB", figmaNodeId: "1:1" })).toBe(true);
    expect(isRealVerifiedFrame({ fileKey: "LIB" })).toBe(false);
    expect(isRealVerifiedFrame({ figmaNodeId: "1:1" })).toBe(false);
    expect(isRealVerifiedFrame(undefined)).toBe(false);
  });

  it("proposes a DSCI rule when a pattern newly becomes strong and is not in recipes", () => {
    let dsck = emptyDsck(3);
    const before = dsck;
    for (const screen of ["pay-1", "pay-2", "pay-3"]) {
      dsck = recordVerifiedUsage(dsck, {
        screenId: screen,
        screenName: "Payment",
        masters: [master("node:btn", "Button")],
      });
    }
    const next = proposeStrongPatterns(dsck, newlyStrongPatterns(before, dsck), () => false);
    expect(listDsci(next)).toHaveLength(1);
    expect(listDsci(next)[0]?.status).toBe("pending");
    expect(listDsci(next)[0]?.summary).toMatch(/Button/);
    expect(listDsci(next)[0]?.suggestedRule).toMatchObject({
      require: "node:btn",
      screenType: "Payment",
    });
  });

  it("does not treat generic screen words as a screen type", () => {
    const factsFor = (names: string[]) => {
      let dsck = emptyDsck();
      names.forEach((screenName, index) => {
        dsck = recordVerifiedUsage(dsck, {
          screenId: `s${index}`,
          screenName,
          masters: [master("node:btn", "Button")],
        });
      });
      return dsck.facts;
    };
    expect(scopeFromUsageFacts(factsFor(["ax Screen", "bx Screen"])).screenType).toBeUndefined();
    expect(scopeFromUsageFacts(factsFor(["Screen v1", "Page v2"])).screenType).toBeUndefined();
    expect(scopeFromUsageFacts(factsFor(["Untitled"])).screenType).toBeUndefined();
    expect(scopeFromUsageFacts(factsFor(["Checkout Screen", "Checkout Page"])).screenType).toBe("checkout");
    expect(scopeFromUsageFacts(factsFor(["Home v1", "Home v2"])).screenType).toBe("home");
    expect(scopeFromUsageFacts(factsFor(["Payment"])).screenType).toBe("Payment");
  });

  it("does not propose an unscoped global require from mixed screens", () => {
    let dsck = emptyDsck(3);
    const before = dsck;
    for (const screen of ["Checkout", "Settings", "Home"]) {
      dsck = recordVerifiedUsage(dsck, {
        screenId: screen,
        screenName: screen,
        masters: [master("node:input", "Input")],
      });
    }
    const next = proposeStrongPatterns(dsck, newlyStrongPatterns(before, dsck), () => false);
    expect(listDsci(next)).toEqual([]);
  });

  it("marks freshness stale when version or lastModified changes", () => {
    let dsck = applyFreshness(emptyDsck(), [{ fileKey: "LIB", version: "1", lastModified: "t1" }]);
    expect(dsck.freshness["LIB"]?.stale).toBe(false);
    dsck = applyFreshness(dsck, [{ fileKey: "LIB", version: "2", lastModified: "t2" }]);
    expect(dsck.freshness["LIB"]?.stale).toBe(true);
    expect(patternsOf(dsck)).toEqual([]);
  });

  it("lists exact pages/frames to re-fetch when stale", () => {
    let dsck = applyFreshness(emptyDsck(), [
      {
        fileKey: "LIB",
        version: "1",
        outline: [
          { id: "1:1", name: "Home", kind: "frame" },
          { id: "1:2", name: "Settings", kind: "frame" },
        ],
      },
    ]);
    dsck = applyFreshness(dsck, [{ fileKey: "LIB", version: "2" }]);
    expect(dsck.freshness["LIB"]?.stale).toBe(true);
    expect(dsck.freshness["LIB"]?.delta?.map((item) => item.name)).toEqual(["Home", "Settings"]);
    expect(dsck.freshness["LIB"]?.delta?.every((item) => item.action === "refetch")).toBe(true);
  });
});
