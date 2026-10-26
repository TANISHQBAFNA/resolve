import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const temp = (name: string) => mkdtempSync(join(realpathSync(tmpdir()), `resolve-cli-bin-${name}-`));

describe("resolve-figma bin", () => {
  it("runs the CLI, directly and through an npm .bin symlink", () => {
    const home = temp("home");
    const run = (args: string[]) => spawnSync(process.execPath, args, { cwd: home, encoding: "utf8", env: { ...process.env, HOME: home, RESOLVE_HOME: home } });
    const direct = run([join(root, "dist-server", "cli.mjs"), "--help"]);
    expect(direct.status).toBe(0);
    expect(direct.stdout).toContain("status");
    const link = join(temp("bin"), "resolve-figma");
    symlinkSync(join(root, "bin", "resolve-cli.mjs"), link);
    for (const bin of [join(root, "bin", "resolve-cli.mjs"), link]) {
      const viaBin = run([bin, "--help"]);
      expect(viaBin.status, bin).toBe(0);
      expect(viaBin.stdout, bin).toBe(direct.stdout);
    }
  });

  it("runs dist-server/cli.mjs through a symlinked folder", () => {
    const home = temp("home");
    const via = temp("via");
    symlinkSync(join(root, "dist-server"), join(via, "dist-server"));
    const result = spawnSync(process.execPath, [join(via, "dist-server", "cli.mjs"), "--help"], {
      cwd: home,
      encoding: "utf8",
      env: { ...process.env, HOME: home, RESOLVE_HOME: home },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("resolve code-map");
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it("says rebuild needed when the built CLI has no runEntry", () => {
    const dir = temp("stale");
    mkdirSync(join(dir, "bin"), { recursive: true });
    mkdirSync(join(dir, "dist-server"), { recursive: true });
    copyFileSync(join(root, "bin", "resolve-cli.mjs"), join(dir, "bin", "resolve-cli.mjs"));
    copyFileSync(join(root, "bin", "node-version.mjs"), join(dir, "bin", "node-version.mjs"));
    writeFileSync(join(dir, "dist-server", "cli.mjs"), "export {}\n");
    const result = spawnSync(process.execPath, [join(dir, "bin", "resolve-cli.mjs"), "--help"], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr.toLowerCase()).toContain("rebuild needed");
    expect(result.stderr).not.toContain("is not a function");
  });
});
