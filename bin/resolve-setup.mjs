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
 * Also the slash commands (commands/*.md): .claude/commands for Claude Code, .cursor/commands for Cursor.
 * Re-runs only change a complete marked block. --uninstall removes only what Resolve wrote. Does not read tokens or other secrets.
 */
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  "Map the file first. Set context before any component pick from the requirements or FSD: product, journey, audience, and a11y. The agent reads that document; Resolve does not. Do not ask for those four. Leave a field off when the document does not say it. Do not invent a product. A context pack is optional and matches only an exact product, and an exact journey when the document gives one. Then recipe, recommend, get_example, verify_frame, and check_cousins when a library and a product file are linked. Place only returned figmaNodeIds. An empty recommend means stop. Resolve is read-only.",
  "",
].join("\n");

function writeError(target, error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return new Error(`Could not write ${target}. Resolve needs permission to change that file.`);
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
  const edited = current.slice(start + BEGIN.length, end).trim() !== inner.trim();
  let text = current.slice(0, start) + `${BEGIN}${inner}${END}` + current.slice(end + END.length);
  const later = stripAllBlocks(text.slice(start + BEGIN.length + inner.length + END.length), BEGIN, END);
  if (later != null) text = text.slice(0, start + BEGIN.length + inner.length + END.length) + later;
  const extra = countPairs(current, BEGIN, END) > 1;
  const note = [
    edited ? " Replaced hand edits inside the Resolve markers." : "",
    extra ? " Removed an extra Resolve block." : "",
  ].join("");
  return { action: text === current ? "unchanged" : "update", text, ...(note ? { note } : {}) };
}

function useEnding(text, ending) {
  return ending === "\n" ? text : text.replace(/\n/g, ending);
}

/**
 * @param {string | null} current
 * @param {string} block
 * @param {string} begin
 * @param {string} end
 * @param {string} label
 * @returns {{ action: "create" | "update" | "unchanged" | "skip", text: string, note?: string }}
 */
function pairAt(text, begin, end, from = 0) {
  const start = text.indexOf(begin, from);
  if (start === -1) return null;
  const finish = text.indexOf(end, start + begin.length);
  if (finish === -1 || finish < start) return null;
  return { start, finish };
}

function countPairs(text, begin, end) {
  let n = 0;
  let i = 0;
  while (i < text.length) {
    const pair = pairAt(text, begin, end, i);
    if (!pair) break;
    n += 1;
    i = pair.finish + end.length;
  }
  return n;
}

/** Cut every complete marker pair. Bytes outside the pairs stay. Null when there is no complete pair. */
function stripAllBlocks(text, begin, end) {
  let out = "";
  let i = 0;
  let found = false;
  while (i < text.length) {
    const pair = pairAt(text, begin, end, i);
    if (!pair) {
      out += text.slice(i);
      break;
    }
    found = true;
    out += text.slice(i, pair.start);
    i = pair.finish + end.length;
    if (text.startsWith("\r\n", i)) i += 2;
    else if (text[i] === "\n") i += 1;
  }
  return found ? out : null;
}

export function installMarked(current, block, begin, end, label) {
  const ending = current != null && current.includes("\r\n") ? "\r\n" : "\n";
  const owned = useEnding(`${begin}\n${block.trim()}\n${end}`, ending);
  if (current == null) return { action: "create", text: `${owned}\n` };
  const start = current.indexOf(begin);
  const finish = current.indexOf(end);
  if ((start === -1) !== (finish === -1)) {
    return {
      action: "skip",
      text: current,
      note: ` (left ${label}; it has only one Resolve marker, so nothing was changed)`,
    };
  }
  if (start === -1) {
    const sep = current.endsWith(ending + ending) ? "" : current.endsWith(ending) ? ending : ending + ending;
    return { action: "update", text: `${current}${sep}${owned}${ending}` };
  }
  const inner = current.slice(start + begin.length, finish);
  const edited = inner.trim() !== block.trim();
  const head = `${current.slice(0, start)}${owned}`;
  const tail = stripAllBlocks(current.slice(finish + end.length), begin, end);
  const text = head + (tail ?? current.slice(finish + end.length));
  const note = [
    edited ? ` Replaced hand edits inside the Resolve markers in ${label}.` : "",
    countPairs(current, begin, end) > 1 ? ` Removed an extra Resolve block in ${label}.` : "",
  ].join("");
  return { action: text === current ? "unchanged" : "update", text, ...(note ? { note } : {}) };
}

/** @returns {{ action: "create" | "update" | "unchanged" | "skip", text: string, note?: string }} */
export function installClaude(current, block = CLAUDE_BLOCK) {
  return installMarked(current, block, BEGIN, END, "CLAUDE.md");
}

/** Learned cache only. Team files in .resolve/ stay committable. */
export const GIT_BEGIN = "# resolve-setup:begin";
export const GIT_END = "# resolve-setup:end";
/** Rebuildable cache. These are the only .resolve paths the block ignores. */
export const GIT_CACHE = [
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
  ".resolve/setup-record.json",
];
/** Team knowledge. Never an ignore path. */
export const GIT_TEAM = [
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
export const GIT_BLOCK = [
  `# Learned cache. Rebuild it with /design-system. Commit team files in .resolve/: ${GIT_TEAM.join(", ")}. sock.json holds decisions. Also commit scoreboard/phrases/ and scoreboard/golden/ (team phrase sets and the golden file from score --init). Run history under scoreboard/ stays ignored.`,
  ...GIT_CACHE,
].join("\n");

/** Lines that ignore the whole store, including globs. Our own cache paths inside the marker block do not count. */
const WHOLE_STORE = new Set([
  ".resolve",
  ".resolve/",
  ".resolve/*",
  ".resolve/**",
  ".resolve/**/*",
  "**/.resolve",
  "**/.resolve/**",
  "*/.resolve",
  "*/.resolve/**",
]);

/** @param {string} text */
export function ignoresWholeResolveStore(text) {
  const start = text.indexOf(GIT_BEGIN);
  const finish = text.indexOf(GIT_END);
  const outside = start === -1 || finish === -1 || finish < start ? text : text.slice(0, start) + text.slice(finish + GIT_END.length);
  return outside.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) return false;
    return WHOLE_STORE.has(trimmed);
  });
}

/** The one server entry Resolve adds. Same command everywhere (Cursor, Claude Code, Codex). */
export const MCP_ENTRY = { command: "npx", args: ["-y", "-p", "github:TANISHQBAFNA/resolve", "resolve-mcp"] };

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameEntry(entry) {
  return isPlainObject(entry) && entry.command === MCP_ENTRY.command && JSON.stringify(entry.args) === JSON.stringify(MCP_ENTRY.args);
}

/**
 * Add the "resolve" server to a project MCP file (.cursor/mcp.json or .mcp.json).
 * Keeps every other key and server. Never replaces a different "resolve" entry unless forced.
 * Backs off (skip) when the file is not a JSON object we can safely edit.
 * @returns {{ action: "create" | "update" | "unchanged" | "skip", text: string, note?: string }}
 */
export function installMcp(current, { claude = false, force = false } = {}) {
  const entry = claude ? { type: "stdio", ...MCP_ENTRY, env: {} } : { ...MCP_ENTRY };
  const blank = current == null || current.trim() === "";
  let doc = {};
  let indent = 2;
  let ending = "\n";
  if (!blank) {
    const raw = current.replace(/^\uFEFF/, "");
    try {
      doc = JSON.parse(raw);
    } catch {
      return { action: "skip", text: current, note: " (left alone: it is not valid JSON, so Resolve did not touch it)" };
    }
    if (!isPlainObject(doc) || (doc.mcpServers !== undefined && !isPlainObject(doc.mcpServers))) {
      return { action: "skip", text: current, note: " (left alone: it does not have the usual mcpServers shape)" };
    }
    indent = /^\t/m.test(raw) ? "\t" : (raw.match(/^( +)"/m)?.[1].length ?? 2);
    ending = raw.includes("\r\n") ? "\r\n" : "\n";
  }
  const servers = doc.mcpServers ?? {};
  if (servers.resolve !== undefined) {
    if (sameEntry(servers.resolve)) return { action: "unchanged", text: current };
    if (!force) {
      return { action: "skip", text: current, note: " (left alone: it already has a different resolve entry; --force replaces only that entry)" };
    }
  }
  const next = { ...doc, mcpServers: { ...servers, resolve: entry } };
  const text = useEnding(`${JSON.stringify(next, null, indent)}\n`, ending);
  return { action: blank ? "create" : "update", text };
}

/** Slash commands shipped in the package: [{ name, text }] from commands/*.md (front matter + body with $ARGUMENTS). */
export function shippedCommands(root = packageRoot) {
  const dir = join(root, "commands");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => ({ name: file.replace(/\.md$/, ""), text: readFileSync(join(dir, file), "utf8") }));
}

/** Cursor commands are plain markdown with no front matter; the designer's words follow the command. */
export function cursorCommand(text) {
  const { body } = splitFrontmatter(text);
  return `${body.replace(/\$ARGUMENTS/g, "the words the designer typed after the command")}\n`;
}

const RECORD_NAME = "setup-record.json";

function recordPath(opts) {
  return opts.global ? join(opts.home, ".resolve", RECORD_NAME) : join(opts.cwd, ".resolve", RECORD_NAME);
}

function emptyRecord() {
  return { created: [], originals: {}, createdDirs: [] };
}

function isMcpConfig(path) {
  const base = path.split(/[/\\]/).pop();
  return base === "mcp.json" || base === ".mcp.json";
}

function loadRecord(opts) {
  try {
    const raw = JSON.parse(readFileSync(recordPath(opts), "utf8"));
    const originals = raw.originals && typeof raw.originals === "object" ? { ...raw.originals } : {};
    for (const key of Object.keys(originals)) {
      if (isMcpConfig(key)) delete originals[key];
    }
    return {
      created: Array.isArray(raw.created) ? raw.created : [],
      originals,
      createdDirs: Array.isArray(raw.createdDirs) ? raw.createdDirs : [],
    };
  } catch {
    return emptyRecord();
  }
}

function saveRecord(opts, record) {
  const path = recordPath(opts);
  const dir = dirname(path);
  const dirExisted = existsSync(dir);
  mkdirSync(dir, { recursive: true });
  if (!dirExisted && !record.createdDirs.includes(dir)) record.createdDirs.push(dir);
  writeFileSync(path, `${JSON.stringify(record)}\n`);
}

/** True when current is the saved original plus only Resolve marker blocks. */
function onlyBlockAdded(current, original, begin, end) {
  if (typeof original !== "string" || !current.startsWith(original)) return false;
  const extra = stripAllBlocks(current.slice(original.length), begin, end);
  return extra != null && extra.trim() === "";
}

function assertCanWrite(target) {
  try {
    if (existsSync(target)) {
      accessSync(target, constants.W_OK);
      return;
    }
    let dir = dirname(target);
    while (!existsSync(dir)) {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    accessSync(dir, constants.W_OK);
  } catch {
    throw new Error(`Could not write ${target}. Resolve needs permission to change that file.`);
  }
}

const onlyFrontmatter = (text) => splitFrontmatter(text).body === "" && (text.trim() === "" || text.startsWith("---"));

/**
 * Remove what setup wrote: marked blocks (and the file when nothing else is left in it), and the resolve entry of the
 * project MCP files when it is exactly ours. Files without Resolve markers are never touched.
 * @returns {Array<{ action: "remove" | "update" | "skip", path: string, text?: string, note?: string }>}
 */
export function planUninstall({ cwd, home, global: isGlobal, root = packageRoot }) {
  const base = isGlobal ? home : cwd;
  const opts = { cwd, home, global: isGlobal };
  const record = loadRecord(opts);
  const names = shippedCommands(root).map((c) => c.name);
  const owned = [
    ...(isGlobal ? [] : [join(cwd, ".cursor", "rules", "resolve.mdc")]),
    join(base, ".claude", "skills", "resolve", "SKILL.md"),
    ...names.map((n) => join(base, ".claude", "commands", `${n}.md`)),
    ...(isGlobal ? [] : names.map((n) => join(cwd, ".cursor", "commands", `${n}.md`))),
    isGlobal ? join(home, ".claude", "CLAUDE.md") : join(cwd, "CLAUDE.md"),
    ...(isGlobal ? [] : [join(cwd, ".gitignore")]),
  ];
  const plan = [];
  for (const path of owned) {
    const current = readOrNull(path);
    if (current == null) continue;
    const git = path.endsWith(".gitignore");
    const begin = git ? GIT_BEGIN : BEGIN;
    const end = git ? GIT_END : END;
    const rest = stripAllBlocks(current, begin, end);
    const created = record.created.includes(path);
    const original = record.originals[path];
    if (rest == null) {
      plan.push({ action: "skip", path, note: " (not written by Resolve, kept)" });
    } else if (typeof original === "string" && onlyBlockAdded(current, original, begin, end)) {
      plan.push({ action: "update", path, text: original });
    } else if ((rest.trim() === "" || onlyFrontmatter(rest)) && created) {
      plan.push({ action: "remove", path });
    } else if (rest.trim() === "" || onlyFrontmatter(rest)) {
      plan.push({ action: "skip", path, note: " (kept; Resolve did not create this file)" });
    } else plan.push({ action: "update", path, text: rest });
  }
  if (!isGlobal) {
    for (const path of [join(cwd, ".cursor", "mcp.json"), join(cwd, ".mcp.json")]) {
      const current = readOrNull(path);
      if (current == null) continue;
      let doc;
      try {
        doc = JSON.parse(current.replace(/^\uFEFF/, ""));
      } catch {
        continue;
      }
      if (!isPlainObject(doc) || !isPlainObject(doc.mcpServers) || !sameEntry(doc.mcpServers.resolve)) continue;
      const { resolve: _gone, ...others } = doc.mcpServers;
      const created = record.created.includes(path);
      const original = record.originals[path];
      let sameOthers = false;
      if (typeof original === "string") {
        try {
          const orig = JSON.parse(original);
          const origServers = { ...(isPlainObject(orig.mcpServers) ? orig.mcpServers : {}) };
          delete origServers.resolve;
          sameOthers = JSON.stringify(others) === JSON.stringify(origServers);
        } catch {
          sameOthers = false;
        }
      }
      const empty = Object.keys(others).length === 0 && Object.keys(doc).length === 1;
      if (typeof original === "string" && sameOthers) plan.push({ action: "update", path, text: original });
      else if (empty && created) plan.push({ action: "remove", path });
      else {
        const indent = /^\t/m.test(current) ? "\t" : (current.match(/^( +)"/m)?.[1].length ?? 2);
        const ending = current.includes("\r\n") ? "\r\n" : "\n";
        plan.push({ action: "update", path, text: useEnding(`${JSON.stringify({ ...doc, mcpServers: others }, null, indent)}\n`, ending) });
      }
    }
  }
  return plan;
}

function removeEmptyDirs(dirs) {
  const ordered = [...dirs].sort((a, b) => b.length - a.length);
  for (const dir of ordered) {
    try {
      if (!existsSync(dir)) continue;
      if (readdirSync(dir).length === 0) rmdirSync(dir);
    } catch {
      // A folder that is not empty, or not ours to remove, stays.
    }
  }
}

export function runUninstall(opts) {
  const plan = planUninstall(opts);
  if (!opts.dryRun) {
    for (const item of plan) {
      if (item.action === "skip") continue;
      assertCanWrite(item.path);
    }
    for (const item of plan) {
      try {
        if (item.action === "remove") rmSync(item.path);
        else if (item.action === "update") writeFileSync(item.path, item.text);
      } catch (error) {
        throw writeError(item.path, error);
      }
    }
    const record = loadRecord(opts);
    const rec = recordPath(opts);
    if (existsSync(rec)) rmSync(rec);
    removeEmptyDirs(record.createdDirs);
  }
  return plan;
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
  // Project files only. User-level files (~/.claude.json, ~/.cursor, ~/.codex) are never written.
  if (!isGlobal) {
    const cursorMcp = join(cwd, ".cursor", "mcp.json");
    const claudeMcp = join(cwd, ".mcp.json");
    planned.push(
      { path: cursorMcp, ...installMcp(readOrNull(cursorMcp), { force }) },
      { path: claudeMcp, ...installMcp(readOrNull(claudeMcp), { claude: true, force }) },
    );
  }
  // Slash commands. A command file you wrote yourself (no Resolve markers) is kept unless --force.
  for (const command of shippedCommands(root)) {
    const claudeCommand = join(base, ".claude", "commands", `${command.name}.md`);
    planned.push({ path: claudeCommand, command: true, ...installOwned(readOrNull(claudeCommand), command.text, force) });
    if (!isGlobal) {
      const cursorPath = join(cwd, ".cursor", "commands", `${command.name}.md`);
      planned.push({ path: cursorPath, command: true, ...installOwned(readOrNull(cursorPath), cursorCommand(command.text), force) });
    }
  }
  const skillPath = join(base, ".claude", "skills", "resolve", "SKILL.md");
  planned.push(
    { path: skillPath, ...installOwned(readOrNull(skillPath), skillSrc, force) },
    { path: claudePath, ...installClaude(readOrNull(claudePath)) },
  );
  if (!isGlobal) {
    const gitPath = join(cwd, ".gitignore");
    const gitCurrent = readOrNull(gitPath);
    const gitItem = { path: gitPath, ...installMarked(gitCurrent, GIT_BLOCK, GIT_BEGIN, GIT_END, ".gitignore") };
    if (ignoresWholeResolveStore(gitItem.text) && !gitItem.note) {
      gitItem.note = " (your .gitignore also ignores the whole .resolve folder, so recipes and the code map stay uncommitted until that line is removed)";
    }
    planned.push(gitItem);
  }
  if (!dryRun) {
    for (const item of planned) {
      if (item.action === "skip" || item.action === "unchanged") continue;
      assertCanWrite(item.path);
    }
    const opts = { cwd, home, global: isGlobal };
    const record = loadRecord(opts);
    for (const item of planned) {
      if (item.action === "skip" || item.action === "unchanged") continue;
      try {
        const dir = dirname(item.path);
        let walk = dir;
        const missing = [];
        while (!existsSync(walk)) {
          missing.push(walk);
          const parent = dirname(walk);
          if (parent === walk) break;
          walk = parent;
        }
        mkdirSync(dir, { recursive: true });
        for (const made of missing) {
          if (!record.createdDirs.includes(made)) record.createdDirs.push(made);
        }
        if (item.action === "create" && !record.created.includes(item.path)) record.created.push(item.path);
        if (item.action === "update" && record.originals[item.path] === undefined && !isMcpConfig(item.path)) {
          const prior = readOrNull(item.path);
          if (prior != null) record.originals[item.path] = prior;
        }
        writeFileSync(item.path, item.text);
      } catch (error) {
        throw writeError(item.path, error);
      }
    }
    saveRecord(opts, record);
  }
  return planned;
}

/** Read-only. Looks only at server names, urls and commands in ~/.claude.json. Never prints or returns its contents. */
function claudeUserFigma(cwd, home) {
  const file = join(home, ".claude.json");
  try {
    if (!existsSync(file) || statSync(file).size > 50_000_000) return false;
    const doc = JSON.parse(readFileSync(file, "utf8"));
    const hasFigma = (servers) =>
      isPlainObject(servers) &&
      Object.entries(servers).some(([name, server]) =>
        /figma/i.test(name) || (isPlainObject(server) && /figma/i.test(JSON.stringify([server.url, server.command, server.args]))),
      );
    if (hasFigma(doc.mcpServers)) return true;
    // Claude Code's "local" scope is stored per project folder.
    for (let dir = cwd, hop = 0; hop < 12; hop += 1) {
      if (hasFigma(doc.projects?.[dir]?.mcpServers)) return true;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Unreadable or odd file is not a connection.
  }
  return false;
}

function figmaConnected(cwd, home) {
  if (process.env["FIGMA_ACCESS_TOKEN"]?.trim()) return true;
  if (claudeUserFigma(cwd, home)) return true;
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
  const pinned = process.env["RESOLVE_HOME"]?.trim() || process.env["GRAPHIFY_HOME"]?.trim();
  if (pinned && existsSync(join(pinned, "graph.json"))) return true;
  let dir = cwd;
  for (let hop = 0; hop < 6; hop += 1) {
    // ".graphify" is the old folder name; still read.
    if ([".resolve", ".graphify"].some((folder) => existsSync(join(dir, folder, "graph.json")))) return true;
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
    "Words your team uses: .resolve/synonyms.json · icon libraries: .resolve/icon-libraries.json",
    "Exact component ids: Figma access token (FIGMA_ACCESS_TOKEN) or get_design_context. Never store a token in the repo.",
    `Next: ${next}`,
  ].join("\n");
}

function main() {
  let dryRun = false;
  let isGlobal = false;
  let force = false;
  let yes = false;
  let uninstall = false;
  for (const arg of process.argv.slice(2)) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--global") isGlobal = true;
    else if (arg === "--force") force = true;
    else if (arg === "--yes" || arg === "-y") yes = true;
    else if (arg === "--uninstall") uninstall = true;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: resolve-setup [--dry-run] [--global] [--yes] [--force] [--uninstall]\nInstalls the Cursor rule, the Claude skill, a marked CLAUDE.md block, the slash commands (.claude/commands and .cursor/commands: /design-system /find /check /parts /handoff /resolve-status), and adds the Resolve server to this project's .cursor/mcp.json and .mcp.json (other servers are kept; a file that is not valid JSON is left alone).\n--global writes into the home folder (~/.claude). It prints the paths and exits unless you pass --yes. It does not write MCP files.\n--force replaces a file that has no Resolve markers, or a different resolve entry in an MCP file.\nIt never writes ~/.claude.json, ~/.cursor or ~/.codex.\nRun it again to update: only files and blocks Resolve wrote are rewritten. A command or rule file you wrote yourself is kept.\n--uninstall removes only what Resolve wrote (its marked blocks and files, and its own resolve entry in the MCP files). Your own files and text stay.\n",
      );
      return;
    } else {
      process.stderr.write(`Unknown argument ${arg}. Use --dry-run, --global, --yes, --force, and --uninstall.\n`);
      process.exit(1);
    }
  }
  const cwd = process.cwd();
  const home = homedir();
  const target = isGlobal ? home : cwd;
  if (uninstall) {
    if (isGlobal && !dryRun && !yes) {
      process.stdout.write(`This removes Resolve files from the home folder (${home}). Re-run with --global --uninstall --yes to confirm.\n`);
      for (const item of runUninstall({ cwd, home, global: true, dryRun: true })) process.stdout.write(`  ${item.action} ${item.path}\n`);
      process.exit(1);
    }
    process.stdout.write(`Removing Resolve from ${target}\n`);
    let plan;
    try {
      plan = runUninstall({ cwd, home, global: isGlobal, dryRun });
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
    for (const item of plan) process.stdout.write(`${item.action} ${item.path}${item.note ?? ""}\n`);
    if (!plan.length) process.stdout.write("Nothing from Resolve was found.\n");
    return;
  }
  if (isGlobal && !dryRun && !yes) {
    process.stdout.write(
      `This writes into the home folder (${home}), not this project.\nPaths:\n`,
    );
    let planned;
    try {
      planned = runSetup({ cwd, home, global: true, dryRun: true, force });
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${raw}\n`);
      process.exit(1);
    }
    for (const item of planned) {
      process.stdout.write(`  ${item.action} ${item.path}\n`);
    }
    process.stdout.write("Re-run with --global --yes to confirm.\n");
    process.exit(1);
  }
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
  const mcpSkipped = [];
  for (const item of planned) {
    const note = item.note ?? (item.action === "skip" ? (item.command ? " (kept your own file; Resolve did not write this command. --force replaces it)" : " (left existing file; no Resolve markers)") : "");
    process.stdout.write(`${item.action} ${item.path}${note}\n`);
    if (item.action === "skip" && item.path.endsWith(`${join(".cursor", "rules", "resolve.mdc")}`)) ruleSkipped = true;
    if (item.action === "skip" && item.path.endsWith(`${join("CLAUDE.md")}`)) claudeSkipped = true;
    if (item.action === "skip" && item.path.endsWith("mcp.json")) mcpSkipped.push(item.path);
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
  for (const path of mcpSkipped) {
    process.stdout.write(`The Resolve connection was NOT added to ${path}. Fix or move that file, then run resolve-setup again, or add the resolve entry by hand (see the README).\n`);
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
