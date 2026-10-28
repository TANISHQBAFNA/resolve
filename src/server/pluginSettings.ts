import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Figma token and library file key come from the environment.
 * Plugin installs pass them in (Claude userConfig, Cursor variables). Nothing is hard-coded.
 * A project install (resolve-setup's .mcp.json or .cursor/mcp.json) passes neither. It does not need them.
 * Keep this file free of the store: `resolve pick` loads it on its fast path.
 */

const TOKEN_KEYS = ["FIGMA_ACCESS_TOKEN", "FIGMA_TOKEN"] as const;
const FILE_KEY_KEYS = ["RESOLVE_LIBRARY_FILE_KEY", "FIGMA_LIBRARY_FILE_KEY"] as const;
/** The server args resolve-setup writes into a project MCP file (MCP_ENTRY in bin/resolve-setup.mjs). */
const SETUP_ARGS = JSON.stringify(["-y", "-p", "github:TANISHQBAFNA/resolve#v0.1.3", "resolve-mcp"]);

const HOW_TO_SET =
  "Set the missing one in the plugin settings. Do not paste it into a project file. " +
  "Claude Code: /plugin configure resolve@resolve. " +
  "Cursor: open Plugins, choose Resolve, then Configure. " +
  "Or set FIGMA_ACCESS_TOKEN and RESOLVE_LIBRARY_FILE_KEY in the environment. " +
  "The file key is the id in a link such as figma.com/design/ACMEUI/Acme. " +
  "The token is a Figma personal access token for that library.";

const PROJECT_HINT =
  "Resolve has no Figma token. This project install does not need one: connect Figma in this app, then map the file with learn_library. " +
  "A token only adds exact component ids and REST learn. To add one, set FIGMA_ACCESS_TOKEN in the environment that starts this app. " +
  "Never put it in .mcp.json, .cursor/mcp.json or another project file.";

export type InstallKind = "plugin" | "project";

export interface SetupContext {
  /** The store this server reads already has a learned library or screens. */
  learned?: boolean;
  install?: InstallKind;
  /** Code-only installs have no use for a Figma token. */
  mode?: "figma" | "code" | "both";
}

function usable(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.includes("${")) return undefined;
  return trimmed;
}

function firstSet(env: NodeJS.ProcessEnv, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = usable(env[key]);
    if (value) return value;
  }
  return undefined;
}

export function aiPicksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["RESOLVE_AI_PICKS"] === "1";
}

export function readPluginSettings(env: NodeJS.ProcessEnv = process.env): {
  token: string | undefined;
  libraryFileKey: string | undefined;
} {
  return {
    token: firstSet(env, TOKEN_KEYS),
    libraryFileKey: firstSet(env, FILE_KEY_KEYS),
  };
}

/** True when the file starts resolve-setup's server without the plugin's settings. */
function setupServer(file: string): boolean {
  try {
    const doc = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as {
      mcpServers?: { resolve?: { command?: unknown; args?: unknown; env?: unknown } };
    };
    const server = doc.mcpServers?.resolve;
    if (server?.command !== "npx" || JSON.stringify(server.args) !== SETUP_ARGS) return false;
    const env = server.env && typeof server.env === "object" ? server.env : {};
    return ![...TOKEN_KEYS, ...FILE_KEY_KEYS].some((key) => key in env);
  } catch {
    return false;
  }
}

/** Project when this folder or a parent has resolve-setup's .mcp.json or .cursor/mcp.json. Else a plugin install. */
export function installKind(cwd: string = process.cwd()): InstallKind {
  let dir = cwd;
  for (let hop = 0; hop < 8; hop += 1) {
    if ([join(dir, ".mcp.json"), join(dir, ".cursor", "mcp.json")].some(setupServer)) return "project";
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "plugin";
}

/** Empty when a library is learned or the settings are present. Otherwise a plain note for the first MCP reply, fit to the install. */
export function pluginSetupSuffix(env: NodeJS.ProcessEnv = process.env, context: SetupContext = {}): string {
  const { token, libraryFileKey } = readPluginSettings(env);
  if (context.learned || context.mode === "code") return "";
  if (context.install === "project") return token ? "" : `\n\n${PROJECT_HINT}`;
  if (token && libraryFileKey) return "";
  const missing =
    !token && !libraryFileKey
      ? "Resolve does not have a Figma token or a library file key yet."
      : !token
        ? "Resolve does not have a Figma token yet."
        : "Resolve does not have a library file key yet.";
  return `\n\n${missing} ${HOW_TO_SET}`;
}
