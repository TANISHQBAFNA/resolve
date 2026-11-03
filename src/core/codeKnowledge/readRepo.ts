import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { Evidence, KnowledgeWarning } from "./types";

export interface LineCheck {
  evidence: Evidence;
  text?: string;
}

/** A path inside the repo. Absolute paths and parent segments are refused. */
export function readRepoFile(repo: string, file: string): string | undefined {
  const rel = file.replace(/^\.\//, "");
  if (!rel || rel.startsWith("/") || rel.includes("\\") || rel.split("/").includes("..")) return undefined;
  const root = resolve(repo);
  const full = resolve(join(root, rel));
  if (full !== root && !full.startsWith(root + sep)) return undefined;
  if (!existsSync(full) || !statSync(full).isFile()) return undefined;
  return readFileSync(full, "utf8");
}

function lineCount(text: string): number {
  if (!text) return 0;
  const parts = text.split(/\r?\n/);
  return text.endsWith("\n") || text.endsWith("\r") ? parts.length - 1 : parts.length;
}

/** Every evidence object on the draft. Missing files and short files are warnings, not errors. */
export function evidenceWarnings(repo: string | undefined, items: Evidence[]): KnowledgeWarning[] {
  if (!items.length) return [];
  if (!repo) {
    return [{ message: "evidence was not checked because no repo was given", next: "pass --repo <folder>. For a git URL, clone that ref and pass the checkout" }];
  }
  const warnings: KnowledgeWarning[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = `${item.file}:${item.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const text = readRepoFile(repo, item.file);
    if (text === undefined) {
      warnings.push({ message: `evidence ${item.file}:${item.line} is not a file in the repo`, next: "cite a file and a line that exist in the repo" });
      continue;
    }
    if (item.line > lineCount(text)) {
      warnings.push({ message: `evidence ${item.file}:${item.line} is past the end of the file`, next: "cite a file and a line that exist in the repo" });
    }
  }
  return warnings;
}
