import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { deltaAgainst, type ScoreDelta, type ScoreReport } from "@/core/query/scoreboard";
import { pinnedHome } from "@/core/query/overlayFile";
import { resolveWorkspaceName } from "./store";

export interface ScoreTrendPoint {
  at: string;
  top1: number | null;
  top1Count: number;
  top1Base: number;
  top3: number | null;
  top3Count: number;
  top3Base: number;
  inventRate: number;
  wrongCousinRate: number | null;
  emptyWhenWeak: number | null;
  leakRate: number | null;
  pass: boolean;
  goldenHash?: string;
}

export interface ScoreWorkspaceChoice {
  name: string;
  at: string;
}

export interface ScoreboardPage {
  workspace: string;
  workspaces: ScoreWorkspaceChoice[];
  latest: ScoreReport | null;
  trend: ScoreTrendPoint[];
  delta: ScoreDelta | null;
  hint: string;
  error?: string;
  status?: 400;
}

function homeDir(env: NodeJS.ProcessEnv): string {
  return env["HOME"]?.trim() || env["USERPROFILE"]?.trim() || homedir();
}

/** Same rejection as the store: `.`, `..`, and separators never leave `~/.resolve/`. */
export function scoreboardWorkspaceName(env: NodeJS.ProcessEnv = process.env): string {
  return resolveWorkspaceName(env["RESOLVE_WORKSPACE"]);
}

export function scoreboardHistoryDir(workspace: string, env: NodeJS.ProcessEnv = process.env): string {
  const name = resolveWorkspaceName(workspace);
  const explicit = pinnedHome(env);
  if (explicit) return join(resolve(explicit), "scoreboard");
  return join(homeDir(env), ".resolve", name, "scoreboard");
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

export function previousScore(
  dir: string,
  match?: { goldenHash?: string; workspace?: string },
): ScoreReport | undefined {
  const rows = readScoreHistory(dir);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row) continue;
    if (match?.goldenHash && row.goldenHash !== match.goldenHash) continue;
    if (match?.workspace && row.workspace !== match.workspace) continue;
    if (match?.goldenHash && !row.goldenHash) continue;
    return row;
  }
  return undefined;
}

export function writeScoreHistory(dir: string, report: ScoreReport): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${report.at.replace(/:/g, "-")}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}

/** Every workspace under ~/.resolve that has a saved run, oldest first. */
export function listScoreWorkspaces(env: NodeJS.ProcessEnv = process.env): ScoreWorkspaceChoice[] {
  const root = join(homeDir(env), ".resolve");
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const rows: ScoreWorkspaceChoice[] = [];
  for (const name of names) {
    if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) continue;
    const latest = readScoreHistory(join(root, name, "scoreboard")).at(-1);
    if (!latest) continue;
    rows.push({ name, at: latest.at });
  }
  rows.sort((a, b) => a.at.localeCompare(b.at));
  return rows;
}

function sameSet(row: ScoreReport, latest: ScoreReport): boolean {
  return Boolean(row.goldenHash) && row.goldenHash === latest.goldenHash && row.workspace === latest.workspace;
}

/** Read-only latest run and trend. Never includes the graph. */
export function scoreboardView(env: NodeJS.ProcessEnv = process.env, selected?: string): ScoreboardPage {
  const picked = selected?.trim();
  if (picked) {
    try {
      resolveWorkspaceName(picked);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        workspace: picked,
        workspaces: [],
        latest: null,
        trend: [],
        delta: null,
        hint: message,
        error: message,
        status: 400,
      };
    }
  }
  const workspaces = listScoreWorkspaces(env);
  const workspace = picked
    ? resolveWorkspaceName(picked)
    : (workspaces.at(-1)?.name ?? resolveWorkspaceName(env["RESOLVE_WORKSPACE"]));
  const rows = readScoreHistory(scoreboardHistoryDir(workspace, env));
  const latest = rows.at(-1) ?? null;
  const comparable = latest ? rows.filter((row) => sameSet(row, latest)) : [];
  const previous = comparable.length > 1 ? comparable[comparable.length - 2] : undefined;
  const trend = comparable.slice(-8).map((row) => ({
    at: row.at,
    top1: row.top1,
    top1Count: row.top1Count ?? 0,
    top1Base: row.top1Base ?? 0,
    top3: row.top3,
    top3Count: row.top3Count ?? 0,
    top3Base: row.top3Base ?? 0,
    inventRate: row.inventRate,
    wrongCousinRate: row.wrongCousinRate,
    emptyWhenWeak: row.emptyWhenWeak,
    leakRate: row.leakRate,
    pass: row.pass,
    ...(row.goldenHash ? { goldenHash: row.goldenHash } : {}),
  }));
  return {
    workspace,
    workspaces,
    latest,
    trend,
    delta: latest ? deltaAgainst(latest, previous) : null,
    hint: latest
      ? `Read-only. Showing workspace "${workspace}". Invent rate must stay at 0.`
      : `No scoreboard run yet${picked ? ` for workspace "${workspace}"` : ""}. In a terminal: npm run resolve -- score`,
  };
}
