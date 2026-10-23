/**
 * Figma token and library file key come from the environment.
 * Plugin installs pass them in (Claude userConfig, Cursor variables). Nothing is hard-coded.
 */

const TOKEN_KEYS = ["FIGMA_ACCESS_TOKEN", "FIGMA_TOKEN"] as const;
const FILE_KEY_KEYS = ["RESOLVE_LIBRARY_FILE_KEY", "FIGMA_LIBRARY_FILE_KEY"] as const;

const HOW_TO_SET =
  "Set the missing one in the plugin settings. Do not paste it into a project file. " +
  "Claude Code: /plugin configure resolve@resolve. " +
  "Cursor: open Plugins, choose Resolve, then Configure. " +
  "Or set FIGMA_ACCESS_TOKEN and RESOLVE_LIBRARY_FILE_KEY in the environment. " +
  "The file key is the id in a link such as figma.com/design/ACMEUI/Acme. " +
  "The token is a Figma personal access token for that library.";

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

/** On only when the plugin env is exactly RESOLVE_AI_PICKS=1. Off by default. */
export function aiPicksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  void env;
  throw new Error("not implemented");
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

/** Empty when both settings are present. Otherwise a plain note for the first MCP reply. */
export function pluginSetupSuffix(env: NodeJS.ProcessEnv = process.env): string {
  const { token, libraryFileKey } = readPluginSettings(env);
  if (token && libraryFileKey) return "";
  const missing =
    !token && !libraryFileKey
      ? "Resolve does not have a Figma token or a library file key yet."
      : !token
        ? "Resolve does not have a Figma token yet."
        : "Resolve does not have a library file key yet.";
  return `\n\n${missing} ${HOW_TO_SET}`;
}
