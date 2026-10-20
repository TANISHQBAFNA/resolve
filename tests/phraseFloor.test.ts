import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function report(top1: number, top3: number, matchCases: number) {
  return JSON.stringify({ totals: { top1, top3, matchCases } });
}

function floor(body: string, baseline = "scoreboard/phrase-baseline.json"): { status: number | null; stderr: string; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), "resolve-floor-"));
  const path = join(dir, "report.json");
  writeFileSync(path, body);
  const run = spawnSync(process.execPath, ["scripts/check-phrase-floor.mjs", baseline, path], { encoding: "utf8" });
  return { status: run.status, stderr: run.stderr, stdout: run.stdout };
}

describe("phrase scoreboard floor", () => {
  it("holds at the committed 83/88 and 85/88 floor", () => {
    const held = floor(report(83, 85, 88));
    expect(held.status).toBe(0);
    expect(held.stdout).toContain("83/88");
    expect(held.stdout).toContain("85/88");
  });

  it("fails when top-1 or top-3 drops below the floor", () => {
    const top1 = floor(report(82, 85, 88));
    expect(top1.status).toBe(1);
    expect(top1.stderr).toContain("top-1 82/88 is below 83/88");
    const top3 = floor(report(83, 84, 88));
    expect(top3.status).toBe(1);
    expect(top3.stderr).toContain("top-3 84/88 is below 85/88");
  });

  it("allows a higher score on the same set", () => {
    expect(floor(report(85, 87, 88)).status).toBe(0);
  });
});
