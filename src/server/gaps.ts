import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { storeRoot } from "./store";

/**
 * Finder gaps: what designers asked recommend for that found nothing, or only a
 * weak match. One JSON line per ask, local to this store. <store>/scoreboard/ is
 * run history, which resolve-setup's ignore block already keeps out of git.
 */

export type GapResult = "empty" | "weak";

export interface GapRow {
  phrase: string;
  result: GapResult;
  count: number;
  last: string;
}

export function gapsPath(): string {
  return join(storeRoot(), "scoreboard", "gaps.jsonl");
}

/** Log a recommend answer when it is empty or weak. Never throws: a log line must not break recommend. */
export function recordGap(phrase: string, card: unknown, at = new Date().toISOString()): void {
  const record = card as { candidates?: unknown; match?: unknown } | undefined;
  if (!Array.isArray(record?.candidates)) return;
  const result: GapResult | undefined =
    record.candidates.length === 0 ? "empty" : record.match === "weak match" ? "weak" : undefined;
  if (!result || !phrase.trim()) return;
  try {
    const path = gapsPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ at, phrase: phrase.trim(), result })}\n`);
  } catch {
    // Read-only store or full disk: recommend still answers.
  }
}

/** Same ask (letter case and spacing ignored) and same result is one row. Most asked first. */
export function readGaps(path = gapsPath()): GapRow[] {
  if (!existsSync(path)) return [];
  const rows = new Map<string, GapRow>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    let entry: { at?: unknown; phrase?: unknown; result?: unknown };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    const { at, phrase, result } = entry;
    if (typeof at !== "string" || typeof phrase !== "string" || (result !== "empty" && result !== "weak")) continue;
    const key = `${result}\u0000${phrase.toLowerCase().replace(/\s+/g, " ").trim()}`;
    const row = rows.get(key) ?? { phrase, result, count: 0, last: at };
    row.count += 1;
    if (at > row.last) row.last = at;
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.count - a.count || b.last.localeCompare(a.last));
}

/** Plain summary first, then one line per ask. */
export function formatGaps(rows: GapRow[], path = gapsPath()): string {
  if (!rows.length) return `No gaps yet. Each recommend that finds nothing, or only a weak match, is added to ${path}.`;
  const asks = rows.reduce((sum, row) => sum + row.count, 0);
  const lines = [
    `Designers asked for ${rows.length} thing(s) Resolve could not answer well (${asks} ask(s) in all). Most asked first.`,
    "Each one needs a team word (synonyms.json), a recipe, or a part the design system does not have yet.",
    "",
  ];
  for (const row of rows) {
    const what = row.result === "empty" ? "nothing found" : "weak match only";
    lines.push(`${row.count}x "${row.phrase}": ${what} (last ${row.last.slice(0, 10)})`);
  }
  return lines.join("\n");
}
