import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BriefAnswerIdsSchema, flag, parseDecisionRecord, positionals, printJson, withJsonErrors, type HandoffPack } from "@/public";
import { aidlcExport, type AidlcHandoff } from "./contract";

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

/** `resolve export aidlc <handoff folder> [--out <file>] [--json]`. */
export function runExport(args: string[]): void {
  withJsonErrors(args, () => exportAidlc(args));
}
