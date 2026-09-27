import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "@/server/cli";
import { clearCache, loadGraph } from "@/server/store";

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
});
