import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { adaptFigmaRestFile } from "@/core/ingestion/adapters/figmaRest";
import { SourceDocumentSchema } from "@/core/ingestion/types";
import type { DesignGraph, GraphNode, NodeType } from "@/core/model";
import { briefScreen, indexGraph, recommendMasters, starterRecipes, type GraphIndex } from "@/core/query";
import { meaningDictionary } from "@/core/query/meaning";
import { buildGraph } from "@/core/transform/buildGraph";
import { clearCache } from "@/server/store";

const FROZEN = "2026-01-01T00:00:00.000Z";

function node(id: string, type: NodeType, name: string): GraphNode {
  return { id, type, name, fileKey: "ACMEUI", figmaNodeId: id, isMainComponent: type === "MAIN_COMPONENT" };
}

function acmeIndex(): GraphIndex {
  const names = ["Card List", "Compact List", "Comfortable List", "Mobile Nav", "Desktop Nav", "Button", "Save CTA", "Search Field"];
  const graph: DesignGraph = {
    fileKey: "ACMEUI",
    fileName: "Acme UI",
    builtAt: FROZEN,
    source: { kind: "mock", ingestedAt: FROZEN },
    warnings: [],
    nodes: [node("file:ACMEUI", "FILE", "Acme UI"), ...names.map((name, index) => node(`node:10:${index}`, "MAIN_COMPONENT", name))],
    edges: [],
  };
  return indexGraph(graph);
}

function lead(index: GraphIndex, phrase: string): { name: string; match?: string } {
  const card = recommendMasters(index, phrase, { budgetChars: 4000 }) as { match?: string; candidates: Array<{ name?: string }> };
  return { name: card.candidates[0]?.name ?? "", match: card.match };
}

describe("r4 density, device, date, and acme wording", () => {
  const previous = process.env["RESOLVE_HOME"];
  afterEach(() => {
    clearCache();
    if (previous === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previous;
  });

  it("reads density for an everyday noun, and not when the noun is a material or a fabric", () => {
    delete process.env["RESOLVE_HOME"];
    clearCache();
    const index = acmeIndex();
    expect(lead(index, "a tight nav list").name).toMatch(/Nav/);
    expect(lead(index, "a dense people list").name).toBe("Compact List");
    expect(lead(index, "a relaxed list of rows").name).toBe("Comfortable List");
    expect(lead(index, "a compact row, of buttons").name).toBe("Button");
    for (const phrase of ["a dense velvet list", "a compact marble list", "a roomy notebook list", "a tight vellum list"]) {
      expect(lead(index, phrase).name, phrase).toBe("");
    }
    expect(meaningDictionary(index).language.density.comfortable).toContain("relaxed");
  });

  it("returns empty for a comfort word on rows when the library has no density variant", () => {
    const home = join(tmpdir(), "resolve-r4-comfort");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "synonyms.json"), readFileSync(join("fixtures", "material", "synonyms.json")));
    process.env["RESOLVE_HOME"] = home;
    clearCache();
    const payload = JSON.parse(readFileSync(join("fixtures", "material", "library.json"), "utf8")) as { fileKey: string; variables: unknown };
    const index = indexGraph(
      buildGraph(
        adaptFigmaRestFile({ fileKey: payload.fileKey, file: payload, variables: payload.variables, kind: "json", ingestedAt: FROZEN }),
        { builtAt: FROZEN },
      ),
    );
    expect(lead(index, "spacious rows").name).toBe("List");
    expect(lead(index, "relaxed rows").name).toBe("List");
    const compact = lead(index, "condensed rows");
    expect(compact.name).toBe("List");
    expect(compact.match).toBeUndefined();
    const brief = briefScreen({ request: "rows that are spacious", index, recipes: starterRecipes(), decisions: [] });
    const topics = "questions" in brief ? brief.questions.map((question) => question.topic) : [];
    expect(topics).not.toContain("states");
  });

  it("keeps all ten screen and display sizes, and a wide display still sets density", () => {
    delete process.env["RESOLVE_HOME"];
    clearCache();
    const index = acmeIndex();
    const device = meaningDictionary(index).language.device;
    for (const phrase of ["small screen", "large screen", "big screen", "wide screen", "narrow screen", "small display", "large display", "big display", "wide display", "narrow display"]) {
      expect(device, phrase).toContain(phrase);
    }
    expect(lead(index, "a list, spacious for a wide display").name).toBe("Comfortable List");
  });

  it("ranks a tool by the verb and object, and pick a date unit leads the date picker", () => {
    const home = join(tmpdir(), "resolve-r4-date");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "synonyms.json"), readFileSync(join("fixtures", "material", "synonyms.json")));
    process.env["RESOLVE_HOME"] = home;
    clearCache();
    const payload = JSON.parse(readFileSync(join("fixtures", "material", "library.json"), "utf8")) as { fileKey: string; variables: unknown };
    const material = indexGraph(
      buildGraph(
        adaptFigmaRestFile({ fileKey: payload.fileKey, file: payload, variables: payload.variables, kind: "json", ingestedAt: FROZEN }),
        { builtAt: FROZEN },
      ),
    );
    const week = lead(material, "pick a week");
    expect(week.name).toBe("Date picker");
    expect(lead(material, "a tool to pick a month").name).toBe("Date picker");
    delete process.env["RESOLVE_HOME"];
    clearCache();
    const raw: unknown = JSON.parse(readFileSync("scoreboard/fixture/library.json", "utf8"));
    const acme = indexGraph(buildGraph(SourceDocumentSchema.parse(raw), { builtAt: FROZEN }));
    expect(lead(acme, "a tool to save the draft").name).toBe("Save CTA");
    expect(lead(acme, "breadcrumb nav").name).toBe("Breadcrumb");
    expect(lead(acme, "breadcrumb-nav").name).toBe("Breadcrumb");
    expect(lead(acme, "call to action buttons").name).toBe("Button");
    expect(lead(acme, "call-to-action").name).toBe("Button");
    expect(lead(acme, "save-call-to-action").name).toBe("Save CTA");
    expect(lead(acme, "save-call-to-action").match).toBeUndefined();
  });
});
