#!/usr/bin/env node
import { nodeVersionMessage, nodeVersionTooOld } from "./node-version.mjs";

if (nodeVersionTooOld(process.version)) {
  process.stderr.write(nodeVersionMessage(process.version));
  process.exit(1);
}

/**
 * Install Resolve's always-on instructions for Cursor and Claude Code.
 * In a project: the Cursor rule, the Claude skill, and a marked CLAUDE.md block.
 * --global is Claude only (~/.claude skill and ~/.claude/CLAUDE.md). Cursor has no
 * global rules folder; its rule stays in the project.
 * Re-runs only change a complete marked block. Does not read tokens or other secrets.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
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

function writeError(target, error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return new Error(`Could not write in ${dirname(target)}. Resolve needs permission to create files there.`);
  }
  return new Error(`Could not write ${target}. Resolve could not create that file.`);
}

function readOrNull(path) {
  if (!existsSync(path)) return null;
  try {
    if (statSync(path).isDirectory()) {
      const error = new Error("path is a folder");
      error.code = "EISDIR";
      throw error;
    }
    return readFileSync(path, "utf8");
  } catch (error) {
    throw writeError(path, error);
  }
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
export function installOwned(current, shipped, force = false) {
  const next = ownedFile(shipped);
  if (current == null) return { action: "create", text: next };
  const start = current.indexOf(BEGIN);
  const end = current.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    if (force) return { action: "update", text: next };
    return { action: "skip", text: current };
  }
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

export function runSetup({ cwd, home, global: isGlobal, dryRun, force = false, packageRoot: root = packageRoot }) {
  const base = isGlobal ? home : cwd;
  const claudePath = isGlobal ? join(home, ".claude", "CLAUDE.md") : join(cwd, "CLAUDE.md");
  const ruleSrc = readFileSync(join(root, "rules", "resolve.mdc"), "utf8");
  const skillSrc = readFileSync(join(root, "skills", "resolve", "SKILL.md"), "utf8");
  const planned = [];
  // Cursor loads project rules only. Do not write a home-folder rule.
  if (!isGlobal) {
    const rulePath = join(cwd, ".cursor", "rules", "resolve.mdc");
    planned.push({ path: rulePath, ...installOwned(readOrNull(rulePath), ruleSrc, force) });
  }
  const skillPath = join(base, ".claude", "skills", "resolve", "SKILL.md");
  planned.push(
    { path: skillPath, ...installOwned(readOrNull(skillPath), skillSrc, force) },
    { path: claudePath, ...installClaude(readOrNull(claudePath)) },
  );
  if (!dryRun) {
    for (const item of planned) {
      if (item.action === "skip" || item.action === "unchanged") continue;
      try {
        mkdirSync(dirname(item.path), { recursive: true });
        writeFileSync(item.path, item.text);
      } catch (error) {
        throw writeError(item.path, error);
      }
    }
  }
  return planned;
}

function figmaConnected(cwd, home) {
  if (process.env["FIGMA_ACCESS_TOKEN"]?.trim()) return true;
  const files = [join(cwd, ".cursor", "mcp.json"), join(home, ".cursor", "mcp.json"), join(cwd, ".mcp.json")];
  for (const file of files) {
    if (!existsSync(file)) continue;
    try {
      if (readFileSync(file, "utf8").toLowerCase().includes("figma")) return true;
    } catch {
      // Unreadable config is not a connection.
    }
  }
  return false;
}

function libraryLearned(cwd, home) {
  const pinned = process.env["GRAPHIFY_HOME"]?.trim();
  if (pinned && existsSync(join(pinned, "graph.json"))) return true;
  let dir = cwd;
  for (let hop = 0; hop < 6; hop += 1) {
    if (existsSync(join(dir, ".graphify", "graph.json"))) return true;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return existsSync(join(home, ".resolve", "default", "graph.json"));
}

/** Plain status after install. Not an MCP tool. */
export function doctorLines({ cwd, home, ruleInstalled, blocked }) {
  const nodeOk = !nodeVersionTooOld(process.version);
  const figma = figmaConnected(cwd, home);
  const library = libraryLearned(cwd, home);
  let next;
  if (!nodeOk) next = "Install Node 22.12 or newer, then run resolve-setup again.";
  else if (!ruleInstalled && blocked === "claude") next = "Fix the Resolve markers in CLAUDE.md, then run resolve-setup again.";
  else if (!ruleInstalled) next = "Re-run with --force to install the rule.";
  else if (!figma) next = "Connect Figma in the design app.";
  else if (!library) next = "Map the library: Figma get_metadata, then learn_library.";
  else next = "Ask Resolve for the screen.";
  return [
    `Node ok? ${nodeOk ? "yes" : "no"}`,
    `Figma connected? ${figma ? "yes" : "no"}`,
    `Library learned? ${library ? "yes" : "no"}`,
    `Rule installed? ${ruleInstalled ? "yes" : "no"}`,
    "Words your team uses: .graphify/synonyms.json",
    `Next: ${next}`,
  ].join("\n");
}

function main() {
  let dryRun = false;
  let isGlobal = false;
  let force = false;
  for (const arg of process.argv.slice(2)) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--global") isGlobal = true;
    else if (arg === "--force") force = true;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: resolve-setup [--dry-run] [--global] [--force]\nInstalls the Cursor rule, the Claude skill, and a marked CLAUDE.md block.\n--force replaces a file that has no Resolve markers.\n",
      );
      return;
    } else {
      process.stderr.write(`Unknown argument ${arg}. Use --dry-run, --global, and --force.\n`);
      process.exit(1);
    }
  }
  const cwd = process.cwd();
  const home = homedir();
  const target = isGlobal ? home : cwd;
  process.stdout.write(`Installing into ${target}\n`);
  let planned;
  try {
    planned = runSetup({ cwd, home, global: isGlobal, dryRun, force });
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const message = raw.includes("EISDIR")
      ? "Could not write the setup files. A path is a folder, or the write failed."
      : raw;
    process.stderr.write(`${message}\n`);
    process.stdout.write(`${doctorLines({ cwd, home, ruleInstalled: false })}\n`);
    process.exit(1);
  }
  let ruleSkipped = false;
  let claudeSkipped = false;
  for (const item of planned) {
    const note = item.note ?? (item.action === "skip" ? " (left existing file; no Resolve markers)" : "");
    process.stdout.write(`${item.action} ${item.path}${note}\n`);
    if (item.action === "skip" && item.path.endsWith(`${join(".cursor", "rules", "resolve.mdc")}`)) ruleSkipped = true;
    if (item.action === "skip" && item.path.endsWith(`${join("CLAUDE.md")}`)) claudeSkipped = true;
  }
  const skillInstalled = planned.some(
    (item) => item.path.endsWith(`${join("skills", "resolve", "SKILL.md")}`) && item.action !== "skip",
  );
  const ruleInstalled = (isGlobal ? skillInstalled : !ruleSkipped) && !claudeSkipped;
  const blocked = claudeSkipped ? "claude" : undefined;
  process.stdout.write(`${doctorLines({ cwd, home, ruleInstalled, blocked })}\n`);
  if (claudeSkipped) {
    process.stdout.write(
      "The Resolve block is NOT installed. CLAUDE.md has only one Resolve marker, so nothing was changed.\n",
    );
  }
  if (ruleSkipped) {
    process.stdout.write(
      "The Cursor rule is NOT installed. An existing file has no Resolve markers. Re-run with --force to replace it.\n",
    );
  }
  if (ruleSkipped || claudeSkipped) process.exit(1);
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
