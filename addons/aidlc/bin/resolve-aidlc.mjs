#!/usr/bin/env node
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const vite = await createServer({
  configFile: false,
  root: repo,
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true, hmr: false, ws: false },
  resolve: { alias: { "@": join(repo, "src") } },
});

let code = 0;
try {
  const loaded = await vite.ssrLoadModule("/addons/aidlc/src/cliEntry.ts");
  if (typeof loaded.main !== "function") throw new Error("Add-on entry is missing main().");
  loaded.main(process.argv.slice(2));
  code = process.exitCode ?? 0;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  code = 1;
} finally {
  await vite.close();
}
process.exit(code);
