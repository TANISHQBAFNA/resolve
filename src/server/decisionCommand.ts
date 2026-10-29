import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { decisionSlug, formatDecisionRecord, parseDecisionRecord, type DecisionRecord } from "@/core/query";
import { flag, printJson } from "./cliArgs";
import { storeRoot } from "./store";

/** Write `<name>.json` and `<name>.md` into dir. Returns the JSON path. Errors name the folder. */
export function writeDecision(dir: string, record: DecisionRecord, name = "decision"): string {
  const path = join(dir, `${name}.json`);
  try {
    if (existsSync(dir) && !statSync(dir).isDirectory()) throw new Error("it is a file, not a folder");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    writeFileSync(join(dir, `${name}.md`), formatDecisionRecord(record));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const why = code === "EACCES" || code === "EPERM" ? "no permission to write there" : code === "ENOTDIR" || code === "EEXIST" ? "part of that path is a file, not a folder" : (error as Error).message.split("\n")[0];
    throw new Error(`Cannot write the decision record to ${dir}: ${why}.`);
  }
  return path;
}

/** Every stored record (newest first): file, kind, what it was about, when. */
export function listDecisions(): Array<{ file: string; kind: string; about: string; createdAt: string }> {
  const dir = decisionsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .flatMap((file) => {
      try {
        const record = parseDecisionRecord(JSON.parse(readFileSync(join(dir, file), "utf8")), file);
        return [{ file, kind: record.kind, about: record.request ?? (record.screens ?? []).join(", "), createdAt: record.createdAt }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.file.localeCompare(b.file));
}

/** Records made over MCP (no --out folder) live in the store: .resolve/decisions/<kind>-<slug>.json. */
export function decisionsDir(): string {
  return join(storeRoot(), "decisions");
}

export function storeDecision(record: DecisionRecord): string {
  return writeDecision(decisionsDir(), record, decisionSlug(record));
}

/**
 * A stored record. A bare name is looked up in the decisions folder; a path must point into that folder,
 * or at a decision*.json file (the one next to a handoff). Anything else is refused. The file is checked.
 */
export function readDecision(ref: string): DecisionRecord {
  const asked = ref.trim();
  if (!asked) throw new Error("decision_record needs ref: a record name from the list, or a path to a decision*.json file.");
  const dir = decisionsDir();
  const file = asked.endsWith(".json") ? asked : `${asked}.json`;
  const bare = !file.includes("/") && !file.includes("\\");
  const path = bare ? join(dir, file) : resolve(file);
  const inside = !relative(dir, path).startsWith("..") && !isAbsolute(relative(dir, path));
  if ((bare && file.startsWith(".")) || (!inside && !/^decision[a-z0-9-]*\.json$/i.test(basename(path)))) {
    throw new Error(`"${asked}" is not a decision record Resolve wrote. Use a name from the decisions list, or a decision*.json path.`);
  }
  if (!existsSync(path)) throw new Error(`No decision record "${asked}". Records are in ${dir} or next to a handoff (decision.json).`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`${basename(path)} is not JSON.`);
  }
  return parseDecisionRecord(raw, basename(path));
}

/** The requirements context the person passed as flags (as given, never guessed). */
export function contextFromFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["pack", "product", "journey", "domain", "audience", "a11y"]) {
    const value = flag(args, key);
    if (value && !value.startsWith("--")) out[key] = value;
  }
  return out;
}

/** `--record <dir>` on brief and recipe --compose: write the record there. Without the flag nothing is written. */
export function recordFlag(args: string[], record: () => DecisionRecord): void {
  const dir = flag(args, "record");
  if (!args.includes("--record")) return;
  if (!dir || dir.startsWith("--")) throw new Error("--record needs a folder, for example --record decisions");
  const built = record();
  const name = `decision-${built.kind}`;
  if (existsSync(join(resolve(dir), `${name}.json`)) && !args.includes("--force")) {
    throw new Error(`${resolve(dir)} already has ${name}.json. Add --force to replace it, or pass another --record folder.`);
  }
  writeDecision(resolve(dir), built, name);
}

/** `resolve decisions [--json]`: the records stored by MCP record: true. */
export function runDecisions(args: string[]): void {
  const rows = listDecisions();
  if (args.includes("--json")) return printJson({ folder: decisionsDir(), records: rows });
  if (!rows.length) return void process.stdout.write(`No decision records in ${decisionsDir()}.\n`);
  process.stdout.write(`${rows.map((row) => `${row.file}  ${row.kind}  ${row.createdAt}  ${row.about}`).join("\n")}\n`);
}
