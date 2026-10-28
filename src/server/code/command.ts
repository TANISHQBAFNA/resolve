import { existsSync, readFileSync } from "node:fs";
import { includesPack, readConfig } from "../mode.ts";
import type { CheckResult } from "./check.ts";
import { checkTool, codeConfig, mapTool, pickTool, scanTool } from "./mcp.ts";
import { writeMappings } from "./map.ts";
import { loadCatalog } from "./scan.ts";
import type { FigmaMaster } from "./scan.ts";
import { readRequests, repeatCheck } from "./repeat.ts";

export const CODE_USAGE = [
  "  resolve code scan [--repo <folder>] [--css <entry.css>] [--theme <file|name>] [--figma <masters.json>] [--list] [--json]",
  "      Learn the coded design system. Saves .resolve/code-catalog.json. Read-only on the repo.",
  '  resolve code pick "<what the screen needs>" [--limit <n>] [--json]',
  "      Real classes, variants, markup and rules for the matching components.",
  "  resolve code pick [\"<need>\"] [--file <requests.json>] [--repeat <n>] [--rescan] [--shuffle] [--json]",
  "      Repeat check: run the requests n times (--rescan rebuilds the catalog each time, --shuffle also reads files in another order)",
  "      and report whether top-1 and the ordered top-3 are identical. With expectations in the file it also reports accuracy.",
  "  resolve code check <file.html> [--json]",
  "      Unknown/deprecated classes, literal colours, unknown tokens, missing stylesheets. Exit 1 on errors.",
  "  resolve code map [--suggest] [--limit <n>] [--json]",
  "      How Figma and coded components join: pairs (mapped, exact, alias), unmatched on each side, and with --suggest likely pairs.",
  '  resolve code map --write "Figma name=code-name[,code-name]" ...',
  "      Append confirmed pairs to .resolve/mapping.json. Writes only what you name.",
  "  resolve mode",
  "      Which workflow is active (figma, code, both) and why.",
].join("\n");

const out = (line = "") => process.stdout.write(`${line}\n`);

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

/** Positional words: everything that is not a flag or a flag's value. */
function words(args: string[], valueFlags: string[]): string[] {
  return args.filter((arg, i) => !arg.startsWith("--") && !valueFlags.includes(args[i - 1] ?? ""));
}

function formatCheck(r: CheckResult): string[] {
  const lines = [`${r.file}: ${r.counts.error} errors, ${r.counts.warn} warnings, ${r.counts.info} info. ${r.classesChecked} classes checked, ${r.localClasses} project-local.`];
  const used = Object.entries(r.componentsUsed).sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (used.length) lines.push(`Components used: ${used.map(([n, c]) => `${n} ${c}`).join(", ")}`);
  for (const f of r.findings) lines.push(`  ${f.severity.toUpperCase().padEnd(5)} ${f.rule} L${f.line}${f.count && f.count > 1 ? ` x${f.count}` : ""}: ${f.message}${f.fix ? ` -> ${f.fix}` : ""}`);
  if (r.ok) lines.push("OK: no errors.");
  return lines;
}

export function runModeCommand(): void {
  const cfg = readConfig();
  const why = { env: "RESOLVE_MODE", config: cfg.configPath ?? "config", inferred: "inferred from repoPath", default: "default (no repoPath set)" }[cfg.modeSource];
  out(`mode: ${cfg.mode} (${why})`);
  out(`figma pack: ${includesPack(cfg.mode, "figma") ? "on" : "off"}   code pack: ${includesPack(cfg.mode, "code") ? "on" : "off"}`);
  if (cfg.repoPath) out(`repoPath: ${cfg.repoPath}`);
  if (cfg.cssEntry) out(`cssEntry: ${cfg.cssEntry}`);
  if (cfg.theme) out(`theme: ${cfg.theme}`);
  if (cfg.libraryFileKey) out(`libraryFileKey: ${cfg.libraryFileKey}`);
  if (cfg.problem) out(`problem: ${cfg.problem}`);
  out("Change it: set \"mode\" in .resolve/config.json or RESOLVE_MODE=figma|code|both.");
}

export function runCodeCommand(argv: string[], graph?: () => FigmaMaster[]): void {
  const [sub, ...rest] = argv;
  const json = rest.includes("--json");
  const base = readConfig();
  const repo = flag(rest, "--repo");
  const cfg = codeConfig({ repoPath: repo, cssEntry: flag(rest, "--css"), theme: flag(rest, "--theme") }, base);
  if (base.mode === "figma" && base.modeSource !== "default") throw new Error("Code workflow is off (mode: figma). Set mode to code or both in .resolve/config.json, or RESOLVE_MODE.");
  if (!sub || !["scan", "pick", "check", "map"].includes(sub)) {
    out(CODE_USAGE);
    if (sub) process.exitCode = 1;
    return;
  }
  if (sub === "scan") {
    const figmaFile = flag(rest, "--figma");
    let figma: unknown;
    if (figmaFile) {
      if (!existsSync(figmaFile)) throw new Error(`--figma file not found: ${figmaFile}`);
      figma = JSON.parse(readFileSync(figmaFile, "utf8"));
    }
    const result = scanTool(cfg, { ...(figma ? { figma } : {}), list: rest.includes("--list") }, graph);
    if (json) {
      out(JSON.stringify(result));
      return;
    }
    out(`${result.components} components (${result.blocks} blocks, ${result.recipes} recipes) from ${result.cssFiles} CSS files in ${result.repoPath}`);
    out(`${result.componentClasses} component classes, ${result.globalClasses} global classes, ${result.tokens} tokens (${result.colorTokens} colour)`);
    out(`deprecated: ${result.deprecated.length ? result.deprecated.join(" ") : "none"}`);
    if (result.withFigma) out(`linked to Figma: ${result.withFigma}${result.matchedBy ? ` (${Object.entries(result.matchedBy).map(([k, n]) => `${n} ${k}`).join(", ")})` : ""}`);
    for (const row of result.list ?? []) out(`  ${row.name} [${row.kind}] ${row.variants} variants`);
    out(`saved: ${result.saved}`);
    return;
  }
  if (sub === "map") {
    const pairs = words(rest, ["--repo", "--css", "--theme", "--limit"]).filter((w) => w.includes("="));
    if (rest.includes("--write")) {
      if (!pairs.length) throw new Error('Name the pairs to save, e.g. resolve code map --write "Status Pill=badge". Run resolve code map --suggest to see likely pairs.');
      const done = writeMappings(cfg, loadCatalog(cfg), pairs);
      out(json ? JSON.stringify(done) : `${done.added.length} pair(s) added to ${done.file}${done.skipped ? `, ${done.skipped} already there` : ""}.`);
      return;
    }
    const report = mapTool(cfg, { suggest: rest.includes("--suggest"), limit: Number(flag(rest, "--limit")) || 3 }, graph);
    if (json) return void out(JSON.stringify(report));
    out(`${report.figmaComponents} Figma components, ${report.codeComponents} coded components. Mapping file: ${report.mappingExists ? report.mappingFile : "none yet (" + report.mappingFile + ")"}`);
    for (const p of report.problems ?? []) out(`  PROBLEM ${p}`);
    for (const p of report.pairs) out(`  ${p.confidence.padEnd(9)} ${p.figma} -> ${p.code}${p.alias ? ` (alias "${p.alias}")` : ""}`);
    out(`Figma with no coded match: ${report.unmatchedFigma.join(", ") || "none"}`);
    out(`Coded with no Figma match: ${report.unmatchedCode.join(", ") || "none"}`);
    if (report.suggestions) {
      out(report.suggestions.length ? "Suggested (not joined; confirm with --write):" : "No suggestions.");
      for (const s of report.suggestions) out(`  suggested ${s.figma} -> ${s.code}  ${s.score}  ${s.reasons.join("; ")}`);
    }
    out(report.note);
    return;
  }
  if (sub === "pick") {
    const valueFlags = ["--limit", "--repo", "--css", "--theme", "--file", "--repeat"];
    const query = words(rest, valueFlags).join(" ");
    const file = flag(rest, "--file");
    const repeat = Number(flag(rest, "--repeat")) || 0;
    if (file || repeat || rest.includes("--rescan") || rest.includes("--shuffle")) {
      if (!file && !query) throw new Error('Usage: resolve code pick ["<need>"] [--file <requests.json>] --repeat <n>');
      const report = repeatCheck(cfg, file ? readRequests(file) : [{ request: query }], { runs: repeat || 1, rescan: rest.includes("--rescan"), shuffle: rest.includes("--shuffle") });
      if (json) return void out(JSON.stringify(report));
      out(`${report.requests} requests x ${report.runs} runs (${report.mode})`);
      out(`catalog identical across runs: ${report.catalogSame ? "yes" : "NO"} (${report.catalogDigests.join(", ")})`);
      out(`top-1 identical: ${report.top1Same}/${report.requests}   ordered top-3 identical: ${report.top3Same}/${report.requests}`);
      if (report.scored) out(`accuracy: top-1 ${report.top1Accuracy}/${report.scored}   top-3 ${report.top3Accuracy}/${report.scored}`);
      for (const row of report.rows) {
        if (row.top3Same && row.hit3 !== false && row.hit1 !== false) continue;
        out(`  ${row.hit3 === false ? "MISS" : row.hit1 === false ? "TOP3" : "UNSTABLE"} "${row.request}"${row.expect ? ` expected ${row.expect}` : ""} -> ${row.top3.join(", ") || "none"}${row.top3Same ? "" : " (varies between runs)"}`);
      }
      if (!report.catalogSame || report.top3Same < report.requests) process.exitCode = 1;
      return;
    }
    if (!query) throw new Error('Usage: resolve code pick "<what the screen needs>"');
    const limit = Number(flag(rest, "--limit")) || 5;
    const result = pickTool(cfg, query, limit);
    if (json) {
      out(JSON.stringify(result));
      return;
    }
    for (const c of result.components) {
      out(`${c.name} [${c.kind}] score ${c.score} — ${c.description}`);
      if (c.classes) {
        out(`  classes: ${c.classes.join(" ")}   css: ${c.css}`);
        out(`  modifiers: ${c.modifiers?.slice(0, 10).join(" ") || "none"}`);
        out(`  markup: ${(c.markup ?? "").replace(/\s+/g, " ")}`);
        if (c.avoid) out(`  avoid: ${c.avoid.join(" ")}`);
      }
      for (const rule of c.rules.slice(0, 3)) out(`  rule: ${rule}`);
    }
    out(("guidance" in result ? result.guidance : result.message) ?? "");
    return;
  }
  const file = words(rest, ["--repo", "--css", "--theme"])[0];
  if (!file) throw new Error("Usage: resolve code check <file.html>");
  const result: CheckResult = checkTool(cfg, file);
  if (json) out(JSON.stringify(result));
  else for (const line of formatCheck(result)) out(line);
  if (!result.ok) process.exitCode = 1;
}
