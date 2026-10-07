import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The slash commands (commands/*.md in the package) as MCP prompts. Same text the setup command installs for
 * Claude Code and Cursor. Prompts are not tools: the default tool count does not change.
 */

export interface CommandPrompt {
  name: string;
  description: string;
  argumentHint: string;
  body: string;
}

function commandsDir(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let hop = 0; hop < 4; hop += 1) {
    if (existsSync(join(dir, "commands", "find.md"))) return join(dir, "commands");
    dir = dirname(dir);
  }
  return undefined;
}

export function loadCommands(): CommandPrompt[] {
  const dir = commandsDir();
  if (!dir) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => {
      const text = readFileSync(join(dir, file), "utf8");
      const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
      const front = match?.[1] ?? "";
      const field = (key: string) => new RegExp(`^${key}:\\s*(.*)$`, "m").exec(front)?.[1]?.trim() ?? "";
      return { name: file.replace(/\.md$/, ""), description: field("description"), argumentHint: field("argument-hint"), body: (match?.[2] ?? text).trim() };
    });
}

export function listPrompts() {
  return loadCommands().map((c) => ({
    name: c.name,
    description: c.description,
    arguments: c.argumentHint.startsWith("(") ? [] : [{ name: "input", description: c.argumentHint, required: false }],
  }));
}

export function getPrompt(name: string, args: unknown) {
  const command = loadCommands().find((c) => c.name === name);
  if (!command) return undefined;
  const input = args && typeof args === "object" && "input" in args ? String((args as { input?: unknown }).input ?? "") : "";
  return {
    description: command.description,
    messages: [{ role: "user", content: { type: "text", text: command.body.replace(/\$ARGUMENTS/g, input.trim() || "(nothing)") } }],
  };
}
