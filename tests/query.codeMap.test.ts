import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphNodeSchema, type DesignGraph, type GraphNode } from "@/core/model";
import {
  attachCodeTwin,
  catalogMasters,
  componentUsageCard,
  formatCodeMapReport,
  indexGraph,
  loadCodeMap,
  NO_CODE_MAP_HINT,
  recommendMasters,
  recipeCard,
  reportCodeMap,
  starterRecipes,
  verifyFrame,
} from "@/core/query";
import { runCli } from "@/server/cli";
import { clearCache, saveGraph } from "@/server/store";
import { index as demo } from "./fixture";

const FROZEN = "2026-01-01T00:00:00.000Z";

function writeMap(dir: string, body: unknown): void {
  writeFileSync(join(dir, "code-map.json"), `${JSON.stringify(body)}\n`);
}

function twin(component = "Button") {
  return {
    import: `import { ${component} } from '@acme/ui'`,
    component,
    props: { variant: { Primary: "primary" } },
  };
}

function mastersGraph(
  rows: Array<{ id: string; name: string; type?: "COMPONENT_SET" | "MAIN_COMPONENT" }>,
): DesignGraph {
  const nodes: GraphNode[] = [
    { id: "file:LIB", type: "FILE", name: "Acme UI", fileKey: "LIB" },
    ...rows.map((row) => ({
      id: `node:${row.id}`,
      type: (row.type ?? "COMPONENT_SET") as GraphNode["type"],
      name: row.name,
      figmaNodeId: row.id,
      fileKey: "LIB",
      isMainComponent: true,
    })),
  ];
  return {
    fileKey: "LIB",
    fileName: "Acme UI",
    builtAt: FROZEN,
    source: { kind: "mock", ingestedAt: FROZEN },
    warnings: [],
    nodes,
    edges: [],
  };
}

function mastersIndex(rows: Array<{ id: string; name: string; type?: "COMPONENT_SET" | "MAIN_COMPONENT" }>) {
  return indexGraph(mastersGraph(rows));
}

const lab = () =>
  mastersIndex([
    { id: "1:1", name: "Button" },
    { id: "2:2", name: "Chip" },
    { id: "3:3", name: "Dialog" },
  ]);

function snapshotCards(index: ReturnType<typeof indexGraph>) {
  return {
    recommend: JSON.stringify(recommendMasters(index, "primary button")),
    verify: JSON.stringify(verifyFrame(index, { frame: "Create account" })),
    resolve: JSON.stringify(componentUsageCard(index, "Button")),
    recipe: JSON.stringify(recipeCard(starterRecipes(), "checkout summary", index)),
  };
}

async function captureCli(argv: string[]): Promise<{ stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const writeOut = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await runCli(argv);
  } finally {
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
  }
  return { stdout: out.join(""), stderr: err.join("") };
}

describe("code-map.json", () => {
  const previousHome = process.env["GRAPHIFY_HOME"];
  let home: string;
  const index = lab();

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "resolve-code-map-"));
    process.env["GRAPHIFY_HOME"] = home;
    clearCache();
  });

  afterEach(() => {
    clearCache();
    if (previousHome === undefined) delete process.env["GRAPHIFY_HOME"];
    else process.env["GRAPHIFY_HOME"] = previousHome;
  });

  it("no map leaves recommend, verify, resolve, and recipe byte-identical", () => {
    const missing = snapshotCards(demo);
    writeMap(home, {});
    const empty = snapshotCards(demo);
    expect(empty).toEqual(missing);
    expect(missing.recommend).not.toContain('"code":');
    expect(missing.verify).not.toContain('"code":');
    expect(missing.resolve).not.toContain('"code":');
    expect(missing.recipe).not.toContain('"code":');
  });

  it("maps by file key + id and stamps code on a copy", () => {
    writeMap(home, {
      entries: [{ fileKey: "LIB", id: "1:1", name: "Button", code: twin() }],
    });
    const button = index.getNode("node:1:1")!;
    const stamped = attachCodeTwin(index, button);
    expect(stamped.code?.component).toBe("Button");
    expect(stamped.code?.import).toContain("@acme/ui");
    expect(stamped.code?.props?.variant?.Primary).toBe("primary");
    expect(button.code).toBeUndefined();
    expect(reportCodeMap(index).mapped).toBe(1);
    expect(reportCodeMap(index).unmapped).toBe(2);
    expect(recommendMasters(index, "Button").candidates[0]?.id).toBe("node:1:1");
  });

  it("falls back to name only when that name is unique", () => {
    writeMap(home, { entries: [{ fileKey: "LIB", name: "Chip", code: twin("Chip") }] });
    expect(attachCodeTwin(index, index.getNode("node:2:2")!).code?.component).toBe("Chip");
    expect(attachCodeTwin(index, index.getNode("node:1:1")!).code).toBeUndefined();
  });

  it("marks a non-unique name as ambiguous, not a pick", () => {
    const dup = mastersIndex([
      { id: "1:1", name: "Button" },
      { id: "9:9", name: "Button" },
      { id: "2:2", name: "Chip" },
    ]);
    writeMap(home, { entries: [{ fileKey: "LIB", name: "Button", code: twin() }] });
    const report = reportCodeMap(dup);
    expect(report.ambiguous).toBe(2);
    expect(report.mapped).toBe(0);
    expect(attachCodeTwin(dup, dup.getNode("node:1:1")!).code).toBeUndefined();
    expect(report.ambiguousNames).toEqual(["Button", "Button"]);
  });

  it("lists map entries that match nothing as stale", () => {
    writeMap(home, {
      entries: [
        { fileKey: "LIB", id: "1:1", code: twin() },
        { fileKey: "LIB", id: "99:99", name: "Ghost", code: twin("Ghost") },
      ],
    });
    const report = reportCodeMap(index);
    expect(report.stale).toBe(1);
    expect(report.staleEntries[0]?.name).toBe("Ghost");
    expect(formatCodeMapReport(report)).toContain("Stale: Ghost");
  });

  it("malformed file is no map and prints one stderr line", () => {
    writeFileSync(join(home, "code-map.json"), `{not json`);
    const err: string[] = [];
    const writeErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      err.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(loadCodeMap()).toBeUndefined();
      expect(reportCodeMap(index).configured).toBe(false);
    } finally {
      process.stderr.write = writeErr;
    }
    const lines = err.join("").trim().split("\n");
    expect(lines).toEqual(["code-map.json is malformed; ignored"]);
  });

  it("namingRule same-name maps a listed PascalCase name and never guesses the rest", () => {
    writeMap(home, { namingRule: "same-name", codeComponents: ["Button"] });
    expect(attachCodeTwin(index, index.getNode("node:1:1")!).code?.component).toBe("Button");
    expect(attachCodeTwin(index, index.getNode("node:2:2")!).code).toBeUndefined();
    const report = reportCodeMap(index);
    expect(report.mapped).toBe(1);
    expect(report.unmappedNames).toEqual(["Chip", "Dialog"]);
  });

  it("namingRule with two same PascalCase names is ambiguous, not a pick", () => {
    const dup = mastersIndex([
      { id: "1:1", name: "Button" },
      { id: "9:9", name: "button" },
    ]);
    writeMap(home, { namingRule: "same-name", codeComponents: ["Button"] });
    const report = reportCodeMap(dup);
    expect(report.mapped).toBe(0);
    expect(report.ambiguous).toBe(2);
    expect(attachCodeTwin(dup, dup.getNode("node:1:1")!).code).toBeUndefined();
  });

  it("two workspaces can own different maps", () => {
    const other = mkdtempSync(join(tmpdir(), "resolve-code-map-b-"));
    writeMap(home, { entries: [{ fileKey: "LIB", id: "1:1", code: twin() }] });
    writeMap(other, { entries: [{ fileKey: "LIB", id: "2:2", code: twin("Chip") }] });
    expect(attachCodeTwin(index, index.getNode("node:1:1")!).code?.component).toBe("Button");
    process.env["GRAPHIFY_HOME"] = other;
    expect(attachCodeTwin(index, index.getNode("node:1:1")!).code).toBeUndefined();
    expect(attachCodeTwin(index, index.getNode("node:2:2")!).code?.component).toBe("Chip");
  });

  it("re-reads the map between runs so an edit takes effect immediately", () => {
    writeMap(home, { entries: [{ fileKey: "LIB", id: "1:1", code: twin() }] });
    expect(attachCodeTwin(index, index.getNode("node:1:1")!).code?.component).toBe("Button");
    writeMap(home, { entries: [{ fileKey: "LIB", id: "2:2", code: twin("Chip") }] });
    expect(attachCodeTwin(index, index.getNode("node:1:1")!).code).toBeUndefined();
    expect(attachCodeTwin(index, index.getNode("node:2:2")!).code?.component).toBe("Chip");
  });

  it("recommend appends a short code hint when it fits, and skips when it would exceed the budget", () => {
    const none = recommendMasters(index, "Button");
    expect(none).not.toHaveProperty("code");
    writeMap(home, { entries: [{ fileKey: "LIB", id: "1:1", code: twin() }] });
    const hinted = recommendMasters(index, "Button");
    expect(hinted.code).toBe("Button from '@acme/ui'");
    expect(hinted.candidates[0]?.id).toBe(none.candidates[0]?.id);
    expect(hinted.cost.chars).toBeLessThanOrEqual(600);
    const tight = recommendMasters(index, "Button", { budgetChars: none.cost.chars });
    expect(tight).not.toHaveProperty("code");
    expect(JSON.stringify(tight)).toBe(JSON.stringify(none));
  });

  it("GraphNode keeps code optional so existing graphs parse unchanged", () => {
    const raw = { id: "node:1:1", type: "COMPONENT_SET", name: "Button" };
    expect(GraphNodeSchema.parse(raw)).toEqual(raw);
    expect(
      GraphNodeSchema.parse({
        ...raw,
        code: { import: "import { Button } from '@acme/ui'", component: "Button" },
      }).code?.component,
    ).toBe("Button");
  });

  it("CLI prints one hint when no map, and counts when a map exists", async () => {
    const none = await captureCli(["code-map"]);
    expect(none.stdout.trim()).toBe(NO_CODE_MAP_HINT);
    expect(none.stderr).toBe("");
    saveGraph(index.graph);
    writeMap(home, {
      entries: [
        { fileKey: "LIB", id: "1:1", code: twin() },
        { fileKey: "LIB", id: "99:99", name: "Ghost", code: twin("Ghost") },
      ],
    });
    const json = await captureCli(["code-map", "--json"]);
    const body = JSON.parse(json.stdout) as { mapped: number; unmapped: number; stale: number; configured: boolean };
    expect(body.configured).toBe(true);
    expect(body.mapped).toBe(1);
    expect(body.stale).toBe(1);
    expect(body.unmapped).toBe(2);
    const text = await captureCli(["code-map"]);
    expect(text.stdout).toContain("1 mapped");
    expect(text.stdout).toContain("Unmapped:");
    expect(text.stdout).toContain("Stale: Ghost");
  });

  it("catalog listing does not invent a code twin", () => {
    expect(catalogMasters(index).every((node) => node.code === undefined)).toBe(true);
  });
});
