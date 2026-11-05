import { runMapCall, runMapCli, screenMapTools } from "@/core/screenMap/run";
import { readConfig } from "./mode";
import { resolveGraph } from "./store";

function io() {
  const config = readConfig();
  return {
    cwd: process.cwd(),
    enabled: config.screenMap?.enabled === true,
    lookalikes: config.screenMap?.lookalikes === true,
    loadGraph: () => resolveGraph()?.graph,
    stdout: (text: string) => process.stdout.write(text),
  };
}

export const mapToolsIfEnabled = () => screenMapTools(readConfig().screenMap?.enabled === true);
export const runMapTool = (name: string, args: Record<string, unknown>) => runMapCall(name, args, io());
export const runMapCommand = (argv: string[]) => runMapCli(argv, io());
