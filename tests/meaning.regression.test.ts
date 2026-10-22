import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scoreAsks } from "../scripts/score-meaning-asks.mts";

interface SavedAsk {
  id: string;
  library: "fixture" | "material" | "acme-small";
  phrase: string;
  mainLead: string;
  mainCorrect: boolean;
}

describe("meaning regression gate", () => {
  it("keeps every ask main leads correctly, and keeps fallback leads weak", () => {
    const saved = JSON.parse(readFileSync("scoreboard/meaning/main-snapshot.json", "utf8")) as { asks: SavedAsk[] };
    const allow = JSON.parse(readFileSync("scoreboard/meaning/regression-allow.json", "utf8")) as { entries: Array<{ id: string; reason: string }> };
    for (const entry of allow.entries) expect(entry.reason.trim().length, entry.id).toBeGreaterThan(0);
    const reasons = new Map(allow.entries.map((entry) => [entry.id, entry.reason]));
    const leads = new Map(scoreAsks(saved.asks.map((row) => ({ id: row.id, library: row.library, phrase: row.phrase }))).map((row) => [row.id, row]));
    const changed: string[] = [];
    const strongFallback: string[] = [];
    for (const row of saved.asks) {
      const got = leads.get(row.id) ?? { lead: "", weak: false, via: "" };
      if (got.via && got.lead && !got.weak) strongFallback.push(`${row.id} ${got.via} "${row.phrase}" → ${got.lead}`);
      if (!row.mainCorrect || got.lead === row.mainLead || reasons.has(row.id)) continue;
      changed.push(`${row.id} "${row.phrase}" main ${row.mainLead || "∅"} branch ${got.lead || "∅"}`);
    }
    const allowLines = [...reasons.entries()].map(([id, reason]) => `${id}: ${reason}`);
    process.stdout.write(`regression gate compared ${saved.asks.length} asks\nallowlist ${reasons.size}\n${allowLines.join("\n")}\n`);
    expect(changed, changed.join("\n")).toEqual([]);
    expect(strongFallback, strongFallback.join("\n")).toEqual([]);
  });
});
