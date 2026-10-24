/**
 * Compare recommend leads with origin/main.
 *
 *   node scripts/meaning-regression.mjs snapshot
 *   node scripts/meaning-regression.mjs check
 *
 * snapshot runs every in-repo ask through origin/main and writes
 * scoreboard/meaning/main-snapshot.json. check scores the current checkout
 * and fails when a correct main lead changed without an allowlist reason,
 * or when a purpose or word-form fallback lead is not weak.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const root = process.cwd();
const snapshotPath = join(root, "scoreboard/meaning/main-snapshot.json");
const allowPath = join(root, "scoreboard/meaning/regression-allow.json");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function files(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(dir, name));
}

function expectation(row) {
  const accept = Array.isArray(row.accept) ? row.accept.filter((name) => typeof name === "string") : [];
  const raw = row.expect !== undefined ? row.expect : row.exp !== undefined ? row.exp : row.expected;
  if (raw === undefined) return undefined;
  if (raw === null || raw === "none" || raw === "empty") return { empty: true, names: [] };
  if (raw === "weak") return { empty: true, names: accept };
  if (typeof raw === "string") return { empty: false, names: [...new Set([raw, ...accept])] };
  if (Array.isArray(raw) && raw.every((name) => typeof name === "string")) return { empty: false, names: [...new Set([...raw, ...accept])] };
  return undefined;
}

function addAsk(asks, seen, library, set, id, phrase, expect) {
  const text = typeof phrase === "string" ? phrase.trim() : "";
  if (!text || !expect) return;
  const key = `${library}\n${text.toLowerCase()}`;
  if (seen.has(key)) return;
  seen.add(key);
  asks.push({ id: `${set}#${id}`, library, phrase: text, expect });
}

function collect() {
  const asks = [];
  const seen = new Set();
  const take = (path, library, rows) => {
    const set = relative(root, path);
    rows.forEach((row, index) => {
      if (!row || typeof row !== "object") return;
      const phrase = row.phrase ?? row.intent ?? row.q ?? row.request;
      const expect = expectation(row);
      addAsk(asks, seen, library, set, row.id ?? String(index), phrase, expect);
      if (Array.isArray(row.slots)) {
        for (const slot of row.slots) {
          const slotExpect = expectation(slot);
          addAsk(asks, seen, library, set, `${row.id ?? index}:${slot.q ?? ""}`, slot.q, slotExpect);
        }
      }
    });
  };
  const casesOf = (path) => {
    const parsed = readJson(path);
    return [...(parsed.cases ?? []), ...(parsed.phrases ?? []), ...(Array.isArray(parsed.screens) ? parsed.screens : [])];
  };
  for (const path of [...files(join(root, "scoreboard/phrases")), ...files(join(root, "scoreboard/regression")), join(root, "scoreboard/fresh/acme.json"), join(root, "scoreboard/golden/no-answer.json")]) {
    if (existsSync(path)) take(path, "fixture", casesOf(path));
  }
  for (const path of [...files(join(root, "scoreboard/material-phrases")), ...files(join(root, "scoreboard/material-fresh")), ...files(join(root, "scoreboard/material-heldout")), join(root, "scoreboard/material/cases.json")]) {
    if (existsSync(path)) take(path, "material", casesOf(path));
  }
  for (const path of files(join(root, "scoreboard/meaning"))) {
    if (path.endsWith("main-snapshot.json") || path.endsWith("regression-allow.json")) continue;
    const parsed = readJson(path);
    const set = relative(root, path);
    for (const [index, row] of (parsed.cases ?? []).entries()) {
      const library = row.library === "acme" ? "acme-small" : row.library === "material" ? "material" : undefined;
      if (!library) continue;
      addAsk(asks, seen, library, set, row.id ?? `${row.kind ?? "ask"}-${index}`, row.phrase, expectation(row));
    }
  }
  return asks;
}

function mainCorrect(expect, lead) {
  if (expect.empty && expect.names.length === 0) return lead === "";
  if (expect.empty) return lead === "" || expect.names.includes(lead);
  return expect.names.includes(lead);
}

function runScorer(cwd, asks, out) {
  const script = join(root, "tests/meaning.score.ts");
  const input = join(tmpdir(), "meaning-regression-asks.json");
  writeFileSync(input, JSON.stringify(asks));
  execFileSync("npx", ["--no-install", "vite-node", "--config", join(cwd, "vite.config.ts"), script, input, out], {
    cwd,
    stdio: "inherit",
    env: { ...process.env, RESOLVE_HOME: "", RESOLVE_MEANING_SCORE: "1" },
  });
}

function worktree() {
  const dir = join(tmpdir(), "resolve-main-meaning");
  if (!existsSync(join(dir, "package.json"))) {
    execFileSync("git", ["worktree", "add", "--detach", dir, "origin/main"], { cwd: root, stdio: "inherit" });
  }
  const modules = join(dir, "node_modules");
  if (!existsSync(modules)) execFileSync("ln", ["-s", join(root, "node_modules"), modules]);
  return dir;
}

function snapshot() {
  const asks = collect();
  const dir = worktree();
  const scored = join(tmpdir(), "meaning-main-scores.json");
  runScorer(dir, asks, scored);
  const leads = new Map(JSON.parse(readFileSync(scored, "utf8")).map((row) => [row.id, row]));
  const sha = execFileSync("git", ["rev-parse", "origin/main"], { cwd: root, encoding: "utf8" }).trim();
  const rows = asks.map((ask) => {
    const got = leads.get(ask.id) ?? { lead: "", weak: false };
    return {
      id: ask.id,
      library: ask.library,
      phrase: ask.phrase,
      expect: ask.expect,
      mainLead: got.lead,
      mainWeak: Boolean(got.weak),
      mainCorrect: mainCorrect(ask.expect, got.lead),
    };
  });
  const body = { version: 1, main: sha, compared: rows.length, asks: rows };
  writeFileSync(snapshotPath, `${JSON.stringify(body, null, 2)}\n`);
  process.stdout.write(`snapshot ${rows.length} asks from ${sha}\n`);
}

function check() {
  if (!existsSync(snapshotPath)) {
    process.stderr.write("Missing scoreboard/meaning/main-snapshot.json. Run: node scripts/meaning-regression.mjs snapshot\n");
    process.exit(1);
  }
  const saved = readJson(snapshotPath);
  const allow = existsSync(allowPath) ? readJson(allowPath) : { entries: [] };
  const reasons = new Map((allow.entries ?? []).map((entry) => [entry.id, entry.reason]));
  for (const [id, reason] of reasons) {
    if (typeof reason !== "string" || !reason.trim()) {
      process.stderr.write(`Allowlist entry ${id} needs a one-line reason.\n`);
      process.exit(1);
    }
  }
  const asks = saved.asks.map((row) => ({ id: row.id, library: row.library, phrase: row.phrase }));
  const scored = join(tmpdir(), "meaning-branch-scores.json");
  runScorer(root, asks, scored);
  const leads = new Map(JSON.parse(readFileSync(scored, "utf8")).map((row) => [row.id, row]));
  const changed = [];
  const strongFallback = [];
  for (const row of saved.asks) {
    const got = leads.get(row.id) ?? { lead: "", weak: false, via: "" };
    if (got.via && got.lead && !got.weak) strongFallback.push(`${row.id} ${got.via} "${row.phrase}" → ${got.lead}`);
    if (!row.mainCorrect || got.lead === row.mainLead) continue;
    if (reasons.has(row.id)) continue;
    changed.push(`${row.id} "${row.phrase}" main ${row.mainLead || "∅"} branch ${got.lead || "∅"}`);
  }
  const allowLines = [...reasons.entries()].map(([id, reason]) => `${id}: ${reason}`);
  process.stdout.write(`regression gate compared ${saved.asks.length} asks\n`);
  process.stdout.write(`allowlist ${reasons.size}\n${allowLines.join("\n")}\n`);
  if (changed.length || strongFallback.length) {
    process.stderr.write(`Changed correct main leads ${changed.length}\n${changed.join("\n")}\n`);
    process.stderr.write(`Strong fallback leads ${strongFallback.length}\n${strongFallback.join("\n")}\n`);
    process.exit(1);
  }
}

const command = process.argv[2];
if (command === "snapshot") snapshot();
else if (command === "check") check();
else {
  process.stderr.write("Use snapshot or check.\n");
  process.exit(1);
}
