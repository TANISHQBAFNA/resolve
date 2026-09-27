import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { deltaAgainst, type ScoreDelta, type ScoreReport } from "@/core/query/scoreboard";

export interface ScoreTrendPoint {
  at: string;
  top1: number;
  top3: number;
  inventRate: number;
  wrongCousinRate: number;
  emptyWhenWeak: number;
  leakRate: number;
  pass: boolean;
}

export interface ScoreboardPage {
  workspace: string;
  latest: ScoreReport | null;
  trend: ScoreTrendPoint[];
  delta: ScoreDelta | null;
  hint: string;
}

export function scoreboardWorkspaceName(env: NodeJS.ProcessEnv = process.env): string {
  const name = (env["RESOLVE_WORKSPACE"]?.trim() || "default").replace(/[^A-Za-z0-9._-]/g, "_");
  return name || "default";
}

export function scoreboardHistoryDir(workspace: string, env: NodeJS.ProcessEnv = process.env): string {
  const home = env["HOME"]?.trim() || env["USERPROFILE"]?.trim() || homedir();
  const name = workspace.replace(/[^A-Za-z0-9._-]/g, "_") || "default";
  return join(home, ".resolve", name, "scoreboard");
}

function isReport(value: unknown): value is ScoreReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<ScoreReport>;
  return row.version === 1 && typeof row.at === "string" && Array.isArray(row.tools);
}

export function readScoreHistory(dir: string): ScoreReport[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const rows: ScoreReport[] = [];
  for (const name of names.sort()) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (isReport(parsed)) rows.push(parsed);
    } catch {
      continue;
    }
  }
  return rows;
}

export function previousScore(dir: string): ScoreReport | undefined {
  const rows = readScoreHistory(dir);
  return rows.at(-1);
}

export function writeScoreHistory(dir: string, report: ScoreReport): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${report.at.replace(/:/g, "-")}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}

/** Read-only latest run and trend. Never includes the graph. */
export function scoreboardView(env: NodeJS.ProcessEnv = process.env): ScoreboardPage {
  const workspace = scoreboardWorkspaceName(env);
  const rows = readScoreHistory(scoreboardHistoryDir(workspace, env));
  const latest = rows.at(-1) ?? null;
  const previous = rows.length > 1 ? rows[rows.length - 2] : undefined;
  const trend = rows.slice(-8).map((row) => ({
    at: row.at,
    top1: row.top1,
    top3: row.top3,
    inventRate: row.inventRate,
    wrongCousinRate: row.wrongCousinRate,
    emptyWhenWeak: row.emptyWhenWeak,
    leakRate: row.leakRate,
    pass: row.pass,
  }));
  return {
    workspace,
    latest,
    trend,
    delta: latest ? deltaAgainst(latest, previous) : null,
    hint: latest
      ? `Read-only. Latest run for workspace "${workspace}" is saved under ~/.resolve/${workspace}/scoreboard. Invent rate must stay at 0.`
      : `No scoreboard run yet for workspace "${workspace}". In a terminal: npm run resolve -- score`,
  };
}
