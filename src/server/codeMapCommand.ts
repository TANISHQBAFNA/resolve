import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { scanAngularPackage } from "@/adapters/angular";
import { isRetired } from "@/core/rules/retired";
import { formatCodeMapReport } from "@/core/query/codeMap";
import {
  codeMapFromCsv,
  codeMapJson,
  entriesToCsv,
  entryLabel,
  mergeCodeMap,
  readCodeMapDocument,
  reviewEntries,
} from "@/core/query/codeMapCsv";
import { mergeSuggestions, suggestionEntries, suggestPairs } from "@/core/query/codeMapSuggest";
import { overlayFile } from "@/core/query/overlayFile";
import { codeMapCard, libraryCodeTargets } from "@/core/query/replacements";
import type { GraphIndex } from "@/core/query/GraphIndex";
import { flag, printJson, requireGraph } from "./cliArgs";
import { isRecord } from "./isRecord";
import { storeRoot } from "./store";

/**
 * `code-map scan`, `suggest`, and `review`.
 * Suggestions are never written as mapped. Review confirms them through the CSV import.
 */

const VALUE_FLAGS = new Set(["--out", "--import", "--package", "--id"]);

export function mapFile(): string {
  return overlayFile("code-map.json") ?? join(storeRoot(), "code-map.json");
}

function tailOf(args: string[], sub: string): string[] {
  const at = args.indexOf(sub);
  return at < 0 ? args : args.slice(at + 1);
}

function positional(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      if (VALUE_FLAGS.has(arg)) i += 1;
      continue;
    }
    return arg;
  }
  return undefined;
}

function packageArg(args: string[]): string {
  const given = flag(args, "package") ?? positional(args);
  if (!given || given.startsWith("--")) throw new Error("Pass a package path or name. Example: resolve code-map scan ./packages/acme-ui");
  return given;
}

function list(items: unknown[]): string {
  return items.slice(0, 12).map((entry) => `  ${entryLabel(entry)}`).join("\n") + (items.length > 12 ? `\n  +${items.length - 12} more` : "");
}

export function runCodeMapExtra(args: string[]): boolean {
  const sub = args.find((arg) => arg === "scan" || arg === "suggest" || arg === "review");
  if (!sub) return false;
  const tail = tailOf(args, sub);
  if (sub === "scan") scan(tail);
  else if (sub === "suggest") suggest(tail);
  else review(tail);
  return true;
}

function scan(args: string[]): void {
  const inventory = scanAngularPackage(resolve(packageArg(args)));
  const out = flag(args, "out");
  if (args.includes("--out") && (!out || out.startsWith("--"))) throw new Error("--out needs a file name.");
  const json = `${JSON.stringify(inventory, null, 2)}\n`;
  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, json);
    process.stdout.write(`Wrote ${out}: ${inventory.components.length} components in ${inventory.packageName}@${inventory.packageVersion}.\n`);
    return;
  }
  if (args.includes("--json")) {
    process.stdout.write(json);
    return;
  }
  const lines = inventory.components.map((component) => {
    const inputs = component.inputs.map((input) => (input.signal ? `${input.name} (signal)` : input.name)).join(", ");
    const where = component.module ?? (component.standalone ? "standalone" : "no module");
    const conflict = component.selectorConflict?.length ? `  selector conflict: ${component.selectorConflict.join(", ")}` : "";
    return `${component.component}  ${component.selector}  ${where}${inputs ? `  inputs: ${inputs}` : ""}  (${component.from})${conflict}`;
  });
  process.stdout.write(`${inventory.packageName}@${inventory.packageVersion}: ${inventory.components.length} components\n${lines.join("\n")}\n`);
}

export function preparedSuggestions(packageOrPath: string, index: ReturnType<typeof requireGraph>["index"]) {
  const inventory = scanAngularPackage(resolve(packageOrPath));
  const pairs = suggestPairs(index, inventory, libraryCodeTargets(index), { retired: (node) => isRetired(index, node) });
  return { inventory, pairs };
}

export function writeSuggestions(packageOrPath: string, index: ReturnType<typeof requireGraph>["index"]) {
  const { inventory, pairs } = preparedSuggestions(packageOrPath, index);
  const path = mapFile();
  const previous = existsSync(path) ? readCodeMapDocument(path) : { entries: [] as unknown[] };
  const entries = mergeSuggestions(previous.entries, suggestionEntries(pairs));
  const packages = { ...(previous.packages ?? {}) };
  packages[inventory.packageName] = inventory.packageVersion;
  const versions = {
    ...(index.graph.source.version ? { figmaVersion: index.graph.source.version } : previous.figmaVersion ? { figmaVersion: previous.figmaVersion } : {}),
    packages,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, codeMapJson(entries, versions));
  return { inventory, pairs, path, entries };
}

function suggest(args: string[]): void {
  const { index } = requireGraph(args);
  const spec = packageArg(args);
  if (args.includes("--write")) {
    const { pairs, path } = writeSuggestions(spec, index);
    process.stdout.write(`Wrote ${path}: ${pairs.length} suggestions. Confirmed entries were kept. None of the new rows are mapped.\n`);
    process.stdout.write(`${formatCodeMapReport(codeMapCard(() => index))}\n`);
    return;
  }
  const { inventory, pairs } = preparedSuggestions(spec, index);
  if (args.includes("--json")) {
    printJson({ packageName: inventory.packageName, packageVersion: inventory.packageVersion, suggestions: pairs });
    return;
  }
  const lines = pairs.map((pair) => `${pair.name} -> ${pair.component} (${pair.relation}, ${pair.status}) ${pair.because}`);
  process.stdout.write(
    lines.length
      ? `Suggested ${pairs.length} (none of these are mapped):\n${lines.join("\n")}\n`
      : "No suggestions. Names did not match, and no part is composed of a matched part.\n",
  );
  process.stdout.write("Nothing written. Add --write to save them as suggestions. A suggestion is not a code twin.\n");
}

export function importReview(csvText: string, replace = false) {
  const parsed = reviewEntries(codeMapFromCsv(csvText));
  if (parsed.errors.length) return { ok: false as const, errors: parsed.errors };
  const path = mapFile();
  const previous = existsSync(path) ? readCodeMapDocument(path) : { entries: [] as unknown[] };
  const merged = mergeCodeMap(previous.entries, parsed, replace);
  return { ok: true as const, path, previous, merged, parsed };
}

/** Reject a mapped row for a retired part, and an id that is not in the learned file. */
/** Print the row problems and set exit 1. True when there were any (nothing may be written). */
export function refuseBadRows(entries: Record<string, unknown>[], index: GraphIndex): boolean {
  const problems = rowProblems(entries, index);
  if (!problems.length) return false;
  process.stdout.write(`Nothing written. Fix these rows:\n${problems.slice(0, 20).map((error) => `  ${error}`).join("\n")}\n`);
  process.exitCode = 1;
  return true;
}

export function rowProblems(entries: Record<string, unknown>[], index: GraphIndex): string[] {
  const masters = index.graph.nodes.filter(
    (node) => (node.type === "COMPONENT_SET" || node.type === "MAIN_COMPONENT") && !node.componentSetId && !node.isRemote,
  );
  const fileKeys = new Set<string>([index.graph.fileKey, ...masters.flatMap((node) => (node.fileKey ? [node.fileKey] : []))]);
  const errors: string[] = [];
  for (const entry of entries) {
    const fileKey = typeof entry["fileKey"] === "string" ? entry["fileKey"] : "";
    const id = typeof entry["id"] === "string" ? entry["id"] : "";
    const name = typeof entry["name"] === "string" ? entry["name"] : "";
    const status = typeof entry["status"] === "string" ? entry["status"] : "";
    const known = masters.filter((node) => !fileKey || node.fileKey === fileKey || index.graph.fileKey === fileKey);
    const node = id ? known.find((item) => item.figmaNodeId === id || item.id === id) : known.find((item) => item.name === name);
    if (fileKey && id && fileKeys.has(fileKey) && !node) errors.push(`unknown id ${fileKey} ${id}${name ? ` (${name})` : ""}`);
    if ((status === "mapped" || status === "current") && node && isRetired(index, node)) errors.push(`${name || id} is retired and cannot be mapped`);
  }
  return errors;
}

function review(args: string[]): void {
  const path = mapFile();
  if (args.includes("--import")) {
    const file = flag(args, "import");
    if (!file || file.startsWith("--")) throw new Error("Usage: resolve code-map review --import <file.csv>");
    if (!existsSync(file)) throw new Error(`No such file: ${file}`);
    const result = importReview(readFileSync(file, "utf8"), args.includes("--replace"));
    if (!result.ok) {
      process.stdout.write(`Nothing written. Fix these rows in ${file}:\n${result.errors.slice(0, 20).map((error) => `  ${error}`).join("\n")}\n`);
      process.exitCode = 1;
      return;
    }
    const mapped = result.merged.entries.filter((entry) => isRecord(entry) && entry["status"] === "mapped").length;
    if (args.includes("--dry-run")) {
      process.stdout.write(codeMapJson(result.merged.entries, result.previous));
      return;
    }
    const index = requireGraph(args).index;
    if (refuseBadRows(result.parsed.entries, index)) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, codeMapJson(result.merged.entries, { ...result.previous, packages: result.previous.packages }));
    const kept = result.merged.untouched.length
      ? `Kept ${result.merged.untouched.length} existing entr${result.merged.untouched.length === 1 ? "y" : "ies"} the CSV has no row for:\n${list(result.merged.untouched)}\n`
      : "";
    process.stdout.write(`Wrote ${path}: ${mapped} mapped. A row becomes mapped only when its status says mapped.\n${kept}`);
    process.stdout.write(`${formatCodeMapReport(codeMapCard(() => index))}\n`);
    return;
  }
  if (!existsSync(path)) throw new Error(`No code map at ${path}. Run resolve code-map suggest <package> --write first.`);
  const previous = readCodeMapDocument(path);
  const out = flag(args, "out") ?? join(dirname(path), "code-map-review.csv");
  if (args.includes("--out") && (!flag(args, "out") || flag(args, "out")?.startsWith("--"))) throw new Error("--out needs a file name.");
  if (existsSync(out) && !args.includes("--force")) throw new Error(`${out} already exists. Add --force to replace it.`);
  writeFileSync(out, entriesToCsv(previous.entries));
  const pending = previous.entries.filter((entry) => isRecord(entry) && (entry["status"] === "suggested" || entry["status"] === "partial")).length;
  process.stdout.write(
    `Wrote ${out}. ${pending} suggestion${pending === 1 ? "" : "s"} to accept or fix. Set status to mapped on the rows you confirm, then run: resolve code-map review --import ${out}\nA blank status stays suggested. Entries the CSV leaves out are kept.\n`,
  );
}
