// Is dist-server already built from the current sources? prepare-server.mjs skips the rebuild when it is,
// so `npx -p <this folder>` (which runs prepare) does not wipe and rewrite dist-server under a running CLI.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const INPUTS = ["src", "vite.server.config.ts", "package.json", "tsconfig.json"];

function newest(path) {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let latest = 0;
  for (const item of readdirSync(path)) latest = Math.max(latest, newest(join(path, item)));
  return latest;
}

/** True when dist-server/cli.mjs and mcp.mjs exist and are newer than every build input. */
export function serverBuildFresh(root) {
  const outputs = ["cli.mjs", "mcp.mjs"].map((name) => join(root, "dist-server", name));
  if (!outputs.every((file) => existsSync(file))) return false;
  const built = Math.min(...outputs.map((file) => statSync(file).mtimeMs));
  return INPUTS.every((input) => newest(join(root, input)) <= built);
}
