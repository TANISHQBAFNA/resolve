import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseKnowledgeArgs } from "@/core/codeKnowledge/args";
import { buildKnowledgeReport, formatReport } from "@/core/codeKnowledge/report";
import type { MappingDraft, ScannerSnapshot } from "@/core/codeKnowledge/types";
import type { ResolveConfig } from "./mode.ts";
import { writeDraft } from "./componentMap.ts";
import { buildCatalog, type CodeCatalog } from "./code/scan.ts";

function scanConfig(repo: string, ref?: string): ResolveConfig {
  return { mode: "code", modeSource: "env", repoPath: repo, ...(ref ? { sourceRef: ref } : {}), localPrefixes: [], storeDir: join(repo, ".resolve") };
}

function snapshotOf(catalog: CodeCatalog): ScannerSnapshot {
  return {
    files: catalog.cssFiles,
    components: catalog.components.map((entry) => ({
      name: entry.name,
      kind: entry.kind,
      ...(entry.dsId ? { dsId: entry.dsId } : {}),
      variants: entry.variants,
      elements: entry.code?.elements ?? [],
      tokens: entry.code?.tokens ?? [],
      aliases: entry.aliases ?? [],
    })),
  };
}

function loadScanner(repo: string | undefined, ref?: string): { snapshot: ScannerSnapshot; root?: string; problem?: string; sourceWarnings: string[] } {
  const empty = { files: [], components: [] };
  if (!repo) return { snapshot: empty, sourceWarnings: [] };
  try {
    const catalog = buildCatalog(scanConfig(repo, ref));
    const root = catalog.repoPath && existsSync(catalog.repoPath) ? catalog.repoPath : undefined;
    return { snapshot: snapshotOf(catalog), ...(root ? { root } : {}), sourceWarnings: catalog.sourceWarnings ?? [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { snapshot: empty, sourceWarnings: [], problem: message.split("\n")[0] ?? "scanner failed" };
  }
}

function sourceWarning(line: string): { message: string; next: string } {
  const at = line.indexOf(" next: ");
  if (at < 0) return { message: line, next: "fix the source and run resolve code knowledge check again" };
  return { message: line.slice(0, at), next: line.slice(at + " next: ".length) };
}

function saveMapping(rows: MappingDraft[], repo: string | undefined): { file: string; proposed: number } | undefined {
  if (!rows.length || !repo) return undefined;
  const done = writeDraft(scanConfig(repo), rows, (name) => name.trim().toLowerCase());
  return { file: done.file, proposed: done.proposed };
}

/** `resolve code knowledge`. Warnings stay on stdout and the exit code stays 0. */
export function runCodeKnowledge(args: readonly string[]): void {
  const parsed = parseKnowledgeArgs(args);
  const given = parsed.repo ? resolve(parsed.repo) : undefined;
  const scanned = parsed.action === "check" ? loadScanner(parsed.repo, parsed.ref) : { snapshot: { files: [], components: [] }, sourceWarnings: [] as string[] };
  const repo = scanned.root ?? (given && existsSync(given) ? given : undefined);
  const report = buildKnowledgeReport(parsed, repo, scanned.snapshot, scanned.problem, (scanned.sourceWarnings ?? []).map(sourceWarning));
  if (parsed.action === "check" && report.mapping.length) {
    try {
      const saved = saveMapping(report.mapping, repo);
      if (saved) {
        report.mappingFile = saved.file;
        report.mappingProposed = saved.proposed;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.warnings.push({ message: `mapping draft was not written (${message.split("\n")[0] ?? "unreadable map"})`, next: "fix the component map and run resolve code knowledge check again. Nothing was confirmed" });
    }
  }
  process.stdout.write(parsed.json ? `${JSON.stringify(report)}\n` : formatReport(report));
  process.exitCode = 0;
}
