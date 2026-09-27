#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const cli = join(root, "..", "dist-server", "cli.mjs");
if (!existsSync(cli)) {
  process.stderr.write("Resolve CLI is not built. In this repo: npm run build:server\n");
  process.exit(1);
}
await import(pathToFileURL(cli).href);
