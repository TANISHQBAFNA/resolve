#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nodeVersionMessage, nodeVersionTooOld } from "./node-version.mjs";

if (nodeVersionTooOld(process.version)) {
  process.stderr.write(nodeVersionMessage(process.version));
  process.exit(1);
}

const root = dirname(fileURLToPath(import.meta.url));
const extra = process.argv.slice(2);
const invokedAs = process.argv[1] ?? "";
const wantsMcp =
  /(?:^|\/)resolve-mcp(?:\.mjs)?$/.test(invokedAs) || extra[0] === "resolve-mcp" || extra[0] === "--mcp";

if (wantsMcp) {
  if (extra[0] === "resolve-mcp" || extra[0] === "--mcp") {
    process.argv.splice(2, 1);
  }
  const mcp = join(root, "..", "dist-server", "mcp.mjs");
  if (!existsSync(mcp)) {
    process.stderr.write(
      "Resolve MCP is not built. In this repo: npm run build:server\nThen: npx -y -p github:TANISHQBAFNA/resolve resolve-mcp\n",
    );
    process.exit(1);
  }
  await import(pathToFileURL(mcp).href);
} else {
  const cli = join(root, "..", "dist-server", "cli.mjs");
  if (!existsSync(cli)) {
    process.stderr.write("Resolve CLI is not built. In this repo: npm run build:server\n");
    process.exit(1);
  }
  await import(pathToFileURL(cli).href);
}
