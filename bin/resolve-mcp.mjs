#!/usr/bin/env node
import { nodeVersionMessage, nodeVersionTooOld } from "./node-version.mjs";

if (nodeVersionTooOld(process.version)) {
  process.stderr.write(nodeVersionMessage(process.version));
  process.exit(1);
}

const { existsSync } = await import("node:fs");
const { dirname, join } = await import("node:path");
const { fileURLToPath, pathToFileURL } = await import("node:url");

const root = dirname(fileURLToPath(import.meta.url));
const mcp = join(root, "..", "dist-server", "mcp.mjs");
if (!existsSync(mcp)) {
  process.stderr.write(
    "Resolve MCP is not built. In this repo: npm run build:server\nThen: npx -y -p github:TANISHQBAFNA/resolve resolve-mcp\n",
  );
  process.exit(1);
}
await import(pathToFileURL(mcp).href);
