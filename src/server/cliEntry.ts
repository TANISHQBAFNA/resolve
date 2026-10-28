import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { designerFailure } from "./designerMessages";

/** Same file even when one path goes through a symlinked folder. */
function samePath(left: string, right: string): boolean {
  const file = (value: string) => (value.startsWith("file:") ? fileURLToPath(value) : value);
  try {
    return realpathSync(file(left)) === realpathSync(file(right));
  } catch {
    return file(left) === file(right);
  }
}

const isEntry = process.argv[1] !== undefined && samePath(import.meta.url, process.argv[1]);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv.find((arg) => arg !== "--pretty");
  if (command === "pick") {
    const { runPickCommand } = await import("./commands");
    runPickCommand(argv.filter((arg) => arg !== "--pretty" && arg !== "pick"));
    return;
  }
  if (command === "code" || command === "mode") {
    const { runCodeCommand, runModeCommand } = await import("./code/command.ts");
    if (command === "mode") runModeCommand();
    else runCodeCommand(argv.filter((arg) => arg !== "--pretty" && arg !== "code"), (await import("./graphMasters.ts")).graphMasters);
    return;
  }
  const { runCli } = await import("./cli");
  await runCli(argv);
}

/** bin/resolve-cli.mjs calls this after importing the bundle; a direct `node dist-server/cli.mjs` run calls it below. */
export function runEntry(): void {
  main().catch((error: unknown) => {
    const raw = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${designerFailure(raw)}\n`);
    process.exit(1);
  });
}

if (isEntry) runEntry();
