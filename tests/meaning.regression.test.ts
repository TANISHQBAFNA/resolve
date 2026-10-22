import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("meaning regression gate", () => {
  it("keeps every ask main leads correctly, and keeps fallback leads weak", () => {
    const out = execFileSync("node", ["scripts/meaning-regression.mjs", "check"], { encoding: "utf8" });
    process.stdout.write(out);
    expect(out).toMatch(/regression gate compared \d+ asks/);
  }, 20_000);
});
