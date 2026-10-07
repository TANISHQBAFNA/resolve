import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { figmaAccessToken } from "@/core/ingestion/adapters/figmaRestSource";
import { codeMapCard } from "@/core/query";
import { listGraphs, loadFileGraph, loadGraph, readWorkspace, resolveGraph, storeRoot } from "./store";

const RULE_BEGIN = "<!-- resolve-setup:begin -->";
const RULE_END = "<!-- resolve-setup:end -->";

export interface StatusReport {
  store: string;
  files: Array<{ name: string; fileKey: string; role?: string; nodes: number; learnedAt?: string; version?: string }>;
  codeMap: { configured: boolean; components: number; mapped: number; retired: number; unmapped: number } | null;
  /** `set` means a token is present. Status does not call Figma, so it cannot see expiry. */
  token: "missing" | "set";
  rule: "installed" | "not installed";
  next: string;
}

function pairInstalled(text: string): boolean {
  const start = text.indexOf(RULE_BEGIN);
  const finish = text.indexOf(RULE_END);
  return start !== -1 && finish !== -1 && finish > start;
}

function ruleInstalled(): StatusReport["rule"] {
  let dir = process.cwd();
  for (let hop = 0; hop < 8; hop += 1) {
    const files = [join(dir, ".cursor", "rules", "resolve.mdc"), join(dir, "CLAUDE.md")];
    for (const path of files) {
      try {
        if (existsSync(path) && pairInstalled(readFileSync(path, "utf8"))) return "installed";
      } catch {
        // Unreadable is not installed.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "not installed";
}

function nextStep(files: number, rule: StatusReport["rule"]): string {
  if (!files) return "Run /design-system and paste the Figma link to your library.";
  if (rule === "not installed") return "Run resolve-setup in this project so the always-on rule is installed.";
  return "Use /find for a component, /check for a screen, or /handoff for the developer build sheet.";
}

/** Which files are learned, when, and how much of the library links to code. Read-only. */
export function statusReport(): StatusReport {
  const files: StatusReport["files"] = [];
  const workspace = readWorkspace();
  if (workspace.files.length) {
    for (const file of workspace.files) {
      const graph = loadFileGraph(file.key);
      files.push({
        name: graph?.fileName ?? file.label ?? file.key,
        fileKey: file.key,
        role: file.role,
        nodes: graph?.nodes.length ?? 0,
        ...(graph ? { learnedAt: graph.source.ingestedAt } : {}),
        ...(graph?.source.version ? { version: graph.source.version } : {}),
      });
    }
  } else {
    const loaded = loadGraph();
    if (loaded) {
      files.push({
        name: loaded.graph.fileName,
        fileKey: loaded.graph.fileKey,
        nodes: loaded.graph.nodes.length,
        learnedAt: loaded.graph.source.ingestedAt,
        ...(loaded.graph.source.version ? { version: loaded.graph.source.version } : {}),
      });
    }
  }
  const resolved = files.length || listGraphs().length ? resolveGraph() : undefined;
  const report = resolved ? codeMapCard(() => resolved.index) : undefined;
  const token = figmaAccessToken() ? "set" : "missing";
  const rule = ruleInstalled();
  return {
    store: storeRoot(),
    files,
    codeMap: report
      ? { configured: report.configured, components: report.counts.masters, mapped: report.counts.mapped, retired: report.counts.retired, unmapped: report.counts.unmapped }
      : null,
    token,
    rule,
    next: nextStep(files.length, rule),
  };
}

function localWhen(iso?: string): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return "unknown";
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  const zone =
    new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(date).find((part) => part.type === "timeZoneName")
      ?.value ?? "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())} ${zone}`.trim();
}

/** Figma's version is often a long internal number. Say that it is recorded, in plain words. */
function readableVersion(version?: string): string {
  if (!version) return "version not recorded";
  if (/^\d{11,}$/.test(version)) return "version recorded";
  return `version ${version}`;
}

export function formatStatus(report: StatusReport): string {
  const lines: string[] = [];
  if (!report.files.length) {
    lines.push(`Nothing is learned yet (store: ${report.store}). Learn a Figma file first: /design-system <Figma link>.`);
  } else {
    lines.push(`Resolve store: ${report.store}`, "", "Learned files:");
    for (const f of report.files) {
      lines.push(`- ${f.name} (${f.fileKey}): ${f.role === "library" ? "design system" : f.role ? `screens (${f.role})` : "learned"}, ${f.nodes} items, last learned ${localWhen(f.learnedAt)}, ${readableVersion(f.version)}`);
    }
  }
  const c = report.codeMap;
  lines.push(
    "",
    report.token === "set"
      ? "Figma token: set. A token adds exact component ids and REST learn. If Figma says it expired, sign in again in this app."
      : "Figma token: missing. A token adds exact component ids and REST learn. /design-system learns through Figma in this app and does not need one.",
    report.rule === "installed" ? "Always-on rule: installed." : "Always-on rule: not installed. Run resolve-setup in this project.",
    !c ? "Code map: none." : c.configured ? `Code map: ${c.mapped} of ${c.components} components link to code (${c.retired} retired, ${c.unmapped} unmapped).` : "Code map: none yet (resolve code-map --init writes a spreadsheet to fill).",
    `Next: ${report.next}`,
  );
  return lines.join("\n");
}
