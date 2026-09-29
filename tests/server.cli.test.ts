import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir } from "node:process";
import { runCli } from "@/server/cli";
import { callTool } from "@/server/tools";
import { clearCache, loadGraph, workspacePath } from "@/server/store";

describe("resolve ingest --role", () => {
  const previousHome = process.env["GRAPHIFY_HOME"];

  beforeEach(() => {
    process.env["GRAPHIFY_HOME"] = mkdtempSync(join(tmpdir(), "resolve-cli-role-"));
    clearCache();
  });

  afterEach(() => {
    clearCache();
    if (previousHome === undefined) delete process.env["GRAPHIFY_HOME"];
    else process.env["GRAPHIFY_HOME"] = previousHome;
  });

  it("fails on junk before ingesting, with a clear error", async () => {
    await expect(runCli(["ingest", "--role", "junk"])).rejects.toThrow(
      /Unknown --role "junk"\. Valid roles: library, product, client\./,
    );
    await expect(runCli(["ingest", "anything.json", "--role", "mystery"])).rejects.toThrow(
      /Unknown --role "mystery"/,
    );
    await expect(runCli(["ingest", "--role"])).rejects.toThrow(/Unknown --role/);
  });

  it("help says --scope file is safer on low API tiers and mentions --force-role", async () => {
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runCli([]);
    } finally {
      process.stdout.write = write;
    }
    const help = chunks.join("");
    expect(help).toMatch(/--scope file/);
    expect(help).toMatch(/low API|low-tier|safer/i);
    expect(help).toMatch(/--force-role/);
    expect(help).toMatch(/--from-metadata|get_metadata/i);
  });

  it("ingests raw Figma get_metadata XML without a REST token", async () => {
    const xmlPath = join(process.env["GRAPHIFY_HOME"]!, "screen.xml");
    writeFileSync(
      xmlPath,
      `<frame id="1:1" name="Screen"><component id="9:9" name="Main Card" /></frame>\n`,
    );
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runCli([
        "ingest",
        xmlPath,
        "--from-metadata",
        "--file-key",
        "METAKEY",
        "--name",
        "Capture",
        "--role",
        "library",
      ]);
    } finally {
      process.stdout.write = write;
    }
    const loaded = loadGraph();
    expect(loaded).toBeDefined();
    expect(loaded?.graph.fileKey).toBe("METAKEY");
    expect(loaded?.graph.nodes.some((node) => node.name === "Main Card")).toBe(true);
  });

  it("rejects a missing design-context file and bad --texts JSON", async () => {
    await expect(runCli(["verify", "Screen", "--design-context", "/tmp/resolve-missing-design-context.txt"])).rejects.toThrow(
      /Design context file not found: \/tmp\/resolve-missing-design-context\.txt/,
    );
    await expect(runCli(["verify", "Screen", "--texts", "{not json"])).rejects.toThrow(
      /--texts must be JSON/,
    );
  });

  it("requires a file key for XML and says when JSON is not JSON", async () => {
    const xmlPath = join(process.env["GRAPHIFY_HOME"]!, "bare.xml");
    writeFileSync(xmlPath, `<frame id="1:1" name="Screen"></frame>\n`);
    await expect(runCli(["ingest", xmlPath])).rejects.toThrow(/--file-key/);
    const jsonPath = join(process.env["GRAPHIFY_HOME"]!, "bad.json");
    writeFileSync(jsonPath, `{not json`);
    await expect(runCli(["ingest", jsonPath])).rejects.toThrow(/not valid JSON/);
  });

  it("refuses rm without --yes, explains --help, and clears the workspace list", async () => {
    const xmlPath = join(process.env["GRAPHIFY_HOME"]!, "lib.xml");
    writeFileSync(xmlPath, `<frame id="1:1" name="Screen"><component id="9:9" name="Button" /></frame>\n`);
    await runCli(["ingest", xmlPath, "--file-key", "LIB", "--role", "library"]);
    expect(existsSync(workspacePath())).toBe(true);
    await expect(runCli(["rm"])).rejects.toThrow(/--yes/);
    expect(loadGraph()).toBeDefined();
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runCli(["rm", "--help"]);
    } finally {
      process.stdout.write = write;
    }
    expect(chunks.join("")).toMatch(/--yes/);
    expect(loadGraph()).toBeDefined();
    await runCli(["rm", "--yes"]);
    expect(loadGraph()).toBeUndefined();
    expect(existsSync(workspacePath())).toBe(false);
  });

  it("exits non-zero when verify fails", async () => {
    const xmlPath = join(process.env["GRAPHIFY_HOME"]!, "verify.xml");
    writeFileSync(xmlPath, `<frame id="1:1" name="Screen"><component id="9:9" name="Button" /></frame>\n`);
    await runCli(["ingest", xmlPath, "--file-key", "LIB"]);
    process.exitCode = undefined;
    await runCli(["verify", "--components", "Not A Real Widget"]);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  it("does not call a named component verified when no id was checked", async () => {
    const xmlPath = join(process.env["GRAPHIFY_HOME"]!, "named.xml");
    writeFileSync(xmlPath, `<frame id="1:1" name="Screen"><component id="9:9" name="Button" /></frame>\n`);
    await runCli(["ingest", xmlPath, "--file-key", "LIB"]);
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.exitCode = undefined;
    try {
      await runCli(["verify", "--components", "Button"]);
    } finally {
      process.stdout.write = write;
    }
    const text = chunks.join("");
    expect(process.exitCode).toBe(1);
    expect(text).toMatch(/"result":\s*"nothing checked"/);
    expect(text.toLowerCase()).not.toContain("verified");
    process.exitCode = undefined;
  });

  it("score --init writes masters, a synonym, and empty asks", async () => {
    const xmlPath = join(process.env["GRAPHIFY_HOME"]!, "init.xml");
    writeFileSync(xmlPath, `<frame id="1:1" name="Screen"><component id="9:9" name="Button" /></frame>\n`);
    await runCli(["ingest", xmlPath, "--file-key", "LIB"]);
    const out = join(process.env["GRAPHIFY_HOME"]!, "golden.json");
    await runCli(["score", "--init", "--out", out]);
    const file = JSON.parse(readFileSync(out, "utf8")) as { cases: Array<{ intent: string; expect: string; expected?: string }> };
    expect(file.cases.some((row) => row.intent === "Button" && row.expected === "Button")).toBe(true);
    expect(file.cases.filter((row) => row.expect === "empty")).toHaveLength(3);
  });

  it("score --init creates a missing default folder", async () => {
    const xmlPath = join(process.env["GRAPHIFY_HOME"]!, "init-default.xml");
    writeFileSync(xmlPath, `<frame id="1:1" name="Screen"><component id="9:9" name="Button" /></frame>\n`);
    await runCli(["ingest", xmlPath, "--file-key", "LIB"]);
    const cwd = mkdtempSync(join(tmpdir(), "resolve-score-init-"));
    const previous = process.cwd();
    chdir(cwd);
    try {
      await runCli(["score", "--init"]);
    } finally {
      chdir(previous);
    }
    const out = join(cwd, "scoreboard", "golden", "from-library.json");
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, "utf8")).toContain("Button");
  });

  it("score --init explains when a parent of --out is a file", async () => {
    const xmlPath = join(process.env["GRAPHIFY_HOME"]!, "init-blocked.xml");
    writeFileSync(xmlPath, `<frame id="1:1" name="Screen"><component id="9:9" name="Button" /></frame>\n`);
    await runCli(["ingest", xmlPath, "--file-key", "LIB"]);
    const cwd = mkdtempSync(join(tmpdir(), "resolve-score-blocked-"));
    const blocker = join(cwd, "blocked");
    writeFileSync(blocker, "not a folder");
    const previous = process.cwd();
    chdir(cwd);
    let message = "";
    try {
      await runCli(["score", "--init", "--out", join(blocker, "golden.json")]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      chdir(previous);
    }
    expect(message).toMatch(/Could not write/);
    expect(message).not.toMatch(/EEXIST/);
  });

  it("learn_library rejects a bad role as a tool error", () => {
    expect(() => callTool("learn_library", { fileKey: "LIB", role: "nope" })).toThrow(
      /Unknown --role "nope"/,
    );
  });
});
