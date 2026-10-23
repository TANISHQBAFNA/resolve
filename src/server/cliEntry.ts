import { pathToFileURL } from "node:url";

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

if (isEntry) {
  main().catch((error: unknown) => {
    const raw = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${raw}\n`);
    process.exit(1);
  });
}
