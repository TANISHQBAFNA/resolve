/**
 * Write meaning files from pack data.
 *   node scripts/build-meaning-sock.mjs <out-dir>
 */
import { createServer } from "vite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.argv[2];
if (!out) {
  process.stderr.write("Usage: node scripts/build-meaning-sock.mjs <out-dir>\n");
  process.exit(1);
}

const server = await createServer({
  configFile: join(repo, "vite.config.ts"),
  root: repo,
  server: { middlewareMode: true, hmr: false },
  appType: "custom",
  logLevel: "error",
});

try {
  const mod = await server.ssrLoadModule("/scripts/meaning-sock-build.ts");
  const written = mod.writePacks(out);
  process.stdout.write(`wrote ${out}\nmeaning pack ${written.tokens} tokens\n`);
  if (written.stale) process.stdout.write(`${written.stale}\n`);
} finally {
  await server.close();
}
