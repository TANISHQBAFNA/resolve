import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "scripts", "choose-configure-eval.mjs");

function run(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

describe("choose-configure formative eval", () => {
  it("does not invent a score when no model transcripts are supplied", () => {
    const result = run([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^not run:/);
    expect(result.stdout).not.toMatch(/"component"/);
  });

  it("totals only marks in supplied transcripts", () => {
    const dir = mkdtempSync(join(tmpdir(), "resolve-eval-"));
    const task = { id: "t1", componentOk: true, configOk: false, unsupported: 2, uncertaintyOk: true, corrections: 1, ms: 40 };
    const worse = { ...task, componentOk: false, unsupported: 4, ms: 80 };
    const base = join(dir, "baseline.json");
    const evidence = join(dir, "evidence.json");
    const guidance = join(dir, "guidance.json");
    writeFileSync(base, JSON.stringify({ tasks: [worse] }));
    writeFileSync(evidence, JSON.stringify({ tasks: [task] }));
    writeFileSync(guidance, JSON.stringify({ tasks: [{ ...task, unsupported: 0, ms: 50 }] }));
    const result = run([base, evidence, guidance]);
    expect(result.status).toBe(0);
    const scored = JSON.parse(result.stdout) as { criteria: string[]; rows: Array<{ condition: string; unsupported: number }> };
    expect(scored.criteria).toContain("Appropriate uncertainty");
    expect(scored.rows.map((row) => row.condition)).toEqual(["baseline", "evidence", "evidence+guidance"]);
    expect(scored.rows.map((row) => row.unsupported)).toEqual([4, 2, 0]);
  });
});
