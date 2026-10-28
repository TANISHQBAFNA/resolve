import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(process.cwd(), "eval", "runs", "2026-10-26");

describe("2026-10-26 accuracy run", () => {
  it("stays on disk and is marked invalid", () => {
    for (const file of ["meta.json", "runs.jsonl", "score.txt", "picks.json", "picks-run2.json", "run.log", "commands.txt"]) {
      expect(existsSync(join(dir, file)), file).toBe(true);
    }
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as { invalid?: boolean; invalidReason?: string; gitSha?: string };
    expect(meta.invalid).toBe(true);
    expect(meta.invalidReason).toMatch(/hard-coded by hand/);
    expect(meta.invalidReason).toMatch(/not produced by the tool/);
    expect(meta.invalidReason).toMatch(/not a real measurement/);
    expect(meta.invalidReason).not.toMatch(/\d/);
    expect(meta.gitSha).toBe("fd3cc82c03a1a97a3e0a6dc4f3cf12d51a642284");
    const score = readFileSync(join(dir, "score.txt"), "utf8");
    expect(score.startsWith("INVALID")).toBe(true);
    expect(score).toContain("hard-coded by hand");
    expect(score).toContain("not produced by the tool");
    expect(score).toContain("not a real measurement");
    expect(score).toContain("Do not cite its numbers");
    expect(score).toContain("Material 60");
  });
});
