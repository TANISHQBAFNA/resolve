import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Project store folder names, new first. The second is the old name: still read, never created, moved or deleted. */
export const STORE_DIRS = [".resolve", ".graphify"] as const;

/** The pinned store folder: RESOLVE_HOME, else GRAPHIFY_HOME (the old name, still read). Empty means not pinned. */
export function pinnedHome(env: { RESOLVE_HOME?: string; GRAPHIFY_HOME?: string } = process.env): string | undefined {
  return env.RESOLVE_HOME?.trim() || env.GRAPHIFY_HOME?.trim() || undefined;
}

/**
 * Team overlay next to synonyms.json. RESOLVE_HOME, else nearest `.resolve/`,
 * else ~/.resolve/default.
 */
export function overlayFile(name: string): string | undefined {
  if (typeof process === "undefined" || !process.versions?.node) return undefined;
  const pinned = pinnedHome();
  if (pinned) return join(resolve(pinned), name);
  let dir = process.cwd();
  for (let hop = 0; hop < 6; hop += 1) {
    for (const folder of STORE_DIRS) {
      const candidate = join(dir, folder, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  const fallback = join(homedir(), ".resolve", "default", name);
  return existsSync(fallback) ? fallback : undefined;
}
