import { runExport } from "./exportCommand";

/** Args are the words after `export`: `aidlc <handoff folder> [--out file] [--json]`. */
export function main(argv: string[]): void {
  runExport(argv);
}
