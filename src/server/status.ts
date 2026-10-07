import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { figmaAccessToken } from "@/core/ingestion/adapters/figmaRestSource";
import { codeMapCard } from "@/core/query";
import { listGraphs, loadFileGraph, loadGraph, readWorkspace, resolveGraph, storeRoot } from "./store";

const RULE_MARKER = "<!-- resolve-setup:begin -->";

export interface StatusReport {
  store: string;
  files: Array<{ name: string; fileKey: string; role?: string; nodes: number; learnedAt?: string; version?: string }>;
  codeMap: { configured: boolean; components: number; mapped: number; retired: number; unmapped: number } | null;
  /** `set` means a token is present. Status does not call Figma, so it cannot see expiry. */
  token: "missing" | "set";
  rule: "installed" | "not installed";
  next: string;
}

function ruleInstalled(): StatusReport["rule"] {
  const files = [join(process.cwd(), ".cursor", "rules", "resolve.mdc"), join(process.cwd(), "CLAUDE.md")];
  for (const path of files) {
    try {
      if (existsSync(path) && readFileSync(path, "utf8").includes(RULE_MARKER)) return "installed";
    } catch {
      // Unreadable is not installed.
    }
  }
  return "not installed";
}

function nextStep(files: number, token: StatusReport["token"], rule: StatusReport["rule"]): string {
  if (!files) return "Run /design-system and paste the Figma link to your library.";
  if (rule === "not installed") return "Run resolve-setup in this project so the always-on rule is installed.";
  if (token === "missing") return "Connect Figma in this app so the next learn can read the file.";
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
    next: nextStep(files.length, token, rule),
  };
}

export function formatStatus(report: StatusReport): string {
  const when = (iso?: string) => (iso && !Number.isNaN(Date.parse(iso)) ? iso.slice(0, 16).replace("T", " ") + " UTC" : "unknown");
  const lines: string[] = [];
  if (!report.files.length) {
    lines.push(`Nothing is learned yet (store: ${report.store}). Learn a Figma file first: /design-system <Figma link>.`);
  } else {
    lines.push(`Resolve store: ${report.store}`, "", "Learned files:");
    for (const f of report.files) {
      const version = f.version ? `version ${f.version}` : "version not recorded";
      lines.push(`- ${f.name} (${f.fileKey}): ${f.role === "library" ? "design system" : f.role ? `screens (${f.role})` : "learned"}, ${f.nodes} nodes, last learned ${when(f.learnedAt)}, ${version}`);
    }
  }
  const c = report.codeMap;
  lines.push(
    "",
    report.token === "set"
      ? "Figma token: set. If Figma says it expired, sign in again in this app."
      : "Figma token: missing. Connect Figma in this app, then run /design-system.",
    report.rule === "installed" ? "Always-on rule: installed." : "Always-on rule: not installed. Run resolve-setup in this project.",
    !c ? "Code map: none." : c.configured ? `Code map: ${c.mapped} of ${c.components} components link to code (${c.retired} retired, ${c.unmapped} unmapped).` : "Code map: none yet (resolve code-map --init writes a spreadsheet to fill).",
    `Next: ${report.next}`,
  );
  return lines.join("\n");
}
