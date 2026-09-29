import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "bin", "resolve-setup.mjs");
const BEGIN = "<!-- resolve-setup:begin -->";
const END = "<!-- resolve-setup:end -->";

function tempDir(name: string): string {
  return join(tmpdir(), `resolve-setup-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function setup(args: string[], cwd: string, home?: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...(home ? { HOME: home } : {}) },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("resolve-setup", () => {
  it("writes the three files, then a second run leaves user text outside the markers", () => {
    const cwd = tempDir("project");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "CLAUDE.md"), "# Notes\n\nKeep this line.\n");

    const first = setup([], cwd);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("create");
    expect(first.stdout).toContain("update");

    const rulePath = join(cwd, ".cursor/rules/resolve.mdc");
    const skillPath = join(cwd, ".claude/skills/resolve/SKILL.md");
    const claudePath = join(cwd, "CLAUDE.md");
    const rule = readFileSync(rulePath, "utf8");
    const skill = readFileSync(skillPath, "utf8");
    const claude = readFileSync(claudePath, "utf8");

    expect(rule.startsWith("---\n")).toBe(true);
    expect(rule.indexOf(BEGIN)).toBeGreaterThan(rule.indexOf("\n---\n"));
    expect(rule).toContain("alwaysApply: true");
    expect(skill).toContain("name: resolve");
    expect(claude).toContain("Keep this line.");
    expect(claude.split(BEGIN)).toHaveLength(2);
    expect(rule).not.toContain("FIGMA_ACCESS_TOKEN");
    expect(skill).not.toContain("FIGMA_ACCESS_TOKEN");
    expect(claude).not.toContain("FIGMA_ACCESS_TOKEN");

    const withNote = `${rule}USER RULE NOTE\n`;
    const start = withNote.indexOf(BEGIN);
    const end = withNote.indexOf(END);
    writeFileSync(rulePath, `${withNote.slice(0, start + BEGIN.length)}\nHACKED\n${withNote.slice(end)}`);
    writeFileSync(claudePath, `${claude}\nUSER CLAUDE NOTE\n`);

    const second = setup([], cwd);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain(`update ${rulePath}`);
    expect(second.stdout).toContain(`unchanged ${skillPath}`);
    expect(second.stdout).toContain(`unchanged ${claudePath}`);

    const ruleAgain = readFileSync(rulePath, "utf8");
    const claudeAgain = readFileSync(claudePath, "utf8");
    expect(ruleAgain).not.toContain("HACKED");
    expect(ruleAgain).toContain("USER RULE NOTE");
    expect(ruleAgain).toContain("call Resolve before");
    expect(claudeAgain).toContain("Keep this line.");
    expect(claudeAgain).toContain("USER CLAUDE NOTE");
    expect(claudeAgain.split(BEGIN)).toHaveLength(2);

    const third = setup([], cwd);
    expect(third.status).toBe(0);
    expect(third.stdout).not.toContain("create ");
    expect(third.stdout).not.toContain("update ");
    expect(third.stdout).toContain("unchanged");
  });

  it("does not overwrite a file that has no Resolve markers", () => {
    const cwd = tempDir("skip");
    mkdirSync(join(cwd, ".cursor/rules"), { recursive: true });
    const rulePath = join(cwd, ".cursor/rules/resolve.mdc");
    writeFileSync(rulePath, "my rule, leave it\n");
    const planned = setup([], cwd);
    expect(planned.status).toBe(0);
    expect(planned.stdout).toContain(`skip ${rulePath}`);
    expect(readFileSync(rulePath, "utf8")).toBe("my rule, leave it\n");
    expect(existsSync(join(cwd, ".claude/skills/resolve/SKILL.md"))).toBe(true);
  });

  it("dry-run writes nothing", () => {
    const cwd = tempDir("dry");
    mkdirSync(cwd, { recursive: true });
    const dry = setup(["--dry-run"], cwd);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain(`create ${join(cwd, ".cursor/rules/resolve.mdc")}`);
    expect(dry.stdout).toContain(`create ${join(cwd, ".claude/skills/resolve/SKILL.md")}`);
    expect(dry.stdout).toContain(`create ${join(cwd, "CLAUDE.md")}`);
    expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(cwd, ".cursor/rules/resolve.mdc"))).toBe(false);

    const bad = setup(["--nope"], cwd);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("Unknown argument --nope");
  });

  it("--global writes under the home folder and leaves the project alone", () => {
    const cwd = tempDir("proj");
    const home = tempDir("home");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(home, { recursive: true });
    const planned = setup(["--global"], cwd, home);
    expect(planned.status).toBe(0);
    expect(planned.stdout).toContain(`create ${join(home, ".cursor/rules/resolve.mdc")}`);
    expect(planned.stdout).toContain(`create ${join(home, ".claude/skills/resolve/SKILL.md")}`);
    expect(planned.stdout).toContain(`create ${join(home, ".claude/CLAUDE.md")}`);
    expect(existsSync(join(home, ".claude/CLAUDE.md"))).toBe(true);
    expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(cwd, ".cursor/rules/resolve.mdc"))).toBe(false);
  });

  it("the published package includes the rule and the skill", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      files: string[];
      bin: Record<string, string>;
    };
    expect(pkg.files).toEqual(expect.arrayContaining(["rules", "skills"]));
    expect(pkg.bin["resolve-setup"]).toBe("./bin/resolve-setup.mjs");
    expect(existsSync(join(root, "rules/resolve.mdc"))).toBe(true);
    expect(existsSync(join(root, "skills/resolve/SKILL.md"))).toBe(true);
    expect(existsSync(join(root, "bin/resolve-setup.mjs"))).toBe(true);
    const ignore = existsSync(join(root, ".npmignore")) ? readFileSync(join(root, ".npmignore"), "utf8") : "";
    expect(ignore).not.toMatch(/^rules\/?$/m);
    expect(ignore).not.toMatch(/^skills\/?$/m);
  });
});
