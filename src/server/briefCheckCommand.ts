import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { BRIEF_EXIT, checkBrief, checkHandoffPack, inventoryTable, type BriefReport } from "@/core/query/designBrief";
import { printJson, strictExit } from "./cliArgs";

export const BRIEF_CHECK_USAGE = 'Usage: resolve brief check <brief.md | handoff-folder> [--suggest] [--json]';

/** What `--suggest` returns: the same rows `resolve spec` gives, as data and as the text card. */
export interface BriefSuggestion {
  json: unknown;
  text: string;
}

const ADVISORY = "Advisory only. Resolve's guess at components for the screen rows. It never changes pass or fail. A no-match row is a likely new component.";

function readInput(target: string): BriefReport & { markdown?: string } {
  const path = resolve(target);
  if (!existsSync(path)) throw new Error(`No brief or handoff folder at ${target}.`);
  if (statSync(path).isDirectory()) {
    const file = join(path, "handoff.json");
    if (!existsSync(file)) throw new Error(`No handoff.json in ${path}. Pass a brief file, or the folder resolve handoff --out wrote.`);
    let pack: unknown;
    try {
      pack = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
    } catch {
      throw new Error(`handoff.json in ${path} is not JSON.`);
    }
    return checkHandoffPack(pack);
  }
  const markdown = readFileSync(path, "utf8");
  return { ...checkBrief(markdown), markdown };
}

function formatReport(report: BriefReport, target: string): string {
  const out = [report.ok ? `Brief check: PASS (${report.input}) ${target}` : `Brief check: FAIL (${report.input}) ${target}, findings do not stop Resolve (--strict exits ${report.exitCode})`];
  if (report.note) out.push(report.note);
  for (const issue of report.issues) out.push(`- [${issue.type}] ${issue.where}: ${issue.message}${issue.next ? ` next: ${issue.next}` : ""}`);
  return `${out.join("\n")}\n`;
}

/**
 * resolve brief check. Exit 0 pass; 1 unreadable input; 2 frontmatter; 3 screens; 4 fields; 5 questions; 6 draft status; 7 handoff.
 * `suggest` is passed in by the CLI so this file never needs a learned library. Its result and any failure
 * of it are advisory: neither can change the exit code.
 */
export function runBriefCheck(args: string[], suggest: (table: string) => BriefSuggestion): void {
  const target = args.find((arg) => !arg.startsWith("--"));
  if (!target) throw new Error(BRIEF_CHECK_USAGE);
  const json = args.includes("--json");
  const { markdown, ...report } = readInput(target);

  let advisory: { json?: unknown; text: string } | undefined;
  if (args.includes("--suggest")) {
    const table = markdown ? inventoryTable(markdown) : "";
    if (report.input === "handoff") advisory = { text: "--suggest reads a brief's screen inventory. A handoff pack already has its components." };
    else if (!table) advisory = { text: "No screen inventory table to read." };
    else {
      try {
        const result = suggest(table);
        advisory = { json: result.json, text: result.text };
      } catch (error) {
        advisory = { text: `Suggestions not available: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
  }

  if (json) printJson({ ...report, target, exitCodes: BRIEF_EXIT, ...(advisory ? { advisory: { note: ADVISORY, ...(advisory.json !== undefined ? { rows: advisory.json } : { message: advisory.text }) } } : {}) });
  else process.stdout.write(`${formatReport(report, target)}${advisory ? `\n${ADVISORY}\n${advisory.text}${advisory.text.endsWith("\n") ? "" : "\n"}` : ""}`);
  if (report.exitCode === 1) process.exitCode = 1;
  else strictExit(args, report.exitCode);
}
