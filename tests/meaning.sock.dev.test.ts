/**
 * DEV set only. Not the frozen acceptance set. Used while building the meaning SOCK.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { DesignGraph, GraphNode, NodeType } from "@/core/model";
import { indexGraph } from "@/core/query/GraphIndex";
import { buildMeaningPack, meaningCandidates, thinComponents, validateAiPick } from "@/core/query/meaning/sock";
import { readFrozenCases } from "./meaning.frozen-score";

const FROZEN = "2026-01-01T00:00:00.000Z";

function node(id: string, type: NodeType, name: string, description = ""): GraphNode {
  return { id, type, name, description, figmaNodeId: id, isMainComponent: type === "MAIN_COMPONENT" };
}

function packFrom(names: Array<[string, string]>) {
  const graph: DesignGraph = {
    fileKey: "ACMEUI",
    fileName: "Acme UI",
    builtAt: FROZEN,
    source: { kind: "mock", ingestedAt: FROZEN },
    warnings: [],
    nodes: [node("file:acme", "FILE", "Acme UI"), ...names.map(([id, name], index) => node(`node:${index}`, "MAIN_COMPONENT", name, id))],
    edges: [],
  };
  return buildMeaningPack(indexGraph(graph), "Acme", FROZEN);
}

describe("meaning SOCK dev set", () => {
  it("is labeled as a development set and is not the frozen fixture", () => {
    const dev = JSON.parse(readFileSync("scoreboard/meaning/dev-set.json", "utf8")) as { label: string; cases: unknown[] };
    expect(dev.label).toMatch(/DEV ONLY/);
    expect(dev.label).toMatch(/Not the frozen/);
    expect(dev.cases.length).toBeGreaterThan(0);
    expect(dev.cases.length).toBeLessThan(20);
    const frozenAsks = new Set(readFrozenCases().map((row) => row.ask.toLowerCase()));
    for (const row of dev.cases as Array<{ ask: string }>) {
      expect(frozenAsks.has(row.ask.toLowerCase()), row.ask).toBe(false);
    }
  });

  it("quotes the component and flags thin descriptions", () => {
    const pack = packFrom([["Library switch control.", "Switch"], ["Sends a form.", "Button"]]);
    const hits = meaningCandidates("Switch", pack);
    expect(hits[0]?.name).toBe("Switch");
    expect(hits[0]?.reason).toBe("Library switch control.");
    const stripped = {
      ...pack,
      components: pack.components.map((component, index) => (index < 5 ? { ...component, description: "", job: "", thin: ["description", "guideline"] } : component)),
    };
    const flagged = thinComponents(stripped);
    expect(flagged).toHaveLength(pack.components.length);
    expect(flagged.every((row) => row.missing.includes("description"))).toBe(true);
    const sure = meaningCandidates("xyzzy", { ...stripped, components: stripped.components.map((component) => ({ ...component, job: "", description: "" })) });
    expect(sure.filter((row) => row.confidence === "sure")).toEqual([]);
    const pick = validateAiPick(pack, {
      library: pack.library,
      ask: "Switch",
      shortlist: hits.map((hit) => hit.id),
      pick: hits[0]?.id ?? "",
      reason: hits[0]?.reason,
      tier: "place",
    });
    expect(pick.tier).toBe("place");
    expect(pick.id).toBe(hits[0]?.id);
    expect(pick.failed).toEqual([]);
    expect(pick.reason).toBe("Library switch control.");
    const missing = validateAiPick(pack, {
      library: pack.library,
      ask: "Switch",
      shortlist: hits.map((hit) => hit.id),
      pick: "not-a-component",
      reason: "Library switch control.",
      tier: "place",
    });
    expect(missing.tier).toBe("no-fit");
    expect(missing.id).toBeUndefined();
    expect(missing.failed).toContain("exists");
  });
});
