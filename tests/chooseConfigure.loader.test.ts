import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "bin", "resolve-setup.mjs");

function tempDir(name: string): string {
  const dir = join(tmpdir(), `resolve-configure-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("choose-and-configure guidance loaders", () => {
  it("installs the Claude skill and guidelines, and the Cursor rule, from the canonical files", () => {
    const cwd = tempDir("install");
    const home = tempDir("home");
    const result = spawnSync(process.execPath, [bin, "--yes"], { cwd, encoding: "utf8", env: { ...process.env, HOME: home } });
    expect(result.status).toBe(0);
    const skill = readFileSync(join(cwd, ".claude/skills/resolve-configure/SKILL.md"), "utf8");
    const guide = readFileSync(join(cwd, ".claude/skills/resolve-configure/guidelines.md"), "utf8");
    const rule = readFileSync(join(cwd, ".cursor/rules/resolve-configure.mdc"), "utf8");
    expect(skill).toContain("Evidence contract");
    expect(skill).toContain("designer choosing and configuring");
    expect(skill).not.toMatch(/handoff/i);
    expect(guide).toContain("This file is the only copy of these principles");
    expect(guide).toContain("Stop when the designer has a choice");
    expect(guide).not.toMatch(/handoff/i);
    expect(skill).not.toContain("This file is the only copy of these principles");
    expect(rule).toContain("does not restate them");
    expect(rule).not.toContain("Prefer a component the learned library");
    const link = join(root, ".cursor/skills/resolve-configure");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(link, "guidelines.md"))).toBe(realpathSync(join(root, "skills/resolve-configure/guidelines.md")));
  });

  it("keeps a guidelines file the user wrote", () => {
    const cwd = tempDir("keep");
    const path = join(cwd, ".claude/skills/resolve-configure/guidelines.md");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "My own principles.\n");
    const result = spawnSync(process.execPath, [bin, "--yes"], { cwd, encoding: "utf8", env: { ...process.env, HOME: tempDir("home2") } });
    expect(result.status).toBe(0);
    expect(readFileSync(path, "utf8")).toBe("My own principles.\n");
    expect(result.stdout).toContain("skip");
  });

  it("Cursor plugin points at ./skills and Claude session start names resolve-configure", () => {
    const plugin = JSON.parse(readFileSync(join(root, ".cursor-plugin/plugin.json"), "utf8")) as { skills: string };
    expect(plugin.skills).toBe("./skills");
    expect(existsSync(join(root, "skills/resolve-configure/SKILL.md"))).toBe(true);
    expect(existsSync(join(root, "skills/resolve-configure/guidelines.md"))).toBe(true);
    const run = spawnSync(process.execPath, [join(root, "scripts/resolve-session-start.mjs")], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, RESOLVE_MODE: "figma", RESOLVE_REPO_PATH: "", CLAUDE_PLUGIN_ROOT: root },
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("resolve-configure");
  });
});
