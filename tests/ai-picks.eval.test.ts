import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    const row = (id: string, pack: string, name: string, tier: string, shortlist: string[], run: number) => JSON.stringify({
      caseId: id,
      pack,
      run,
      shortlist,
      request: { pick: tier === "no-fit" ? undefined : shortlist[0] },
      result: { tier, id: tier === "no-fit" ? undefined : shortlist[0], name: tier === "no-fit" ? undefined : name, reason: name, failed: [], thin: [] },
    });
    const lines = [1, 2, 3].flatMap((run) => [
      row("m-1", "material", "Tooltip", "place", ["tooltip"], run),
      row("a-1", "acme", "", "no-fit", [], run),
    ]);
    writeFileSync(runs, `${lines.join("\n")}\n`);
    const prepared = spawnSync(process.execPath, ["scripts/ai-picks-eval.mjs", "prepare", "--cases", cases, "--out", join(dir, "prompts")], { encoding: "utf8" });
    expect(prepared.status).toBe(0);
    expect(prepared.stdout).toContain("wrote 2 prompts");
    expect(readFileSync(join(dir, "prompts", "m-1.txt"), "utf8")).toContain("a hint on hover");
    const mapPath = join(dir, "id-map.json");
    const noMap = spawnSync(process.execPath, ["scripts/ai-picks-eval.mjs", "score", "--cases", cases, "--runs", runs], { encoding: "utf8" });
    expect(noMap.status).toBe(1);
    expect(noMap.stderr).toContain("--id-map");
    writeFileSync(mapPath, "{}\n");
    const mixedRuns = join(dir, "mixed.jsonl");
    writeFileSync(mixedRuns, `${[
      row("m-1", "material", "Tooltip", "place", ["tooltip"], 1),
      row("a-1", "acme", "", "no-fit", [], 1),
      row("a-1", "acme", "", "no-fit", [], 2),
      row("a-1", "acme", "", "no-fit", [], 3),
    ].join("\n")}\n`);
    const mixed = spawnSync(process.execPath, ["scripts/ai-picks-eval.mjs", "score", "--cases", cases, "--runs", mixedRuns, "--id-map", mapPath], { encoding: "utf8" });
    expect(mixed.status).toBe(1);
    expect(mixed.stderr).toContain("Mixed 1-run and 3-run");
    expect(mixed.stdout).not.toContain("one run");
    const scored = spawnSync(process.execPath, ["scripts/ai-picks-eval.mjs", "score", "--cases", cases, "--runs", runs, "--id-map", mapPath], { encoding: "utf8" });
    expect(scored.status, scored.stderr).toBe(0);
    expect(scored.stdout).toContain("top-1");
    expect(scored.stdout).toContain("no-fit");
    expect(scored.stdout).toContain("name-only");
    expect(scored.stdout).toContain("library quote");
    expect(scored.stdout).not.toContain("http://");
    const prompted = spawnSync(process.execPath, ["scripts/ai-picks-eval.mjs", "prompts", "--cases", cases, "--out", join(dir, "blind"), "--id-map", mapPath], { encoding: "utf8" });
    expect(prompted.status, prompted.stderr).toBe(0);
    const material = JSON.parse(readFileSync(join(dir, "blind", "material.jsonl"), "utf8")) as { id: string; ask: string; library: string };
    const acme = JSON.parse(readFileSync(join(dir, "blind", "acme.jsonl"), "utf8")) as { id: string; ask: string; library: string };
    expect(Object.keys(material).sort()).toEqual(["ask", "id", "library"]);
    expect(material.id).not.toBe("m-1");
    expect(material.id).not.toMatch(/-n|-c|m-1/);
    expect(material.ask).toBe("a hint on hover");
    expect(material.library).toBe("material");
    expect(existsSync(join(dir, "blind", "id-map.json"))).toBe(false);
    const map = JSON.parse(readFileSync(mapPath, "utf8")) as Record<string, string>;
    expect(map[material.id]).toBe("m-1");
    expect(map[acme.id]).toBe("a-1");
    expect(JSON.stringify(material)).not.toMatch(/expect|tier|alternate/);
    const inside = spawnSync(process.execPath, ["scripts/ai-picks-eval.mjs", "prompts", "--cases", cases, "--out", join(dir, "blind-2"), "--id-map", join(process.cwd(), "scoreboard/ai-picks/id-map.json")], { encoding: "utf8" });
    expect(inside.status).toBe(1);
    expect(inside.stderr).toContain("inside the repo");
    const blocked = spawnSync(process.execPath, ["scripts/ai-picks-eval.mjs", "prompts", "--cases", cases], { encoding: "utf8" });
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain("Committed prompts");
    rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it("scores one run, rejects duplicate runs, and lists only main's losses", () => {
    const script = `
      import { caseRuns, eitherCorrect, formatScore, majority, scoreRecorded } from "./scripts/ai-picks-eval.mjs";
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
      if (caseRuns([{ run: "1", result: {} }]).error !== "run") throw new Error("string run");
      if (caseRuns([place(7, "tooltip", "Tooltip"), place(8, "tooltip", "Tooltip"), place(9, "tooltip", "Tooltip")]).error !== "run") throw new Error("run range");
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
      const noFitFlip = scoreRecorded([cases[0]], [place(1, "tooltip", "Tooltip", "place"), place(2, "tooltip", "Tooltip", "no-fit"), place(3, "tooltip", "Tooltip", "place")], names, indexIds);
      if (noFitFlip.groups.material.tierFlips !== 0 || noFitFlip.groups.material.gate !== 1) throw new Error("no-fit flip " + JSON.stringify(noFitFlip.groups.material));
      const nameOnlyRun = scoreRecorded([cases[0]], [{ caseId: "m-1", pack: "material", run: 1, request: { tier: "ask", pick: "tooltip", shortlist: ["tooltip"] }, result: { tier: "ask", id: "tooltip", name: "Tooltip", reason: "Tooltip", nameOnly: true, failed: [], thin: [] } }], names, indexIds);
      if (nameOnlyRun.nameOnly !== 1 || nameOnlyRun.libraryShown !== 0 || nameOnlyRun.thinDescribed[0] !== "tooltip") throw new Error("name-only metric");
      const blank = (top1) => ({ asks: 0, top1, top3: top1, avoid: 0, avoidHit: 0, noFit: 0, noFitHit: 0, confusableWrong: 0, unstable: 0, gate: 0, tierFlips: 0, split: 0 });
      const materialCases = Array.from({ length: 60 }, (_, index) => ({ id: "m-" + index, pack: "material", expect: { accept: "exact", lead: "Tooltip" } }));
      const acmeCases = [
        { id: "a-1", pack: "acme", expect: { accept: "exact", lead: "Switch" } },
        { id: "a-2", pack: "acme", expect: { accept: "empty" }, tags: ["no-fit"] },
      ];
      const reportOf = (materialTop1, acmeTop1) => ({
        groups: { material: blank(materialTop1), acme: { ...blank(acmeTop1), noFitHit: 1 }, total: blank(materialTop1 + acmeTop1) },
        invented: 0, unquoted: 0, thinPlaced: 0, oneRun: true, duplicates: 0, badRuns: 0, nameOnly: 0, libraryQuotes: 0, libraryShown: 0, thinDescribed: [],
      });
      const main = {
        material: { asks: 60, top1: 20, top3: 40, noFit: 0, noFitHit: 0 },
        acme: { asks: 2, top1: 2, top3: 2, noFit: 1, noFitHit: 1 },
      };
      const below = formatScore(reportOf(22, 1), [...materialCases, ...acmeCases], main);
      const acmeBelow = below.split("Acme ")[1].split("Total ")[0];
      if (!acmeBelow.includes("fail")) throw new Error("all-no-fit acme should fail\\n" + acmeBelow);
      const acmeGate = acmeBelow.split("\\n").find((line) => line.startsWith("gate "));
      if (!acmeGate || /pass|fail/.test(acmeGate)) throw new Error("acme gate mark " + acmeGate);
      const materialBelow = below.split("Material ")[1].split("Acme ")[0];
      if (!materialBelow.includes("top-1 22/60") || !materialBelow.includes("fail")) throw new Error(materialBelow);
      const materialGate = materialBelow.split("\\n").find((line) => line.startsWith("gate "));
      if (!materialGate || !materialGate.includes("pass")) throw new Error("material gate " + materialGate);
      const met = formatScore(reportOf(23, 2), [...materialCases, ...acmeCases], main);
      if (!met.split("Acme ")[0].includes("top-1 23/60") || !met.split("Material ")[1].split("Acme ")[0].includes("pass")) throw new Error(met);
      const missing = formatScore(reportOf(60, 2), [...materialCases, ...acmeCases]);
      if (!missing.includes("fail")) throw new Error("missing main should fail");
      const union = eitherCorrect(true, ["Tooltip"], [], "Tooltip", false);
      if (!union.top1) throw new Error("recommend path");
      const weak = eitherCorrect(true, ["Tooltip"], [], "Tooltip", true);
      if (weak.top1) throw new Error("weak lead");
      const frozen = eitherCorrect(true, ["Tooltip"], ["Tooltip"], "", false);
      if (!frozen.top1) throw new Error("frozen path");
      const none = eitherCorrect(false, [], ["Tooltip"], "Tooltip", true);
      if (none.noFit || none.top1) throw new Error("shown no-fit");
      const empty = eitherCorrect(false, [], [], "", false);
      if (!empty.noFit || !empty.top1) throw new Error("empty no-fit");
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });
});
