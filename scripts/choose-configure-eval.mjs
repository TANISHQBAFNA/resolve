#!/usr/bin/env node
/**
 * Scores three supplied transcripts against docs/choose-configure/eval-criteria.md.
 * With no transcripts it prints "not run" and exits 0. It never invents a score.
 *
 *   node scripts/choose-configure-eval.mjs <baseline.json> <evidence.json> <guidance.json>
 *
 * Each file is { "tasks": [ { "id", "componentOk", "configOk", "unsupported", "uncertaintyOk", "corrections", "ms" } ] }.
 * Booleans are the scorer's marks. This script only totals them. It does not call a model.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const criteria = readFileSync(join(root, "docs/choose-configure/eval-criteria.md"), "utf8");
const required = [
  "Component correctness",
  "Property and child configuration",
  "Unsupported claims",
  "Appropriate uncertainty",
  "Corrections",
  "Completion time",
];
const missing = required.filter((name) => !criteria.includes(name));
if (missing.length) {
  process.stdout.write(`not run: criteria missing ${missing.join(", ")}\n`);
  process.exit(0);
}

const [baseline, evidence, guidance] = process.argv.slice(2);
if (!baseline || !evidence || !guidance) {
  process.stdout.write("not run: no signed-in model transcripts for baseline, evidence, and evidence+guidance\n");
  process.exit(0);
}

const load = (path) => JSON.parse(readFileSync(path, "utf8"));
const total = (file) => {
  const tasks = load(file).tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error(`${file} has no tasks`);
  const sum = { component: 0, config: 0, unsupported: 0, uncertainty: 0, corrections: 0, ms: 0, n: tasks.length };
  for (const task of tasks) {
    sum.component += task.componentOk === true ? 1 : 0;
    sum.config += task.configOk === true ? 1 : 0;
    sum.unsupported += Number(task.unsupported) || 0;
    sum.uncertainty += task.uncertaintyOk === true ? 1 : 0;
    sum.corrections += Number(task.corrections) || 0;
    sum.ms += Number(task.ms) || 0;
  }
  return sum;
};

const names = ["baseline", "evidence", "evidence+guidance"];
const rows = [baseline, evidence, guidance].map((file, index) => ({ condition: names[index], ...total(file) }));
process.stdout.write(`${JSON.stringify({ criteria: required, rows }, null, 2)}\n`);
