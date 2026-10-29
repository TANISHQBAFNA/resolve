import { existsSync, readFileSync } from "node:fs";
import { actorName } from "@/core/query/bindRulesFit";
import { formatCodeMapReport } from "@/core/query/codeMap";
import { namespaceSet } from "@/core/rules/figmaNamespaces";
import { printJson } from "../cliArgs";
import { confirmComponentPairs, confirmEvidenceTier, proposalsFromReport, readComponentMap, writeDraft } from "../componentMap.ts";
import { deprecationNotice } from "../deprecations";
import { figmaTotalCheck } from "../mapPair.ts";
import { includesPack, readConfig, type ResolveConfig } from "../mode.ts";
import type { CheckResult } from "./check.ts";
import { attachImportReport, confirmBulk, mapReport, norm, writeMappings } from "./map.ts";
import { checkTool, codeConfig, mapTool, pickTool, scanTool } from "./mcp.ts";
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
  "  resolve code map   Deprecated spelling of resolve code-map. Alone, same report as code-map --pairs --unmatched. Prints one notice.",
  "  resolve mode",
  "      Which workflow is active (figma, code, both) and why.",
].join("\n");

const out = (line = "") => process.stdout.write(`${line}\n`);

const LINK_FLAGS = ["--pairs", "--unmatched", "--suggest", "--limit", "--write", "--draft", "--confirm", "--deny", "--confirm-evidence"];

/** Join view (`--pairs`, `--unmatched`, `--suggest`). A `scan` / `suggest` / `review` subcommand is not this view. */
export function isLinkMapRequest(args: string[]): boolean {
  if (args.some((arg) => arg === "scan" || arg === "suggest" || arg === "review")) return false;
  return LINK_FLAGS.some((name) => args.includes(name));
}

function linkSections(args: string[]) {
  const suggest = args.includes("--suggest");
  const pairs = args.includes("--pairs");
  const unmatched = args.includes("--unmatched");
  const asked = pairs || unmatched;
  return { suggest, pairs: suggest || pairs || !asked, unmatched: suggest || unmatched || !asked };
}

const pairWords = (args: string[]) => words(args, ["--repo", "--css", "--theme", "--limit", "--who"]).filter((word) => word.includes("="));
const sameName = (cfg: ResolveConfig) => (name: string) => norm(name, namespaceSet(cfg.figmaNamespaces));

/** Import map plus Figma-to-coded joins. No section flag prints pairs and unmatched. */
export function runLinkMap(args: string[], graph?: () => FigmaMaster[]): void {
  const json = args.includes("--json");
  const base = readConfig();
  const cfg = codeConfig({ repoPath: flag(args, "--repo"), cssEntry: flag(args, "--css"), theme: flag(args, "--theme") }, base);
  if (args.includes("--draft") && ["--write", "--confirm", "--deny", "--confirm-evidence"].some((name) => args.includes(name))) {
    throw new Error("Run code-map --draft on its own. Confirm afterwards.");
  }
  if (args.includes("--confirm-evidence") && ["--confirm", "--deny", "--write"].some((name) => args.includes(name))) {
    throw new Error("--confirm-evidence confirms every proposed evidence row. It does not take a pair.");
  }
  if (args.includes("--confirm") && args.includes("--deny")) throw new Error("Use either --confirm or --deny.");
  const who = actorName(flag(args, "--who"));
  const at = new Date().toISOString();
  const same = sameName(cfg);
  const opened = () => {
    const catalog = loadCatalog(cfg);
    const masters = graph?.() ?? catalog.figmaMasters ?? [];
    if (masters.length) catalog.figmaMasters = masters;
    return { catalog, masters };
  };
  if (args.includes("--draft")) {
    const { catalog, masters } = opened();
    const inferred = mapReport(catalog, cfg, { suggest: true, limit: Number(flag(args, "--limit")) || 25, masters, infer: true });
    const done = writeDraft(cfg, proposalsFromReport(inferred), same, masters);
    const message = `Wrote ${done.file}: ${done.proposed} proposed, ${done.kept} confirmed or denied left as they were. Nothing was marked confirmed.`;
    if (json) printJson({ ...done, message });
    else out(message);
    return;
  }
  if (args.includes("--confirm-evidence")) {
    const done = confirmEvidenceTier(cfg, who, at);
    if (json) printJson({ ...done, who, at });
    else out(`Confirmed ${done.confirmed} evidence proposal(s) in ${done.file}. ${done.left} proposed row(s) still waiting.`);
    return;
  }
  const named = pairWords(args);
  if (args.includes("--confirm") || args.includes("--deny")) {
    if (!named.length) throw new Error('Name one pair, e.g. resolve code-map --confirm "Button=button". --confirm-evidence confirms every evidence proposal.');
    const { catalog, masters } = opened();
    const action = args.includes("--deny") ? "deny" : "confirm";
    const done = confirmComponentPairs({ cfg, pairs: named, action, who, at, masters, components: catalog.components, same });
    if (json) printJson(done);
    else out(`${action === "deny" ? "Denied" : "Confirmed"} ${done.updated.length} pair(s) in ${done.file}${done.skipped ? `, ${done.skipped} unchanged` : ""}.`);
    return;
  }
  if (args.includes("--write")) {
    if (!named.length) throw new Error('Name the pairs to save, e.g. resolve code-map --write "Status Pill=badge". Run resolve code-map --suggest to see likely pairs.');
    if (readComponentMap(cfg).exists) {
      const { catalog, masters } = opened();
      const done = confirmComponentPairs({ cfg, pairs: named, action: "confirm", who, at, masters, components: catalog.components, same });
      if (json) printJson(done);
      else out(`Confirmed ${done.updated.length} pair(s) in ${done.file}${done.skipped ? `, ${done.skipped} unchanged` : ""}.`);
      return;
    }
    const catalog = loadCatalog(cfg);
    const done = named.length === 1 ? writeMappings(cfg, catalog, named) : confirmBulk(cfg, catalog, named);
    if (json) printJson(done);
    else out(`${done.added.length} pair(s) added to ${done.file}${done.skipped ? `, ${done.skipped} already there` : ""}.`);
    return;
  }
  const sections = linkSections(args);
  const report = attachImportReport(mapTool(cfg, { suggest: sections.suggest, limit: Number(flag(args, "--limit")) || 3 }, graph));
  if (json) {
    printJson(report);
    return;
  }
  const imports = report.imports;
  if (imports) {
    out("Import map:");
    out(formatCodeMapReport(imports));
  } else out("Import map: no learned library.");
  out(`${report.figmaComponents} Figma components (${figmaTotalCheck(report)}), ${report.codeComponents} coded components. Mapping file: ${report.mappingExists ? report.mappingFile : "none yet (" + report.mappingFile + ")"}`);
  for (const problem of report.problems ?? []) out(`  PROBLEM ${problem}`);
  if (sections.pairs) for (const pair of report.pairs) out(`  ${pair.confidence.padEnd(9)} ${pair.figma} -> ${pair.code}${pair.alias ? ` (alias "${pair.alias}")` : ""}${pair.source ? ` [${pair.source}]` : ""}${pair.parts?.length ? `  parts: ${pair.parts.join(", ")}` : ""}`);
  if (sections.unmatched) {
    out(`Figma with no coded match: ${report.unmatchedFigma.join(", ") || "none"}`);
    out(`Coded with no Figma match: ${report.unmatchedCode.join(", ") || "none"}`);
    for (const row of report.unpairedParts ?? []) out(`  ${row.code}: ${row.parts.join(", ")}`);
  }
  if (report.componentMapExists) {
    const figma = (report.unlinkedFigma ?? []).map((name) => `${name} (figma)`);
    const code = (report.unlinkedCode ?? []).map((name) => `${name} (code)`);
    out(`unlinked, please confirm: ${[...figma, ...code].join(", ") || "none"}`);
    for (const row of report.stale ?? []) out(`stale: ${row.figma} -> ${row.code} (${row.missing} missing)`);
    for (const row of report.conflicts ?? []) out(`conflict: ${row}`);
    for (const row of report.denies ?? []) out(`denied: ${row}`);
  }
  if (sections.suggest && report.suggestions) {
    out(report.suggestions.length ? "Suggested (not joined; confirm with code-map --write):" : "No suggestions.");
    for (const suggestion of report.suggestions) out(`  ${suggestion.confidence === "risky: same name only" ? suggestion.confidence : "suggested"} ${suggestion.figma} -> ${suggestion.code}  ${suggestion.score}  ${suggestion.reasons.join("; ")}`);
  }
  out(report.note);
  if (report.draftHint) out(report.draftHint);
}

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
  if (base.mode === "figma" && (base.modeSource !== "default" || sub === "scan" || sub === "pick" || sub === "check")) throw new Error(`Tool "${sub === "scan" ? "code_scan" : sub === "pick" ? "code_pick" : sub === "check" ? "code_check" : sub === "map" ? "code_map" : "code"}" is in the code workflow, which is off (mode: ${base.mode}). Set mode to code or both in .resolve/config.json, or RESOLVE_MODE.`);
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
    out(`${result.components} components (${result.blocks} blocks, ${result.recipes} recipes) from ${result.cssFiles} CSS files and ${result.htmlFiles} HTML files in ${result.repoPath}`);
    out(`${result.componentClasses} component classes, ${result.globalClasses} global classes, ${result.tokens} tokens (${result.colorTokens} colour)`);
    out(`deprecated: ${result.deprecated.length ? result.deprecated.join(" ") : "none"}`);
    if (result.withFigma) out(`linked to Figma: ${result.withFigma}${result.matchedBy ? ` (${Object.entries(result.matchedBy).map(([k, n]) => `${n} ${k}`).join(", ")})` : ""}`);
    for (const row of result.list ?? []) out(`  ${row.name} [${row.kind}] ${row.variants} variants`);
    out(`saved: ${result.saved}`);
    return;
  }
  if (sub === "map") {
    process.stderr.write(`${deprecationNotice("code map", "code-map")}\n`);
    runLinkMap(rest, graph);
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
