import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function report(top1: number, top3: number, matchCases: number, extra: Record<string, number> = {}) {
  return JSON.stringify({ totals: { top1, top3, matchCases, invented: 0, retiredRecommended: 0, correctEmpty: 30, emptyCases: 30, ...extra } });
}

function floor(body: string, baseline = "scoreboard/phrase-baseline.json"): { status: number | null; stderr: string; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), "resolve-floor-"));
  const path = join(dir, "report.json");
  writeFileSync(path, body);
  const run = spawnSync(process.execPath, ["scripts/check-phrase-floor.mjs", baseline, path], { encoding: "utf8" });
  return { status: run.status, stderr: run.stderr, stdout: run.stdout };
}

describe("phrase scoreboard floor", () => {
  it("holds at the committed 85/88 and 87/88 floor", () => {
    const held = floor(report(85, 87, 88));
    expect(held.status).toBe(0);
    expect(held.stdout).toContain("85/88");
    expect(held.stdout).toContain("87/88");
  });

  it("fails when top-1, top-3, empty answers, or invented picks drop", () => {
    const top1 = floor(report(84, 87, 88));
    expect(top1.status).toBe(1);
    expect(top1.stderr).toContain("top-1 84/88 is below 85/88");
    const top3 = floor(report(85, 86, 88));
    expect(top3.status).toBe(1);
    expect(top3.stderr).toContain("top-3 86/88 is below 87/88");
    const invented = floor(report(85, 87, 88, { invented: 1 }));
    expect(invented.status).toBe(1);
    expect(invented.stderr).toContain("invented 1 is above 0");
    const empty = floor(report(85, 87, 88, { correctEmpty: 29 }));
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain("empty-correct 29 is below 30");
  });

  it("fails when the golden set shrinks or invents a part", () => {
    const dir = mkdtempSync(join(tmpdir(), "resolve-floor-"));
    const phrases = join(dir, "phrases.json");
    const golden = join(dir, "golden.json");
    writeFileSync(phrases, report(85, 87, 88));
    writeFileSync(golden, JSON.stringify({ cases: 74, inventCount: 0 }));
    const shrunk = spawnSync(process.execPath, ["scripts/check-phrase-floor.mjs", "scoreboard/phrase-baseline.json", phrases, golden], { encoding: "utf8" });
    expect(shrunk.status).toBe(1);
    expect(shrunk.stderr).toContain("golden cases 74 is below 75");
    writeFileSync(golden, JSON.stringify({ cases: 75, inventCount: 1 }));
    const invented = spawnSync(process.execPath, ["scripts/check-phrase-floor.mjs", "scoreboard/phrase-baseline.json", phrases, golden], { encoding: "utf8" });
    expect(invented.status).toBe(1);
    expect(invented.stderr).toContain("golden invented 1 is above 0");
  });

  it("allows a higher score on the same set", () => {
    expect(floor(report(86, 88, 88)).status).toBe(0);
  });
});
