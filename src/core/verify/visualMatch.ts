import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

/**
 * Visual match, worth 0-20. Compares a PNG in `.resolve/figma-images/` with a render of the coded component.
 * Resolve does not read or store a Figma token. A missing PNG or browser stays at 0 and does not throw.
 */

export interface VisualFile { file: string; abs: string }

export interface VisualSignal { points: number; text: string }

/** Tests pass a shot so ordering can be checked when no browser is installed. Production leaves this unset. */
export type VisualShot = (input: { htmlPath: string; width: number; height: number; codeName: string }) => Buffer | undefined;

let shotOverride: VisualShot | undefined;
let playwrightMiss = false;
let chromeMiss = false;
let chromeBroken = false;
let noBrowser = false;
const shotCache = new Map<string, Buffer>();

export function setVisualShot(next: VisualShot | undefined): void {
  shotOverride = next;
}

/** 0-20 from two PNGs. 0 when either file cannot be read. Never throws. */
export function visualPoints(figma: Buffer, code: Buffer): number {
  try {
    const left = decodePng(figma);
    const right = decodePng(code);
    if (!left || !right) return 0;
    return compareRgba(left, right);
  } catch {
    return 0;
  }
}

/** One signal line. Points stay 0, with a next: step, when the PNG or the browser is missing. */
export function visualSignal(input: {
  repo?: string;
  home?: string;
  figmaName: string;
  nodeId?: string;
  dsId?: string;
  codeName: string;
  files: VisualFile[];
}): VisualSignal {
  try {
    return measure(input);
  } catch {
    return unmeasured("the visual check did not finish. Nothing failed.");
  }
}

function unmeasured(next: string): VisualSignal {
  return { points: 0, text: `visual 0/20 not yet measured. next: ${next}` };
}

function measure(input: { repo?: string; home?: string; figmaName: string; nodeId?: string; dsId?: string; codeName: string; files: VisualFile[] }): VisualSignal {
  const repo = input.repo ?? "";
  const dirs = imageDirs(repo, input.home);
  if (!dirs.length) return unmeasured("pass a repo so Resolve can read .resolve/figma-images. Resolve does not use a Figma token.");
  const hints = [input.nodeId, input.dsId, input.figmaName].filter((item): item is string => Boolean(item && item.trim()));
  const image = findPng(dirs, hints);
  if (!image) {
    const stem = fileStem(input.nodeId || input.dsId || input.figmaName || "component");
    return unmeasured(`export a PNG of this Figma component to .resolve/figma-images/${stem}.png (the id or the name). Resolve does not use a Figma token.`);
  }
  const decoded = readPng(image.abs);
  if (!decoded) return unmeasured("the PNG in .resolve/figma-images could not be read. Export an 8-bit non-interlaced PNG and try again.");
  const html = findHtml(input.files, input.codeName, repo);
  if (!html) return unmeasured("add an HTML file for the coded component, or an example HTML file beside it, so it can be rendered.");
  const width = Math.max(1, Math.min(800, decoded.w));
  const height = Math.max(1, Math.min(800, decoded.h));
  const shot = render(html, width, height, input.codeName);
  if ("next" in shot) return unmeasured(shot.next);
  const codeImg = decodePng(shot.png);
  if (!codeImg) return unmeasured("the coded component rendered, but the screenshot was not a readable PNG. Visual match stays 0.");
  const points = compareRgba(decoded, codeImg);
  return { points, text: `visual ${points}/20 ${relPath(repo, image.abs)} ${html.file}`.trim() };
}

function imageDirs(repo: string, home?: string): string[] {
  const dirs = [repo ? join(repo, ".resolve", "figma-images") : "", home ? join(home, "figma-images") : ""].filter(Boolean);
  return [...new Set(dirs)];
}

function findPng(dirs: string[], hints: string[]): { abs: string } | undefined {
  for (const hint of hints) {
    const forms = nameForms(hint);
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      let names: string[] = [];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      const pngs = names.filter((name) => name.toLowerCase().endsWith(".png"));
      for (const form of forms) {
        const hit = pngs.find((name) => name.slice(0, -4).toLowerCase() === form.toLowerCase());
        if (hit) return { abs: join(dir, hit) };
      }
    }
  }
  return undefined;
}

function nameForms(value: string): string[] {
  const leaf = value.split(/[/\\]/).pop() ?? value;
  const list = [value, leaf, value.replace(/:/g, "-"), leaf.replace(/:/g, "-"), value.replace(/[/:\\]+/g, "-"), leaf.replace(/\s+/g, "-")];
  return [...new Set(list.map((item) => item.trim()).filter(Boolean))];
}

function fileStem(value: string): string {
  const leaf = (value.split(/[/\\]/).pop() ?? value).replace(/:/g, "-");
  const stem = leaf.replace(/[^\w.@+-]+/g, "-").replace(/^-+|-+$/g, "");
  return stem || "component";
}

function readPng(abs: string): Rgba | undefined {
  try {
    if (!existsSync(abs) || statSync(abs).size > 8_000_000) return undefined;
    return decodePng(readFileSync(abs));
  } catch {
    return undefined;
  }
}

function findHtml(files: VisualFile[], codeName: string, repo: string): { file: string; abs: string; css: string } | undefined {
  const listed = files.find((file) => /\.html?$/i.test(file.file) && safeFile(repo, file.abs));
  const picked = listed ?? exampleFile(files, codeName, repo);
  if (!picked) return undefined;
  return { file: picked.file, abs: picked.abs, css: cssText(files, picked.abs, repo) };
}

function exampleFile(files: VisualFile[], codeName: string, repo: string): VisualFile | undefined {
  for (const file of files) {
    if (!file.file.endsWith("component.json") || !safeFile(repo, file.abs)) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(file.abs, "utf8").replace(/^\uFEFF/, ""));
      const example = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { example?: unknown }).example : undefined;
      if (typeof example !== "string" || !example.trim() || !/\.html?$/i.test(example)) continue;
      const abs = join(dirname(file.abs), example);
      if (safeFile(repo, abs)) return { file: example.split(sep).join("/"), abs };
    } catch {
      continue;
    }
  }
  const names = ["example.html", join("examples", `${codeName}.html`), `${codeName}.example.html`];
  for (const dir of [...new Set(files.map((file) => dirname(file.abs)))]) {
    for (const name of names) {
      const abs = join(dir, name);
      if (safeFile(repo, abs)) return { file: name.split(sep).join("/"), abs };
    }
  }
  return undefined;
}

function cssText(files: VisualFile[], htmlAbs: string, repo: string): string {
  const parts: string[] = [];
  const take = (abs: string) => {
    if (!abs.toLowerCase().endsWith(".css") || !safeFile(repo, abs)) return;
    try {
      parts.push(readFileSync(abs, "utf8"));
    } catch {
      /* a missing sheet stays out of the page */
    }
  };
  for (const file of files) take(file.abs);
  let html = "";
  try {
    html = readFileSync(htmlAbs, "utf8");
  } catch {
    html = "";
  }
  for (const match of html.matchAll(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/gi)) {
    const href = match[1] ?? "";
    if (!href || /^(https?:|data:|\/\/)/i.test(href)) continue;
    take(join(dirname(htmlAbs), href));
  }
  return parts.join("\n").replace(/<\/style/gi, "<\\/style");
}

function safeFile(repo: string, abs: string): boolean {
  if (!existsSync(abs)) return false;
  if (!repo) return true;
  const root = join(repo);
  const target = join(abs);
  return target === root || target.startsWith(`${root}${sep}`);
}

function relPath(repo: string, abs: string): string {
  const root = repo ? join(repo) : "";
  const target = abs.split(sep).join("/");
  if (root && (join(abs) === root || join(abs).startsWith(`${root}${sep}`))) return join(abs).slice(root.length + 1).split(sep).join("/");
  return target;
}

function render(html: { abs: string; css: string }, width: number, height: number, codeName: string): { png: Buffer } | { next: string } {
  if (shotOverride) {
    try {
      const png = shotOverride({ htmlPath: html.abs, width, height, codeName });
      if (isPng(png)) return { png };
      return { next: "the render did not return a PNG. Visual match stays 0." };
    } catch {
      return { next: "the render did not finish. Visual match stays 0." };
    }
  }
  let source = "";
  try {
    source = readFileSync(html.abs, "utf8");
  } catch {
    return { next: "the component HTML could not be read, so it was not rendered." };
  }
  const page = wrap(source, html.css, width, height);
  const key = createHash("sha256").update(`${width}x${height}`).update(page).digest("hex");
  const cached = shotCache.get(key);
  if (cached) return { png: cached };
  const dir = mkdtempSync(join(tmpdir(), "resolve-visual-"));
  try {
    const file = join(dir, "page.html");
    writeFileSync(file, page);
    const png = launchShot(file, width, height);
    if (!png) return { next: "install an optional headless browser (playwright, or Chrome) to render the coded component. Visual match stays 0 until then." };
    shotCache.set(key, png);
    return { png };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* the temp page is only for the shot */
    }
  }
}

function wrap(html: string, css: string, width: number, height: number): string {
  const style = `html,body{margin:0;padding:0;background:#fff;width:${width}px;height:${height}px}${css}`;
  if (/<head[\s>]/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1><style>${style}</style>`);
  if (/<html[\s>]/i.test(html)) return html.replace(/<html([^>]*)>/i, `<html$1><head><style>${style}</style></head>`);
  return `<!doctype html><html><head><meta charset="utf-8"><style>${style}</style></head><body>${html}</body></html>`;
}

function launchShot(file: string, width: number, height: number): Buffer | undefined {
  if (noBrowser) return undefined;
  const playwright = playwrightEntry();
  if (playwright) {
    const png = runRunner(["--playwright", playwright, file, String(width), String(height)]);
    if (png) return png;
  }
  const chrome = chromeBin();
  if (chrome) {
    const png = runRunner(["--chrome", chrome, file, String(width), String(height)]);
    if (png) return png;
  }
  if (!playwright && !chrome) noBrowser = true;
  return undefined;
}

function playwrightEntry(): string | undefined {
  if (playwrightMiss) return undefined;
  try {
    return createRequire(fileURLToPath(import.meta.url)).resolve("playwright");
  } catch {
    playwrightMiss = true;
    return undefined;
  }
}

function chromeBin(): string | undefined {
  if (chromeMiss || chromeBroken) return undefined;
  const env = process.env["RESOLVE_CHROME"];
  if (env && existsSync(env)) return env;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const found = spawnSync("which", [name], { encoding: "utf8" });
    const path = found.status === 0 ? found.stdout.trim().split("\n")[0] : "";
    if (path) return path;
  }
  chromeMiss = true;
  return undefined;
}

function runRunner(args: string[]): Buffer | undefined {
  const result = spawnSync(process.execPath, [runnerPath(), ...args], { timeout: 15000, maxBuffer: 8_000_000 });
  if (isPng(result.stdout)) return result.stdout;
  const err = result.stderr?.toString() ?? "";
  if (args[0] === "--playwright" && /Executable doesn't exist|browserType\.launch|no chromium/.test(err)) playwrightMiss = true;
  if (args[0] === "--chrome" && /browser did not start|render timed out/.test(err)) chromeBroken = true;
  return undefined;
}

function isPng(buf: Buffer | undefined): buf is Buffer {
  return Boolean(buf && buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47);
}

let runner: string | undefined;
function runnerPath(): string {
  if (runner && existsSync(runner)) return runner;
  runner = join(tmpdir(), "resolve-visual-shot.mjs");
  writeFileSync(runner, RUNNER);
  return runner;
}

interface Rgba { w: number; h: number; data: Uint8Array }

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf: Buffer, start: number, length: number): number {
  let c = 0xffffffff;
  for (let i = 0; i < length; i++) c = CRC_TABLE[(c ^ buf[start + i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function decodePng(buf: Buffer): Rgba | undefined {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return undefined;
  let width = 0;
  let height = 0;
  let depth = 0;
  let color = 0;
  let interlace = 1;
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const start = offset + 8;
    const next = start + length + 4;
    if (next > buf.length) return undefined;
    if (crc32(buf, offset + 4, 4 + length) !== buf.readUInt32BE(start + length)) return undefined;
    const type = buf.toString("ascii", offset + 4, offset + 8);
    if (type === "IHDR") {
      width = buf.readUInt32BE(start);
      height = buf.readUInt32BE(start + 4);
      depth = buf[start + 8] ?? 0;
      color = buf[start + 9] ?? 0;
      interlace = buf[start + 12] ?? 1;
      if (buf[start + 10] !== 0 || buf[start + 11] !== 0) return undefined;
    } else if (type === "IDAT") idat.push(buf.subarray(start, start + length));
    else if (type === "IEND") break;
    offset = next;
  }
  const channels = color === 0 ? 1 : color === 2 ? 3 : color === 4 ? 2 : color === 6 ? 4 : 0;
  if (!width || !height || width > 4096 || height > 4096 || depth !== 8 || interlace !== 0 || !channels || !idat.length) return undefined;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return undefined;
  }
  const samples = unfilter(raw, width, height, channels);
  if (!samples) return undefined;
  return { w: width, h: height, data: toRgba(samples, width, height, channels) };
}

function unfilter(raw: Buffer, width: number, height: number, channels: number): Uint8Array | undefined {
  const rowBytes = width * channels;
  const out = new Uint8Array(height * rowBytes);
  let src = 0;
  for (let y = 0; y < height; y++) {
    if (src >= raw.length) return undefined;
    const filter = raw[src++] ?? 0;
    const start = y * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      if (src >= raw.length) return undefined;
      const value = raw[src++] ?? 0;
      const left = x >= channels ? out[start + x - channels]! : 0;
      const up = y > 0 ? out[start - rowBytes + x]! : 0;
      const ul = y > 0 && x >= channels ? out[start - rowBytes + x - channels]! : 0;
      let next = value;
      if (filter === 1) next = (value + left) & 255;
      else if (filter === 2) next = (value + up) & 255;
      else if (filter === 3) next = (value + ((left + up) >> 1)) & 255;
      else if (filter === 4) next = (value + paeth(left, up, ul)) & 255;
      else if (filter !== 0) return undefined;
      out[start + x] = next;
    }
  }
  return out;
}

function paeth(left: number, up: number, ul: number): number {
  const p = left + up - ul;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - ul);
  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return up;
  return ul;
}

function toRgba(samples: Uint8Array, width: number, height: number, channels: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const d = i * 4;
    if (channels === 1) {
      out[d] = out[d + 1] = out[d + 2] = samples[s] ?? 0;
      out[d + 3] = 255;
    } else if (channels === 2) {
      out[d] = out[d + 1] = out[d + 2] = samples[s] ?? 0;
      out[d + 3] = samples[s + 1] ?? 255;
    } else if (channels === 3) {
      out[d] = samples[s] ?? 0;
      out[d + 1] = samples[s + 1] ?? 0;
      out[d + 2] = samples[s + 2] ?? 0;
      out[d + 3] = 255;
    } else {
      out[d] = samples[s] ?? 0;
      out[d + 1] = samples[s + 1] ?? 0;
      out[d + 2] = samples[s + 2] ?? 0;
      out[d + 3] = samples[s + 3] ?? 255;
    }
  }
  return out;
}

const GRID = 32;

function compareRgba(left: Rgba, right: Rgba): number {
  const a = fit(trim(left));
  const b = fit(trim(right));
  const score = (ssim(a, b, 0) + ssim(a, b, 1) + ssim(a, b, 2)) / 3;
  if (!Number.isFinite(score)) return 0;
  return Math.round(Math.max(0, Math.min(1, score)) * 20);
}

function trim(img: Rgba): Rgba {
  const blank = (x: number, y: number) => {
    const i = (y * img.w + x) * 4;
    const r = img.data[i] ?? 0;
    const g = img.data[i + 1] ?? 0;
    const b = img.data[i + 2] ?? 0;
    const a = img.data[i + 3] ?? 0;
    return a < 16 || (r > 248 && g > 248 && b > 248);
  };
  let top = 0;
  let bottom = img.h - 1;
  let left = 0;
  let right = img.w - 1;
  const rowBlank = (y: number) => {
    for (let x = 0; x < img.w; x++) if (!blank(x, y)) return false;
    return true;
  };
  const colBlank = (x: number, y0: number, y1: number) => {
    for (let y = y0; y <= y1; y++) if (!blank(x, y)) return false;
    return true;
  };
  while (top < bottom && rowBlank(top)) top++;
  while (bottom > top && rowBlank(bottom)) bottom--;
  while (left < right && colBlank(left, top, bottom)) left++;
  while (right > left && colBlank(right, top, bottom)) right--;
  const w = right - left + 1;
  const h = bottom - top + 1;
  if (w < 2 || h < 2 || (w === img.w && h === img.h)) return img;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) data.set(img.data.subarray(((top + y) * img.w + left) * 4, ((top + y) * img.w + left) * 4 + w * 4), y * w * 4);
  return { w, h, data };
}

function fit(img: Rgba): Float32Array {
  const out = new Float32Array(GRID * GRID * 3);
  for (let y = 0; y < GRID; y++) {
    const y0 = Math.floor((y * img.h) / GRID);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.h) / GRID));
    for (let x = 0; x < GRID; x++) {
      const x0 = Math.floor((x * img.w) / GRID);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.w) / GRID));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let yy = y0; yy < y1 && yy < img.h; yy++) {
        for (let xx = x0; xx < x1 && xx < img.w; xx++) {
          const i = (yy * img.w + xx) * 4;
          const a = (img.data[i + 3] ?? 255) / 255;
          r += (img.data[i] ?? 0) * a + 255 * (1 - a);
          g += (img.data[i + 1] ?? 0) * a + 255 * (1 - a);
          b += (img.data[i + 2] ?? 0) * a + 255 * (1 - a);
          n++;
        }
      }
      const o = (y * GRID + x) * 3;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
    }
  }
  return out;
}

function ssim(a: Float32Array, b: Float32Array, channel: number): number {
  const c1 = 6.5025;
  const c2 = 58.5225;
  const win = 8;
  let acc = 0;
  let n = 0;
  for (let y = 0; y + win <= GRID; y += win) {
    for (let x = 0; x + win <= GRID; x += win) {
      let muA = 0;
      let muB = 0;
      for (let yy = 0; yy < win; yy++) for (let xx = 0; xx < win; xx++) {
        const i = ((y + yy) * GRID + (x + xx)) * 3 + channel;
        muA += a[i] ?? 0;
        muB += b[i] ?? 0;
      }
      const m = win * win;
      muA /= m;
      muB /= m;
      let va = 0;
      let vb = 0;
      let cov = 0;
      for (let yy = 0; yy < win; yy++) for (let xx = 0; xx < win; xx++) {
        const i = ((y + yy) * GRID + (x + xx)) * 3 + channel;
        const da = (a[i] ?? 0) - muA;
        const db = (b[i] ?? 0) - muB;
        va += da * da;
        vb += db * db;
        cov += da * db;
      }
      va /= m - 1;
      vb /= m - 1;
      cov /= m - 1;
      acc += ((2 * muA * muB + c1) * (2 * cov + c2)) / ((muA * muA + muB * muB + c1) * (va + vb + c2));
      n++;
    }
  }
  return n ? acc / n : 0;
}

const RUNNER = `import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const mode = process.argv[2];
const spec = process.argv[3];
const file = process.argv[4];
const width = Number(process.argv[5]);
const height = Number(process.argv[6]);
const url = pathToFileURL(file).href;
const fail = (error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); };
setTimeout(() => fail("render timed out"), 12000);

if (mode === "--playwright") {
  try {
    const mod = await import(spec);
    const chromium = mod.chromium || (mod.default && mod.default.chromium);
    if (!chromium) fail("playwright has no chromium");
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
      await page.goto(url, { waitUntil: "load", timeout: 8000 });
      process.stdout.write(await page.screenshot({ type: "png", clip: { x: 0, y: 0, width, height } }));
    } finally {
      await browser.close();
    }
    process.exit(0);
  } catch (error) {
    fail(error);
  }
}

const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const found = address && typeof address === "object" ? address.port : 0;
    server.close(() => resolve(found));
  });
});
const profile = mkdtempSync(join(tmpdir(), "resolve-chrome-"));
const child = spawn(spec, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars",
  "--no-first-run", "--no-default-browser-check", "--force-device-scale-factor=1",
  "--remote-debugging-port=" + port, "--user-data-dir=" + profile, "about:blank",
], { stdio: "ignore" });
const kill = () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } try { rmSync(profile, { recursive: true, force: true }); } catch { /* temp profile */ } };
process.on("SIGTERM", () => { kill(); process.exit(1); });
let version;
for (let i = 0; i < 40 && !version; i++) {
  try {
    const res = await fetch("http://127.0.0.1:" + port + "/json/version");
    if (res.ok) version = await res.json();
  } catch { /* chrome is still starting */ }
  if (!version) await new Promise((r) => setTimeout(r, 100));
}
if (!version?.webSocketDebuggerUrl) { kill(); fail("browser did not start"); }
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
let seq = 0;
const pending = new Map();
let onLoad = () => {};
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method === "Page.loadEventFired") onLoad();
  const hit = msg.id && pending.get(msg.id);
  if (!hit) return;
  pending.delete(msg.id);
  if (msg.error) hit.reject(new Error(msg.error.message || "cdp"));
  else hit.resolve(msg.result);
});
const send = (method, params, sessionId) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
try {
  const target = await send("Target.createTarget", { url: "about:blank" });
  const attached = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const sid = attached.sessionId;
  await send("Page.enable", {}, sid);
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sid);
  const loaded = new Promise((resolve) => { onLoad = resolve; });
  await send("Page.navigate", { url }, sid);
  await Promise.race([loaded, new Promise((r) => setTimeout(r, 1000))]);
  const shot = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width, height, scale: 1 }, fromSurface: true }, sid);
  process.stdout.write(Buffer.from(shot.data, "base64"));
} finally {
  try { ws.close(); } catch { /* socket */ }
  kill();
}
process.exit(0);
`;
