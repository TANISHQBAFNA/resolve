import { describe, expect, it } from "vitest";
import {
  applyFreshness,
  emptySock,
  isRealVerifiedFrame,
  listSoci,
  newlyStrongPatterns,
  patternFor,
  patternsOf,
  proposeRuleChange,
  proposeStrongPatterns,
  recordVerifiedUsage,
  usageAllowsRecipeFill,
} from "@/core/query/sock";

const master = (id: string, name: string, extra: { deprecated?: boolean; private?: boolean } = {}) => ({
  id,
  name,
  figmaNodeId: id.replace("node:", ""),
  fileKey: "LIB",
  ...extra,
});

describe("SOCK usage facts", () => {
  it("learns on verify: one screen is low-confidence and does not drive recipes", () => {
    let sock = emptySock();
    sock = recordVerifiedUsage(sock, {
      screenId: "screen:1",
      screenName: "Checkout",
      masters: [master("node:btn", "Button")],
      verifiedAt: "2026-01-01T00:00:00.000Z",
    });
    const pattern = patternFor(sock, "node:btn");
    expect(pattern?.screens).toEqual(["screen:1"]);
    expect(pattern?.confidence).toBe("low");
    expect(usageAllowsRecipeFill(sock, "node:btn", 0)).toBe(false);
  });

  it("marks a pattern strong only after N distinct verified screens", () => {
    let sock = emptySock(3);
    sock = recordVerifiedUsage(sock, {
      screenId: "s1",
      screenName: "One",
      masters: [master("node:card", "Main Card")],
    });
    sock = recordVerifiedUsage(sock, {
      screenId: "s2",
      screenName: "Two",
      masters: [master("node:card", "Main Card")],
    });
    expect(patternFor(sock, "node:card")?.confidence).toBe("low");
    sock = recordVerifiedUsage(sock, {
      screenId: "s3",
      screenName: "Three",
      masters: [master("node:card", "Main Card")],
    });
    const pattern = patternFor(sock, "node:card");
    expect(pattern?.confidence).toBe("strong");
    expect(pattern?.screens).toHaveLength(3);
    expect(usageAllowsRecipeFill(sock, "node:card", 0)).toBe(true);
  });

  it("records deprecated usage but never promotes it", () => {
    let sock = emptySock(1);
    sock = recordVerifiedUsage(sock, {
      screenId: "s1",
      screenName: "Legacy",
      masters: [master("node:old", "Old Banner", { deprecated: true })],
    });
    const pattern = patternFor(sock, "node:old");
    expect(sock.facts[0]?.promoted).toBe(false);
    expect(pattern?.promoted).toBe(false);
    expect(pattern?.confidence).toBe("low");
    expect(usageAllowsRecipeFill(sock, "node:old", 99)).toBe(false);
  });

  it("does not auto-write rules — SOCI proposals stay pending", () => {
    let sock = emptySock();
    sock = proposeRuleChange(sock, "Deny Banner", "Seen on 4 verified screens as deprecated");
    expect(listSoci(sock)).toHaveLength(1);
    expect(listSoci(sock)[0]?.status).toBe("pending");
    expect(listSoci(sock)[0]?.kind).toBe("rule");
  });

  it("does not count component-list observations toward the N=3 threshold", () => {
    let sock = emptySock(3);
    for (const order of ["Button", "Card,Button", "Button,Card"]) {
      sock = recordVerifiedUsage(sock, {
        screenId: `obs:${order}`,
        screenName: "observation",
        masters: [master("node:btn", "Button")],
        countsTowardThreshold: false,
      });
    }
    expect(patternFor(sock, "node:btn")?.confidence).toBe("low");
    expect(patternFor(sock, "node:btn")?.screens).toEqual([]);
    expect(sock.facts).toHaveLength(3);
    expect(usageAllowsRecipeFill(sock, "node:btn", 0)).toBe(false);
  });

  it("only treats fileKey + frame nodeId as a real verified frame", () => {
    expect(isRealVerifiedFrame({ fileKey: "LIB", figmaNodeId: "1:1" })).toBe(true);
    expect(isRealVerifiedFrame({ fileKey: "LIB" })).toBe(false);
    expect(isRealVerifiedFrame({ figmaNodeId: "1:1" })).toBe(false);
    expect(isRealVerifiedFrame(undefined)).toBe(false);
  });

  it("proposes a SOCI rule when a pattern newly becomes strong and is not in recipes", () => {
    let sock = emptySock(3);
    const before = sock;
    for (const screen of ["pay-1", "pay-2", "pay-3"]) {
      sock = recordVerifiedUsage(sock, {
        screenId: screen,
        screenName: "Payment",
        masters: [master("node:btn", "Button")],
      });
    }
    const next = proposeStrongPatterns(sock, newlyStrongPatterns(before, sock), () => false);
    expect(listSoci(next)).toHaveLength(1);
    expect(listSoci(next)[0]?.status).toBe("pending");
    expect(listSoci(next)[0]?.summary).toMatch(/Button/);
    expect(listSoci(next)[0]?.suggestedRule).toMatchObject({
      require: "node:btn",
      screenType: "Payment",
    });
  });

  it("does not propose an unscoped global require from mixed screens", () => {
    let sock = emptySock(3);
    const before = sock;
    for (const screen of ["Checkout", "Settings", "Home"]) {
      sock = recordVerifiedUsage(sock, {
        screenId: screen,
        screenName: screen,
        masters: [master("node:input", "Input")],
      });
    }
    const next = proposeStrongPatterns(sock, newlyStrongPatterns(before, sock), () => false);
    expect(listSoci(next)).toEqual([]);
  });

  it("marks freshness stale when version or lastModified changes", () => {
    let sock = applyFreshness(emptySock(), [{ fileKey: "LIB", version: "1", lastModified: "t1" }]);
    expect(sock.freshness["LIB"]?.stale).toBe(false);
    sock = applyFreshness(sock, [{ fileKey: "LIB", version: "2", lastModified: "t2" }]);
    expect(sock.freshness["LIB"]?.stale).toBe(true);
    expect(patternsOf(sock)).toEqual([]);
  });

  it("lists exact pages/frames to re-fetch when stale", () => {
    let sock = applyFreshness(emptySock(), [
      {
        fileKey: "LIB",
        version: "1",
        outline: [
          { id: "1:1", name: "Home", kind: "frame" },
          { id: "1:2", name: "Settings", kind: "frame" },
        ],
      },
    ]);
    sock = applyFreshness(sock, [{ fileKey: "LIB", version: "2" }]);
    expect(sock.freshness["LIB"]?.stale).toBe(true);
    expect(sock.freshness["LIB"]?.delta?.map((item) => item.name)).toEqual(["Home", "Settings"]);
    expect(sock.freshness["LIB"]?.delta?.every((item) => item.action === "refetch")).toBe(true);
  });
});
