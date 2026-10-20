import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { formatLearnedAt } from "@/server/localTime";

const ISO = "2026-01-01T00:00:00.000Z";
const ZONES = [
  { tz: "UTC", text: "2026-01-01 00:00 UTC" },
  { tz: "Asia/Kolkata", text: "2026-01-01 05:30 GMT+5:30" },
  { tz: "America/New_York", text: "2025-12-31 19:00 EST" },
  { tz: "Pacific/Auckland", text: "2026-01-01 13:00 GMT+13" },
] as const;

function learnedAtIn(tz: string): string {
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/print-learned-at.ts"], {
    env: { ...process.env, TZ: tz, LEARNED_AT: ISO },
    encoding: "utf8",
  });
  expect(run.status, run.stderr).toBe(0);
  return run.stdout;
}

describe("learned-at is local time with a zone label", () => {
  it("prints a zone label for a known instant in this process", () => {
    expect(formatLearnedAt(ISO)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \S+$/);
    expect(formatLearnedAt("not-a-time")).toBe("unknown");
    expect(formatLearnedAt(undefined)).toBe("unknown");
  });

  it.each(ZONES)("$tz", ({ tz, text }) => {
    expect(learnedAtIn(tz)).toBe(text);
  });
});
