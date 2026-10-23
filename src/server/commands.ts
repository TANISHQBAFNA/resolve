import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packFromFiles, validateAiPick, type PickRequest } from "../core/query/meaning/sock";
import { aiPicksEnabled } from "./pluginSettings";

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

export interface PickCommandIo {
  stdout: (text: string) => void;
  exitCode: (code: number) => void;
}

const PICK_OFF = "AI picks is off. Use recommend.\n";

function folderFor(library: string): string {
  const key = library.trim().toLowerCase();
  if (key === "angular material" || key === "material") return "material";
  if (key === "acme ui" || key === "acme-small") return "acme-small";
  if (key === "acme") return "acme";
  return key.replace(/\s+/g, "-");
}

function asRequest(raw: unknown): PickRequest | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  if (typeof row["library"] !== "string" || typeof row["ask"] !== "string" || !Array.isArray(row["shortlist"]) || typeof row["tier"] !== "string") return undefined;
  const shortlist = row["shortlist"].filter((item): item is string => typeof item === "string");
  const propsRaw = row["props"];
  const props: Record<string, string> = {};
  if (propsRaw && typeof propsRaw === "object" && !Array.isArray(propsRaw)) {
    for (const [key, value] of Object.entries(propsRaw)) if (typeof value === "string") props[key] = value;
  }
  return {
    library: row["library"],
    ask: row["ask"],
    shortlist,
    ...(typeof row["pick"] === "string" ? { pick: row["pick"] } : {}),
    ...(Object.keys(props).length ? { props } : {}),
    ...(typeof row["reason"] === "string" ? { reason: row["reason"] } : {}),
    tier: row["tier"],
  };
}

function readMeaningPack(library: string) {
  const dir = join(process.cwd(), "meaning", folderFor(library));
  const indexPath = join(dir, "index.md");
  if (!existsSync(indexPath)) return undefined;
  const index = readFileSync(indexPath, "utf8");
  const builtAt = /^built:\s*(.+)$/m.exec(index)?.[1]?.trim() ?? "";
  const title = /^#\s+(.+)$/m.exec(index)?.[1]?.trim() ?? library;
  const files = new Map<string, string>();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md") || name === "index.md") continue;
    files.set(name.slice(0, -3), readFileSync(join(dir, name), "utf8"));
  }
  return packFromFiles(title, builtAt, files);
}

export function runPickCommand(args: readonly string[], env: NodeJS.ProcessEnv = process.env, io?: PickCommandIo): void {
  const stdout = io?.stdout ?? ((text: string) => process.stdout.write(text));
  const exitCode = io?.exitCode ?? ((code: number) => {
    process.exitCode = code;
  });
  if (!aiPicksEnabled(env)) {
    stdout(PICK_OFF);
    exitCode(0);
    return;
  }
  const source = args.find((arg) => !arg.startsWith("--"));
  if (!source) {
    stdout("Usage: resolve pick <request.json>\n");
    exitCode(1);
    return;
  }
  let text = source;
  if (existsSync(source)) text = readFileSync(source, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    stdout("The pick request is not valid JSON.\n");
    exitCode(1);
    return;
  }
  const req = asRequest(parsed);
  if (!req) {
    stdout("The pick request needs library, ask, shortlist, and tier.\n");
    exitCode(1);
    return;
  }
  const pack = readMeaningPack(req.library);
  if (!pack) {
    stdout(`No meaning files for ${req.library}.\n`);
    exitCode(1);
    return;
  }
  const builtFlag = args.findIndex((arg) => arg === "--library-built-at");
  const libraryBuiltAt = builtFlag >= 0 ? args[builtFlag + 1] : undefined;
  const result = validateAiPick(pack, req, libraryBuiltAt);
  stdout(`${JSON.stringify(result)}\n`);
  exitCode(result.failed.length ? 1 : 0);
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
