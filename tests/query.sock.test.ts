import { describe, expect, it } from "vitest";
import {
  applyFreshness,
  emptySock,
  listSoci,
  patternFor,
  patternsOf,
  proposeRuleChange,
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

  it("marks freshness stale when version or lastModified changes", () => {
    let sock = applyFreshness(emptySock(), [{ fileKey: "LIB", version: "1", lastModified: "t1" }]);
    expect(sock.freshness["LIB"]?.stale).toBe(false);
    sock = applyFreshness(sock, [{ fileKey: "LIB", version: "2", lastModified: "t2" }]);
    expect(sock.freshness["LIB"]?.stale).toBe(true);
    expect(patternsOf(sock)).toEqual([]);
  });
});
