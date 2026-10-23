import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

function rel(root, file) {
  return relative(root, file).split("\\").join("/");
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

function linksOf(text) {
  return [...text.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((match) => match[1])
    .filter((href) => href && !/^[a-z][a-z0-9+.-]*:/i.test(href));
}

function checkHops(indexPath, fail) {
  const seen = new Map();
  const queue = [[indexPath, 0]];
  while (queue.length) {
    const next = queue.shift();
    if (!next) break;
    const [file, depth] = next;
    const known = seen.get(file);
    if (known !== undefined && known <= depth) continue;
    seen.set(file, depth);
    if (!existsSync(file)) {
      fail(`missing file ${file}`);
      continue;
    }
    for (const href of linksOf(readFileSync(file, "utf8"))) {
      const target = join(dirname(file), href.split("#")[0] ?? href);
      if (!existsSync(target)) {
        fail(`unresolved link ${href} from ${file}`);
        continue;
      }
      const hop = depth + 1;
      if (hop > 2 && !seen.has(target)) fail(`more than 2 hops: ${file} → ${href}`);
      queue.push([target, hop]);
    }
  }
}

export function checkCommitted(root) {
  const errors = [];
  const fail = (message) => errors.push(message);
  if (!existsSync(root)) {
    fail(`missing directory ${root}`);
    return errors;
  }
  const files = walk(root);
  if (!files.length) fail(`no files under ${root}`);

  const blocks = new Map();
  const byDir = new Map();
  for (const file of files) {
    const base = rel(root, file);
    const text = readFileSync(file, "utf8");
    const dir = dirname(file);
    const bucket = byDir.get(dir) ?? [];
    bucket.push(file);
    byDir.set(dir, bucket);
    if (!text.trim()) {
      fail(`empty file ${base}`);
      continue;
    }
    if (text.includes("figd_")) fail(`${base} contains a figd_ token`);
    if (base === "pack.txt") continue;
    if (!base.endsWith(".md")) {
      fail(`garbage file ${base}`);
      continue;
    }
    const name = base.slice(base.lastIndexOf("/") + 1);
    if (name === "index.md") {
      if (!text.startsWith("# ") || !text.includes("\nbuilt:")) fail(`garbage file ${base}`);
      const lines = text.split("\n");
      const linked = lines.filter((line) => /^- \[[^\]]+\]\([^)]+\.md\)/.test(line));
      if (!linked.length) fail(`missing index lines in ${base}`);
      for (const line of lines) {
        if (line.length > 150) fail(`index line is ${line.length} characters in ${base}`);
      }
      checkHops(file, fail);
      continue;
    }
    const bytes = Buffer.byteLength(text);
    if (bytes > 4096) fail(`${base} is ${bytes} bytes`);
    if (!text.startsWith("# ") || !text.includes("](index.md)")) {
      fail(`garbage file ${base}`);
      continue;
    }
    const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
    for (let index = 0; index + 4 <= lines.length; index += 1) {
      const block = lines.slice(index, index + 4).join("\n");
      const prior = blocks.get(block);
      if (prior && prior !== file) fail(`copied block over 3 lines in ${base} and ${rel(root, prior)}`);
      else if (!prior) blocks.set(block, file);
    }
  }

  for (const [dir, entries] of byDir) {
    const indexFile = entries.find((file) => basename(file) === "index.md");
    if (!indexFile) {
      const stray = entries.filter((file) => file.endsWith(".md"));
      if (stray.length) fail(`missing index.md in ${rel(root, dir) || "."}`);
      continue;
    }
    const indexText = readFileSync(indexFile, "utf8");
    const linked = new Set(
      [...indexText.matchAll(/^- \[([^\]]+)\]\(([^)]+)\)/gm)].map((match) => match[2]),
    );
    for (const file of entries) {
      if (!file.endsWith(".md") || file === indexFile) continue;
      const name = basename(file);
      if (!linked.has(name)) {
        fail(`missing index line for ${rel(root, file)}`);
        fail(`orphaned file ${rel(root, file)}`);
      }
    }
    for (const name of linked) {
      const target = join(dir, name);
      if (!existsSync(target)) fail(`missing index line target ${rel(root, target)}`);
    }
  }

  const packPath = join(root, "pack.txt");
  if (!existsSync(packPath)) fail("missing pack.txt");
  else {
    const tokens = Math.ceil(readFileSync(packPath, "utf8").length / 4);
    if (tokens > 6000) fail(`context pack is ${tokens} tokens`);
  }

  let largest = 0;
  for (const entries of byDir.values()) {
    if (!entries.some((file) => basename(file) === "index.md")) continue;
    let chars = 0;
    for (const file of entries) if (file.endsWith(".md")) chars += readFileSync(file, "utf8").length;
    largest = Math.max(largest, Math.ceil(chars / 4));
  }
  if (largest > 6000) fail(`largest library is ${largest} tokens`);
  return errors;
}

function fileMap(root) {
  const out = new Map();
  if (!existsSync(root)) return out;
  for (const file of walk(root)) out.set(rel(root, file), readFileSync(file, "utf8"));
  return out;
}

export function checkSync(root) {
  const tmp = mkdtempSync(join(tmpdir(), "meaning-gen-"));
  const errors = [];
  try {
    const child = spawnSync(process.execPath, [join(repo, "scripts/build-meaning-sock.mjs"), tmp], {
      cwd: repo,
      encoding: "utf8",
    });
    if (child.status !== 0) {
      errors.push(`generator failed\n${child.stdout ?? ""}\n${child.stderr ?? ""}`);
      return errors;
    }
    const want = fileMap(tmp);
    const got = fileMap(root);
    for (const [path, text] of want) {
      if (!got.has(path)) errors.push(`missing ${path} (generator wrote it)`);
      else if (got.get(path) !== text) errors.push(`${path} is out of sync with the generator`);
    }
    for (const path of got.keys()) {
      if (!want.has(path)) errors.push(`orphaned file ${path} (generator did not write it)`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return errors;
}

function main() {
  const root = process.argv[2];
  if (!root) {
    process.stderr.write("Usage: node scripts/check-meaning-sock.mjs <dir> [--structural]\n");
    process.exit(1);
  }
  const structural = process.argv.includes("--structural");
  const errors = structural ? checkCommitted(root) : [...checkCommitted(root), ...checkSync(root)];
  if (errors.length) {
    process.stderr.write(`${errors.join("\n")}\n`);
    process.exit(1);
  }
  const count = walk(root).filter((file) => file.endsWith(".md")).length;
  const tokens = Math.ceil(readFileSync(join(root, "pack.txt"), "utf8").length / 4);
  process.stdout.write(`meaning pack ${tokens} tokens\nmeaning sock files ok (${count} markdown)\n`);
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) main();
