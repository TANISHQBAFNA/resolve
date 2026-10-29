import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Optional add-ons live in addons/<name>/hook.json. Core discovers them.
 * It does not import add-on code. A registered handler (tests, in-process) wins;
 * otherwise the add-on bin is spawned.
 */
export type AddonCommand = (args: string[]) => void | Promise<void>;

type HookFile = { command?: string; bin?: string; usage?: string[] };

type Hook = { command: string; bin: string; dir: string; usage: string[] };

const handlers = new Map<string, AddonCommand>();

export function registerAddonCommand(command: string, run: AddonCommand): void {
  handlers.set(command, run);
}

export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "src"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dir;
}

export function addonHooks(): Hook[] {
  const root = join(packageRoot(), "addons");
  if (!existsSync(root)) return [];
  const hooks: Hook[] = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    const file = join(dir, "hook.json");
    if (!existsSync(file)) continue;
    let parsed: HookFile;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8")) as HookFile;
    } catch {
      continue;
    }
    if (!parsed.command || !parsed.bin) continue;
    const usage = Array.isArray(parsed.usage) ? parsed.usage.filter((line): line is string => typeof line === "string") : [];
    hooks.push({ command: parsed.command, bin: parsed.bin, dir, usage });
  }
  return hooks;
}

export function addonUsageLines(): string[] {
  return addonHooks().flatMap((hook) => hook.usage);
}

/** Always run the add-on bin, ignoring an in-process handler. */
export function spawnAddonCommand(command: string, args: string[]): void {
  const hook = addonHooks().find((item) => item.command === command);
  if (!hook) throw new Error(`Unknown command: ${command}`);
  const bin = join(hook.dir, hook.bin);
  if (!existsSync(bin)) throw new Error(`Add-on command ${command} is missing (${bin}).`);
  const result = spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const status = result.status ?? 1;
  if (status !== 0) {
    process.exitCode = status;
    if (!args.includes("--json")) {
      const message = (result.stderr || result.stdout || "Add-on command failed").trim();
      throw new Error(message);
    }
  }
}

export async function runAddonCommand(command: string, args: string[]): Promise<void> {
  const registered = handlers.get(command);
  if (registered) {
    await registered(args);
    return;
  }
  spawnAddonCommand(command, args);
}
