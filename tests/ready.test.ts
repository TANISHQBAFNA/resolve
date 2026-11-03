import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkReady } from "@/ready/check";
import { runReady } from "@/ready/run";
import type { ReadyItemId, ReadyResult } from "@/ready/types";
import { runCli } from "@/server/cli";
import { clearCache } from "@/server/store";
import { callTool, listToolDefinitions } from "@/server/tools";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "acme-ready");
const good = join(root, "good");
const problems = join(root, "problems");
const gitRef = join(root, "git-ref");
const missingVendor = join(root, "missing-vendor");

const codes = (result: ReadyResult, id: ReadyItemId) => result.items.find((item) => item.id === id)?.findings.map((finding) => finding.code) ?? [];

describe("resolve ready", () => {
  const previous = { home: process.env["RESOLVE_HOME"], mode: process.env["RESOLVE_MODE"] };
  let home = "";

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "resolve-ready-"));
    process.env["RESOLVE_HOME"] = home;
    delete process.env["RESOLVE_MODE"];
    clearCache();
    process.exitCode = undefined;
  });

  afterEach(() => {
    clearCache();
    process.exitCode = undefined;
    if (previous.home === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previous.home;
    if (previous.mode === undefined) delete process.env["RESOLVE_MODE"];
    else process.env["RESOLVE_MODE"] = previous.mode;
  });

  it("passes the Acme prototype and writes a next step on every item", () => {
    const result = checkReady(good);
    expect(result.ok).toBe(true);
    expect(result.strictExitCode).toBe(0);
    expect(result.written).toBe(false);
    for (const item of result.items) {
      expect(item.status, item.id).toBe("pass");
      expect(item.findings, item.id).toEqual([]);
    }
    expect(result.markdown).toContain("next: none");
    expect(result.markdown.match(/next: none/g)?.length).toBe(6);
    expect(result.items.find((item) => item.id === "vendor")?.summary).toContain("acme@v1.4.0");
    expect(result.items.find((item) => item.id === "vendor")?.summary).toContain("v1.4.0");
  });

  it("warns once for each problem and still exits 0 unless --strict", async () => {
    const result = checkReady(problems);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.strictExitCode).toBe(2);
    expect(codes(result, "components").sort()).toEqual(["made-up-id", "unconfirmed-id", "unknown-id"]);
    expect(codes(result, "vendor")).toEqual(["vendor-mismatch"]);
    expect(codes(result, "tokens").sort()).toEqual(["raw-colour", "raw-spacing"]);
    expect(codes(result, "variants")).toEqual(["unknown-variant"]);
    expect(codes(result, "screens")).toEqual(["missing-screen"]);
    expect(codes(result, "accessibility").sort()).toEqual(["missing-alt", "missing-label", "missing-landmark"]);
    for (const item of result.items) {
      expect(item.status).toBe("warning");
      for (const finding of item.findings) {
        expect(finding.next.length).toBeGreaterThan(0);
        expect(result.markdown).toContain(`next: ${finding.next}`);
      }
    }
    expect(result.items.find((item) => item.id === "components")?.findings.find((finding) => finding.code === "unknown-id")?.next).toContain("ds@1.4.0.core.button");
    const copy = join(home, "problems");
    cpSync(problems, copy, { recursive: true });
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runCli(["ready", copy]);
      expect(process.exitCode ?? 0).toBe(0);
      await runCli(["ready", copy, "--strict"]);
      expect(process.exitCode).toBe(2);
    } finally {
      process.stdout.write = write;
    }
    expect(readFileSync(join(copy, "5-readiness", "report.md"), "utf8")).toContain("warning:");
    expect(chunks.join("")).toContain("## components");
  });

  it("warns when the git pin ref does not match, and passes when pin.json records it", () => {
    const wrong = checkReady(gitRef);
    expect(wrong.ok).toBe(false);
    expect(codes(wrong, "vendor")).toEqual(["vendor-ref"]);
    expect(wrong.strictExitCode).toBe(3);
    for (const id of ["components", "tokens", "variants", "screens", "accessibility"] as const) expect(codes(wrong, id), id).toEqual([]);

    const copy = join(home, "git");
    cpSync(gitRef, copy, { recursive: true });
    writeFileSync(join(copy, "4-code/prototype/vendor/acme@v1.4.0/pin.json"), JSON.stringify({ source: "https://github.com/acme/ds", ref: "v1.4.0" }));
    const fixed = checkReady(copy);
    expect(codes(fixed, "vendor")).toEqual([]);
    expect(fixed.ok).toBe(true);
  });

  it("warns when the vendor folder is missing and when the project folder is missing", () => {
    const result = checkReady(missingVendor);
    expect(codes(result, "vendor")).toEqual(["vendor-missing"]);
    expect(result.strictExitCode).toBe(3);
    expect(codes(result, "components")).toEqual([]);
    expect(codes(result, "accessibility")).toEqual([]);
    const gone = checkReady(join(home, "nope"));
    expect(gone.strictExitCode).toBe(1);
    expect(gone.ok).toBe(false);
    expect(gone.markdown).toContain("next:");
  });

  it("a denied pair is not confirmed", () => {
    const copy = join(home, "denied");
    cpSync(good, copy, { recursive: true });
    const mapDir = join(copy, "4-code/prototype/vendor/acme@v1.4.0/.resolve");
    mkdirSync(mapDir, { recursive: true });
    writeFileSync(
      join(mapDir, "component-map.json"),
      JSON.stringify({
        entries: [{ figma: "Button", code: "acme-button", status: "denied", by: "ada", at: "2026-01-15T12:00:00.000Z" }],
      }),
    );
    const result = checkReady(copy);
    const ids = result.items.find((item) => item.id === "components")?.findings ?? [];
    expect(ids.map((finding) => finding.code)).toEqual(["unconfirmed-id", "unconfirmed-id"]);
    expect(ids.every((finding) => finding.message.includes("ds@1.4.0.core.button"))).toBe(true);
    expect(result.markdown).not.toContain("ds@1.4.0.core.field` is denied");
  });

  it("writes the report from the CLI and keeps --strict off the exit when omitted", async () => {
    const copy = join(home, "tree", "good");
    cpSync(root, join(home, "tree"), { recursive: true });
    const written = runReady(copy);
    expect(written.written).toBe(true);
    expect(written.exitCode).toBe(0);
    expect(readFileSync(join(copy, "5-readiness/report.md"), "utf8")).toContain("pass:");
    const out = join(home, "out.md");
    const elsewhere = runReady(copy, { out });
    expect(elsewhere.reportPath).toBe(out);
    expect(readFileSync(out, "utf8")).toContain("pass:");

    process.env["RESOLVE_MODE"] = "code";
    const tool = callTool("ready", { project: copy, strict: true }) as ReadyResult & { cost?: unknown };
    expect(tool.ok).toBe(true);
    expect(tool.exitCode).toBe(0);
    expect(tool.strictExitCode).toBe(0);
    expect(process.exitCode ?? 0).toBe(0);

    process.env["RESOLVE_MODE"] = "figma";
    expect(() => callTool("ready", { project: copy })).toThrow(/code workflow, which is off/);
    expect(listToolDefinitions(false, "figma").map((tool) => tool.name)).not.toContain("ready");
    expect(listToolDefinitions(false, "code").map((tool) => tool.name)).toContain("ready");
    expect(listToolDefinitions(false, "both").map((tool) => tool.name)).toContain("ready");
  });
});
