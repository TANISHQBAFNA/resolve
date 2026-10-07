import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { storeRoot } from "./store";

/**
 * Finder gaps: what designers asked recommend for that found nothing, or only a
 * weak match, and screen asks ("inquiry screen") with no mapped screen of that job.
 * One JSON line per ask, local to this store. <store>/scoreboard/ is run history,
 * which resolve-setup's ignore block already keeps out of git.
 */

export type GapResult = "empty" | "weak" | "no-screen";

const RESULTS: readonly GapResult[] = ["empty", "weak", "no-screen"];

export interface GapRow {
  phrase: string;
  result: GapResult;
  count: number;
  last: string;
  /** Screen jobs with no mapped screen (result no-screen). */
  jobs?: string[];
}

export function gapsPath(): string {
  return join(storeRoot(), "scoreboard", "gaps.jsonl");
}

/** Screen jobs of a screen-ask card that have no mapped screen, when none of its jobs has one. */
function unmappedJobs(card: { approaches?: unknown }): string[] | undefined {
  if (!Array.isArray(card.approaches) || !card.approaches.length) return undefined;
  const rows = card.approaches as Array<{ job?: unknown; masters?: unknown }>;
  if (rows.some((row) => Array.isArray(row.masters) && row.masters.length > 0)) return undefined;
  return rows.flatMap((row) => (typeof row.job === "string" ? [row.job] : []));
}

/** Log a recommend answer when it is empty, weak, or a screen ask with no mapped screen. Never throws: a log line must not break recommend. */
export function recordGap(phrase: string, card: unknown, at = new Date().toISOString()): void {
  const record = card as { candidates?: unknown; match?: unknown; approaches?: unknown } | undefined;
  if (!record || !phrase.trim()) return;
  const jobs = unmappedJobs(record);
  const result: GapResult | undefined = jobs
    ? "no-screen"
    : !Array.isArray(record.candidates)
      ? undefined
      : record.candidates.length === 0
        ? "empty"
        : record.match === "weak match"
          ? "weak"
          : undefined;
  if (!result) return;
  try {
    const path = gapsPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ at, phrase: phrase.trim(), result, ...(jobs ? { jobs } : {}) })}\n`);
  } catch {
    // Read-only store or full disk: recommend still answers.
  }
}

/** Same ask (letter case and spacing ignored) and same result is one row. Most asked first. */
export function readGaps(path = gapsPath()): GapRow[] {
  if (!existsSync(path)) return [];
  const rows = new Map<string, GapRow>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    let entry: { at?: unknown; phrase?: unknown; result?: unknown; jobs?: unknown };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    const { at, phrase, result } = entry;
    if (typeof at !== "string" || typeof phrase !== "string" || !RESULTS.includes(result as GapResult)) continue;
    const jobs = Array.isArray(entry.jobs) ? entry.jobs.filter((job): job is string => typeof job === "string") : [];
    const key = `${result}\u0000${phrase.toLowerCase().replace(/\s+/g, " ").trim()}`;
    const row = rows.get(key) ?? { phrase, result: result as GapResult, count: 0, last: at, ...(jobs.length ? { jobs } : {}) };
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
  const lines = [`Designers asked for ${rows.length} thing(s) Resolve could not answer well (${asks} ask(s) in all). Most asked first.`];
  if (rows.some((row) => row.result !== "no-screen")) {
    lines.push("A part ask needs a team word (synonyms.json), a recipe, or a part the design system does not have yet.");
  }
  if (rows.some((row) => row.result === "no-screen")) {
    lines.push("A screen ask needs one real frame of that job checked with verify_frame. Nothing else to add.");
  }
  lines.push("");
  for (const row of rows) {
    const what =
      row.result === "no-screen"
        ? `no mapped ${row.jobs?.join(" or ") || "matching"} screen yet`
        : row.result === "empty"
          ? "nothing found"
          : "weak match only";
    lines.push(`${row.count}x "${row.phrase}": ${what} (last ${row.last.slice(0, 10)})`);
  }
  return lines.join("\n");
}
