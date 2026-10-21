import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SourceDocumentSchema } from "@/core/ingestion/types";
import { adaptFigmaRestFile } from "@/core/ingestion/adapters/figmaRest";
import type { DesignGraph, GraphNode, NodeType } from "@/core/model";
import { buildMeaningDictionary, rankMeaning } from "@/core/query/meaning";
import { loadSynonymOverlay } from "@/core/query/recommendContext";
import { indexGraph } from "@/core/query/GraphIndex";
import { buildGraph } from "@/core/transform/buildGraph";
import { clearCache } from "@/server/store";

const repo = join(fileURLToPath(new URL("..", import.meta.url)));
const FROZEN = "2026-01-01T00:00:00.000Z";

function node(id: string, type: NodeType, name: string, extra: Partial<GraphNode> = {}): GraphNode {
  return { id, type, name, fileKey: "ACMEUI", ...extra };
}

function acmeLists() {
  const names = ["Summary Card", "Card List", "Compact List", "Comfortable List", "Save CTA", "Button", "Mini FAB"];
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

function acmeSample() {
  const raw: unknown = JSON.parse(readFileSync(join(repo, "scoreboard/fixture/library.json"), "utf8"));
  return indexGraph(buildGraph(SourceDocumentSchema.parse(raw), { builtAt: FROZEN }));
}

function material() {
  const payload = JSON.parse(readFileSync(join(repo, "fixtures/material/library.json"), "utf8")) as { fileKey: string; variables: unknown };
  return indexGraph(
    buildGraph(
      adaptFigmaRestFile({ fileKey: payload.fileKey, file: payload, variables: payload.variables, kind: "json", ingestedAt: FROZEN }),
      { builtAt: FROZEN },
    ),
  );
}

function withMaterialSynonyms(): void {
  const home = join(tmpdir(), "resolve-meaning-dict");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "synonyms.json"), readFileSync(join(repo, "fixtures/material/synonyms.json")));
  process.env["RESOLVE_HOME"] = home;
  clearCache();
  loadSynonymOverlay();
}

describe("meaning dictionary", () => {
  const previous = process.env["RESOLVE_HOME"];
  afterEach(() => {
    clearCache();
    if (previous === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previous;
    loadSynonymOverlay();
  });

  it("stores a reviewable dictionary for Acme and Angular Material", () => {
    delete process.env["RESOLVE_HOME"];
    clearCache();
    loadSynonymOverlay();
    const acme = buildMeaningDictionary(acmeSample(), "Acme");
    withMaterialSynonyms();
    const mat = buildMeaningDictionary(material(), "Angular Material");
    expect(acme.version).toBe(1);
    expect(mat.version).toBe(1);
    expect(acme.entries.length).toBeGreaterThan(20);
    expect(mat.entries.length).toBeGreaterThan(40);
    for (const dictionary of [acme, mat]) {
      expect(dictionary.language.density["compact"]).toContain("dense");
      for (const entry of dictionary.entries) {
        expect(entry.name.length).toBeGreaterThan(0);
        expect(entry.id).not.toMatch(/figd_|fileKey/i);
        expect(JSON.stringify(entry)).not.toMatch(/figd_/);
      }
    }
    expect(mat.entries.find((entry) => entry.name === "Date picker")?.synonyms).toContain("datepicker");
    expect(acme.entries.find((entry) => entry.name === "Button")?.not.length).toBeGreaterThan(0);
    const dir = join(repo, "src/data/meaning");
    if (process.env["WRITE_MEANING"] === "1") {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "acme.json"), `${JSON.stringify(acme, null, 2)}\n`);
      writeFileSync(join(dir, "material.json"), `${JSON.stringify(mat, null, 2)}\n`);
    }
    const savedAcme = JSON.parse(readFileSync(join(dir, "acme.json"), "utf8")) as typeof acme;
    const savedMat = JSON.parse(readFileSync(join(dir, "material.json"), "utf8")) as typeof mat;
    expect(savedAcme).toEqual(acme);
    expect(savedMat).toEqual(mat);
  });

  it("reads a card that is dated, a compact phone list, and a fruit picker", () => {
    delete process.env["RESOLVE_HOME"];
    clearCache();
    loadSynonymOverlay();
    const acme = buildMeaningDictionary(acmeLists(), "Acme");
    const dated = rankMeaning("a card that is dated", acme);
    expect(dated.empty).toBe(false);
    expect(dated.hits[0]?.name).toMatch(/Card/);
    expect(dated.intent.attributes).toContainEqual({ kind: "date", value: "date" });
    expect(dated.hits[0]?.reasons.join(" ")).toMatch(/[Dd]ate/);
    const list = rankMeaning("list, compact for phones", acme);
    expect(list.hits[0]?.name).toBe("Compact List");
    expect(list.intent.context.device).toBe("phone");
    expect(list.intent.attributes).toContainEqual({ kind: "density", value: "compact" });
    expect(list.hits[0]?.weak).toBe(false);
    withMaterialSynonyms();
    const mat = buildMeaningDictionary(material(), "Angular Material");
    const fruit = rankMeaning("picker for fruit", mat);
    expect(fruit.empty).toBe(true);
    expect(fruit.hits).toEqual([]);
    const card = rankMeaning("a card that is dated", mat);
    expect(card.hits[0]?.name).toBe("Card");
    expect(card.intent.attributes.map((row) => row.value)).toContain("date");
  });
});
