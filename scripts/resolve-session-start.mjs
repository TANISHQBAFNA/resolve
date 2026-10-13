#!/usr/bin/env node
/**
 * SessionStart: inject the use-Resolve-first note from skills/resolve/SKILL.md.
 * The skill file is the source. This script does not copy that sentence.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env["CLAUDE_PLUGIN_ROOT"] || join(dirname(fileURLToPath(import.meta.url)), "..");

function skillDescription(text) {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  return /^description:\s*(.+)\s*$/m.exec(front)?.[1]?.trim() ?? "";
}

try {
  const description = skillDescription(readFileSync(join(root, "skills", "resolve", "SKILL.md"), "utf8"));
  if (!description) process.exit(0);
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: description,
      },
    })}\n`,
  );
} catch {
  process.exit(0);
}
