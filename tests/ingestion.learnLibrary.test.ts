import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { learnLibrary } from "@/server/learn";
import { clearCache, loadGraph, loadLearnCheckpoint } from "@/server/store";
import { placeReady } from "@/core/query/placeReady";

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

  it("documents the componentKey gap when only get_metadata is passed", () => {
    const result = learnLibrary({ fileKey: "LIB", role: "library", metadataXml: SCREEN_XML });
    expect(result.gaps[0]?.missing).toBe("componentKey");
    expect(result.gaps[0]?.hint).toMatch(/search_design_system|get_libraries/);
  });
});
