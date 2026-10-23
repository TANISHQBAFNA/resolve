import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("AI picks eval harness", () => {
  it("writes one prompt per ask and scores recorded runs without a network call", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-picks-eval-"));
    const cases = join(dir, "cases.json");
    const runs = join(dir, "runs.jsonl");
    writeFileSync(cases, JSON.stringify({
      cases: [
        { id: "m-1", pack: "material", ask: "a hint on hover", expect: { lead: "Tooltip", accept: "exact" }, alternates: [], tags: ["meaning-only"] },
        { id: "a-1", pack: "acme", ask: "a flux gauge", expect: { accept: "empty" }, tags: ["no-fit"] },
      ],
    }));
    const row = (id: string, pack: string, name: string, tier: string, shortlist: string[]) => JSON.stringify({
      caseId: id,
      pack,
      shortlist,
      request: { pick: tier === "no-fit" ? undefined : shortlist[0] },
      result: { tier, id: tier === "no-fit" ? undefined : shortlist[0], name: tier === "no-fit" ? undefined : name, reason: name, failed: [], thin: [] },
    });
    const lines = [1, 2, 3].flatMap(() => [
      row("m-1", "material", "Tooltip", "place", ["tooltip"]),
      row("a-1", "acme", "", "no-fit", []),
    ]);
    writeFileSync(runs, `${lines.join("\n")}\n`);
    const prepared = spawnSync(process.execPath, ["scripts/ai-picks-eval.mjs", "prepare", "--cases", cases, "--out", join(dir, "prompts")], { encoding: "utf8" });
    expect(prepared.status).toBe(0);
    expect(prepared.stdout).toContain("wrote 2 prompts");
    expect(readFileSync(join(dir, "prompts", "m-1.txt"), "utf8")).toContain("a hint on hover");
    const scored = spawnSync(process.execPath, ["scripts/ai-picks-eval.mjs", "score", "--cases", cases, "--runs", runs], { encoding: "utf8" });
    expect(scored.status).toBe(0);
    expect(scored.stdout).toContain("top-1");
    expect(scored.stdout).toContain("no-fit");
    expect(scored.stdout).not.toContain("http://");
    const prompted = spawnSync(process.execPath, ["scripts/ai-picks-eval.mjs", "prompts", "--cases", cases, "--out", join(dir, "blind")], { encoding: "utf8" });
    expect(prompted.status).toBe(0);
    const material = readFileSync(join(dir, "blind", "material.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, string>);
    const acme = readFileSync(join(dir, "blind", "acme.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, string>);
    expect(material).toEqual([{ id: "m-1", ask: "a hint on hover", library: "material" }]);
    expect(acme).toEqual([{ id: "a-1", ask: "a flux gauge", library: "acme" }]);
    expect(JSON.stringify(material[0])).not.toMatch(/expect|tier|lead|alternate/);
    rmSync(dir, { recursive: true, force: true });
  });
});
