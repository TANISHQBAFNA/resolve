import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnAddonCommand } from "@/server/addonHook";
import { usage } from "@/server/cliUsage";

describe("add-on registration", () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it("core help lists the export from the add-on hook", () => {
    const writes: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      usage();
    } finally {
      process.stdout.write = write;
    }
    expect(writes.join("")).toContain("resolve export aidlc <handoff folder>");
  });

  it("resolve export runs the add-on bin", () => {
    const empty = mkdtempSync(join(tmpdir(), "resolve-addon-bin-"));
    mkdirSync(empty, { recursive: true });
    const writes: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      spawnAddonCommand("export", ["aidlc", empty, "--json"]);
    } finally {
      process.stdout.write = write;
    }
    const error = JSON.parse(writes.join("")) as { ok: boolean; message: string };
    expect(error.ok).toBe(false);
    expect(error.message).toMatch(/No handoff.json/);
    expect(process.exitCode).toBe(1);
  }, 60_000);
});
