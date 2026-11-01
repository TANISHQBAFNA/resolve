import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatReport, readFrozenCases, scoreFrozen, writePacks } from "./meaning.frozen-score";

/** The frozen fixture is committed unchanged. */
const FROZEN_SHA256 = "a1b2a7f42ffc43eedf28771545f6ae82e53e7b7ee80be38bbb3d6b354360a79a";

describe("meaning DSCK frozen set", () => {
  it("prints the frozen score and leaves the fixture unchanged", () => {
    const raw = readFileSync("scoreboard/meaning/frozen.json");
    expect(createHash("sha256").update(raw).digest("hex")).toBe(FROZEN_SHA256);
    const report = scoreFrozen(readFrozenCases());
    const text = formatReport(report);
    process.stdout.write(`${text}\n${report.misses.join("\n")}\n`);
    expect(report.top1.of).toBe(111);
    expect(report.noFit.of).toBe(17);
    process.stdout.write(`frozen top-1 ${report.top1.hit}/111\n`);
  });

  it("writes packs under the file caps, hop limit, and token budget", () => {
    const dir = mkdtempSync(join(tmpdir(), "meaning-dsck-"));
    try {
      const written = writePacks(dir);
      expect(written.tokens).toBeLessThanOrEqual(6000);
      expect(written.stale).toMatch(/older than the library/);
      const check = spawnSync(process.execPath, ["scripts/check-meaning-dsck.mjs", dir], { encoding: "utf8" });
      expect(check.status, check.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
