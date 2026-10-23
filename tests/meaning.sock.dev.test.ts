/**
 * DEV set only. Not the frozen acceptance set. Used while building the meaning SOCK.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { DesignGraph, GraphNode, NodeType } from "@/core/model";
import { indexGraph } from "@/core/query/GraphIndex";
import { buildMeaningPack, meaningCandidates, thinComponents, validatePick } from "@/core/query/meaning/sock";

const FROZEN = "2026-01-01T00:00:00.000Z";

function node(id: string, type: NodeType, name: string, description = ""): GraphNode {
  return { id, type, name, description, figmaNodeId: id, isMainComponent: type === "MAIN_COMPONENT" };
}

function packFrom(names: Array<[string, string]>, guidelines: string) {
  const graph: DesignGraph = {
    fileKey: "ACMEUI",
    fileName: "Acme UI",
    builtAt: FROZEN,
    source: { kind: "mock", ingestedAt: FROZEN },
    warnings: [],
    nodes: [node("file:acme", "FILE", "Acme UI"), ...names.map(([id, name], index) => node(`node:${index}`, "MAIN_COMPONENT", name, id))],
    edges: [],
  };
  return buildMeaningPack(indexGraph(graph), "Acme", guidelines, FROZEN);
}

describe("meaning SOCK dev set", () => {
  it("is labeled as a development set and is not the frozen fixture", () => {
    const dev = JSON.parse(readFileSync("scoreboard/meaning/dev-set.json", "utf8")) as { label: string; cases: unknown[] };
    expect(dev.label).toMatch(/DEV/);
    expect(dev.cases.length).toBeGreaterThan(0);
    expect(dev.cases.length).toBeLessThan(20);
  });

  it("quotes the component and flags thin descriptions", () => {
    const guidelines = ["# Acme", "## Switch", "Turns a setting on or off.", "## Button", "Sends a form."].join("\n");
    const pack = packFrom([["", "Switch"], ["", "Button"]], guidelines);
    const hits = meaningCandidates("turn alerts on or off", pack);
    expect(hits[0]?.name).toBe("Switch");
    expect(hits[0]?.reason.toLowerCase()).toContain("on or off");
    const stripped = {
      ...pack,
      components: pack.components.map((component, index) => (index < 5 ? { ...component, description: "", job: "", thin: ["description", "guideline"] } : component)),
    };
    const flagged = thinComponents(stripped);
    expect(flagged).toHaveLength(pack.components.length);
    expect(flagged.every((row) => row.missing.includes("description"))).toBe(true);
    const sure = meaningCandidates("turn alerts on or off", { ...stripped, components: stripped.components.map((component) => ({ ...component, job: "", description: "" })) });
    expect(sure.filter((row) => row.confidence === "sure")).toEqual([]);
    const pick = validatePick(pack, hits, hits[0]?.id ?? "", {});
    expect(pick.ok).toBe(true);
    expect(validatePick(pack, hits, "not-a-component").ok).toBe(false);
  });
});
