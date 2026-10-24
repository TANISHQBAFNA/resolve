import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, symlinkSync } from "node:fs";
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
});
