import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  aidlcExport,
  decisionSlug,
  formatDecisionRecord,
  type AidlcHandoff,
  type DecisionRecord,
  type HandoffPack,
} from "@/core/query";
import { flag, positionals, printJson } from "./cliArgs";
import { storeRoot } from "./store";

/** Write `<name>.json` and `<name>.md` into dir. Returns the JSON path. */
export function writeDecision(dir: string, record: DecisionRecord, name = "decision"): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  writeFileSync(join(dir, `${name}.md`), formatDecisionRecord(record));
  return path;
}

/** Records made over MCP (no --out folder) live in the store: .resolve/decisions/<kind>-<slug>.json. */
export function decisionsDir(): string {
  return join(storeRoot(), "decisions");
}

export function storeDecision(record: DecisionRecord): string {
  return writeDecision(decisionsDir(), record, decisionSlug(record));
}

/** A stored record by path, file name or slug. Only files inside the decisions folder or a path the caller names. */
export function readDecision(ref: string): DecisionRecord {
  const name = ref.endsWith(".json") ? ref : `${ref}.json`;
  const path = existsSync(name) ? resolve(name) : join(decisionsDir(), name);
  if (!existsSync(path)) throw new Error(`No decision record "${ref}". Records are in ${decisionsDir()} or next to a handoff (decision.json).`);
  return JSON.parse(readFileSync(path, "utf8")) as DecisionRecord;
}

/** handoff.json + decision.json from a handoff --out folder, as the AIDLC contract. */
export function aidlcFromFolder(dir: string): AidlcHandoff {
  const folder = resolve(dir);
  const handoffPath = join(folder, "handoff.json");
  if (!existsSync(handoffPath)) throw new Error(`No handoff.json in ${folder}. Run resolve handoff "<frame>" --out ${dir} first.`);
  const pack = JSON.parse(readFileSync(handoffPath, "utf8")) as HandoffPack;
  if (!pack.ok) throw new Error(`The handoff in ${folder} was refused, so there is nothing to export. Fix it and run handoff again.`);
  const recordPath = join(folder, "decision.json");
  const record = existsSync(recordPath) ? (JSON.parse(readFileSync(recordPath, "utf8")) as DecisionRecord) : undefined;
  return aidlcExport(pack, record);
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
  writeDecision(resolve(dir), built, `decision-${built.kind}`);
}

/** `resolve export aidlc <handoff folder> [--out <file>] [--json]`. */
export function runExport(args: string[]): void {
  try {
    exportAidlc(args);
  } catch (error) {
    if (!args.includes("--json")) throw error;
    printJson({ ok: false, status: "error", message: error instanceof Error ? error.message : String(error), exitCode: 1 });
    process.exitCode = 1;
  }
}

function exportAidlc(args: string[]): void {
  const [target, dir] = positionals(args);
  if (target !== "aidlc" || !dir) throw new Error("Usage: resolve export aidlc <handoff folder> [--out aidlc.json] [--json]");
  const doc = aidlcFromFolder(dir);
  const out = flag(args, "out");
  if (args.includes("--out") && (!out || out.startsWith("--"))) throw new Error("--out needs a file name, for example --out aidlc.json");
  if (out) {
    writeFileSync(resolve(out), `${JSON.stringify(doc, null, 2)}\n`);
    if (args.includes("--json")) printJson({ ok: true, path: resolve(out), schemaVersion: doc.schemaVersion });
    else process.stdout.write(`Wrote ${resolve(out)} (resolve.aidlc schemaVersion ${doc.schemaVersion}, ${doc.designHandoff.screens.length} screen(s)).\n`);
    return;
  }
  printJson(doc);
}
