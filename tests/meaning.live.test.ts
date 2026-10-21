import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { adaptFigmaRestFile } from "@/core/ingestion/adapters/figmaRest";
import type { DesignGraph, GraphNode, NodeType } from "@/core/model";
import { indexGraph, type GraphIndex } from "@/core/query/GraphIndex";
import { recommendMasters } from "@/core/query/recommendMasters";
import { buildGraph } from "@/core/transform/buildGraph";
import { clearCache } from "@/server/store";

const FROZEN = "2026-01-01T00:00:00.000Z";

function node(id: string, type: NodeType, name: string, extra: Partial<GraphNode> = {}): GraphNode {
  return { id, type, name, fileKey: "ACMEUI", ...extra };
}

function acmeIndex(): GraphIndex {
  const names = [
    "Data Table", "Card List", "Summary Card", "Text Field", "Pay CTA", "Save CTA", "Search Field",
    "Empty Message", "Error Alert", "Loading Spinner", "Compact List", "Comfortable List",
    "Mobile Nav", "Desktop Nav", "Button", "Link Button",
  ];
  const graph: DesignGraph = {
    fileKey: "ACMEUI",
    fileName: "Acme UI",
    builtAt: FROZEN,
    source: { kind: "mock", ingestedAt: FROZEN },
    warnings: [],
    nodes: [node("file:ACMEUI", "FILE", "Acme UI"), ...names.map((name, i) => node(`node:10:${i}`, "MAIN_COMPONENT", name, { figmaNodeId: `10:${i}`, isMainComponent: true }))],
    edges: [],
  };
  return indexGraph(graph);
}

function materialIndex(): GraphIndex {
  const payload = JSON.parse(readFileSync("fixtures/material/library.json", "utf8")) as { fileKey: string; variables: unknown };
  return indexGraph(buildGraph(adaptFigmaRestFile({ fileKey: payload.fileKey, file: payload, variables: payload.variables, kind: "json", ingestedAt: FROZEN }), { builtAt: FROZEN }));
}

function top(index: GraphIndex, phrase: string, lexicalOnly = false): string {
  const card = recommendMasters(index, phrase, { budgetChars: 4000, ...(lexicalOnly ? { lexicalOnly: true } : {}) }) as { candidates: Array<{ name?: string }> };
  return card.candidates[0]?.name ?? "";
}

const ASKS: Array<{ library: "acme" | "material"; phrase: string; expect: string }> = [
  { library: "acme", phrase: "a dense list", expect: "Compact List" },
  { library: "acme", phrase: "a tight list", expect: "Compact List" },
  { library: "acme", phrase: "a condensed list", expect: "Compact List" },
  { library: "acme", phrase: "an airy list", expect: "Comfortable List" },
  { library: "acme", phrase: "a roomy list", expect: "Comfortable List" },
  { library: "acme", phrase: "a spacious list", expect: "Comfortable List" },
  { library: "acme", phrase: "list, compact for phones", expect: "Compact List" },
  { library: "acme", phrase: "a list, dense for mobile", expect: "Compact List" },
  { library: "acme", phrase: "a list, roomy on desktop", expect: "Comfortable List" },
  { library: "acme", phrase: "rows that are airy", expect: "Comfortable List" },
  { library: "acme", phrase: "a list which is compact please", expect: "Compact List" },
  { library: "acme", phrase: "a list, dense for tablets", expect: "Compact List" },
  { library: "acme", phrase: "a list, dense in landscape", expect: "Compact List" },
  { library: "acme", phrase: "a list, roomy on the phone", expect: "Comfortable List" },
  { library: "acme", phrase: "saving button", expect: "Save CTA" },
  { library: "acme", phrase: "a card that is dated", expect: "Card List" },
  { library: "acme", phrase: "a dense contact list", expect: "Compact List" },
  { library: "material", phrase: "something to pick a date", expect: "Date picker" },
  { library: "material", phrase: "a card that is dated", expect: "Card" },
  { library: "material", phrase: "the timed card", expect: "Card" },
  { library: "material", phrase: "mini floating action button", expect: "Mini FAB" },
  { library: "material", phrase: "dated picker", expect: "Date picker" },
  { library: "material", phrase: "the selected tab", expect: "Tabs" },
  { library: "material", phrase: "a searching bar", expect: "Search bar" },
  { library: "acme", phrase: "a list, airy;", expect: "Comfortable List" },
  { library: "acme", phrase: "refund rows, tight on an ipad", expect: "Compact List" },
  { library: "acme", phrase: "a list, spacious in portrait", expect: "Comfortable List" },
  { library: "acme", phrase: "searched field", expect: "Search Field" },
  { library: "material", phrase: "a toggled switch", expect: "Slide toggle" },
  { library: "material", phrase: "checked checkboxes", expect: "Checkbox" },
];

describe("meaning layer changes live answers", () => {
  const previous = process.env["RESOLVE_HOME"];
  afterEach(() => {
    clearCache();
    if (previous === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previous;
  });

  it("beats plain lexical ranking on at least 20 made-up asks", () => {
    const home = join(tmpdir(), "resolve-meaning-live");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "synonyms.json"), readFileSync("fixtures/material/synonyms.json"));
    process.env["RESOLVE_HOME"] = home;
    clearCache();
    const acme = acmeIndex();
    const material = materialIndex();
    const wins: string[] = [];
    const misses: string[] = [];
    for (const row of ASKS) {
      const index = row.library === "acme" ? acme : material;
      const live = top(index, row.phrase);
      const lexical = top(index, row.phrase, true);
      if (live === row.expect && live !== lexical) wins.push(`${row.phrase} → ${live} (lexical ${lexical || "∅"})`);
      else misses.push(`${row.phrase} live ${live || "∅"} lexical ${lexical || "∅"} want ${row.expect}`);
    }
    process.stdout.write(`${wins.length} live wins\n${wins.join("\n")}\n${misses.length ? `misses\n${misses.join("\n")}` : ""}\n`);
    expect(wins.length).toBeGreaterThanOrEqual(20);
  });

  it("drops the part named after not, and answers a purpose with no head", () => {
    const home = join(tmpdir(), "resolve-meaning-not");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "synonyms.json"), readFileSync("fixtures/material/synonyms.json"));
    process.env["RESOLVE_HOME"] = home;
    clearCache();
    const acme = acmeIndex();
    const material = materialIndex();
    expect(top(acme, "a button, not a link")).toBe("Button");
    expect(top(acme, "a link button, not button")).toBe("Link Button");
    expect(top(material, "something to pick a date")).toBe("Date picker");
    expect(top(material, "picker to choose a flavor")).toBe("");
  });
});
