import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// Root cause of the ai-picks "Resolve is not installed" flake: `npx -p <repo>` (server.mcpSpawn) runs the
// prepare script, which rebuilt dist-server while other test files were spawning the CLI from it.
const fresh = async (): Promise<(root: string) => boolean> =>
  ((await import(pathToFileURL(join(process.cwd(), "scripts", "server-build-fresh.mjs")).href)) as { serverBuildFresh: (root: string) => boolean }).serverBuildFresh;

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "resolve-prepare-"));
  mkdirSync(join(root, "src", "server"), { recursive: true });
  mkdirSync(join(root, "dist-server"), { recursive: true });
  for (const file of ["src/server/cli.ts", "package.json", "vite.server.config.ts", "dist-server/cli.mjs", "dist-server/mcp.mjs"]) writeFileSync(join(root, file), "x");
  return root;
}

const at = (root: string, file: string, seconds: number) => utimesSync(join(root, file), seconds, seconds);

describe("prepare keeps a fresh server build", () => {
  it("skips the rebuild only when dist-server is newer than every input", async () => {
    const serverBuildFresh = await fresh();
    const root = project();
    for (const file of ["src/server/cli.ts", "package.json", "vite.server.config.ts"]) at(root, file, 1_000);
    at(root, "dist-server/cli.mjs", 2_000);
    at(root, "dist-server/mcp.mjs", 2_000);
    expect(serverBuildFresh(root)).toBe(true);
    at(root, "src/server/cli.ts", 3_000);
    expect(serverBuildFresh(root)).toBe(false);
  });

  it("rebuilds when an output is missing", async () => {
    const serverBuildFresh = await fresh();
    const root = mkdtempSync(join(tmpdir(), "resolve-prepare-empty-"));
    expect(serverBuildFresh(root)).toBe(false);
  });
});
