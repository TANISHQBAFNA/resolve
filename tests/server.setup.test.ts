import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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
    expect(first.stdout).toContain("Node ok? yes");
    expect(first.stdout).toContain("Figma connected?");
    expect(first.stdout).toContain("Library learned?");
    expect(first.stdout).toContain("Rule installed? yes");
    expect(first.stdout).toContain("Words your team uses: .resolve/synonyms.json · icon libraries: .resolve/icon-libraries.json");
    expect(first.stdout).toContain("Exact component ids:");
    expect(first.stdout).toContain("FIGMA_ACCESS_TOKEN");
    expect(first.stdout).toContain("Next:");

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
    expect(planned.status).toBe(1);
    expect(planned.stdout).toContain(`skip ${rulePath}`);
    expect(planned.stdout).toContain("The Cursor rule is NOT installed");
    expect(planned.stdout).toContain("Rule installed? no");
    expect(planned.stdout).toContain("Next: Re-run with --force to install the rule.");
    expect(readFileSync(rulePath, "utf8")).toBe("my rule, leave it\n");
    expect(existsSync(join(cwd, ".claude/skills/resolve/SKILL.md"))).toBe(true);

    const forced = setup(["--force"], cwd);
    expect(forced.status).toBe(0);
    expect(readFileSync(rulePath, "utf8")).toContain("resolve-setup:begin");
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

  it("--global writes Claude files in the home folder and no Cursor rule", () => {
    const cwd = tempDir("proj");
    const home = tempDir("home");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(home, { recursive: true });
    const planned = setup(["--global"], cwd, home);
    expect(planned.status).toBe(1);
    expect(planned.stdout).toContain("home folder");
    expect(planned.stdout).toContain("--global --yes");
    expect(planned.stdout).toContain(join(home, ".claude/skills/resolve/SKILL.md"));
    expect(planned.stdout).toContain(join(home, ".claude/CLAUDE.md"));
    expect(existsSync(join(home, ".claude/CLAUDE.md"))).toBe(false);
    expect(existsSync(join(home, ".claude/skills/resolve/SKILL.md"))).toBe(false);

    const confirmed = setup(["--global", "--yes"], cwd, home);
    expect(confirmed.status).toBe(0);
    expect(confirmed.stdout).not.toContain(join(home, ".cursor"));
    expect(confirmed.stdout).toContain(`create ${join(home, ".claude/skills/resolve/SKILL.md")}`);
    expect(confirmed.stdout).toContain(`create ${join(home, ".claude/CLAUDE.md")}`);
    expect(existsSync(join(home, ".claude/CLAUDE.md"))).toBe(true);
    expect(existsSync(join(home, ".claude/skills/resolve/SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".cursor/rules/resolve.mdc"))).toBe(false);
    expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(cwd, ".cursor/rules/resolve.mdc"))).toBe(false);
  });

  it("leaves CLAUDE.md alone when exactly one Resolve marker is present", () => {
    for (const original of [
      `# Notes\n\n${BEGIN}\nKeep the text after the orphan marker.\n`,
      `# Notes\n\nKeep this.\n${END}\n`,
    ]) {
      const cwd = tempDir("orphan");
      mkdirSync(cwd, { recursive: true });
      const claudePath = join(cwd, "CLAUDE.md");
      writeFileSync(claudePath, original);
      const first = setup([], cwd);
      expect(first.status).toBe(1);
      expect(first.stdout).toContain(`skip ${claudePath} (left CLAUDE.md; it has only one Resolve marker, so nothing was changed)`);
      expect(first.stdout).toContain("The Resolve block is NOT installed");
      expect(first.stdout).toContain("Rule installed? no");
      expect(first.stdout).toContain("Node ok? yes");
      expect(first.stdout).not.toContain("Rule installed? yes");
      expect(readFileSync(claudePath, "utf8")).toBe(original);
      const second = setup([], cwd);
      expect(second.status).toBe(1);
      expect(second.stdout).toContain("Rule installed? no");
      expect(readFileSync(claudePath, "utf8")).toBe(original);
    }
  });

  it("prints a friendly message and the doctor summary when CLAUDE.md is a folder", () => {
    const cwd = tempDir("eisdir");
    mkdirSync(join(cwd, "CLAUDE.md"), { recursive: true });
    const result = setup([], cwd);
    expect(result.status).toBe(1);
    expect(`${result.stderr}\n${result.stdout}`).not.toMatch(/EISDIR/);
    expect(result.stderr).toContain(`Could not write ${join(cwd, "CLAUDE.md")}`);
    expect(result.stdout).toContain("Node ok? yes");
    expect(result.stdout).toContain("Rule installed? no");
    expect(result.stdout).toContain("Next:");
  });

  it("keeps CRLF line endings when adding the block to a CRLF CLAUDE.md", () => {
    const cwd = tempDir("crlf");
    mkdirSync(cwd, { recursive: true });
    const claudePath = join(cwd, "CLAUDE.md");
    writeFileSync(claudePath, "# Notes\r\n\r\nKeep this line.\r\n");
    const first = setup([], cwd);
    expect(first.status).toBe(0);
    const claude = readFileSync(claudePath, "utf8");
    expect(claude).toContain("Keep this line.");
    expect(claude).toContain(BEGIN);
    expect(claude.replace(/\r\n/g, "")).not.toContain("\n");
    const second = setup([], cwd);
    expect(second.stdout).toContain(`unchanged ${claudePath}`);
    expect(readFileSync(claudePath, "utf8").replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("writes files when started through a symlink and from a packed tarball", () => {
    const cwd = tempDir("symlink");
    mkdirSync(cwd, { recursive: true });
    const link = join(cwd, "resolve-setup-link.mjs");
    symlinkSync(bin, link);
    const viaLink = spawnSync(process.execPath, [link], { cwd, encoding: "utf8" });
    expect(viaLink.status).toBe(0);
    expect(viaLink.stdout).toContain("create");
    expect(existsSync(join(cwd, ".cursor/rules/resolve.mdc"))).toBe(true);
    expect(readFileSync(join(cwd, "CLAUDE.md"), "utf8")).toContain(BEGIN);

    const packDir = tempDir("pack");
    mkdirSync(packDir, { recursive: true });
    cpSync(join(root, "bin"), join(packDir, "bin"), { recursive: true });
    cpSync(join(root, "rules"), join(packDir, "rules"), { recursive: true });
    cpSync(join(root, "skills"), join(packDir, "skills"), { recursive: true });
    writeFileSync(
      join(packDir, "package.json"),
      JSON.stringify({
        name: "resolve-setup-fixture",
        version: "0.0.0",
        bin: { "resolve-setup": "./bin/resolve-setup.mjs" },
        files: ["bin", "rules", "skills"],
      }),
    );
    const packed = spawnSync("npm", ["pack", "--json"], { cwd: packDir, encoding: "utf8" });
    expect(packed.status).toBe(0);
    const listing = JSON.parse(packed.stdout.slice(packed.stdout.indexOf("["))) as Array<{ filename: string }>;
    const tgz = join(packDir, listing[0]?.filename ?? "");
    expect(existsSync(tgz)).toBe(true);

    const installDir = tempDir("npx");
    mkdirSync(installDir, { recursive: true });
    const viaPack = spawnSync("npx", ["-y", "-p", tgz, "resolve-setup"], {
      cwd: installDir,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, npm_config_cache: join(packDir, "npm-cache"), NO_UPDATE_NOTIFIER: "1" },
    });
    expect(viaPack.status, viaPack.stderr).toBe(0);
    expect(existsSync(join(installDir, ".cursor/rules/resolve.mdc"))).toBe(true);
    expect(existsSync(join(installDir, ".claude/skills/resolve/SKILL.md"))).toBe(true);
    expect(readFileSync(join(installDir, "CLAUDE.md"), "utf8")).toContain("call Resolve before drawing");
  }, 60_000);

  it("the published package includes the rule and the skill", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      files: string[];
      bin: Record<string, string>;
    };
    expect(pkg.files).toEqual(expect.arrayContaining(["rules", "skills/resolve"]));
    expect(pkg.files).not.toContain("skills");
    expect(pkg.bin["resolve-setup"]).toBe("./bin/resolve-setup.mjs");
    expect(existsSync(join(root, "rules/resolve.mdc"))).toBe(true);
    expect(existsSync(join(root, "skills/resolve/SKILL.md"))).toBe(true);
    expect(existsSync(join(root, "bin/resolve-setup.mjs"))).toBe(true);
    const ignore = existsSync(join(root, ".npmignore")) ? readFileSync(join(root, ".npmignore"), "utf8") : "";
    expect(ignore).not.toMatch(/^rules\/?$/m);
    expect(ignore).not.toMatch(/^skills\/?$/m);
  });
});
