#!/usr/bin/env node
/**
 * Fresh-install kit (F4-R1). Makes a scratch project with its own HOME, installs Resolve there with
 * resolve-setup (so the project .mcp.json is the only MCP config), then runs each of the 8 slash
 * commands through `claude -p` and records pass, needs-Figma or fail. It calls Claude, so it is not
 * part of `npm test`. It never reads or writes the real ~/.claude*, ~/.cursor or MCP settings.
 *
 *   node scripts/fresh-install-kit.mjs [--package <npx spec>] [--library <file.json> [--file-key <key>]]
 *                                      [--screen <figma screen link>] [--out <dir>] [--dry-run]
 *
 * Claude Code needs a sign-in that works under the scratch HOME, for example CLAUDE_CODE_OAUTH_TOKEN
 * from `claude setup-token`. The kit passes the environment through and never prints it.
 * The installed commands and MCP entry name the package spec that setup writes, so the runtime they
 * reach is that spec (the repo's default branch), whatever --package installed the files.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The start of the designer messages (src/server/designerMessages.ts) the kit looks for. */
export const PHRASES = {
  notInstalled: "Resolve is not installed in this project",
  nothingLearned: "Resolve has not learned a design system yet",
  token: "Figma needs you to sign in again",
  viewSeat: "Figma refused this file",
};
const STACK = /^\s*at .+:\d+:\d+\)?$/m;
const BROKEN = /command not found|is not built|Cannot find module/i;

/** The 8 commands and their input. Screen commands get --screen; /design-system gets that file's link. */
export function commandPlan(screen) {
  const file = screen ? screen.replace(/[?#].*$/, "") : "";
  return [
    ["resolve-status", ""],
    ["design-system", file],
    ["find", "primary button"],
    ["brief", "a sign-in screen"],
    ["check", screen ?? ""],
    ["parts", screen ?? ""],
    ["handoff", screen ?? ""],
    ["code-map", "review"],
  ];
}

const textOf = (content) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n") : "";
const reachesResolve = (call) =>
  call.name.startsWith("mcp__resolve__") || (call.name === "Bash" && /resolve-(figma|setup)\b/.test(String(call.input?.command ?? "")));

/**
 * One verdict from a stream-json transcript. pass: a call reached Resolve (its bin or its MCP tools)
 * and came back with an answer. A refusal is an answer. Empty output, "command not found" or a stack
 * trace is not. needs-Figma: the answer is that Figma or a learned library is needed.
 */
export function classify(name, events) {
  const calls = new Map();
  let answered = false;
  let text = "";
  for (const event of events) {
    for (const block of event?.message?.content ?? []) {
      if (event.type === "assistant" && block.type === "tool_use") calls.set(block.id, block);
      if (event.type === "user" && block.type === "tool_result") {
        const call = calls.get(block.tool_use_id);
        const out = textOf(block.content).trim();
        if (call && reachesResolve(call) && out && !BROKEN.test(out) && !STACK.test(out)) answered = true;
      }
    }
    if (event?.type === "result") text = String(event.result ?? "");
  }
  if (text.includes(PHRASES.notInstalled)) return { verdict: "fail", why: "said Resolve is not installed" };
  if (STACK.test(text) || text.includes("node_modules/")) return { verdict: "fail", why: "showed a stack trace or a node_modules path" };
  if ([PHRASES.token, PHRASES.viewSeat, PHRASES.nothingLearned].some((phrase) => text.includes(phrase))) return { verdict: "needs-Figma", why: "asked for Figma or a learned library" };
  if (name === "design-system" && !answered) return { verdict: "needs-Figma", why: "learning needs Figma in this app" };
  if (answered) return { verdict: "pass", why: "Resolve answered" };
  return { verdict: "fail", why: "Resolve was not called, or it answered nothing" };
}

function parseArgs(argv) {
  const opt = { package: "github:TANISHQBAFNA/resolve#v0.1.0", dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") opt.dryRun = true;
    else if (["--package", "--library", "--file-key", "--screen", "--out"].includes(arg) && argv[i + 1]) opt[arg.slice(2).replace("-k", "K")] = argv[(i += 1)];
    else throw new Error(`Unknown or incomplete argument ${arg}. See the usage at the top of scripts/fresh-install-kit.mjs.`);
  }
  return opt;
}

function main(argv) {
  const opt = parseArgs(argv);
  const out = resolve(opt.out ?? mkdtempSync(join(tmpdir(), "resolve-kit-")));
  const home = join(out, "home");
  const project = join(out, "project");
  const env = { ...process.env, HOME: home, USERPROFILE: home, FIGMA_ACCESS_TOKEN: "", RESOLVE_LIBRARY_FILE_KEY: "" };
  const npx = ["npx", "-y", "-p", opt.package];
  const setup = [[...npx, "resolve-setup"]];
  if (opt.library) setup.push([...npx, "resolve-figma", "ingest", resolve(opt.library), "--role", "library", ...(opt.fileKey ? ["--file-key", opt.fileKey] : [])]);
  if (opt.dryRun) {
    for (const step of setup) process.stdout.write(`${step.join(" ")}\n`);
  } else {
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    for (const [command, ...args] of setup) {
      const run = spawnSync(command, args, { cwd: project, env, encoding: "utf8" });
      if (run.status !== 0) throw new Error(`${[command, ...args].join(" ")} failed: ${(run.stderr || run.stdout).trim().split("\n")[0]}`);
    }
  }
  const mcpConfig = join(project, ".mcp.json");
  const entry = existsSync(mcpConfig) ? JSON.parse(readFileSync(mcpConfig, "utf8")).mcpServers?.resolve : undefined;
  const spec = entry ? [entry.command, ...entry.args.slice(0, -1)].join(" ") : "npx -y -p github:TANISHQBAFNA/resolve#v0.1.0";
  const allowed = [`Bash(${spec} resolve-figma:*)`, `Bash(${spec} resolve-setup:*)`, "mcp__resolve"];
  const results = [];
  if (!opt.dryRun) mkdirSync(join(out, "transcripts"), { recursive: true });
  for (const [name, input] of commandPlan(opt.screen)) {
    const args = ["-p", `/${name}${input ? ` ${input}` : ""}`, "--output-format", "stream-json", "--verbose", "--mcp-config", mcpConfig, "--strict-mcp-config",
      "--setting-sources", "project", "--no-session-persistence", "--allowedTools", ...allowed];
    if (opt.dryRun) {
      process.stdout.write(`claude ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}\n`);
      continue;
    }
    const run = spawnSync("claude", args, { cwd: project, env, encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(join(out, "transcripts", `${name}.jsonl`), run.stdout ?? "");
    const events = (run.stdout ?? "").split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
    if (!events.some((event) => event.type === "result")) throw new Error(`claude -p did not finish /${name}: ${(run.stderr ?? "").trim().split("\n")[0] || `exit ${run.status}`}`);
    results.push({ command: name, input, ...classify(name, events) });
  }
  if (opt.dryRun) return 0;
  writeFileSync(join(out, "RESULT.json"), `${JSON.stringify({ package: opt.package, runtime: spec, results }, null, 2)}\n`);
  for (const r of results) process.stdout.write(`${r.verdict.padEnd(11)} /${r.command}  ${r.why}\n`);
  const passed = results.filter((r) => r.verdict === "pass").length;
  const figma = results.filter((r) => r.verdict === "needs-Figma").length;
  process.stdout.write(`${passed}/${results.length} pass, ${figma} needs-Figma. Transcripts and RESULT.json: ${out}\n`);
  return results.some((r) => r.verdict === "fail") ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
