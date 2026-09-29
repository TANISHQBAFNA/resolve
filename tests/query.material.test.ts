import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import synonymFile from "@/data/synonyms.json";
import { adaptFigmaMcpMetadata } from "@/core/ingestion/adapters/figmaMcp";
import { mergeDesignGraphs } from "@/core/ingestion/learnLibrary";
import { buildGraph } from "@/core/transform/buildGraph";
import {
  indexGraph,
  recommendMasters,
  slotRecommendIntent,
  starterRecipes,
  verifyFrame,
} from "@/core/query";
import { initGoldenCases } from "@/core/query/scoreboard";
import type { DesignGraph, GraphEdge, GraphNode, NodeType } from "@/core/model";

const root = join(fileURLToPath(new URL("..", import.meta.url)), "scoreboard", "material");

function materialGraph() {
  const dir = join(root, "frames");
  const files = readdirSync(dir).filter((name) => name.startsWith("frame-") && name.endsWith(".xml"));
  return buildGraph(
    adaptFigmaMcpMetadata({
      fileKey: "M3",
      fileName: "Material",
      captures: files.map((name) => ({
        nodeId: name,
        metadataXml: readFileSync(join(dir, name), "utf8"),
      })),
    }),
  );
}

function materialIndex() {
  return indexGraph(materialGraph());
}

function materialWithProduct() {
  const product = buildGraph(
    adaptFigmaMcpMetadata({
      fileKey: "M3APP",
      fileName: "App",
      metadataXml: readFileSync(join(root, "frames", "product-screen.xml"), "utf8"),
    }),
  );
  return indexGraph(mergeDesignGraphs(materialGraph(), product));
}

function family(name: string | undefined): string {
  return (name ?? "").split(" / ")[0] ?? "";
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((part) => part.length > 1);
}

function related(familyName: string, hints: string[]): boolean {
  const fam = new Set(words(familyName));
  const hintTokens = hints.flatMap((hint) => words(hint));
  for (const token of hintTokens) {
    if ([...fam].some((part) => part.startsWith(token) || token.startsWith(part))) return true;
    for (const group of synonymFile.groups) {
      const terms = group.terms.flatMap((term) => words(term));
      if (terms.includes(token) && terms.some((term) => fam.has(term))) return true;
    }
  }
  return false;
}

function scoreMaterial(index: ReturnType<typeof materialIndex>, label: string) {
  const cases = JSON.parse(readFileSync(join(root, "cases.json"), "utf8")) as {
    screens: Array<{ slots: Array<{ q: string; exp: string[] | null }> }>;
    synonyms: Array<{ q: string; exp: string[] }>;
  };
  let top = 0;
  let top3 = 0;
  let topN = 0;
  let falseEmpty = 0;
  let emptyOk = 0;
  let emptyN = 0;
  const ids = new Set(index.allNodes.map((node) => node.id));
  for (const screen of cases.screens) {
    for (const slot of screen.slots) {
      const result = recommendMasters(index, slot.q);
      for (const row of result.candidates) {
        if ("id" in row && row.id) expect(ids.has(row.id), `${label} ${slot.q}`).toBe(true);
      }
      const names = result.candidates.slice(0, 3).map((row) => family(row.name));
      const topName = names[0] ?? "";
      if (slot.exp === null) {
        emptyN += 1;
        if (result.candidates.length === 0) emptyOk += 1;
      } else {
        topN += 1;
        if (slot.exp.includes(topName)) top += 1;
        if (slot.exp.some((exp) => names.includes(exp))) top3 += 1;
        if (result.candidates.length === 0) falseEmpty += 1;
      }
    }
  }
  let syn = 0;
  for (const row of cases.synonyms) {
    const result = recommendMasters(index, row.q);
    if (row.exp.includes(family(result.candidates[0]?.name))) syn += 1;
  }
  expect(top, label).toBe(41);
  expect(top3, label).toBe(41);
  expect(topN).toBe(41);
  expect(falseEmpty, label).toBe(0);
  expect(emptyOk, label).toBe(14);
  expect(emptyN).toBe(14);
  expect(syn, label).toBe(18);
  for (const query of ["primary button", "primary sign in button"]) {
    const card = recommendMasters(index, query);
    expect(family(card.candidates[0]?.name), `${label} ${query}`).toBe("Button");
    expect(card.match, `${label} ${query}`).toBe("weak match");
    expect(card.candidates.length, `${label} ${query}`).toBeGreaterThan(0);
    expect(card.candidates.length, `${label} ${query}`).toBeLessThanOrEqual(3);
    expect(card.candidates.some((row) => family(row.name) === "Tabs"), `${label} ${query}`).toBe(false);
  }
}

describe("material-like library", () => {
  it("scores the library alone and the library plus a product screen", () => {
    scoreMaterial(materialIndex(), "library");
    scoreMaterial(materialWithProduct(), "library+product");
  });

  it("gives every starter recipe a nextRecommend that is right or honestly empty", () => {
    const index = materialIndex();
    const families = [
      ...new Set(index.getNodesByType("COMPONENT_SET", "MAIN_COMPONENT").map((node) => node.name)),
    ];
    for (const recipe of starterRecipes()) {
      for (const slot of recipe.slots) {
        const query = slotRecommendIntent(recipe, slot);
        const result = recommendMasters(index, query);
        const topName = family(result.candidates[0]?.name);
        if (!topName) {
          expect(families.some((name) => related(name, slot.hints)), query).toBe(false);
          continue;
        }
        expect(related(topName, slot.hints), `${query} => ${topName}`).toBe(true);
        expect(topName).not.toBe("Tabs");
      }
    }
  });
});

describe("verify name and typos", () => {
  function n(id: string, type: NodeType, name: string, extra: Partial<GraphNode> = {}): GraphNode {
    return { id, type, name, ...extra };
  }
  function e(type: GraphEdge["type"], source: string, target: string): GraphEdge {
    return { id: `${type}|${source}|${target}`, source, target, type };
  }

  it("marks a name-matched layer name-only unless the design context names the master", () => {
    const graph: DesignGraph = {
      fileKey: "LIB",
      fileName: "Library",
      builtAt: "2026-01-01T00:00:00.000Z",
      source: { kind: "mock", ingestedAt: "2026-01-01T00:00:00.000Z" },
      warnings: [],
      nodes: [
        n("file:LIB", "FILE", "Library"),
        n("node:page", "PAGE", "App", { parentId: "file:LIB" }),
        n("node:frame", "FRAME", "Login", { parentId: "node:page", figmaNodeId: "1:1" }),
        n("node:button", "MAIN_COMPONENT", "Button", { parentId: "node:page", figmaNodeId: "9:9" }),
        n("node:guess", "MAIN_COMPONENT", "Button", {
          parentId: "node:page",
          figmaNodeId: "mcp-name:Button",
          metadata: { identity: "inferred-from-name" },
        }),
        n("node:inst", "COMPONENT_INSTANCE", "Button", {
          parentId: "node:frame",
          figmaNodeId: "2:2",
          mainComponentId: "node:guess",
          isInstance: true,
        }),
      ],
      edges: [
        e("CONTAINS", "file:LIB", "node:page"),
        e("CONTAINS", "node:page", "node:frame"),
        e("CONTAINS", "node:page", "node:button"),
        e("CONTAINS", "node:page", "node:guess"),
        e("CONTAINS", "node:frame", "node:inst"),
        e("NESTS", "node:frame", "node:inst"),
        e("INSTANCE_OF", "node:inst", "node:guess"),
      ],
    };
    const index = indexGraph(graph);
    const named = verifyFrame(index, { frame: "Login" });
    expect(named.pass).toBe(false);
    expect(JSON.stringify(named)).toContain('"result":"name-only"');
    expect(named.nameOnly).toBe(true);
    expect(JSON.stringify(named).toLowerCase()).not.toContain("verified");

    const wrong = verifyFrame(index, {
      frame: "Login",
      designContext: `<div data-node-id="2:2" componentId="8:8"></div>`,
    });
    expect(wrong.pass).toBe(false);

    const bound = verifyFrame(index, {
      frame: "Login",
      designContext: `<div data-node-id="2:2" componentId="9:9"></div>`,
    });
    expect(bound.pass).toBe(true);
    expect(JSON.stringify(bound)).toContain('"result":"verified"');
    expect(bound.nameOnly).toBeUndefined();
  });

  it("suggests Text Field for a swapped letter instead of inventing", () => {
    const index = materialIndex();
    const result = verifyFrame(index, { components: ["Text Feild"] });
    expect(result.pass).toBe(false);
    expect(result.invents).toEqual([]);
    expect(result.unresolved[0]?.didYouMean?.name).toMatch(/Text field/i);
    const recommend = recommendMasters(index, "Text Feild");
    expect(family(recommend.candidates[0]?.name)).toBe("Text field");
  });
});

describe("score --init", () => {
  it("writes a case for each master, a synonym, and three empty asks", () => {
    const index = materialIndex();
    const cases = initGoldenCases(index);
    const button = cases.find((row) => row.intent === "Button");
    expect(button?.expected).toBe("Button");
    expect(button?.expect).toBe("master");
    expect(cases.some((row) => row.intent === "cta" && row.expected === "Button")).toBe(true);
    const empties = cases.filter((row) => row.expect === "empty");
    expect(empties).toHaveLength(3);
    expect(cases.some((row) => row.intent === "Type=Filled")).toBe(false);
  });
});
