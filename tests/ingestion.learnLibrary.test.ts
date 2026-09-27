import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { learnLibrary } from "@/server/learn";
import { clearCache, loadGraph, loadLearnCheckpoint } from "@/server/store";
import { placeReady } from "@/core/query/placeReady";
import { applyPublishedCatalog } from "@/core/ingestion/learnLibrary";
import { emptyGraph } from "@/core/model";
import { recommendMasters } from "@/core/query";
import { indexGraph } from "@/core/query";
import { readSock } from "@/server/store";

/** Real-shaped Figma MCP get_metadata output (prose wrapper + XML). */
const SCREEN_XML = `
Currently selected nodes:
- 1:1: Home

<frame id="1:1" name="Home" x="0" y="0" width="440" height="956">
  <component id="9:9" name="Main Card" x="16" y="80" width="408" height="200" />
  <instance id="2:2" name="Main Card" x="16" y="300" width="408" height="200" />
</frame>
IMPORTANT: After you call this tool, you MUST call get_design_context.
`;

const DIVIDER_XML = `
<frame id="1:2" name="Settings" x="500" y="0" width="440" height="956">
  <component id="8:8" name="Divider" x="16" y="24" width="408" height="1" />
</frame>
`;

describe("learn_library from Figma MCP get_metadata", () => {
  const previousHome = process.env["GRAPHIFY_HOME"];

  beforeEach(() => {
    process.env["GRAPHIFY_HOME"] = mkdtempSync(join(tmpdir(), "resolve-learn-"));
    clearCache();
  });

  afterEach(() => {
    clearCache();
    if (previousHome === undefined) delete process.env["GRAPHIFY_HOME"];
    else process.env["GRAPHIFY_HOME"] = previousHome;
  });

  it("learns masters incrementally across two passes", () => {
    const first = learnLibrary({
      fileKey: "LIB",
      role: "library",
      fileName: "DS",
      metadataXml: SCREEN_XML,
      version: "1",
    });
    expect(first.learned).toBe(true);
    expect(first.added).toBeGreaterThan(0);
    expect(loadGraph()?.graph.nodes.some((node) => node.name === "Main Card")).toBe(true);

    const second = learnLibrary({
      fileKey: "LIB",
      role: "library",
      metadataXml: DIVIDER_XML,
      version: "1",
      resume: true,
    });
    expect(second.resumed).toBe(true);
    const names = loadGraph()?.graph.nodes.map((node) => node.name) ?? [];
    expect(names).toContain("Main Card");
    expect(names).toContain("Divider");
  });

  it("resumes a checkpoint and skips a duplicate XML hash", () => {
    learnLibrary({ fileKey: "LIB", role: "library", metadataXml: SCREEN_XML });
    const checkpoint = loadLearnCheckpoint("LIB");
    expect(checkpoint?.completedHashes.length).toBe(1);

    const again = learnLibrary({
      fileKey: "LIB",
      role: "library",
      metadataXml: SCREEN_XML,
      resume: true,
    });
    expect(again.skippedDuplicate).toBe(true);
    expect(again.added).toBe(0);
  });

  it("stamps a published key from search_design_system and says when local-only", () => {
    learnLibrary({ fileKey: "LIB", role: "library", metadataXml: SCREEN_XML });
    const before = loadGraph()?.graph.nodes.find((node) => node.name === "Main Card");
    expect(placeReady(before!).published).toBe(false);
    expect(placeReady(before!).publishState).toBe("local-only");

    const result = learnLibrary({
      fileKey: "LIB",
      role: "library",
      libraries: {
        results: [{ name: "Main Card", key: "abc123published", nodeId: "9:9" }],
      },
    });
    expect(result.gaps.some((gap) => gap.missing === "componentKey")).toBe(false);
    const card = loadGraph()?.graph.nodes.find((node) => node.name === "Main Card");
    const place = placeReady(card!, "LIB");
    expect(place.componentKey).toBe("abc123published");
    expect(place.published).toBe(true);
    expect(place.nodeId).toBe("9:9");
    expect(place.fileKey).toBe("LIB");
  });

  it("does not swap published keys when node ids share a suffix (Button 12:3 vs Card 112:3)", () => {
    const graph = emptyGraph("LIB", "DS");
    graph.nodes.push(
      {
        id: "node:12:3",
        figmaNodeId: "12:3",
        fileKey: "LIB",
        type: "MAIN_COMPONENT",
        name: "Button",
        isMainComponent: true,
      },
      {
        id: "node:112:3",
        figmaNodeId: "112:3",
        fileKey: "LIB",
        type: "MAIN_COMPONENT",
        name: "Card",
        isMainComponent: true,
      },
    );
    applyPublishedCatalog(graph, {
      results: [
        { name: "Button", key: "btn-key", nodeId: "12:3", fileKey: "LIB" },
        { name: "Card", key: "card-key", nodeId: "112:3", fileKey: "LIB" },
      ],
    });
    const button = graph.nodes.find((node) => node.name === "Button");
    const card = graph.nodes.find((node) => node.name === "Card");
    expect(button?.metadata?.["key"]).toBe("btn-key");
    expect(card?.metadata?.["key"]).toBe("card-key");
  });

  it("name-fallback stamps a key only when exactly one master in that file has that name", () => {
    const graph = emptyGraph("LIB", "DS");
    graph.nodes.push(
      {
        id: "node:1:1",
        figmaNodeId: "1:1",
        fileKey: "LIB",
        type: "MAIN_COMPONENT",
        name: "Button",
        isMainComponent: true,
      },
      {
        id: "node:2:2",
        figmaNodeId: "2:2",
        fileKey: "LIB",
        type: "MAIN_COMPONENT",
        name: "Button",
        isMainComponent: true,
      },
    );
    applyPublishedCatalog(graph, { results: [{ name: "Button", key: "ambiguous" }] });
    expect(graph.nodes.every((node) => node.metadata?.["key"] === undefined)).toBe(true);
  });

  it("reports learned X of Y pages and the next frame", () => {
    const first = learnLibrary({
      fileKey: "LIB",
      role: "library",
      metadataXml: SCREEN_XML,
      outline: [
        { id: "1:1", name: "Home", kind: "frame" },
        { id: "1:2", name: "Settings", kind: "frame" },
      ],
    });
    expect(first.progress).toBe("learned 1 of 2 pages; next: Settings");
    expect(first.remaining.map((unit) => unit.name)).toEqual(["Settings"]);

    const second = learnLibrary({
      fileKey: "LIB",
      role: "library",
      metadataXml: DIVIDER_XML,
      resume: true,
      outline: [
        { id: "1:1", name: "Home", kind: "frame" },
        { id: "1:2", name: "Settings", kind: "frame" },
      ],
    });
    expect(second.progress).toBe("learned 2 of 2 pages; next: none (complete)");
    expect(second.remaining).toEqual([]);
  });

  it("marks a missing master deprecated-by-absence and never recommends it", () => {
    learnLibrary({
      fileKey: "LIB",
      role: "library",
      metadataXml: SCREEN_XML,
      version: "1",
    });
    const gone = learnLibrary({
      fileKey: "LIB",
      role: "library",
      metadataXml: `<frame id="1:1" name="Home"></frame>`,
      version: "2",
    });
    expect(gone.progress).toMatch(/learned /);
    const card = loadGraph()?.graph.nodes.find((node) => node.name === "Main Card");
    expect(card?.status).toBe("deprecated");
    expect(card?.metadata?.["removedByAbsence"]).toBe(true);
    expect(readSock().freshness["LIB"]?.removed?.some((row) => row.name === "Main Card")).toBe(true);

    const rec = recommendMasters(indexGraph(loadGraph()!.graph), "Main Card", { sock: readSock() });
    expect(rec.candidates.some((row) => row.name === "Main Card")).toBe(false);
  });

  it("documents the componentKey gap when only get_metadata is passed", () => {
    const result = learnLibrary({ fileKey: "LIB", role: "library", metadataXml: SCREEN_XML });
    expect(result.gaps[0]?.missing).toBe("componentKey");
    expect(result.gaps[0]?.hint).toMatch(/search_design_system|get_libraries/);
  });
});
