import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  BriefAnswerIdsSchema,
  aidlcExport,
  decisionSlug,
  formatDecisionRecord,
  parseDecisionRecord,
  type AidlcHandoff,
  type DecisionRecord,
  type HandoffPack,
} from "@/core/query";
import { flag, positionals, printJson, withJsonErrors } from "./cliArgs";
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

function readJson(path: string, name: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`${name} in ${resolve(path, "..")} is not JSON.`);
  }
}

/** handoff.json + decision.json from a handoff --out folder, as the AIDLC contract. Both are checked first. */
export function aidlcFromFolder(dir: string): AidlcHandoff {
  if (!dir.trim()) throw new Error("export aidlc needs a handoff folder (the --out folder of resolve handoff). It never uses the current folder by itself.");
  const folder = resolve(dir);
  const handoffPath = join(folder, "handoff.json");
  if (!existsSync(handoffPath)) throw new Error(`No handoff.json in ${folder}. Run resolve handoff "<frame>" --out ${dir} first.`);
  const raw = readJson(handoffPath, "handoff.json");
  const pack = raw as HandoffPack;
  if (!pack || typeof pack !== "object" || pack.ok !== true || !Array.isArray(pack.screens) || !pack.screens.length) {
    throw new Error(`handoff.json in ${folder} is not a passing handoff with screens, so there is nothing to export.`);
  }
  const handoffAnswersRaw = raw && typeof raw === "object" ? (raw as { answers?: unknown }).answers : undefined;
  const parsedAnswers = BriefAnswerIdsSchema.safeParse(handoffAnswersRaw);
  if (handoffAnswersRaw !== undefined && !parsedAnswers.success) {
    throw new Error(`handoff.json in ${folder} has invalid answers. Run resolve handoff "<frame>" --out ${dir} again.`);
  }
  const recordPath = join(folder, "decision.json");
  const record = existsSync(recordPath) ? parseDecisionRecord(readJson(recordPath, "decision.json"), "decision.json") : undefined;
  return aidlcExport(pack, record, parsedAnswers.success ? parsedAnswers.data : undefined);
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

/** Write the export file. Errors name the file and say what to change, like writeDecision. */
function writeExport(path: string, text: string): void {
  const folder = dirname(path);
  if (existsSync(path) && statSync(path).isDirectory()) throw new Error(`Cannot write ${path}: it is a folder. Pass a file name, for example --out aidlc.json.`);
  if (!existsSync(folder)) throw new Error(`Cannot write ${path}: the folder ${folder} does not exist.`);
  try {
    writeFileSync(path, text);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const why =
      code === "EACCES" || code === "EPERM"
        ? "no permission to write there"
        : code === "ENOTDIR" || code === "EISDIR"
          ? "part of that path is a file, not a folder"
          : code === "ENOENT"
            ? existsSync(folder)
              ? `the folder ${folder} cannot be written`
              : `the folder ${folder} does not exist`
            : code === "EROFS"
              ? "the file system is read-only"
              : code === "ENOSPC"
                ? "the disk is full"
                : "could not write the file";
    throw new Error(`Cannot write ${path}: ${why}.`);
  }
}

/** `resolve export aidlc <handoff folder> [--out <file>] [--json]`. */
export function runExport(args: string[]): void {
  withJsonErrors(args, () => exportAidlc(args));
}

function exportAidlc(args: string[]): void {
  const [target, dir] = positionals(args);
  if (target !== "aidlc" || !dir) throw new Error("Usage: resolve export aidlc <handoff folder> [--out aidlc.json] [--json]");
  const doc = aidlcFromFolder(dir);
  const out = flag(args, "out");
  if (args.includes("--out") && (!out || out.startsWith("--"))) throw new Error("--out needs a file name, for example --out aidlc.json");
  if (out) {
    writeExport(resolve(out), `${JSON.stringify(doc, null, 2)}\n`);
    if (args.includes("--json")) printJson({ ok: true, path: resolve(out), schemaVersion: doc.schemaVersion });
    else process.stdout.write(`Wrote ${resolve(out)} (resolve.aidlc schemaVersion ${doc.schemaVersion}, ${doc.designHandoff.screens.length} screen(s)).\n`);
    return;
  }
  printJson(doc);
}
