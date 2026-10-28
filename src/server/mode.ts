import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { acceptedPinnedHome, STORE_DIRS } from "../core/query/overlayFile.ts";

/** Which workflow is active. Self-contained so the code engine runs without a bundler. */
export type Mode = "figma" | "code" | "both";
export type Pack = "figma" | "code";

export interface ResolveConfig {
  mode: Mode;
  modeSource: "env" | "config" | "inferred" | "default";
  libraryFileKey?: string;
  repoPath?: string;
  theme?: string;
  cssEntry?: string;
  localPrefixes: string[];
  configPath?: string;
  /** Folder that holds config.json and code-catalog.json. */
  storeDir: string;
  problem?: string;
}

type Env = Record<string, string | undefined>;

const MODES: readonly Mode[] = ["figma", "code", "both"];

function usable(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && !text.includes("${") ? text : undefined;
}

export function isMode(value: unknown): value is Mode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

export function includesPack(mode: Mode, pack: Pack): boolean {
  return mode === "both" || mode === pack;
}

function findConfig(cwd: string, env: Env): string | undefined {
  const pinned = acceptedPinnedHome(env, usable);
  if (pinned) {
    const file = join(resolve(pinned), "config.json");
    return existsSync(file) ? file : undefined;
  }
  const seen = new Set<string>();
  for (const start of [cwd, usable(env["INIT_CWD"])]) {
    if (!start) continue;
    let dir = resolve(start);
    while (!seen.has(dir)) {
      seen.add(dir);
      for (const folder of STORE_DIRS) {
        const file = join(dir, folder, "config.json");
        if (existsSync(file)) return file;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

function nearestStore(cwd: string, env: Env): string {
  const pinned = acceptedPinnedHome(env, usable);
  if (pinned) return resolve(pinned);
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, ".resolve");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return join(resolve(cwd), ".resolve");
    dir = parent;
  }
}

function list(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return items.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
}

/**
 * One tool-neutral config: `.resolve/config.json` (or RESOLVE_HOME/config.json).
 * Env wins: RESOLVE_MODE, RESOLVE_LIBRARY_FILE_KEY, RESOLVE_REPO_PATH,
 * RESOLVE_THEME, RESOLVE_CSS_ENTRY, RESOLVE_LOCAL_PREFIXES.
 */
export function readConfig(cwd: string = process.cwd(), env: Env = process.env): ResolveConfig {
  let file: Record<string, unknown> = {};
  let problem: string | undefined;
  const configPath = findConfig(cwd, env);
  if (configPath) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) file = parsed as Record<string, unknown>;
      else problem = `${configPath} must be a JSON object.`;
    } catch {
      problem = `${configPath} is not valid JSON.`;
    }
  }
  const projectDir = configPath ? dirname(dirname(configPath)) : cwd;

  const envMode = usable(env["RESOLVE_MODE"])?.toLowerCase();
  const fileMode = typeof file["mode"] === "string" ? file["mode"].trim().toLowerCase() : undefined;
  if (envMode && !isMode(envMode)) problem = `RESOLVE_MODE must be figma, code, or both (got "${envMode}").`;
  if (fileMode && !isMode(fileMode)) problem = `config mode must be figma, code, or both (got "${fileMode}").`;

  const envRepo = usable(env["RESOLVE_REPO_PATH"]);
  const fileRepo = usable(file["repoPath"]);
  const repoRaw = envRepo ?? fileRepo;
  const repoPath = repoRaw ? (isAbsolute(repoRaw) ? repoRaw : resolve(envRepo ? cwd : projectDir, repoRaw)) : undefined;

  let mode: Mode;
  let modeSource: ResolveConfig["modeSource"];
  if (envMode && isMode(envMode)) [mode, modeSource] = [envMode, "env"];
  else if (fileMode && isMode(fileMode)) [mode, modeSource] = [fileMode, "config"];
  else if (repoPath) [mode, modeSource] = ["both", "inferred"];
  else [mode, modeSource] = ["figma", "default"];

  const prefixes = usable(env["RESOLVE_LOCAL_PREFIXES"]) ? list(env["RESOLVE_LOCAL_PREFIXES"]) : list(file["localPrefixes"]);
  const libraryFileKey = usable(env["RESOLVE_LIBRARY_FILE_KEY"]) ?? usable(file["libraryFileKey"]) ?? usable(file["figmaFileKey"]);
  const theme = usable(env["RESOLVE_THEME"]) ?? usable(file["theme"]);
  const cssEntry = usable(env["RESOLVE_CSS_ENTRY"]) ?? usable(file["cssEntry"]);
  return {
    mode,
    modeSource,
    ...(libraryFileKey ? { libraryFileKey } : {}),
    ...(repoPath ? { repoPath } : {}),
    ...(theme ? { theme } : {}),
    ...(cssEntry ? { cssEntry } : {}),
    localPrefixes: prefixes,
    ...(configPath ? { configPath } : {}),
    storeDir: configPath ? dirname(configPath) : nearestStore(cwd, env),
    ...(problem ? { problem } : {}),
  };
}

export function activeMode(env: Env = process.env, cwd: string = process.cwd()): Mode {
  return readConfig(cwd, env).mode;
}
