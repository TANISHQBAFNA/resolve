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
    const material = JSON.parse(readFileSync(join(dir, "blind", "material.jsonl"), "utf8")) as { id: string; ask: string; library: string };
    const acme = JSON.parse(readFileSync(join(dir, "blind", "acme.jsonl"), "utf8")) as { id: string; ask: string; library: string };
    expect(Object.keys(material).sort()).toEqual(["ask", "id", "library"]);
    expect(material.id).not.toBe("m-1");
    expect(material.id).not.toMatch(/-n|-c|m-1/);
    expect(material.ask).toBe("a hint on hover");
    expect(material.library).toBe("material");
    const map = JSON.parse(readFileSync(join(dir, "id-map.json"), "utf8")) as Record<string, string>;
    expect(map[material.id]).toBe("m-1");
    expect(map[acme.id]).toBe("a-1");
    expect(JSON.stringify(material)).not.toMatch(/expect|tier|alternate/);
    const blocked = spawnSync(process.execPath, ["scripts/ai-picks-eval.mjs", "prompts", "--cases", cases], { encoding: "utf8" });
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain("Committed prompts");
    rmSync(dir, { recursive: true, force: true });
  });

  it("scores one run, rejects duplicate runs, and lists only main's losses", () => {
    const script = `
      import { caseRuns, majority, scoreRecorded } from "./scripts/ai-picks-eval.mjs";
      const cases = [
        { id: "m-1", pack: "material", ask: "hint", expect: { lead: "Tooltip", accept: "exact" }, alternates: ["Badge"], tags: ["meaning-only"] },
        { id: "m-2", pack: "material", ask: "none", expect: { accept: "empty" }, tags: ["no-fit"] },
      ];
      const names = { material: { tooltip: "Tooltip", badge: "Badge" } };
      const indexIds = { material: new Set(["tooltip", "badge"]) };
      const place = (run, id, name, tier = "place") => ({ caseId: "m-1", pack: "material", run, request: { tier, pick: id, shortlist: [id] }, result: { tier, id, name, reason: "A long library sentence.", failed: [], thin: [] } });
      const one = scoreRecorded(cases, [place(1, "tooltip", "Tooltip")], names, indexIds);
      if (!one.oneRun || one.groups.material.top1 !== 1) throw new Error("one run");
      if (caseRuns([place(1, "tooltip", "Tooltip"), place(1, "badge", "Badge")]).error !== "duplicate") throw new Error("duplicate");
      const stable = scoreRecorded(cases, [place(1, "tooltip", "Tooltip", "place"), place(2, "tooltip", "Tooltip", "ask"), place(3, "tooltip", "Tooltip", "ask")], names, indexIds);
      if (stable.groups.material.gate !== 0 || stable.groups.material.tierFlips !== 1) throw new Error("tier");
      const swapped = scoreRecorded([cases[0]], [place(1, "tooltip", "Tooltip"), place(2, "badge", "Badge"), place(3, "tooltip", "Tooltip")], names, indexIds);
      if (swapped.groups.material.gate !== 0) throw new Error("gate");
      const strict = scoreRecorded([cases[0]], [{ caseId: "m-1", pack: "material", run: 1, request: { tier: "no-fit", shortlist: ["tooltip"] }, result: { tier: "no-fit", failed: [], thin: [] } }], names, indexIds);
      if (strict.groups.material.top3 !== 0) throw new Error("top3");
      const thin = scoreRecorded([cases[1]], [{ caseId: "m-2", pack: "material", run: 1, request: { tier: "place", pick: "badge", shortlist: ["badge"] }, result: { tier: "ask", id: "badge", name: "Badge", failed: ["thin-cap"], thin: [{ id: "badge", missing: ["description"] }] } }], names, indexIds);
      if (thin.thinPlaced !== 1) throw new Error("thin");
      const lost = scoreRecorded(cases, [place(1, "slider", "Slider"), { caseId: "m-2", pack: "material", run: 1, request: { tier: "no-fit", shortlist: ["tooltip"] }, result: { tier: "no-fit", failed: [], thin: [] } }], names, indexIds, { "m-1": true, "m-2": true });
      if (JSON.stringify(lost.lost.material) !== JSON.stringify(["m-1"])) throw new Error("lost " + JSON.stringify(lost.lost));
      const four = [place(1, "tooltip", "Tooltip"), place(2, "tooltip", "Tooltip"), place(3, "badge", "Badge"), place(4, "badge", "Badge")];
      if (majority(four).result.id !== "badge" || majority([...four].reverse()).result.id !== "badge") throw new Error("tie");
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });
});
