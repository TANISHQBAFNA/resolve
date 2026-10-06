import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { z } from "zod";
import type { GraphIndex } from "./GraphIndex";
import { recommendMasters } from "./agentSurface";
import type { BindRulesFile } from "./bindRules";
import type { SockState } from "./sock";
import type { WorkspaceManifest } from "./workspace";
import {
  inventsInCard,
  isCousinPick,
  recommendPicks,
  resolveMasterByName,
  sameFamily,
  vocabOf,
  type ScorePick,
} from "./scoreboard";

/**
 * Designer-phrase scoreboard. Each phrase is how a designer asks for a part.
 * It is sent to recommend only. Expected parts are names, looked up in the
 * current graph. No Figma calls. Ranking is read, never changed.
 */

export const PHRASE_TYPES = ["exact", "paraphrase", "cousin-trap", "retired", "no-match", "weak-match"] as const;

const PhraseSchema = z.object({
  id: z.string().min(1),
  phrase: z.string().min(1),
  /** Free label for the breakdown. The shipped set uses PHRASE_TYPES. */
  type: z.string().min(1),
  /** Part names (any one is right), "none" (no part fits), or "weak" (empty, or a pick from accept). */
  expect: z.union([z.array(z.string().min(1)).min(1), z.literal("none"), z.literal("weak")]),
  accept: z.array(z.string().min(1)).optional(),
  mustNot: z.array(z.string().min(1)).optional(),
});

const FileSchema = z.object({ version: z.literal(1), cases: z.array(PhraseSchema) });

export type PhraseCase = z.infer<typeof PhraseSchema>;

export interface PhraseMiss {
  id: string;
  phrase: string;
  type: string;
  kind: "top1" | "top3" | "invent" | "false-empty" | "not-empty" | "wrong-cousin" | "retired";
  detail: string;
}

export interface PhraseTypeRollup {
  type: string;
  phrases: number;
  /** Phrases that expect a part. */
  matchCases: number;
  top1: number;
  top3: number;
  /** Phrases where empty is the right answer, and how many came back empty. */
  emptyCases: number;
  correctEmpty: number;
  falseEmpty: number;
  wrongCousin: number;
  retiredRecommended: number;
  invented: number;
}

export interface PhraseReport {
  at: string;
  source: string[];
  phrases: number;
  skipped: { id: string; reason: string }[];
  totals: PhraseTypeRollup;
  byType: PhraseTypeRollup[];
  /** Invent rate and retired-recommended are the test gate. Both must be 0. */
  inventRate: number;
  pass: boolean;
  misses: PhraseMiss[];
}

export interface PhraseRunOptions {
  at?: string;
  source?: string[];
  workspace?: WorkspaceManifest;
  sock?: SockState;
  bindRules?: BindRulesFile;
}

function filesIn(path: string): string[] {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => join(path, name));
}

/** Load phrase files from folders or files, in order. A repeated id is an error. */
export function loadPhraseCases(paths: string[]): PhraseCase[] {
  const seen = new Map<string, string>();
  const out: PhraseCase[] = [];
  // The same folder given twice (for example the store inside the checkout) is read once.
  const files = [...new Set(paths.flatMap(filesIn).map((file) => resolvePath(file)))];
  for (const file of files) {
    let parsed: z.infer<typeof FileSchema>;
    try {
      parsed = FileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    } catch (error) {
      throw new Error(`Bad phrase file ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const row of parsed.cases) {
      const first = seen.get(row.id);
      if (first) throw new Error(`Phrase id "${row.id}" is in both ${first} and ${file}. Ids must be unique.`);
      seen.set(row.id, file);
      out.push(row);
    }
  }
  if (!out.length) throw new Error(`No phrases found in ${paths.join(", ")}. Add a .json file with { "version": 1, "cases": [...] }.`);
  return out;
}

function emptyRollup(type: string): PhraseTypeRollup {
  return {
    type,
    phrases: 0,
    matchCases: 0,
    top1: 0,
    top3: 0,
    emptyCases: 0,
    correctEmpty: 0,
    falseEmpty: 0,
    wrongCousin: 0,
    retiredRecommended: 0,
    invented: 0,
  };
}

function add(into: PhraseTypeRollup, row: PhraseTypeRollup): void {
  for (const key of Object.keys(row) as (keyof PhraseTypeRollup)[]) {
    if (key !== "type") into[key] = (into[key] as number) + (row[key] as number);
  }
}

export function scorePhrases(index: GraphIndex, cases: PhraseCase[], options: PhraseRunOptions = {}): PhraseReport {
  const vocab = vocabOf(index);
  const byType = new Map<string, PhraseTypeRollup>();
  const misses: PhraseMiss[] = [];
  const skipped: PhraseReport["skipped"] = [];

  for (const row of cases) {
    const lookup = (names: string[]) => names.map((name) => resolveMasterByName(index, name));
    let expected: ReturnType<typeof lookup>;
    let accepted: ReturnType<typeof lookup>;
    let banned: ReturnType<typeof lookup>;
    try {
      expected = row.expect === "none" || row.expect === "weak" ? [] : lookup(row.expect);
      accepted = lookup(row.accept ?? []);
      banned = lookup(row.mustNot ?? []);
    } catch (error) {
      skipped.push({ id: row.id, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const okIds = new Set([...expected, ...accepted].map((node) => node.id));
    // Same rule as the golden scorer: a part, or its component set / sibling variant, is a hit.
    // "weak" phrases stay strict: only an exact accepted pick counts.
    const okNodes = [...expected, ...accepted];
    const isOk = (pick: ScorePick) => {
      if (!pick.id) return false;
      if (okIds.has(pick.id)) return true;
      const node = index.getNode(pick.id);
      return Boolean(node && okNodes.some((want) => sameFamily(want, node)));
    };
    const isExactOk = (pick: ScorePick) => (pick.id ? okIds.has(pick.id) : false);
    const bannedIds = new Set(banned.map((node) => node.id));

    const card = recommendMasters(index, row.phrase, {
      ...(options.workspace ? { workspace: options.workspace } : {}),
      ...(options.sock ? { sock: options.sock } : {}),
      ...(options.bindRules ? { bindRules: options.bindRules } : {}),
    });
    const picks = recommendPicks(card, vocab);
    const top = picks[0];
    const stat = byType.get(row.type) ?? emptyRollup(row.type);
    byType.set(row.type, stat);
    const miss = (kind: PhraseMiss["kind"], detail: string) =>
      misses.push({ id: row.id, phrase: row.phrase, type: row.type, kind, detail });

    stat.phrases += 1;

    const invents = inventsInCard(card, index);
    if (invents.length) {
      stat.invented += 1;
      miss("invent", invents.join("; "));
    }
    const retired = picks.filter((pick) => pick.deprecated || pick.private);
    if (retired.length) {
      stat.retiredRecommended += 1;
      miss("retired", retired.map((pick) => pick.name).join(", "));
    }

    if (row.expect === "none" || row.expect === "weak") {
      stat.emptyCases += 1;
      if (!picks.length) stat.correctEmpty += 1;
      else if (row.expect === "weak" && top && isExactOk(top)) stat.correctEmpty += 1;
      else miss("not-empty", `offered ${picks.map((pick) => pick.name).join(", ")}`);
      continue;
    }

    stat.matchCases += 1;
    if (!top) {
      stat.falseEmpty += 1;
      miss("false-empty", "nothing offered");
      continue;
    }
    const topOk = isOk(top);
    if (topOk) stat.top1 += 1;
    else {
      const cousin =
        (top.id !== undefined && bannedIds.has(top.id)) ||
        expected.some((node) => isCousinPick(node, top, index));
      if (cousin) {
        stat.wrongCousin += 1;
        miss("wrong-cousin", `top pick ${top.name}`);
      } else miss("top1", `top pick ${top.name}`);
    }
    if (picks.slice(0, 3).some(isOk)) stat.top3 += 1;
    else miss("top3", `offered ${picks.slice(0, 3).map((pick) => pick.name).join(", ")}`);
  }

  const rows = [...byType.values()].sort((a, b) => {
    const order = (type: string) => {
      const at = (PHRASE_TYPES as readonly string[]).indexOf(type);
      return at < 0 ? PHRASE_TYPES.length : at;
    };
    return order(a.type) - order(b.type) || a.type.localeCompare(b.type);
  });
  const totals = emptyRollup("all");
  for (const row of rows) add(totals, row);
  const inventRate = totals.phrases ? totals.invented / totals.phrases : 0;
  return {
    at: options.at ?? new Date().toISOString(),
    source: options.source ?? [],
    phrases: totals.phrases,
    skipped,
    totals,
    byType: rows,
    inventRate,
    // A run that scored nothing proves nothing, so it does not pass.
    pass: totals.phrases > 0 && totals.invented === 0 && totals.retiredRecommended === 0,
    misses,
  };
}

export function phraseExitCode(report: Pick<PhraseReport, "pass">): 0 | 1 {
  return report.pass ? 0 : 1;
}

function pct(hits: number, base: number): string {
  return base ? `${Math.round((hits / base) * 100)}%` : "n/a";
}

function cell(hits: number, base: number): string {
  return base ? `${hits}/${base}` : "n/a";
}

/** Plain-English summary first, details below. */
export function formatPhraseTable(report: PhraseReport): string {
  const t = report.totals;
  const lines: string[] = [];
  lines.push(
    `Resolve tried ${report.phrases} designer phrases against your library.`,
    `It put the right part first for ${cell(t.top1, t.matchCases)} (${pct(t.top1, t.matchCases)}) and in the top 3 for ${cell(t.top3, t.matchCases)} (${pct(t.top3, t.matchCases)}).`,
    `Where nothing fits, it correctly said "no match" ${cell(t.correctEmpty, t.emptyCases)} times.`,
    t.invented === 0 ? "It never made up a part." : `It made up a part for ${t.invented} phrase(s). That is a failure.`,
    t.retiredRecommended === 0
      ? "It never recommended a retired or private part."
      : `It recommended a retired or private part for ${t.retiredRecommended} phrase(s). That is a failure.`,
  );
  if (report.skipped.length) {
    lines.push(`${report.skipped.length} phrase(s) skipped: they name a part this library does not have.`);
  }
  if (report.phrases === 0) lines.push("No phrase could be scored on this library, so nothing was tested. That is a failure.");
  const weakest = [...report.byType]
    .filter((row) => row.matchCases + row.emptyCases > 0)
    .map((row) => ({
      type: row.type,
      score: (row.top1 + row.correctEmpty) / Math.max(1, row.matchCases + row.emptyCases),
    }))
    .sort((a, b) => a.score - b.score)[0];
  if (weakest && weakest.score < 1) lines.push(`Weakest phrase type: ${weakest.type} (${Math.round(weakest.score * 100)}% right).`);
  lines.push(`Result: ${report.pass ? "pass" : "FAIL"}`, "", "Details");
  const head = ["type", "phrases", "top-1", "top-3", "empty ok", "false-empty", "wrong-cousin", "retired", "invent"];
  const body = [...report.byType, report.totals].map((row) => [
    row.type,
    String(row.phrases),
    cell(row.top1, row.matchCases),
    cell(row.top3, row.matchCases),
    cell(row.correctEmpty, row.emptyCases),
    String(row.falseEmpty),
    String(row.wrongCousin),
    String(row.retiredRecommended),
    String(row.invented),
  ]);
  const widths = head.map((title, col) => Math.max(title.length, ...body.map((row) => (row[col] ?? "").length)));
  const fmt = (row: string[]) => row.map((value, col) => value.padEnd(widths[col] ?? 0)).join("  ").trimEnd();
  lines.push(fmt(head), ...body.map(fmt));
  if (report.misses.length) {
    lines.push("", "Misses");
    for (const miss of report.misses) lines.push(`${miss.id} [${miss.kind}] "${miss.phrase}": ${miss.detail}`);
  }
  for (const row of report.skipped) lines.push(`skipped ${row.id}: ${row.reason}`);
  return lines.join("\n");
}
