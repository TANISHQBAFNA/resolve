import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getPrompt, listPrompts } from "@/server/commands";
import { DESIGNER } from "@/server/designerMessages";
import { attachMcpStdio } from "@/server/mcpSession";
import { listToolDefinitions } from "@/server/tools";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "bin", "resolve-setup.mjs");
const BEGIN = "<!-- resolve-setup:begin -->";
const NAMES = ["check", "design-system", "find", "handoff", "parts", "resolve-status"];
/** What each command must tell the agent to call. */
const CALLS: Record<string, string[]> = {
  "design-system": ["learn_library", "get_metadata", "page by page", "50,000", "report.told"],
  find: ["recommend", "resolve", "weak match"],
  check: ["verify_frame", "check_cousins", "node-id", "name-only", "wrong cousin", "missing required state"],
  parts: ["what's on this screen and its code twin (or unmapped)", "resolve-figma parts", "unmapped", "retired", "screen link"],
  handoff: ["developer build sheet", "resolve-figma handoff", "get_handoff", "node-id"],
  "resolve-status": ["resolve-figma status", "version", "always-on rule"],
};

const temp = (name: string) => {
  const dir = join(realpathSync(tmpdir()), `resolve-slash-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const setup = (args: string[], cwd: string, home = temp("home")) => {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf8", env: { ...process.env, HOME: home, FIGMA_ACCESS_TOKEN: "" } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};
const read = (path: string) => readFileSync(path, "utf8");
/** Every file under a folder, relative path -> bytes. */
function snapshot(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, snapshot(path, base));
    else out[path.slice(base.length)] = read(path);
  }
  return out;
}

describe("slash commands: install", () => {
  it("installs the six commands for Claude Code and Cursor, each naming its tool and the no-invent rule", () => {
    const cwd = temp("install");
    const result = setup([], cwd);
    expect(result.status).toBe(0);
    for (const name of NAMES) {
      const claude = read(join(cwd, ".claude/commands", `${name}.md`));
      const cursor = read(join(cwd, ".cursor/commands", `${name}.md`));
      expect(claude.startsWith("---\n")).toBe(true);
      expect(claude).toMatch(/^description: .+$/m);
      expect(claude).toContain(BEGIN);
      if (name !== "resolve-status") expect(claude).toContain("$ARGUMENTS");
      expect(cursor.startsWith("---")).toBe(false);
      expect(cursor).not.toContain("$ARGUMENTS");
      expect(cursor).toContain(BEGIN);
      for (const text of [claude, cursor]) {
        for (const call of CALLS[name] ?? []) expect(text).toContain(call);
        if (name !== "resolve-status") expect(text).toMatch(/Never invent a component/);
        expect(text).toContain("Never show a stack trace");
        for (const key of ["badLink", "token", "viewSeat", "nothingLearned", "notInstalled"] as const) {
          expect(text).toContain(DESIGNER[key]);
        }
        expect(text).not.toMatch(/figd\_|\bfile[ -]?key: [A-Za-z0-9]{16,}/i);
      }
    }
    expect(read(join(cwd, "CLAUDE.md"))).toContain("Do not invent components");
    expect(read(join(cwd, ".cursor/rules/resolve.mdc"))).toContain("alwaysApply: true");
  });

  it("installing again changes nothing: no duplicates, byte-identical", () => {
    const cwd = temp("again");
    const home = temp("again-home");
    setup([], cwd, home);
    const before = snapshot(cwd);
    const second = setup([], cwd, home);
    expect(second.status).toBe(0);
    expect(second.stdout).not.toMatch(/^(create|update) /m);
    expect(snapshot(cwd)).toEqual(before);
    expect(Object.keys(before).filter((f) => f.includes("commands"))).toHaveLength(NAMES.length * 2);
  });

  it("update rewrites only the Resolve block of a command file and keeps your own lines", () => {
    const cwd = temp("update");
    const home = temp("update-home");
    setup([], cwd, home);
    const file = join(cwd, ".claude/commands/find.md");
    const original = read(file);
    const hacked = original.replace(/(<!-- resolve-setup:begin -->\n)[\s\S]*?(\n<!-- resolve-setup:end -->)/, "$1OLD TEXT$2");
    writeFileSync(file, `${hacked}MY OWN NOTE\n`);
    const result = setup([], cwd, home);
    expect(result.stdout).toContain(`update ${file}`);
    const after = read(file);
    expect(after).not.toContain("OLD TEXT");
    expect(after).toContain("MY OWN NOTE");
    expect(after.replace("MY OWN NOTE\n", "")).toBe(original);
  });

  it("keeps a command you wrote yourself, says so, and --force replaces it", () => {
    const cwd = temp("mine");
    const home = temp("mine-home");
    mkdirSync(join(cwd, ".claude/commands"), { recursive: true });
    mkdirSync(join(cwd, ".cursor/commands"), { recursive: true });
    writeFileSync(join(cwd, ".claude/commands/find.md"), "my own find\n");
    writeFileSync(join(cwd, ".cursor/commands/check.md"), "my own check\n");
    const result = setup([], cwd, home);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`skip ${join(cwd, ".claude/commands/find.md")} (kept your own file`);
    expect(read(join(cwd, ".claude/commands/find.md"))).toBe("my own find\n");
    expect(read(join(cwd, ".cursor/commands/check.md"))).toBe("my own check\n");
    expect(existsSync(join(cwd, ".claude/commands/check.md"))).toBe(true);
    const again = setup([], cwd, home);
    expect(read(join(cwd, ".claude/commands/find.md"))).toBe("my own find\n");
    expect(again.stdout).toContain("kept your own file");
    setup(["--force"], cwd, home);
    expect(read(join(cwd, ".claude/commands/find.md"))).toContain(BEGIN);
  });

  it("gitignore ignores only the learned cache and keeps a team's own lines", () => {
    const cwd = temp("gitignore");
    const home = temp("gitignore-home");
    writeFileSync(join(cwd, ".gitignore"), ".resolve/\nnode_modules\n");
    const first = setup([], cwd, home);
    expect(first.status).toBe(0);
    const git = read(join(cwd, ".gitignore"));
    expect(git).toContain(".resolve/\n");
    expect(git).toContain("node_modules");
    expect(git).toContain(".resolve/graph.json");
    expect(git).toContain(".resolve/files/");
    expect(git).toContain("recipes.json");
    expect(first.stdout).toContain("ignores the whole .resolve folder");
    const before = read(join(cwd, ".gitignore"));
    setup([], cwd, home);
    expect(read(join(cwd, ".gitignore"))).toBe(before);
    setup(["--uninstall"], cwd, home);
    expect(read(join(cwd, ".gitignore"))).toBe(".resolve/\nnode_modules\n");
  });

  it("gitignore block lists the learned cache and never ignores team knowledge", () => {
    const cache = [
      ".resolve/graph.json",
      ".resolve/files/",
      ".resolve/GRAPH_REPORT.md",
      ".resolve/index.json",
      ".resolve/scoreboard/*",
      "!.resolve/scoreboard/phrases/",
      "!.resolve/scoreboard/phrases/**",
      "!.resolve/scoreboard/golden/",
      "!.resolve/scoreboard/golden/**",
      ".resolve/learn/",
      ".resolve/ingest/",
    ];
    const team = [
      "recipes.json",
      "context-packs.json",
      "code-map.json",
      "bind-rules.json",
      "bind-rules.audit.jsonl",
      "synonyms.json",
      "icon-libraries.json",
      "library-rules.json",
      "workspace.json",
      "sock.json",
    ];
    const cwd = temp("gitignore-sets");
    const home = temp("gitignore-sets-home");
    expect(setup([], cwd, home).status).toBe(0);
    const git = read(join(cwd, ".gitignore"));
    const start = git.indexOf("# resolve-setup:begin");
    const end = git.indexOf("# resolve-setup:end");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const ignoreLines = git
      .slice(start, end)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    expect(ignoreLines).toEqual(cache);
    for (const name of team) {
      expect(ignoreLines).not.toContain(`.resolve/${name}`);
      expect(ignoreLines).not.toContain(name);
      expect(git.slice(start, end)).toContain(name);
    }
    expect(git.slice(start, end)).toContain("scoreboard/phrases/");
    expect(git.slice(start, end)).toContain("scoreboard/golden/");
  });

  it("git check-ignore leaves phrase sets and golden files, and ignores scoreboard run history", () => {
    const cwd = temp("gitignore-check");
    const home = temp("gitignore-check-home");
    expect(setup([], cwd, home).status).toBe(0);
    expect(spawnSync("git", ["init"], { cwd, encoding: "utf8" }).status).toBe(0);
    mkdirSync(join(cwd, ".resolve/scoreboard/phrases"), { recursive: true });
    mkdirSync(join(cwd, ".resolve/scoreboard/golden"), { recursive: true });
    mkdirSync(join(cwd, ".resolve/scoreboard/runs"), { recursive: true });
    writeFileSync(join(cwd, ".resolve/scoreboard/phrases/team.json"), "{}\n");
    writeFileSync(join(cwd, ".resolve/scoreboard/golden/from-library.json"), "{}\n");
    writeFileSync(join(cwd, ".resolve/scoreboard/runs/1.json"), "{}\n");
    writeFileSync(join(cwd, ".resolve/scoreboard/last.json"), "{}\n");
    const ignored = (rel: string) =>
      spawnSync("git", ["check-ignore", "-q", "--", rel], { cwd, encoding: "utf8" }).status === 0;
    expect(ignored(".resolve/scoreboard/phrases/team.json")).toBe(false);
    expect(ignored(".resolve/scoreboard/golden/from-library.json")).toBe(false);
    expect(ignored(".resolve/scoreboard/runs/1.json")).toBe(true);
    expect(ignored(".resolve/scoreboard/last.json")).toBe(true);
  });

  it("warns when a user glob ignores the whole .resolve folder", () => {
    for (const line of [".resolve", ".resolve/", ".resolve/*", ".resolve/**", ".resolve/**/*", "**/.resolve", "**/.resolve/**", "*/.resolve", "*/.resolve/**"]) {
      const cwd = temp(`gitignore-glob-${line.replace(/[^\w]+/g, "-")}`);
      const home = temp("gitignore-glob-home");
      writeFileSync(join(cwd, ".gitignore"), `${line}\n`);
      const result = setup([], cwd, home);
      expect(result.status, line).toBe(0);
      expect(result.stdout, line).toContain("ignores the whole .resolve folder");
    }
  });

  it("--global puts the Claude commands in ~/.claude/commands and writes no Cursor files", () => {
    const cwd = temp("global");
    const home = temp("global-home");
    expect(setup(["--global", "--yes"], cwd, home).status).toBe(0);
    for (const name of NAMES) expect(existsSync(join(home, ".claude/commands", `${name}.md`))).toBe(true);
    expect(existsSync(join(home, ".cursor"))).toBe(false);
    expect(existsSync(join(cwd, ".claude"))).toBe(false);
  });
});

describe("slash commands: uninstall", () => {
  it("removes only what Resolve wrote and keeps your files, text and servers", () => {
    const cwd = temp("uninstall");
    const home = temp("uninstall-home");
    mkdirSync(join(cwd, ".claude/commands"), { recursive: true });
    mkdirSync(join(cwd, ".cursor"), { recursive: true });
    writeFileSync(join(cwd, ".claude/commands/find.md"), "my own find\n");
    writeFileSync(join(cwd, "CLAUDE.md"), "# Notes\n\nKeep this line.\n");
    writeFileSync(join(cwd, ".cursor/mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }, null, 2));
    setup([], cwd, home);
    const rule = join(cwd, ".cursor/rules/resolve.mdc");
    writeFileSync(rule, `${read(rule)}MY RULE NOTE\n`);

    const result = setup(["--uninstall"], cwd, home);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`skip ${join(cwd, ".claude/commands/find.md")} (not written by Resolve, kept)`);
    expect(read(join(cwd, ".claude/commands/find.md"))).toBe("my own find\n");
    expect(read(join(cwd, "CLAUDE.md"))).toBe("# Notes\n\nKeep this line.\n");
    expect(read(rule)).toContain("MY RULE NOTE");
    expect(read(rule)).not.toContain(BEGIN);
    expect(JSON.parse(read(join(cwd, ".cursor/mcp.json")))).toEqual({ mcpServers: { other: { command: "x" } } });
    expect(existsSync(join(cwd, ".mcp.json"))).toBe(false);
    expect(existsSync(join(cwd, ".claude/skills/resolve/SKILL.md"))).toBe(false);
    for (const name of NAMES.filter((n) => n !== "find")) {
      expect(existsSync(join(cwd, ".claude/commands", `${name}.md`))).toBe(false);
      expect(existsSync(join(cwd, ".cursor/commands", `${name}.md`))).toBe(false);
    }
    // A second uninstall finds nothing of Resolve's to remove.
    expect(setup(["--uninstall"], cwd, home).stdout).not.toMatch(/^(remove|update) /m);
  });

  it("removes a CLAUDE.md that only held Resolve's block, and --dry-run writes nothing", () => {
    const cwd = temp("uninstall-claude");
    const home = temp("uninstall-claude-home");
    setup([], cwd, home);
    const before = snapshot(cwd);
    const dry = setup(["--uninstall", "--dry-run"], cwd, home);
    expect(dry.stdout).toContain(`remove ${join(cwd, "CLAUDE.md")}`);
    expect(snapshot(cwd)).toEqual(before);
    setup(["--uninstall"], cwd, home);
    expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(cwd, ".mcp.json"))).toBe(false);
    expect(snapshot(cwd)).toEqual({});
  });

  it("--global --uninstall asks first, then removes only the home-folder files", () => {
    const cwd = temp("uninstall-global");
    const home = temp("uninstall-global-home");
    setup(["--global", "--yes"], cwd, home);
    const ask = setup(["--global", "--uninstall"], cwd, home);
    expect(ask.status).toBe(1);
    expect(existsSync(join(home, ".claude/commands/find.md"))).toBe(true);
    expect(setup(["--global", "--uninstall", "--yes"], cwd, home).status).toBe(0);
    expect(snapshot(home)).toEqual({});
  });
});

describe("slash commands: MCP prompts and status", () => {
  it("exposes the same commands as prompts and leaves the default tool count at 7", () => {
    expect(listPrompts().map((p) => p.name)).toEqual(NAMES);
    expect(listToolDefinitions(false)).toHaveLength(7);
    const prompt = getPrompt("find", { input: "payee picker" })!;
    expect(prompt.messages[0]!.content.text).toContain("The designer typed: payee picker");
    expect(prompt.messages[0]!.content.text).toContain("recommend");
    expect(getPrompt("nope", {})).toBeUndefined();
    expect(listPrompts().find((p) => p.name === "resolve-status")!.arguments).toEqual([]);
  });

  it("the stdio server answers prompts/list and prompts/get without a prior build", async () => {
    const lines = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", id: 2, method: "prompts/list" },
      { jsonrpc: "2.0", id: 3, method: "prompts/get", params: { name: "check", arguments: { input: "https://www.figma.com/design/ACMEUI/Acme?node-id=20-40" } } },
    ];
    const input = new PassThrough();
    const replies: Array<{ id: number; result: { capabilities?: { prompts?: unknown }; prompts?: Array<{ name: string }>; messages?: Array<{ content: { text: string } }> } }> = [];
    let done = () => {};
    const closed = new Promise<void>((resolve) => {
      done = resolve;
    });
    attachMcpStdio({
      input,
      write: (line) => {
        replies.push(JSON.parse(line) as (typeof replies)[number]);
      },
      onClose: () => done(),
    });
    input.end(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    await closed;
    expect(replies.find((message) => message.id === 1)!.result.capabilities!.prompts).toEqual({ listChanged: false });
    expect(replies.find((message) => message.id === 2)!.result.prompts!.map((prompt) => prompt.name)).toEqual(NAMES);
    expect(replies.find((message) => message.id === 3)!.result.messages![0]!.content.text).toContain("node-id=20-40");
  });
});
