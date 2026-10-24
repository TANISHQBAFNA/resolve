import { pathToFileURL } from "node:url";
import { designerFailure } from "./designerMessages";

const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv.find((arg) => arg !== "--pretty");
  if (command === "pick") {
    const { runPickCommand } = await import("./commands");
    runPickCommand(argv.filter((arg) => arg !== "--pretty" && arg !== "pick"));
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
