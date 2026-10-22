import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { adaptFigmaRestFile } from "@/core/ingestion/adapters/figmaRest";
import type { DesignGraph, GraphNode, NodeType } from "@/core/model";
import { indexGraph, recommendMasters, type GraphIndex } from "@/core/query";
import { buildGraph } from "@/core/transform/buildGraph";
import { clearCache } from "@/server/store";

const FROZEN = "2026-01-01T00:00:00.000Z";

function node(id: string, type: NodeType, name: string): GraphNode {
  return { id, type, name, fileKey: "ACMEUI", figmaNodeId: id, isMainComponent: type === "MAIN_COMPONENT" };
}

function graph(names: string[]): GraphIndex {
  const built: DesignGraph = {
    fileKey: "ACMEUI",
    fileName: "Acme UI",
    builtAt: FROZEN,
    source: { kind: "mock", ingestedAt: FROZEN },
    warnings: [],
    nodes: [node("file:ACMEUI", "FILE", "Acme UI"), ...names.map((name, index) => node(`node:10:${index}`, "MAIN_COMPONENT", name))],
    edges: [],
  };
  return indexGraph(built);
}

function lead(index: GraphIndex, phrase: string): { name: string; match?: string } {
  const card = recommendMasters(index, phrase, { budgetChars: 4000 }) as { match?: string; candidates: Array<{ name?: string }> };
  return { name: card.candidates[0]?.name ?? "", match: card.match };
}

describe("r8 regressions against main", () => {
  const previous = process.env["RESOLVE_HOME"];
  afterEach(() => {
    clearCache();
    if (previous === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previous;
  });

  it("keeps the named part when the library has no density list", () => {
    delete process.env["RESOLVE_HOME"];
    clearCache();
    const acme = graph(["Button", "Slider", "Chip", "Badge"]);
    expect(lead(acme, "compact list of buttons").name).toBe("Button");
    expect(lead(acme, "dense list of sliders").name).toBe("Slider");

    const home = join(tmpdir(), "resolve-r8-parts");
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
    expect(lead(material, "compact list of chips").name).toBe("Chip");
    expect(lead(material, "a dense list of badges").name).toBe("Badge");
    expect(lead(material, "dense list of sliders").name).toBe("Slider");
  });

  it("lets an explicit form win over a density word, and keeps a non-name lead weak", () => {
    delete process.env["RESOLVE_HOME"];
    clearCache();
    const acme = graph(["Form", "Compact List", "Comfortable List", "Card List", "Button", "Chip"]);
    for (const phrase of ["a form for a compact guest with a list", "form for a comfortable name with a list", "a form for a compact chip with a list"]) {
      const got = lead(acme, phrase);
      expect(got.name, phrase).toBe("Form");
      expect(got.match, phrase).toBeUndefined();
    }
    const home = join(tmpdir(), "resolve-r8-form");
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
    const form = lead(material, "a form for a compact guest with a list");
    expect(form.name).toBe("Form field");
    expect(form.match).toBeUndefined();
    const chipForm = lead(material, "a form for a compact chip with a list");
    expect(chipForm.name).toBe("Form field");
    expect(chipForm.match).toBeUndefined();
    const paging = lead(material, "paging");
    expect(paging.name).toBe("Paginator");
    expect(paging.match).toBe("weak match");
  });

  it("leaves a single inflected word empty when it does not name a component", () => {
    delete process.env["RESOLVE_HOME"];
    clearCache();
    const acme = graph(["Save CTA", "Button", "Date picker", "Time picker", "Card List"]);
    for (const phrase of ["saving", "dated", "timed"]) expect(lead(acme, phrase).name, phrase).toBe("");

    const home = join(tmpdir(), "resolve-r8-inflect");
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
    for (const phrase of ["dated", "timed", "saving", "checked"]) expect(lead(material, phrase).name, phrase).toBe("");
    expect(lead(material, "selected").name).toBe("Select");
  });
});
