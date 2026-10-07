import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatGaps, gapsPath, readGaps, recordGap } from "@/server/gaps";
import { callTool } from "@/server/tools";
import { clearCache, saveGraph } from "@/server/store";
import { indexGraph } from "@/core/query";
import { scorePhrases } from "@/core/query/phraseScore";
import { graph } from "./fixture";

describe("finder gaps", () => {
  const previousHome = process.env["RESOLVE_HOME"];

  beforeEach(() => {
    process.env["RESOLVE_HOME"] = mkdtempSync(join(tmpdir(), "resolve-gaps-"));
    clearCache();
  });

  afterEach(() => {
    clearCache();
    if (previousHome === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previousHome;
  });

  it("logs empty and weak recommend answers only", () => {
    recordGap("date range picker", { candidates: [] }, "2026-10-07T10:00:00.000Z");
    recordGap("fancy toggle", { candidates: [{ id: "1" }], match: "weak match" }, "2026-10-07T10:01:00.000Z");
    recordGap("primary button", { candidates: [{ id: "2" }] });
    recordGap("not a recommend card", { found: false });
    recordGap("   ", { candidates: [] });
    expect(readGaps()).toEqual([
      { phrase: "fancy toggle", result: "weak", count: 1, last: "2026-10-07T10:01:00.000Z" },
      { phrase: "date range picker", result: "empty", count: 1, last: "2026-10-07T10:00:00.000Z" },
    ]);
  });

  it("counts the same ask once per result, ignoring letter case and spacing, most asked first", () => {
    recordGap("Date  Range Picker", { candidates: [] }, "2026-10-01T00:00:00.000Z");
    recordGap("date range picker", { candidates: [] }, "2026-10-03T00:00:00.000Z");
    recordGap("stepper", { candidates: [] }, "2026-10-02T00:00:00.000Z");
    writeFileSync(gapsPath(), "not json\n{\"phrase\":1}\n", { flag: "a" });
    const rows = readGaps();
    expect(rows.map((row) => [row.phrase, row.count, row.last.slice(0, 10)])).toEqual([
      ["Date  Range Picker", 2, "2026-10-03"],
      ["stepper", 1, "2026-10-02"],
    ]);
    const text = formatGaps(rows);
    expect(text).toMatch(/^Designers asked for 2 thing\(s\) .* \(3 ask\(s\) in all\)/);
    expect(text).toContain('2x "Date  Range Picker": nothing found (last 2026-10-03)');
  });

  it("says so plainly when nothing is logged yet", () => {
    expect(readGaps()).toEqual([]);
    expect(formatGaps([])).toMatch(/^No gaps yet\./);
  });

  it("never breaks recommend when the store cannot be written", () => {
    const file = join(mkdtempSync(join(tmpdir(), "resolve-gaps-ro-")), "a-file");
    writeFileSync(file, "");
    process.env["RESOLVE_HOME"] = file;
    expect(() => recordGap("stepper", { candidates: [] })).not.toThrow();
  });

  it("the recommend tool logs what it could not answer; the phrase scoreboard does not", () => {
    saveGraph(graph);
    const card = callTool("recommend", { intent: "quantum flux capacitor" }) as {
      candidates: unknown[];
      match?: string;
    };
    const expected = card.candidates.length === 0 ? "empty" : card.match === "weak match" ? "weak" : undefined;
    expect(expected).toBeDefined();
    expect(readGaps().map((row) => [row.phrase, row.result])).toEqual([["quantum flux capacitor", expected]]);

    process.env["RESOLVE_HOME"] = mkdtempSync(join(tmpdir(), "resolve-gaps-score-"));
    scorePhrases(indexGraph(graph), [{ id: "x", phrase: "quantum flux capacitor", type: "no-match", expect: "none" }]);
    expect(existsSync(gapsPath())).toBe(false);
  });
});
