#!/usr/bin/env node
/**
 * SessionStart: inject the core use-Resolve-first note plus the active mode's pack note.
 * The skill files are the source (skills/resolve, skills/resolve-figma, skills/resolve-code).
 * Mode: RESOLVE_MODE, else .resolve/config.json `mode`, else both when a repoPath is set, else figma.
 * Same order as src/server/mode.ts.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env["CLAUDE_PLUGIN_ROOT"] || join(dirname(fileURLToPath(import.meta.url)), "..");
const usable = (value) => (typeof value === "string" && value.trim() && !value.includes("${") ? value.trim() : undefined);

function skillDescription(name) {
  const text = readFileSync(join(root, "skills", name, "SKILL.md"), "utf8");
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  return /^description:\s*(.+)\s*$/m.exec(front)?.[1]?.trim() ?? "";
}

function config() {
  const pinned = usable(process.env["RESOLVE_HOME"]);
  let dir = resolve(process.cwd());
  for (;;) {
    for (const file of pinned ? [join(resolve(pinned), "config.json")] : [join(dir, ".resolve", "config.json")]) {
      if (existsSync(file)) {
        try {
          return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
        } catch {
          return {};
        }
      }
    }
    const parent = dirname(dir);
    if (pinned || parent === dir) return {};
    dir = parent;
  }
}

function activeMode() {
  const file = config();
  const pick = (value) => (["figma", "code", "both"].includes(String(value).trim().toLowerCase()) ? String(value).trim().toLowerCase() : undefined);
  return pick(usable(process.env["RESOLVE_MODE"])) ?? pick(file.mode) ?? (usable(process.env["RESOLVE_REPO_PATH"]) || usable(file.repoPath) ? "both" : "figma");
}

try {
  const mode = activeMode();
  const names = ["resolve", ...(mode === "code" ? [] : ["resolve-figma"]), ...(mode === "figma" ? [] : ["resolve-code"])];
  const text = names.map(skillDescription).filter(Boolean).join("\n");
  if (!text) process.exit(0);
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } })}\n`);
} catch {
  process.exit(0);
}
