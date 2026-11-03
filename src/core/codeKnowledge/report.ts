import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { KnowledgeArgs } from "./args";
import { compareKnowledge } from "./compare";
import { knowledgeInstructions } from "./instructions";
import { evidenceWarnings } from "./readRepo";
import { parseDraft } from "./schemaCheck";
import type { Evidence, KnowledgeReport, KnowledgeWarning, ParsedComponent, ParsedRecipe, ScannerSnapshot } from "./types";

function empty(status: KnowledgeReport["status"], confirmed: boolean): KnowledgeReport {
  return { exitCode: 0, status, confirmed, warnings: [], pairs: [], agreements: [], disagreements: [], mapping: [] };
}

function flagWarnings(args: KnowledgeArgs): KnowledgeWarning[] {
  return [
    ...args.unknownFlags.map((flag) => ({ message: `unknown option ${flag}`, next: "use --repo, --ref, --usage, --who, --out, or --json" })),
    ...args.unknown.map((word) => ({ message: `unexpected argument ${word}`, next: "use resolve code knowledge, resolve code knowledge check <file>, or resolve code knowledge confirm --who <name>" })),
  ];
}

function readJson(path: string): { value?: unknown; problem?: string } {
  if (!existsSync(path)) return { problem: `no file at ${path}` };
  try {
    return { value: JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as unknown };
  } catch {
    return { problem: `${path} is not valid JSON` };
  }
}

function draftFile(repo: string | undefined, out: string | undefined): string | undefined {
  if (out) return resolve(out);
  return repo ? join(repo, ".resolve", "code-knowledge.json") : undefined;
}

function evidences(components: ParsedComponent[], recipes: ParsedRecipe[]): Evidence[] {
  const out: Evidence[] = [];
  const push = (item: Evidence | undefined) => {
    if (item) out.push(item);
  };
  for (const component of components) {
    push(component.evidence);
    for (const list of [component.props, component.variants, component.parts, component.slots, component.tokens, component.aliases]) {
      for (const item of list) push(item.evidence);
    }
  }
  for (const recipe of recipes) push(recipe.evidence);
  return out;
}

function writeDraft(path: string, body: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
}

/** Build the check or confirm report. Does not write the component map. That stays on the scanner review path. */
export function buildKnowledgeReport(args: KnowledgeArgs, repo: string | undefined, snapshot: ScannerSnapshot, scanProblem?: string, extra: KnowledgeWarning[] = []): KnowledgeReport {
  if (args.action === "guide" || args.action === "unknown") {
    const report = empty("none", false);
    report.instructions = knowledgeInstructions();
    report.warnings = flagWarnings(args);
    if (args.action === "unknown") {
      report.warnings.unshift({ message: "that is not a code knowledge command", next: "run resolve code knowledge to print the steps" });
    }
    return report;
  }
  if (args.action === "confirm") return confirmReport(args, repo);
  return checkReport(args, repo, snapshot, scanProblem, extra);
}

function checkReport(args: KnowledgeArgs, repo: string | undefined, snapshot: ScannerSnapshot, scanProblem?: string, extra: KnowledgeWarning[] = []): KnowledgeReport {
  const report = empty("proposed", false);
  report.warnings = [...flagWarnings(args), ...extra];
  if (!args.file) {
    report.warnings.push({ message: "no DSCK file was given", next: "pass the DSCK JSON path. Example: resolve code knowledge check dsck.json --repo <folder>" });
    return report;
  }
  const dsck = readJson(resolve(args.file));
  if (dsck.problem) {
    report.warnings.push({ message: dsck.problem, next: "pass the DSCK JSON path. Example: resolve code knowledge check dsck.json --repo <folder>" });
    return report;
  }
  let usage: unknown;
  if (args.usage) {
    const read = readJson(resolve(args.usage));
    if (read.problem) report.warnings.push({ message: read.problem, next: "pass a DSCI JSON path as --usage <file>, or leave --usage off" });
    else usage = read.value;
  }
  const parsed = parseDraft(dsck.value, usage);
  report.warnings.push(...parsed.warnings);
  if (scanProblem) report.warnings.push({ message: `the scanner could not read the repo (${scanProblem})`, next: "pass a folder of HTML, CSS, and JS. The scanner is unchanged" });
  report.warnings.push(...evidenceWarnings(repo, evidences(parsed.components, parsed.recipes)));
  const compared = compareKnowledge(parsed.components, parsed.recipes, snapshot, repo);
  report.pairs = compared.pairs;
  report.agreements = compared.agreements;
  report.disagreements = compared.disagreements;
  if (compared.disagreements.length) {
    const count = compared.disagreements.length;
    report.warnings.push({
      message: `AI and the scanner disagree on ${count} claim${count === 1 ? "" : "s"}`,
      next: "a person reviews the draft. Nothing was confirmed",
    });
  }
  report.mapping = parsed.components.flatMap((component) => {
    if (!component.figma) return [];
    const found = snapshot.components.find((item) => item.dsId === component.id) ?? snapshot.components.find((item) => item.name === component.name);
    return [{ figma: component.figma, code: found?.name ?? component.name, status: "proposed" as const, tier: "suggested" as const, reason: "AI draft" as const }];
  });
  const path = draftFile(repo, args.out);
  if (!path) {
    report.warnings.push({ message: "no draft file was written", next: "pass --repo <folder> or --out <file>. Nothing was confirmed" });
    return report;
  }
  writeDraft(path, {
    version: 1,
    source: "ai",
    status: "proposed",
    components: parsed.components,
    recipes: parsed.recipes,
    pairs: report.pairs,
    agreements: report.agreements,
    disagreements: report.disagreements,
    warnings: report.warnings,
    mapping: report.mapping,
  });
  report.status = "proposed";
  report.confirmed = false;
  report.draft = { file: path, status: "proposed" };
  return report;
}

function confirmReport(args: KnowledgeArgs, repo: string | undefined): KnowledgeReport {
  const report = empty("proposed", false);
  report.warnings = flagWarnings(args);
  const path = draftFile(repo, args.out);
  if (!path || !existsSync(path)) {
    report.warnings.push({ message: `no knowledge draft${path ? ` at ${path}` : ""}`, next: "run resolve code knowledge check <dsck.json> --repo <folder>" });
    report.status = "none";
    return report;
  }
  const who = args.who?.trim();
  if (!who) {
    report.warnings.push({ message: "confirm needs a person", next: "pass --who <name>. Nothing was confirmed" });
    report.draft = { file: path, status: "proposed" };
    return report;
  }
  const read = readJson(path);
  if (!read.value || typeof read.value !== "object" || Array.isArray(read.value)) {
    report.warnings.push({ message: `${path} is not a knowledge draft`, next: "run resolve code knowledge check again. Nothing was confirmed" });
    return report;
  }
  const at = new Date().toISOString();
  writeDraft(path, { ...read.value, version: 1, source: "ai", status: "confirmed", by: who, at });
  report.status = "confirmed";
  report.confirmed = true;
  report.draft = { file: path, status: "confirmed" };
  return report;
}

export function formatReport(report: KnowledgeReport): string {
  if (report.instructions && !report.warnings.length && report.status === "none") return report.instructions;
  const lines: string[] = [];
  if (report.instructions) lines.push(report.instructions.trimEnd());
  for (const warning of report.warnings) lines.push(`warning: ${warning.message} next: ${warning.next}`);
  for (const pair of report.pairs) lines.push(`pair ${pair.id} ${pair.field} ${pair.value} source ${pair.source}`);
  for (const row of report.agreements) lines.push(`agreement ${row.id} ${row.field} ${row.value}`);
  for (const row of report.disagreements) lines.push(`disagreement ${row.id} ${row.field} ${row.value} source ${row.source}`);
  if (report.draft?.status === "proposed") {
    lines.push(`Draft ${report.draft.file}: proposed. Nothing was confirmed.`);
    lines.push('next: a person confirms with resolve code knowledge confirm --who <name>. Mapping rows stay proposed until resolve code-map --confirm "Figma=code" --who <name>.');
  }
  if (report.draft?.status === "confirmed") lines.push(`Draft ${report.draft.file}: confirmed by the person named with --who. The scanner catalog was not changed.`);
  if (report.mappingFile) lines.push(`Mapping draft: ${report.mappingFile}: ${report.mappingProposed ?? 0} proposed. Nothing was confirmed.`);
  return `${lines.join("\n")}\n`;
}
