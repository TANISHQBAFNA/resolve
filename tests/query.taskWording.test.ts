import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DesignGraph, GraphEdge, GraphNode } from "@/core/model";
import { indexGraph, recommendMasters } from "@/core/query";
import { clearCache } from "@/server/store";

// Asks worded the way a designer writes a task, from the 18-task component-selection run.
const FROZEN = "2026-01-01T00:00:00.000Z";
const parts = ["Toggle", "Date Picker", "Input Field", "Button", "Favourite", "Help Text", "Card", "Loading Mesage"];
const nodes: GraphNode[] = [
  { id: "file:LIB", type: "FILE", name: "Lib", fileKey: "LIB" },
  { id: "page:parts", type: "PAGE", name: "Components", fileKey: "LIB" },
  { id: "page:art", type: "PAGE", name: "↳ Illustrations", fileKey: "LIB" },
  ...parts.map((name, i): GraphNode => ({ id: `m:${i}`, type: "MAIN_COMPONENT", name, fileKey: "LIB", figmaNodeId: `1:${i}`, pageId: "page:parts" })),
  { id: "m:art", type: "MAIN_COMPONENT", name: "cards", fileKey: "LIB", figmaNodeId: "2:1", pageId: "page:art" },
];
const edge = (source: string, target: string): GraphEdge => ({ id: `CONTAINS|${source}|${target}`, type: "CONTAINS", source, target });
const graph: DesignGraph = {
  fileKey: "LIB",
  fileName: "Lib",
  schemaVersion: 1,
  builtAt: FROZEN,
  source: { kind: "mock", ingestedAt: FROZEN },
  warnings: [],
  nodes,
  edges: [
    edge("file:LIB", "page:parts"),
    edge("file:LIB", "page:art"),
    ...nodes.filter((node) => node.pageId).map((node) => edge(node.pageId!, node.id)),
  ],
};

describe("task-worded asks", () => {
  const previous = process.env["RESOLVE_HOME"];
  beforeAll(() => {
    process.env["RESOLVE_HOME"] = mkdtempSync(join(tmpdir(), "resolve-task-wording-"));
    clearCache();
  });
  afterAll(() => {
    if (previous === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previous;
    clearCache();
  });
  const top = (ask: string) => recommendMasters(indexGraph(graph), ask).candidates[0]?.name;

  it.each([
    ["a switch that turns workout reminders on and off", "Toggle"],
    ["big confirm button whose colour changes with the toggle", "Button"],
    ["a field to pick the departure date", "Date Picker"],
    ["an error message shown under a failed form field", "Help Text"],
    ["heart", "Favourite"],
    ["favourite heart", "Favourite"],
  ])("%s → %s", (ask, name) => {
    expect(top(ask)).toBe(name);
  });

  it("keeps artwork on an Illustrations page out of a part ask", () => {
    const names = (ask: string) => recommendMasters(indexGraph(graph), ask, { budgetChars: 3000 }).candidates.map((row) => row.name);
    expect(names("stacked cards")).not.toContain("cards");
    expect(names("illustration cards")).toContain("cards");
  });
});
