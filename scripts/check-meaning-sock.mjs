/**
 * Meaning SOCK file checks.
 *   node scripts/check-meaning-sock.mjs <dir>
 *
 * Fails when a component file exceeds 4 KB, an index line exceeds 200 characters,
 * a link does not resolve, a link chain is deeper than 2 hops from the index,
 * a context pack is over 6k tokens, or the same 4-line block is copied into two files.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const root = process.argv[2];
if (!root) {
  process.stderr.write("Usage: node scripts/check-meaning-sock.mjs <dir>\n");
  process.exit(1);
}

const errors = [];
const fail = (message) => errors.push(message);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
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

function checkHops(indexPath) {
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

const files = walk(root).filter((path) => path.endsWith(".md"));
if (!files.length) fail(`no markdown under ${root}`);

const blocks = new Map();
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const base = file.slice(root.length + 1);
  if (text.includes("figd_")) fail(`${base} contains a figd_ token`);
  if (base.endsWith("index.md")) {
    for (const line of text.split("\n")) {
      if (line.length > 200) fail(`index line is ${line.length} characters in ${base}`);
    }
    checkHops(file);
    continue;
  }
  const bytes = Buffer.byteLength(text);
  if (bytes > 4096) fail(`${base} is ${bytes} bytes`);
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  for (let index = 0; index + 4 <= lines.length; index += 1) {
    const block = lines.slice(index, index + 4).join("\n");
    const prior = blocks.get(block);
    if (prior && prior !== file) fail(`copied block over 3 lines in ${base} and ${prior.slice(root.length + 1)}`);
    else if (!prior) blocks.set(block, file);
  }
}

const packPath = join(root, "pack.txt");
if (existsSync(packPath)) {
  const tokens = Math.ceil(readFileSync(packPath, "utf8").length / 4);
  if (tokens > 6000) fail(`context pack is ${tokens} tokens`);
  process.stdout.write(`meaning pack ${tokens} tokens\n`);
}

if (errors.length) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`meaning sock files ok (${files.length} markdown)\n`);
