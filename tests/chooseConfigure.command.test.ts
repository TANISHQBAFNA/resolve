import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SourceDocumentSchema } from "@/core/ingestion/types";
import { buildGraph } from "@/core/transform";
import { indexGraph } from "@/core/query";
import { configureChoice } from "@/core/chooseConfigure/configure";
import { recommendMasters } from "@/core/query/recommendMasters";
import { runConfigureCli } from "@/server/configureCommand";
import { clearCache } from "@/server/store";
import { callTool } from "@/server/tools";

const root = fileURLToPath(new URL("..", import.meta.url));

function fixtureIndex() {
  const raw: unknown = JSON.parse(readFileSync(join(root, "scoreboard", "fixture", "library.json"), "utf8"));
  const source = SourceDocumentSchema.parse(raw);
  return indexGraph(buildGraph(source, { builtAt: "2026-01-01T00:00:00.000Z" }));
}

describe("configure from the learned graph", () => {
  const index = fixtureIndex();

  it("sets a real button and leaves unmatched properties unset", () => {
    const report = configureChoice(index, "primary button");
    expect(report.choice?.name).toBe("Button");
    expect(report.configuration).toContainEqual(
      expect.objectContaining({ property: "Style", set: "Primary", evidence: "request" }),
    );
    const plain = configureChoice(index, "button");
    expect(plain.choice?.name).toBe("Button");
    expect(plain.configuration).toContainEqual(expect.objectContaining({ property: "Style", evidence: "unset" }));
    expect(report.visibility).toBe("unknown");
    expect(report.warnings.some((row) => row.warning.includes("shows or hides"))).toBe(true);
    const text = JSON.stringify(report);
    expect(text).not.toMatch(/"angular"/);
    expect(text).not.toMatch(/handoff/i);
  });

  it("does not invent a component when nothing matches", () => {
    const report = configureChoice(index, "kelp forest gauge");
    expect(report.choice).toBeNull();
    expect(report.configuration).toEqual([]);
    expect(report.warnings[0]?.warning).toMatch(/No component/);
    expect(report.next.length).toBeGreaterThan(0);
  });

  it("keeps a weak match weak and an empty answer empty", () => {
    const card = recommendMasters(index, "calendar picker");
    const report = configureChoice(index, "calendar picker");
    if (!card.candidates[0]) {
      expect(report.choice).toBeNull();
      return;
    }
    if (card.match === "weak match") {
      expect(report.warnings.some((row) => row.warning.startsWith("Weak match"))).toBe(true);
    }
    expect(report.choice?.name).toBe(card.candidates[0].name);
  });

  it("answers a missing library with a warning, not a throw", () => {
    process.env["RESOLVE_HOME"] = mkdtempSync(join(tmpdir(), "resolve-configure-"));
    clearCache();
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
    try {
      runConfigureCli(["sign-in screen"]);
    } finally {
      process.stdout.write = write;
    }
    const report = JSON.parse(out.join("")) as { choice: unknown; warnings: Array<{ warning: string }> };
    expect(report.choice).toBeNull();
    expect(report.warnings[0]?.warning).toMatch(/learned/);
    const tool = callTool("configure", { intent: "sign-in screen" }) as { choice: unknown };
    expect(tool.choice).toBeNull();
    expect(callTool("configure", {})).toMatchObject({ choice: null });
  });

  it("does not route the command or the core module at an engineering export", () => {
    const command = readFileSync(join(root, "commands", "configure.md"), "utf8");
    const core = readFileSync(join(root, "src", "core", "chooseConfigure", "configure.ts"), "utf8");
    const server = readFileSync(join(root, "src", "server", "configureCommand.ts"), "utf8");
    for (const text of [command, core, server]) expect(text).not.toMatch(/handoff/i);
    expect(core).not.toMatch(/screenMap/);
  });
});
