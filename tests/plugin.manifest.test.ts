import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import addFormats from "ajv-formats";
import Ajv from "ajv";
import { MCP_INSTRUCTIONS } from "@/server/instructions";
import { attachMcpStdio } from "@/server/mcpSession";
import { pluginSetupSuffix, readPluginSettings } from "@/server/pluginSettings";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function schemaErrors(schemaPath: string, data: unknown): string {
  const validate = ajv.compile(loadJson(schemaPath) as object);
  if (validate(data)) return "";
  return (validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? ""}`).join("\n");
}

function assertInsideRoot(path: string): void {
  const full = resolve(root, path);
  const rel = normalize(full).startsWith(normalize(root));
  expect(rel, path).toBe(true);
  expect(full.includes(".."), path).toBe(false);
  expect(existsSync(full), path).toBe(true);
}

/** Every ./ path or marketplace source the manifest names must exist inside the repo. */
function referencedPaths(value: unknown, bag: string[] = []): string[] {
  if (typeof value === "string") {
    if (value.startsWith("./") || value === ".") bag.push(value);
    return bag;
  }
  if (Array.isArray(value)) {
    for (const item of value) referencedPaths(item, bag);
    return bag;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) referencedPaths(item, bag);
  }
  return bag;
}

const ENV_KEYS = ["FIGMA_ACCESS_TOKEN", "FIGMA_TOKEN", "RESOLVE_LIBRARY_FILE_KEY", "FIGMA_LIBRARY_FILE_KEY"] as const;

describe("plugin manifests", () => {
  const claudePlugin = loadJson(join(root, ".claude-plugin/plugin.json")) as {
    name: string;
    version: string;
    description: string;
    homepage: string;
    author: { name: string };
    userConfig: Record<string, { type: string; title: string; description: string; sensitive?: boolean }>;
  };
  const claudeMarket = loadJson(join(root, ".claude-plugin/marketplace.json")) as {
    name: string;
    plugins: Array<{ name: string; source: string }>;
  };
  const cursorPlugin = loadJson(join(root, ".cursor-plugin/plugin.json")) as {
    name: string;
    version: string;
    rules: string;
    skills: string;
    commands: string;
    mcpServers: string;
    variables: { type: string; properties: Record<string, { type: string; title: string; description: string }> };
  };
  const cursorMarket = loadJson(join(root, ".cursor-plugin/marketplace.json")) as {
    name: string;
    plugins: Array<{ name: string; source: string }>;
  };
  const pkg = loadJson(join(root, "package.json")) as { version: string };

  it("matches the Claude and Cursor schemas", () => {
    expect(schemaErrors(join(root, "schemas/claude-plugin.schema.json"), claudePlugin)).toBe("");
    expect(schemaErrors(join(root, "schemas/claude-marketplace.schema.json"), claudeMarket)).toBe("");
    expect(schemaErrors(join(root, "schemas/cursor-plugin.schema.json"), cursorPlugin)).toBe("");
    expect(schemaErrors(join(root, "schemas/cursor-marketplace.schema.json"), cursorMarket)).toBe("");
  });

  it("points at the existing commands, skill, and rule, and every named path exists", () => {
    for (const file of [
      ".claude-plugin/plugin.json",
      ".claude-plugin/marketplace.json",
      ".cursor-plugin/plugin.json",
      ".cursor-plugin/marketplace.json",
    ]) {
      for (const path of referencedPaths(loadJson(join(root, file)))) assertInsideRoot(path);
    }
    expect(claudePlugin.name).toBe("resolve");
    expect(cursorPlugin.name).toBe("resolve");
    expect(claudePlugin.version).toBe(pkg.version);
    expect(cursorPlugin.version).toBe(pkg.version);
    expect(claudePlugin.author.name.length).toBeGreaterThan(0);
    expect(claudePlugin.homepage).toBe("https://github.com/TANISHQBAFNA/resolve");
    expect(claudePlugin.description.length).toBeGreaterThan(0);
    expect(claudeMarket.name).toBe("resolve");
    expect(claudeMarket.plugins[0]).toEqual({
      name: "resolve",
      source: "./",
      description: claudePlugin.description,
    });
    expect(cursorMarket.plugins[0]?.source).toBe(".");
    expect(existsSync(join(root, cursorMarket.plugins[0]!.source, ".cursor-plugin/plugin.json"))).toBe(true);
    expect(existsSync(join(root, "skills/resolve/SKILL.md"))).toBe(true);
    expect(readFileSync(join(root, "rules/resolve.mdc"), "utf8")).toContain("alwaysApply: true");
    const commands = readdirSync(join(root, "commands")).filter((file) => file.endsWith(".md")).sort();
    expect(commands).toEqual(["check.md", "code-map.md", "design-system.md", "find.md", "handoff.md", "parts.md", "resolve-status.md"]);
    expect(statSync(join(root, cursorPlugin.rules)).isDirectory()).toBe(true);
    expect(statSync(join(root, cursorPlugin.skills)).isDirectory()).toBe(true);
    expect(statSync(join(root, cursorPlugin.commands)).isDirectory()).toBe(true);
    expect(statSync(join(root, cursorPlugin.mcpServers)).isFile()).toBe(true);
  });

  it("starts the published server and takes the token and file key from plugin settings", () => {
    const setup = readFileSync(join(root, "bin/resolve-setup.mjs"), "utf8");
    const args = ["-y", "-p", "github:TANISHQBAFNA/resolve", "resolve-mcp"];
    expect(setup).toContain(
      'export const MCP_ENTRY = { command: "npx", args: ["-y", "-p", "github:TANISHQBAFNA/resolve", "resolve-mcp"] }',
    );
    for (const file of [".mcp.json", "mcp.json"]) {
      const doc = loadJson(join(root, file)) as {
        mcpServers: { resolve: { command: string; args: string[]; env: Record<string, string> } };
      };
      expect(doc.mcpServers.resolve.command).toBe("npx");
      expect(doc.mcpServers.resolve.args).toEqual(args);
      expect(JSON.stringify(doc)).not.toMatch(/figd_/);
    }
    const claudeEnv = (loadJson(join(root, ".mcp.json")) as { mcpServers: { resolve: { env: Record<string, string> } } }).mcpServers.resolve.env;
    expect(claudeEnv["FIGMA_ACCESS_TOKEN"]).toBe("${user_config.FIGMA_ACCESS_TOKEN}");
    expect(claudeEnv["RESOLVE_LIBRARY_FILE_KEY"]).toBe("${user_config.RESOLVE_LIBRARY_FILE_KEY}");
    expect(Object.keys(claudePlugin.userConfig).sort()).toEqual(["FIGMA_ACCESS_TOKEN", "RESOLVE_LIBRARY_FILE_KEY"]);
    expect(claudePlugin.userConfig["FIGMA_ACCESS_TOKEN"]?.sensitive).toBe(true);
    const cursorEnv = (loadJson(join(root, "mcp.json")) as { mcpServers: { resolve: { env: Record<string, string> } } }).mcpServers.resolve.env;
    expect(Object.keys(cursorEnv).sort()).toEqual(Object.keys(cursorPlugin.variables.properties).sort());
    for (const name of Object.keys(cursorEnv)) {
      expect(cursorEnv[name]).toBe(`\${${name}}`);
      expect(cursorPlugin.variables.properties[name]?.type).toBe("string");
    }
  });

  it("SessionStart reads the skill description and does not copy it", () => {
    const skill = readFileSync(join(root, "skills/resolve/SKILL.md"), "utf8");
    const description = /^description:\s*(.+)\s*$/m.exec(skill)?.[1];
    expect(description).toContain("call Resolve before drawing");
    const script = readFileSync(join(root, "scripts/resolve-session-start.mjs"), "utf8");
    expect(script).toContain("skills/resolve/SKILL.md");
    expect(script).not.toContain("call Resolve before drawing");
    const hooks = loadJson(join(root, "hooks/hooks.json")) as {
      hooks: { SessionStart: Array<{ hooks: Array<{ type: string; command: string }> }> };
    };
    const command = hooks.hooks.SessionStart[0]?.hooks[0];
    expect(command).toEqual({
      type: "command",
      command: "node \"${CLAUDE_PLUGIN_ROOT}/scripts/resolve-session-start.mjs\"",
    });
    const run = spawnSync(process.execPath, [join(root, "scripts/resolve-session-start.mjs")], { encoding: "utf8" });
    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(parsed.hookSpecificOutput).toEqual({ hookEventName: "SessionStart", additionalContext: description });
  });
});

describe("plugin settings on the first MCP reply", () => {
  it("names the missing setting and how to set it, with an Acme file key", () => {
    const neither = pluginSetupSuffix({});
    expect(neither).toContain("Figma token");
    expect(neither).toContain("library file key");
    expect(neither).toContain("/plugin configure resolve@resolve");
    expect(neither).toContain("Plugins, choose Resolve, then Configure");
    expect(neither).toContain("FIGMA_ACCESS_TOKEN");
    expect(neither).toContain("RESOLVE_LIBRARY_FILE_KEY");
    expect(neither).toContain("figma.com/design/ACMEUI/Acme");
    expect(neither).not.toMatch(/figd_/);
    expect(pluginSetupSuffix({ FIGMA_ACCESS_TOKEN: "acme-token" })).toContain("library file key");
    expect(pluginSetupSuffix({ FIGMA_ACCESS_TOKEN: "acme-token" })).not.toContain("does not have a Figma token");
    expect(pluginSetupSuffix({ RESOLVE_LIBRARY_FILE_KEY: "ACMEUI" })).toContain("Figma token");
    expect(pluginSetupSuffix({ RESOLVE_LIBRARY_FILE_KEY: "ACMEUI" })).not.toContain("library file key yet");
    const tokenOnly = pluginSetupSuffix({ FIGMA_ACCESS_TOKEN: "acme-token" });
    expect(tokenOnly).not.toContain("acme-token");
    expect(pluginSetupSuffix({ FIGMA_TOKEN: "acme-token", FIGMA_LIBRARY_FILE_KEY: "ACMEUI" })).toBe("");
    expect(pluginSetupSuffix({ FIGMA_ACCESS_TOKEN: "${FIGMA_ACCESS_TOKEN}", RESOLVE_LIBRARY_FILE_KEY: "  " })).toContain("Figma token");
    expect(readPluginSettings({ FIGMA_ACCESS_TOKEN: "acme-token" }).token).toBe("acme-token");
    expect(MCP_INSTRUCTIONS.length + neither.length).toBeLessThan(2048);
  });

  it("appends that note to the first reply only when a setting is missing", async () => {
    async function firstInstructions(): Promise<string> {
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
    }

    const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
    try {
      const missing = await firstInstructions();
      expect(missing.startsWith(MCP_INSTRUCTIONS)).toBe(true);
      expect(missing).toContain("Resolve does not have a Figma token or a library file key yet.");
      expect(missing).not.toMatch(/figd_/);
      process.env["FIGMA_ACCESS_TOKEN"] = "acme-token";
      process.env["RESOLVE_LIBRARY_FILE_KEY"] = "ACMEUI";
      expect(await firstInstructions()).toBe(MCP_INSTRUCTIONS);
    } finally {
      for (const key of ENV_KEYS) {
        const previous = saved[key];
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }
    }
  });
});
