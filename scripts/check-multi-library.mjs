import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "resolve-multi-"));
const asks = [
  ["primary button", "Button", "ACMEDS"],
  ["large primary button", "Button", "ACMEDS"],
  ["main action button", "Button", "ACMEDS"],
  ["primary CTA", "Button", "ACMEDS"],
  ["submit button", "Button", "ACMEDS"],
  ["main button", "Button", "ACMEDS"],
  ["primary action", "Button", "ACMEDS"],
  ["card", "Card", "ACMEDS"],
  ["info icon", "Info", "ACMEDS"],
  ["submit", "Button", "ACMEDS"],
  ["primary btn", "Button", "ACMEDS"],
  ["primary buttton", "Button", "ACMEDS"],
];

function run(args) {
  const result = spawnSync(process.execPath, ["dist-server/cli.mjs", ...args], {
    env: { ...process.env, RESOLVE_HOME: home },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

function jsonFrom(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("CLI did not print JSON");
  return JSON.parse(text.slice(start, end + 1));
}

run(["ingest", "scoreboard/guards/acme-app.json", "--role", "library", "--name", "Acme App"]);
run(["ingest", "scoreboard/guards/acme-ds.json", "--role", "library", "--name", "Acme DS"]);
run(["ingest", "scoreboard/guards/acme-marketing.json", "--role", "library", "--name", "Acme Marketing"]);

const failures = [];
for (const [intent, name, fileKey] of asks) {
  const card = jsonFrom(run(["recommend", intent]));
  const top = card.candidates?.[0];
  if (top?.name !== name || top?.fileKey !== fileKey) {
    failures.push(`"${intent}" picked ${top?.name ?? "nothing"} from ${top?.fileKey ?? "nowhere"}; expected ${name} from Acme DS (${fileKey})`);
  }
}

const navigation = jsonFrom(run(["recommend", "primary navigation"]));
const navName = navigation.candidates?.[0]?.name;
if (navName === "Primary" || (navName && !/nav/i.test(navName))) {
  failures.push(`"primary navigation" picked ${navName}; expected a navigation part or nothing`);
}
for (const ask of ["primary color token", "navigation bar"]) {
  const card = jsonFrom(run(["recommend", ask]));
  if (card.candidates?.[0]?.name === "Button") {
    failures.push(`"${ask}" picked Button`);
  }
}

const bar = jsonFrom(run(["recommend", "bottom action bar"]));
const barName = bar.candidates?.[0]?.name;
if (barName === "Button" || barName !== "Bottom action bar") {
  failures.push(`"bottom action bar" picked ${barName ?? "nothing"}; expected Bottom action bar, not Button`);
}

if (failures.length) {
  process.stderr.write(`Multi-library guard failed. With Acme App, Acme DS, and Acme Marketing learned, the base masters lost:\n${failures.map((line) => `- ${line}`).join("\n")}\n`);
  process.exit(1);
}

process.stdout.write("Multi-library guard holds: action phrases, submit, and the info icon come from Acme DS. Primary navigation does not pick Marketing Primary, and the bottom action bar does not pick Button.\n");
