import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import bundle from "../docs/examples/acme-proper-use.json";
import { adaptFigmaRestFile } from "@/core/ingestion";
import { adaptFigmaMcpMetadata } from "@/core/ingestion/adapters/figmaMcp";
import { mergeDesignGraphs } from "@/core/ingestion/learnLibrary";
import { buildGraph } from "@/core/transform";
import { indexGraph, verifyFrame } from "@/core/query";
import { publishedVerdict, verifyExitCode } from "@/core/query/properUse";
import { presentToolResult } from "@/server/cards";
import { runCli } from "@/server/cli";
import { clearCache, saveGraph } from "@/server/store";
import { callTool, encodeToolResult } from "@/server/tools";

const FROZEN = "2026-01-01T00:00:00.000Z";

const VERDICT_TYPES = ["verified", "proper-use", "warnings", "name-only", "nothing-checked", "component-fail"] as const;
type VerdictType = (typeof VERDICT_TYPES)[number];

function sample(type: VerdictType): { pass: boolean; result?: string; properUse?: { exitCode: 0 | 7; errors: number; warnings?: number } } {
  switch (type) {
    case "verified":
      return { pass: true, result: "verified", properUse: { exitCode: 0, errors: 0 } };
    case "proper-use":
      return { pass: true, result: "verified", properUse: { exitCode: 7, errors: 2 } };
    case "warnings":
      return { pass: true, result: "verified", properUse: { exitCode: 0, errors: 0, warnings: 2 } };
    case "name-only":
      return { pass: false, result: "name-only" };
    case "nothing-checked":
      return { pass: false, result: "nothing checked" };
    case "component-fail":
      return { pass: false };
    default: {
      const unexpected: never = type;
      throw new Error(`Unhandled verdict type ${String(unexpected)}`);
    }
  }
}

describe("JSON pass matches the verdict exit code", () => {
  it.each(VERDICT_TYPES)("%s", (type) => {
    const card = sample(type);
    const exitCode = verifyExitCode(card);
    const cli = publishedVerdict(card);
    const mcp = JSON.parse(presentToolResult(card, "json", "verify_frame")) as { pass?: boolean };
    expect(cli.pass, type).toBe(exitCode === 0);
    expect(mcp.pass, type).toBe(exitCode === 0);
    expect(card.pass, type).toBe(type === "component-fail" || type === "name-only" || type === "nothing-checked" ? false : true);
  });

  it("leads with FAIL when only proper use fails, and JSON result is not verified", () => {
    const text = presentToolResult(sample("proper-use"), "markdown", "verify_frame");
    expect(text.startsWith("FAIL: proper use (2 errors, 0 warnings) · components pass")).toBe(true);
    const json = JSON.parse(presentToolResult(sample("proper-use"), "json", "verify_frame")) as { pass?: boolean; result?: string };
    expect(json.pass).toBe(false);
    expect(json.result).toBe("proper_use_failed");
  });
});

const libraryXml = `<frame id="1:1" name="Kit"><component id="14:101" name="Button" /></frame>`;
const productXml = `<frame id="9:1" name="Named only"><instance id="9:2" name="Button" /></frame>
<frame id="9:9" name="Empty"><text id="9:10" name="Title" characters="Hello" /></frame>`;

describe("CLI check/verify JSON and MCP verify_frame", () => {
  const previousHome = process.env["RESOLVE_HOME"];
  let home = "";

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "resolve-verdict-"));
    process.env["RESOLVE_HOME"] = home;
    clearCache();
  });

  afterEach(() => {
    clearCache();
    if (previousHome === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previousHome;
  });

  async function capture(args: string[]): Promise<{ out: string; code: number | undefined }> {
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.exitCode = undefined;
    try {
      await runCli(args);
    } finally {
      process.stdout.write = write;
    }
    const code = process.exitCode;
    process.exitCode = undefined;
    return { out: chunks.join(""), code };
  }

  function saveProperUse() {
    saveGraph(
      buildGraph(
        adaptFigmaRestFile({
          fileKey: "ACMEUSE",
          file: bundle.file,
          variables: bundle.variables,
          kind: "figma-rest",
          ingestedAt: FROZEN,
        }),
        { builtAt: FROZEN },
      ),
    );
  }

  it("sets pass false for exit 7 and keeps pass true for a clean frame", async () => {
    saveProperUse();
    const cases = [
      { args: ["check", "Paid screen", "--json"], exit: 0 },
      { args: ["verify", "Paid screen"], exit: 0 },
      { args: ["check", "Misused", "--json"], exit: 7 },
      { args: ["verify", "Misused"], exit: 7 },
    ] as const;
    for (const row of cases) {
      // --strict keeps the old exit codes for CI.
      const run = await capture([...row.args, "--strict"]);
      const json = JSON.parse(run.out) as { pass?: boolean };
      expect(run.code ?? 0, row.args.join(" ")).toBe(row.exit);
      expect(json.pass, row.args.join(" ")).toBe(row.exit === 0);
      // Without it a finding never stops Resolve: exit 0, the same verdict, and a next step.
      const soft = await capture([...row.args]);
      const softJson = JSON.parse(soft.out) as { pass?: boolean; next?: string };
      expect(soft.code ?? 0, row.args.join(" ")).toBe(0);
      expect(softJson.pass, row.args.join(" ")).toBe(row.exit === 0);
      expect(Boolean(softJson.next), row.args.join(" ")).toBe(row.exit !== 0);
    }
    const text = await capture(["check", "Misused", "--strict"]);
    expect(text.code).toBe(7);
    expect(text.out.startsWith("FAIL: proper use")).toBe(true);
    const softText = await capture(["check", "Misused"]);
    expect(softText.code ?? 0).toBe(0);
    expect(softText.out).toContain("\nnext: set each flagged property to one of the allowed values listed");

    for (const frame of ["Paid screen", "Misused"]) {
      const raw = callTool("verify_frame", { frame }) as { pass?: boolean; properUse?: { exitCode?: number } };
      const json = JSON.parse(encodeToolResult(raw, "json", "verify_frame")) as { pass?: boolean; result?: string };
      const exitCode = verifyExitCode(raw);
      expect(json.pass, frame).toBe(exitCode === 0);
      const markdown = encodeToolResult(raw, "markdown", "verify_frame");
      if (frame === "Misused") {
        expect(markdown.startsWith("FAIL: proper use")).toBe(true);
        expect(json.result).toBe("proper_use_failed");
      } else expect(markdown.startsWith("PASS")).toBe(true);
    }
  });

  it("matches pass to the exit code for name-only, nothing checked, and a missing component", async () => {
    const library = buildGraph(adaptFigmaMcpMetadata({ fileKey: "LIB", fileName: "Library", metadataXml: libraryXml }));
    const product = buildGraph(adaptFigmaMcpMetadata({ fileKey: "APP", fileName: "App", metadataXml: productXml }));
    saveGraph(mergeDesignGraphs(library, product));
    const index = indexGraph(mergeDesignGraphs(library, product));
    const frames = [
      { frame: "Named only", result: "name-only" },
      { frame: "Empty", result: "nothing checked" },
    ] as const;
    for (const row of frames) {
      const live = verifyFrame(index, { frame: row.frame }) as { result?: string };
      expect(live.result, row.frame).toBe(row.result);
      const run = await capture(["verify", row.frame, "--strict"]);
      const json = JSON.parse(run.out) as { pass?: boolean; result?: string };
      expect((await capture(["verify", row.frame])).code ?? 0, row.frame).toBe(0);
      expect(json.result, row.frame).toBe(row.result);
      expect(json.pass, row.frame).toBe((run.code ?? 0) === 0);
      expect(run.code, row.frame).toBe(1);
      const mcpRaw = callTool("verify_frame", { frame: row.frame }) as { pass?: boolean };
      const mcp = JSON.parse(encodeToolResult(mcpRaw, "json", "verify_frame")) as { pass?: boolean };
      expect(mcp.pass, row.frame).toBe(verifyExitCode(mcpRaw) === 0);
    }
    const missing = await capture(["check", "--components", "Gold", "--json", "--strict"]);
    expect((await capture(["check", "--components", "Gold", "--json"])).code ?? 0).toBe(0);
    const missingJson = JSON.parse(missing.out) as { pass?: boolean; invents?: unknown[] };
    expect(missing.code).toBe(1);
    expect(missingJson.pass).toBe(false);
    expect(missingJson.invents?.length).toBeGreaterThan(0);
    const mcpMissing = callTool("verify_frame", { components: ["Gold"] }) as { pass?: boolean };
    const mcpJson = JSON.parse(encodeToolResult(mcpMissing, "json", "verify_frame")) as { pass?: boolean };
    expect(mcpJson.pass).toBe(verifyExitCode(mcpMissing) === 0);
    expect(mcpJson.pass).toBe(false);
  });
});
