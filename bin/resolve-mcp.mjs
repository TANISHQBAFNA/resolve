#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const mcp = join(root, "..", "dist-server", "mcp.mjs");
if (!existsSync(mcp)) {
  process.stderr.write(
    "Resolve MCP is not built. In this repo: npm run build:server\nThen: npx resolve-mcp\n",
  );
  process.exit(1);
}
await import(pathToFileURL(mcp).href);
