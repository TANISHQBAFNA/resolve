import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { graphFromMetadataXml, LEARN_PARSER_VERSION } from "@/core/ingestion/learnLibrary";

/**
 * Guard for the hand-bumped LEARN_PARSER_VERSION. A re-learn of an unchanged payload is skipped unless the
 * version changed, so when parsing the same XML gives a different graph the version must go up too.
 * If this fails: bump LEARN_PARSER_VERSION in src/core/ingestion/learnLibrary.ts, then pin the new
 * version and output hash below (and tell upgraded users to re-learn in the release notes).
 */
const PINNED = { version: 2, output: "cfa7b81ab00fa37c" };

const XML = [
  `<frame id="1:1" name="Kit">`,
  `<component_set id="5:1" name="Button"><component id="5:2" name="Type=Primary, Size=Medium" /><component id="5:3" name="Type=Ghost, Size=Small" /></component_set>`,
  `<component id="6:1" name="Badge" />`,
  `<component id="7:1" name="_Private dot" />`,
  `<frame id="8:1" name="Card"><instance id="8:2" name="Button" /><text id="8:3" name="Title" /></frame>`,
  `</frame>`,
].join("");

function outputHash(): string {
  const graph = graphFromMetadataXml({ fileKey: "GUARD", fileName: "Guard", metadataXml: XML, lastModified: "2026-01-01T00:00:00Z", version: "1" });
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !/^(builtAt|createdAt|updatedAt|ingestedAt)$/.test(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, inner]) => [key, stable(inner)]))
        : value;
  const sortBy = (rows: unknown[]) => rows.map((row) => JSON.stringify(stable(row))).sort();
  return createHash("sha256").update(JSON.stringify({ nodes: sortBy(graph.nodes), edges: sortBy(graph.edges) })).digest("hex").slice(0, 16);
}

describe("learn parser version guard", () => {
  it("parser output for a fixed payload only changes together with LEARN_PARSER_VERSION", () => {
    expect({ version: LEARN_PARSER_VERSION, output: outputHash() }).toEqual(PINNED);
  });

  it("the output hash is stable across runs", () => {
    expect(outputHash()).toBe(outputHash());
  });
});
