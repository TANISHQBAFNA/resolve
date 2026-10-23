import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatReport, readFrozenCases, scoreFrozen, targetsMet, writePacks } from "./meaning.frozen-score";

/** The frozen fixture is committed unchanged. */
const FROZEN_SHA256 = "e9d913289548451a25196d66e463f5d29c18fc816724125a2871c50958de4263";

describe("meaning SOCK frozen set", () => {
  it("meets the ticket targets without changing the fixture", () => {
    const raw = readFileSync("scoreboard/meaning/frozen.json");
    expect(createHash("sha256").update(raw).digest("hex")).toBe(FROZEN_SHA256);
    const report = scoreFrozen(readFrozenCases());
    const text = formatReport(report);
    process.stdout.write(`${text}\n${report.misses.join("\n")}\n`);
    expect(targetsMet(report), text).toBe(true);
  });

  it("writes packs under the file caps, hop limit, and token budget", () => {
    const dir = mkdtempSync(join(tmpdir(), "meaning-sock-"));
    try {
      const written = writePacks(dir);
      expect(written.tokens).toBeLessThanOrEqual(6000);
      expect(written.stale).toMatch(/older than the library/);
      const check = spawnSync(process.execPath, ["scripts/check-meaning-sock.mjs", dir], { encoding: "utf8" });
      expect(check.status, check.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
