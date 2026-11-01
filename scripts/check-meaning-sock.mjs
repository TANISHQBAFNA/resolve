// Old script name from before the DSCK rename, kept for the CI workflow.
// Runs scripts/check-meaning-dsck.mjs with the same arguments and exit code.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const target = fileURLToPath(new URL("./check-meaning-dsck.mjs", import.meta.url));
const run = spawnSync(process.execPath, [target, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(run.status ?? 1);
