import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Team overlay next to synonyms.json. GRAPHIFY_HOME, else nearest `.graphify/`,
 * else ~/.resolve/default.
 */
export function overlayFile(name: string): string | undefined {
  if (typeof process === "undefined" || !process.versions?.node) return undefined;
  const pinned = process.env["GRAPHIFY_HOME"]?.trim();
  if (pinned) return join(resolve(pinned), name);
  let dir = process.cwd();
  for (let hop = 0; hop < 6; hop += 1) {
    const candidate = join(dir, ".graphify", name);
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  const fallback = join(homedir(), ".resolve", "default", name);
  return existsSync(fallback) ? fallback : undefined;
}
