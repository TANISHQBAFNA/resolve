import { describe, expect, it } from "vitest";
import type { AngularInventory } from "@/adapters/angular";
import type { DesignGraph, GraphNode } from "@/core/model";
import { indexGraph } from "@/core/query/GraphIndex";
import { suggestPairs, type CodeTarget } from "@/core/query/codeMapSuggest";

const FROZEN = "2026-01-01T00:00:00.000Z";

function inventory(components: { component: string; selector: string }[]): AngularInventory {
  return {
    packageName: "@acme/match",
    packageVersion: "1.0.0",
    components: components.map((row) => ({
      component: row.component,
      selector: row.selector,
      inputs: [],
      outputs: [],
      file: "index.d.ts",
      from: "dts" as const,
    })),
  };
}

function pairsFor(name: string, components: { component: string; selector: string }[]) {
  const nodes: GraphNode[] = [
    { id: "file:ACMEMATCH", type: "FILE", name: "Acme Match", fileKey: "ACMEMATCH" },
    { id: "node:1", type: "COMPONENT_SET", name, figmaNodeId: "1:1", fileKey: "ACMEMATCH", isMainComponent: true },
  ];
  const graph: DesignGraph = {
    fileKey: "ACMEMATCH",
    fileName: "Acme Match",
    builtAt: FROZEN,
    source: { kind: "mock", ingestedAt: FROZEN, version: "1" },
    warnings: [],
    nodes,
    edges: [],
  };
  const index = indexGraph(graph);
  const node = index.graph.nodes.find((item) => item.name === name)!;
  const targets: CodeTarget[] = [{ fileKey: "ACMEMATCH", id: "1:1", name, node }];
  return suggestPairs(index, inventory(components), targets);
}

describe("code map name matching", () => {
  it("does not match a raw character prefix", () => {
    const pairs = pairsFor("Harbor", [{ component: "HarborviewComponent", selector: "acme-harborview" }]);
    expect(pairs).toEqual([]);
  });

  it("labels an added button suffix partial, and prefers the exact class when both exist", () => {
    const onlyButton = pairsFor("Beacon", [{ component: "BeaconButtonComponent", selector: "acme-beacon-button" }]);
    expect(onlyButton.map((pair) => ({ component: pair.component, status: pair.status }))).toEqual([
      { component: "BeaconButtonComponent", status: "partial" },
    ]);
    const both = pairsFor("Beacon", [
      { component: "BeaconComponent", selector: "acme-beacon" },
      { component: "BeaconButtonComponent", selector: "acme-beacon-button" },
    ]);
    expect(both.map((pair) => ({ component: pair.component, status: pair.status }))).toEqual([
      { component: "BeaconComponent", status: "suggested" },
    ]);
  });

  it("labels family siblings partial", () => {
    const pairs = pairsFor("Color scale legend", [
      { component: "ColorScaleTickComponent", selector: "acme-color-scale-tick" },
      { component: "ColorScaleLabelComponent", selector: "acme-color-scale-label" },
    ]);
    expect(pairs.map((pair) => pair.status)).toEqual(["partial", "partial"]);
    expect(pairs.map((pair) => pair.component).sort()).toEqual(["ColorScaleLabelComponent", "ColorScaleTickComponent"]);
    expect(pairs.some((pair) => pair.status === "suggested")).toBe(false);
  });

  it("returns both partial candidates when an Acme class and a decoy share a name", () => {
    const pairs = pairsFor("Nimbus", [
      { component: "NimbusComponent", selector: "acme-nimbus" },
      { component: "AcmeNimbusComponent", selector: "acme-nimbus-mark" },
    ]);
    expect(pairs.map((pair) => pair.status)).toEqual(["partial", "partial"]);
    expect(pairs.map((pair) => pair.component).sort()).toEqual(["AcmeNimbusComponent", "NimbusComponent"]);
    expect(pairs.some((pair) => pair.status === "suggested")).toBe(false);
  });

  it("stems a plural to partial, never suggested", () => {
    const pairs = pairsFor("Lanterns", [{ component: "LanternComponent", selector: "acme-lantern" }]);
    expect(pairs.map((pair) => ({ component: pair.component, status: pair.status }))).toEqual([
      { component: "LanternComponent", status: "partial" },
    ]);
  });
});
