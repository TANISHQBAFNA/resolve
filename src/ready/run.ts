import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { hasStrict, printJson, strictExit } from "@/server/cliArgs.ts";
import { checkReady } from "./check.ts";
import { READY_USAGE, type ReadyResult } from "./types.ts";

export { READY_TOOL, READY_USAGE } from "./types.ts";
export { checkReady } from "./check.ts";

function projectArg(args: string[]): { project?: string; out?: string; help: boolean } {
  let project: string | undefined;
  let out: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--help") return { help: true };
    if (arg === "--json" || arg === "--strict") continue;
    if (arg === "--out") {
      out = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) continue;
    project ??= arg;
  }
  return { ...(project ? { project } : {}), ...(out ? { out } : {}), help: false };
}

/** Check and write 5-readiness/report.md. Does not exit the process. */
export function runReady(projectArgValue: string | undefined, options: { out?: string; strict?: boolean } = {}): ReadyResult {
  const project = resolve(projectArgValue?.trim() || process.cwd());
  const report = checkReady(project);
  const destination = options.out ? (isAbsolute(options.out) ? options.out : resolve(options.out)) : report.reportPath;
  let written = false;
  if (!existsSync(project) && !options.out) {
    process.stderr.write(`warning: ${project} is missing, so the report was not written. next: pass a project folder.\n`);
  } else {
    try {
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, report.markdown);
      written = true;
      process.stderr.write(`wrote ${destination}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`warning: could not write ${destination} (${message}). next: pick a folder you can write to.\n`);
    }
  }
  return { ...report, reportPath: destination, written, exitCode: options.strict ? report.strictExitCode : 0 };
}

export async function runReadyCli(args: string[]): Promise<void> {
  const parsed = projectArg(args);
  if (parsed.help) {
    process.stdout.write(`${READY_USAGE.join("\n")}\n`);
    return;
  }
  const result = runReady(parsed.project, { ...(parsed.out ? { out: parsed.out } : {}), strict: hasStrict(args) });
  if (args.includes("--json")) printJson(result);
  else process.stdout.write(result.markdown);
  strictExit(args, result.strictExitCode);
}

/** MCP `ready`. Writes the report. Does not set the process exit code. */
export function runReadyTool(args: Record<string, unknown>): ReadyResult {
  const project = typeof args["project"] === "string" ? args["project"] : undefined;
  const out = typeof args["out"] === "string" ? args["out"] : undefined;
  return runReady(project, { ...(out ? { out } : {}), strict: args["strict"] === true });
}
