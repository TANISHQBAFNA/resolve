import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chdir } from "node:process";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCli } from "@/server/cli";
import { MCP_INSTRUCTIONS } from "@/server/instructions";
import { attachMcpStdio } from "@/server/mcpSession";
import { installKind } from "@/server/pluginSettings";
import { clearCache } from "@/server/store";

/** F4-R2: the first MCP reply nags about a token or file key only when no library is learned, in words that fit the install. */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEYS = ["FIGMA_ACCESS_TOKEN", "FIGMA_TOKEN", "RESOLVE_LIBRARY_FILE_KEY", "FIGMA_LIBRARY_FILE_KEY", "HOME"];
/** What each plugin manifest passes when the designer has not filled in its settings. */
const CLAUDE_PLUGIN = {
  FIGMA_ACCESS_TOKEN: "${user_config.FIGMA_ACCESS_TOKEN}",
  RESOLVE_LIBRARY_FILE_KEY: "${user_config.RESOLVE_LIBRARY_FILE_KEY}",
};
const CURSOR_PLUGIN = { FIGMA_ACCESS_TOKEN: "${FIGMA_ACCESS_TOKEN}", RESOLVE_LIBRARY_FILE_KEY: "${RESOLVE_LIBRARY_FILE_KEY}" };

const temp = (name: string) => {
  const dir = join(realpathSync(tmpdir()), `resolve-hint-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** A fresh project folder and its own HOME. With `setup`, resolve-setup has run in it. */
function project(name: string, setup = false): { cwd: string; home: string } {
  const cwd = temp(name);
  const home = temp(`${name}-home`);
  if (setup) {
    const run = spawnSync(process.execPath, [join(root, "bin", "resolve-setup.mjs")], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, HOME: home, FIGMA_ACCESS_TOKEN: "" },
    });
    expect(run.status, run.stderr).toBe(0);
  }
  return { cwd, home };
}

/** The `instructions` of the first MCP reply, started in `cwd` with that HOME and only the given settings. */
async function firstInstructions(cwd: string, home: string, settings: Record<string, string> = {}): Promise<string> {
  return inProject(cwd, home, settings, async () => {
    const input = new PassThrough();
    let instructions = "";
    let done = () => {};
    const closed = new Promise<void>((resolveClosed) => {
      done = resolveClosed;
    });
    attachMcpStdio({
      input,
      write: (line) => {
        const message = JSON.parse(line) as { id?: number; result?: { instructions?: string } };
        if (message.id === 1) instructions = message.result?.instructions ?? "";
      },
      onClose: () => done(),
    });
    input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    await closed;
    return instructions;
  });
}

async function inProject<T>(cwd: string, home: string, settings: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  const previous = process.cwd();
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, { HOME: home, ...settings });
  chdir(cwd);
  clearCache();
  try {
    return await run();
  } finally {
    chdir(previous);
    clearCache();
    for (const key of KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Learn a small library the way a fresh install does: into the store this folder's server reads. */
async function learn(cwd: string, home: string): Promise<void> {
  writeFileSync(join(cwd, "lib.xml"), `<frame id="1:1" name="Screen"><component id="9:9" name="Button" /></frame>\n`);
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    await inProject(cwd, home, {}, () => runCli(["ingest", join(cwd, "lib.xml"), "--file-key", "LIB", "--role", "library"]));
  } finally {
    process.stdout.write = write;
  }
}

function expectProjectHint(text: string): void {
  expect(text.startsWith(MCP_INSTRUCTIONS)).toBe(true);
  expect(text).not.toContain("/plugin configure");
  expect(text).not.toContain("plugin settings");
  expect(text).not.toContain("library file key");
  expect(text).toContain("This project install does not need one");
  expect(text).toContain("set FIGMA_ACCESS_TOKEN in the environment");
  expect(text.length).toBeLessThan(2048);
}

describe("F4-R2: install hint on the first MCP reply", () => {
  it("Claude Code plugin install: the plugin hint until a library is learned, then nothing", async () => {
    const { cwd, home } = project("claude-plugin");
    expect(installKind(cwd)).toBe("plugin");
    const fresh = await firstInstructions(cwd, home, CLAUDE_PLUGIN);
    expect(fresh).toContain("Resolve does not have a Figma token or a library file key yet.");
    expect(fresh).toContain("/plugin configure resolve@resolve");
    await learn(cwd, home);
    expect(await firstInstructions(cwd, home, CLAUDE_PLUGIN)).toBe(MCP_INSTRUCTIONS);
  });

  it("project install via the .mcp.json resolve-setup writes: no plugin nag, and nothing once a library is learned", async () => {
    const { cwd, home } = project("project", true);
    expect(installKind(cwd)).toBe("project");
    expect(installKind(join(cwd, ".claude"))).toBe("project");
    rmSync(join(cwd, ".cursor", "mcp.json"));
    expect(installKind(cwd)).toBe("project");
    expectProjectHint(await firstInstructions(cwd, home));
    expect(await firstInstructions(cwd, home, { FIGMA_ACCESS_TOKEN: "test-token" })).toBe(MCP_INSTRUCTIONS);
    await learn(cwd, home);
    expect(await firstInstructions(cwd, home)).toBe(MCP_INSTRUCTIONS);
  });

  it("Cursor: a project install via .cursor/mcp.json gets the project hint, the Cursor plugin gets Configure", async () => {
    const { cwd, home } = project("cursor-project", true);
    rmSync(join(cwd, ".mcp.json"));
    expect(installKind(cwd)).toBe("project");
    expectProjectHint(await firstInstructions(cwd, home));
    await learn(cwd, home);
    expect(await firstInstructions(cwd, home)).toBe(MCP_INSTRUCTIONS);

    const plugin = project("cursor-plugin");
    const fresh = await firstInstructions(plugin.cwd, plugin.home, CURSOR_PLUGIN);
    expect(fresh).toContain("Resolve does not have a Figma token or a library file key yet.");
    expect(fresh).toContain("Cursor: open Plugins, choose Resolve, then Configure.");
    await learn(plugin.cwd, plugin.home);
    expect(await firstInstructions(plugin.cwd, plugin.home, CURSOR_PLUGIN)).toBe(MCP_INSTRUCTIONS);
  });

  it("only resolve-setup's own entry, without the plugin settings, counts as a project install", () => {
    const entry = { command: "npx", args: ["-y", "-p", "github:TANISHQBAFNA/resolve#v0.1.2", "resolve-mcp"] };
    const cases: Array<[unknown, string]> = [
      [{ mcpServers: { resolve: { command: "npm", args: ["run", "mcp"] } } }, "plugin"],
      [{ mcpServers: { resolve: { ...entry, env: { FIGMA_ACCESS_TOKEN: "${user_config.FIGMA_ACCESS_TOKEN}" } } } }, "plugin"],
      [{ mcpServers: { other: entry } }, "plugin"],
      [{ mcpServers: { resolve: entry } }, "project"],
    ];
    for (const [doc, kind] of cases) {
      const cwd = temp("kind");
      mkdirSync(join(cwd, ".cursor"), { recursive: true });
      writeFileSync(join(cwd, ".cursor", "mcp.json"), JSON.stringify(doc));
      expect(installKind(cwd), JSON.stringify(doc)).toBe(kind);
    }
    const broken = temp("kind-broken");
    writeFileSync(join(broken, ".mcp.json"), "{ not json");
    expect(installKind(broken)).toBe("plugin");
  });
});
