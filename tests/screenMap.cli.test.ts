import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adaptFigmaRestFile } from "@/core/ingestion";
import { runMapCall, runMapCli, screenMapTools, screenMapUsageLines } from "@/core/screenMap/run";
import { buildGraph } from "@/core/transform";
import { usage } from "@/server/cliUsage";
import { readConfig } from "@/server/mode";
import { callTool, listToolDefinitions } from "@/server/tools";

const FROZEN = "2026-11-05T00:00:00.000Z";

function graph() {
  return buildGraph(adaptFigmaRestFile({
    fileKey: "acme-checkout",
    file: { name: "Acme Checkout", version: "5", document: { id: "0:0", name: "Acme Checkout", type: "DOCUMENT", children: [{ id: "0:1", name: "Checkout", type: "CANVAS", children: [{ id: "1:1", name: "Cart", type: "FRAME" }] }] } },
    kind: "figma-rest",
    ingestedAt: FROZEN,
  }), { builtAt: FROZEN });
}

function tempDir(enabled: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "screen-map-cli-"));
  if (enabled) {
    mkdirSync(join(dir, ".resolve"));
    writeFileSync(join(dir, ".resolve", "config.json"), JSON.stringify({ screenMap: { enabled: true, lookalikes: false } }));
  }
  return dir;
}

describe("screen map cli and mcp", () => {
  it("stays off until config says so, and help still exits cleanly", () => {
    const off = tempDir(false);
    expect(readConfig(off).screenMap).toBeUndefined();
    expect(screenMapTools(false)).toEqual([]);
    expect(screenMapUsageLines(false).join("\n")).toContain("Screen Map is off");
    expect(listToolDefinitions(false).some((tool) => tool.name.startsWith("map_"))).toBe(false);
    const called = callTool("map_outline", {}) as { warnings: Array<{ code: string; next: string }> };
    expect(called.warnings[0]?.code).toBe("W-MAP-OFF");
    expect(called.warnings[0]?.next).toContain("screenMap.enabled");
    const lines: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write;
    usage();
    process.stdout.write = write;
    expect(lines.join("")).toContain("Screen Map is off");
    runMapCli(["build"], { cwd: off, enabled: false, loadGraph: () => graph(), stdout: () => undefined });
    expect(existsSync(join(off, ".resolve", "private", "screen-map"))).toBe(false);
  });

  it("builds when enabled, lists map tools, and does not touch DSCK or DSCI stores", () => {
    const dir = tempDir(true);
    expect(readConfig(dir).screenMap).toEqual({ enabled: true, lookalikes: false });
    expect(screenMapTools(true).map((tool) => tool.name)).toEqual(["map_build", "map_outline", "map_screen", "map_node", "map_journey", "map_drift", "map_expand"]);
    const out: string[] = [];
    const io = { cwd: dir, enabled: true, loadGraph: () => graph(), stdout: (text: string) => out.push(text) };
    runMapCli(["build", "--json", "--built-at", FROZEN], io);
    const first = JSON.parse(out[0]!) as { next: string; path: string; warnings: unknown[] };
    expect(first.next.length).toBeGreaterThan(0);
    expect(first.path).toContain(join(".resolve", "private", "screen-map"));
    out.length = 0;
    runMapCli(["build", "--json", "--built-at", FROZEN], io);
    expect(JSON.parse(out[0]!).warnings[0].code).toBe("W-MAP-REBUILT");
    expect(existsSync(join(dir, "dsck", "standins.json"))).toBe(false);
    const learned = runMapCall("map_outline", {}, io);
    expect(learned["view"]).toBe("outline");
  });

  it("does not import a meaning store and public text stays on Acme and DSCK", () => {
    const source = readdirSync("src/core/screenMap").filter((file) => file.endsWith(".ts")).map((file) => readFileSync(join("src/core/screenMap", file), "utf8")).join("\n");
    expect(source).not.toMatch(/learn-from-screens|learnFromScreens|standins/);
    expect(readFileSync("src/core/query/recommendMasters.ts", "utf8")).not.toMatch(/screenMap/);
    const publicText = ["README.md", "docs/screen-map.md", "commands/map.md", "commands/map-build.md"].map((file) => readFileSync(file, "utf8")).join("\n");
    expect(publicText).toContain("Acme");
    expect(publicText).toContain("DSCK");
    expect(screenMapUsageLines(true).join("\n")).toContain("Acme");
  });
});
