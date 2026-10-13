#!/usr/bin/env node
/**
 * Git and npx installs need dist-server before the first command.
 * CI sets CI=true and runs `npm run build` once, so skip here.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.CI) process.exit(0);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vite = join(root, "node_modules", "vite", "bin", "vite.js");
const result = spawnSync(process.execPath, [vite, "build", "--config", "vite.server.config.ts"], {
  cwd: root,
  stdio: "inherit",
});
process.exit(result.status === null ? 1 : result.status);
