#!/usr/bin/env node
/**
 * Install Resolve's always-on instructions for Cursor and Claude Code.
 * In a project: the Cursor rule, the Claude skill, and a marked CLAUDE.md block.
 * --global is Claude only (~/.claude skill and ~/.claude/CLAUDE.md). Cursor has no
 * global rules folder; its rule stays in the project.
 * Re-runs only change a complete marked block. Does not read tokens or other secrets.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BEGIN = "<!-- resolve-setup:begin -->";
export const END = "<!-- resolve-setup:end -->";

const here = dirname(fileURLToPath(import.meta.url));
export const packageRoot = join(here, "..");

export const CLAUDE_BLOCK = [
  "## Resolve",
  "",
  "For ANY Figma design, screen, or component task, call Resolve before drawing.",
  "",
  "Resolve works best when the Figma MCP connection is active and a design system, library, or existing screens are learned. If either is missing, tell the user in plain words what is missing and how to add it. Connect Figma in this app, then map the file with learn_library. Do not guess. Do not invent components.",
  "",
  "Map the file first. Then recipe when the job matches, recommend, get_example, verify_frame, and check_cousins when a library and a product file are linked. Resolve is read-only.",
  "",
].join("\n");

function readOrNull(path) {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

function splitFrontmatter(text) {
  if (!text.startsWith("---\n")) return { front: "", body: text.trim() };
  const close = text.indexOf("\n---\n", 3);
  if (close === -1) return { front: "", body: text.trim() };
  return {
    front: text.slice(0, close + "\n---\n".length),
    body: text.slice(close + "\n---\n".length).trim(),
  };
}

function unwrap(body) {
  const start = body.indexOf(BEGIN);
  const end = body.indexOf(END);
  if (start === -1 || end === -1 || end < start) return body.trim();
  return body.slice(start + BEGIN.length, end).trim();
}

export function ownedFile(shipped) {
  const { front, body } = splitFrontmatter(shipped);
  return `${front}${BEGIN}\n${unwrap(body)}\n${END}\n`;
}

/** @returns {{ action: "create" | "update" | "unchanged" | "skip", text: string }} */
export function installOwned(current, shipped) {
  const next = ownedFile(shipped);
  if (current == null) return { action: "create", text: next };
  const start = current.indexOf(BEGIN);
  const end = current.indexOf(END);
  if (start === -1 || end === -1 || end < start) return { action: "skip", text: current };
  const shippedStart = next.indexOf(BEGIN);
  const shippedEnd = next.lastIndexOf(END);
  const inner = next.slice(shippedStart + BEGIN.length, shippedEnd);
  const text = current.slice(0, start + BEGIN.length) + inner + current.slice(end);
  return { action: text === current ? "unchanged" : "update", text };
}

function useEnding(text, ending) {
  return ending === "\n" ? text : text.replace(/\n/g, ending);
}

/** @returns {{ action: "create" | "update" | "unchanged" | "skip", text: string, note?: string }} */
export function installClaude(current, block = CLAUDE_BLOCK) {
  const ending = current != null && current.includes("\r\n") ? "\r\n" : "\n";
  const owned = useEnding(`${BEGIN}\n${block.trim()}\n${END}`, ending);
  if (current == null || current.trim() === "") return { action: "create", text: `${owned}\n` };
  const start = current.indexOf(BEGIN);
  const end = current.indexOf(END);
  if ((start === -1) !== (end === -1)) {
    return {
      action: "skip",
      text: current,
      note: " (left CLAUDE.md; it has only one Resolve marker, so nothing was changed)",
    };
  }
  if (start === -1) {
    const sep = current.endsWith(ending + ending) ? "" : current.endsWith(ending) ? ending : ending + ending;
    return { action: "update", text: `${current}${sep}${owned}${ending}` };
  }
  const text = `${current.slice(0, start)}${owned}${current.slice(end + END.length)}`;
  return { action: text === current ? "unchanged" : "update", text };
}

export function runSetup({ cwd, home, global: isGlobal, dryRun, packageRoot: root = packageRoot }) {
  const base = isGlobal ? home : cwd;
  const claudePath = isGlobal ? join(home, ".claude", "CLAUDE.md") : join(cwd, "CLAUDE.md");
  const ruleSrc = readFileSync(join(root, "rules", "resolve.mdc"), "utf8");
  const skillSrc = readFileSync(join(root, "skills", "resolve", "SKILL.md"), "utf8");
  const planned = [];
  // Cursor loads project rules only. Do not write a home-folder rule.
  if (!isGlobal) {
    const rulePath = join(cwd, ".cursor", "rules", "resolve.mdc");
    planned.push({ path: rulePath, ...installOwned(readOrNull(rulePath), ruleSrc) });
  }
  const skillPath = join(base, ".claude", "skills", "resolve", "SKILL.md");
  planned.push(
    { path: skillPath, ...installOwned(readOrNull(skillPath), skillSrc) },
    { path: claudePath, ...installClaude(readOrNull(claudePath)) },
  );
  if (!dryRun) {
    for (const item of planned) {
      if (item.action === "skip" || item.action === "unchanged") continue;
      mkdirSync(dirname(item.path), { recursive: true });
      writeFileSync(item.path, item.text);
    }
  }
  return planned;
}

function main() {
  let dryRun = false;
  let isGlobal = false;
  for (const arg of process.argv.slice(2)) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--global") isGlobal = true;
    else {
      process.stderr.write(`Unknown argument ${arg}. Use --dry-run and --global.\n`);
      process.exit(1);
    }
  }
  const planned = runSetup({ cwd: process.cwd(), home: homedir(), global: isGlobal, dryRun });
  for (const item of planned) {
    const note = item.note ?? (item.action === "skip" ? " (left existing file; no Resolve markers)" : "");
    process.stdout.write(`${item.action} ${item.path}${note}\n`);
  }
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    // npx and npm's .bin entries are symlinks. Compare the real file.
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) main();
