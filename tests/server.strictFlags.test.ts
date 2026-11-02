import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { hasStrict, KNOWN_FLAGS, normalizeCliArgs } from "@/core/query/cliFlags";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist-server", "cli.mjs");

describe("normalizeCliArgs", () => {
  it("matches flag names case-insensitively and splits --name=value", () => {
    expect(normalizeCliArgs(["verify", "Pay", "--STRICT"]).argv).toEqual(["verify", "Pay", "--strict"]);
    expect(normalizeCliArgs(["verify", "Pay", "--Strict"]).argv).toEqual(["verify", "Pay", "--strict"]);
    expect(normalizeCliArgs(["code", "pick", "x", "--limit=3"]).argv).toEqual(["code", "pick", "x", "--limit", "3"]);
    expect(normalizeCliArgs(["verify", "Pay", "--strict"]).warnings).toEqual([]);
  });

  it("reads --strict=true as on and --strict=false as off", () => {
    for (const on of ["--strict=true", "--strict=TRUE", "--strict=1", "--STRICT=yes"]) {
      expect(normalizeCliArgs(["check", "Pay", on]).argv, on).toEqual(["check", "Pay", "--strict"]);
      expect(hasStrict([on]), on).toBe(true);
    }
    for (const off of ["--strict=false", "--strict=0", "--strict=no"]) {
      expect(normalizeCliArgs(["check", "Pay", off]).argv, off).toEqual(["check", "Pay"]);
      expect(hasStrict([off]), off).toBe(false);
    }
    const odd = normalizeCliArgs(["check", "Pay", "--strict=maybe"]);
    expect(odd.argv).toEqual(["check", "Pay"]);
    expect(odd.warnings[0]).toContain("next:");
  });

  it("warns on an unknown flag with a did-you-mean next step, and never drops it silently", () => {
    const typo = normalizeCliArgs(["verify", "Pay", "--stirct"]);
    expect(typo.warnings).toHaveLength(1);
    expect(typo.warnings[0]).toContain("unknown flag --stirct");
    expect(typo.warnings[0]).toContain("next: did you mean --strict?");
    const far = normalizeCliArgs(["verify", "Pay", "--zzzzzzzz"]);
    expect(far.warnings[0]).toContain("unknown flag --zzzzzzzz");
    expect(far.warnings[0]).toContain("next:");
  });

  it("knows every flag the CLI source reads", () => {
    const read = new Set<string>();
    const walk = (dir: string) => {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, item.name);
        if (item.isDirectory()) walk(path);
        else if (path.endsWith(".ts")) {
          const text = readFileSync(path, "utf8");
          for (const match of text.matchAll(/\bflag\([a-zA-Z]+, "(?:--)?([a-z][a-z0-9-]*)"\)/g)) read.add(match[1]!);
          for (const match of text.matchAll(/\.includes\("--([a-z][a-z0-9-]*)"\)/g)) read.add(match[1]!);
        }
      }
    };
    walk(join(root, "src", "server"));
    expect(read.size).toBeGreaterThan(20);
    expect([...read].filter((name) => !KNOWN_FLAGS.has(name))).toEqual([]);
  });
});

describe("--strict at the bin, the way CI runs it", () => {
  let home = "";
  const run = (args: string[], cwd = home) =>
    spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", env: { ...process.env, HOME: home, RESOLVE_HOME: join(home, "store"), RESOLVE_MODE: "both" } });

  beforeAll(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), "resolve-strict-"));
    mkdirSync(join(home, "store"), { recursive: true });
    const ingest = run(["ingest", join(root, "scoreboard", "fixture", "library.json"), "--role", "library", "--name", "Fixture"]);
    expect(ingest.status, ingest.stderr).toBe(0);
  });

  it("verify on a missing frame is a clear warning with a next step and exit 0", () => {
    const result = run(["verify", "No Such Frame"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("warning: nothing was checked");
    expect(result.stderr).toContain("next:");
    const json = JSON.parse(result.stdout) as { checked?: boolean; warning?: string; next?: string };
    expect(json.checked).toBe(false);
    expect(json.next).toContain("check the frame name");
  });

  it("verify and check fail under every accepted spelling of --strict", () => {
    for (const command of ["verify", "check"]) {
      for (const strict of ["--strict", "--STRICT", "--strict=true"]) {
        expect(run([command, "No Such Frame", strict]).status, `${command} ${strict}`).toBe(1);
      }
      expect(run([command, "No Such Frame", "--strict=false"]).status, command).toBe(0);
    }
  });

  it("a misspelled --strict warns with a did-you-mean and does not fail", () => {
    const result = run(["verify", "No Such Frame", "--stirct"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("unknown flag --stirct");
    expect(result.stderr).toContain("did you mean --strict?");
  });

  it("cousins exits 0 on an unlearned file link and 1 with --strict", () => {
    const link = "https://www.figma.com/design/NOTLEARNED12/x?node-id=1-2";
    expect(run(["cousins", link]).status).toBe(0);
    expect(run(["cousins", link, "--strict"]).status).toBe(1);
    expect(run(["cousins", link, "--Strict"]).status).toBe(1);
  });

  it("code check exits 0 with findings and 1 with --strict", () => {
    const repo = join(home, "ds");
    mkdirSync(join(repo, "components", "button"), { recursive: true });
    writeFileSync(join(repo, "components", "button", "button.css"), ".btn { color: var(--ink); }\n");
    writeFileSync(join(repo, "tokens.css"), ":root { --ink: #112233; }\n");
    const screen = join(repo, "screen.html");
    writeFileSync(screen, '<link rel="stylesheet" href="components/button/button.css">\n<div class="nope" style="color:#ff00aa"></div>\n');
    expect(run(["code", "scan", "--repo", repo]).status).toBe(0);
    const loose = run(["code", "check", screen, "--repo", repo]);
    expect(loose.status, loose.stderr).toBe(0);
    expect(run(["code", "check", screen, "--repo", repo, "--strict"]).status).toBe(1);
    expect(run(["code", "check", screen, "--repo", repo, "--STRICT=true"]).status).toBe(1);
  });

  it("brief check says --strict in its usage and does not say findings do not stop under --strict", () => {
    const brief = join(home, "draft.md");
    writeFileSync(brief, "---\nstatus: draft\n---\n# Draft\n");
    const loose = run(["brief", "check", brief]);
    expect(loose.status).toBe(0);
    expect(loose.stdout).toContain("findings do not stop Resolve");
    const strict = run(["brief", "check", brief, "--strict"]);
    expect(strict.status).not.toBe(0);
    expect(strict.stdout).not.toContain("findings do not stop Resolve");
    expect(strict.stdout).toContain("(--strict)");
    const usage = run(["brief", "check"]);
    expect(usage.stderr).toContain("[--strict]");
  });
});
