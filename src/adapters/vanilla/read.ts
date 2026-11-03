import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parseDsId } from "@/core/rules/dsId";
import { parseCss, selectorClasses, varRefs } from "@/server/code/css";
import { parseHtml, type HtmlDoc, type HtmlTag } from "@/server/code/html";
import type { CatalogEntry, CodeCatalog } from "@/server/code/scan";

/**
 * Vanilla HTML/CSS/JS component folder in, catalog entries out.
 * A component is a folder or file whose root element has `data-ds-id`, or a folder with `component.json`.
 * Classes, tokens and other data-* attributes are evidence. They never link a pair.
 * Nothing here throws: a bad URL, a bad ID, or bad JSON is a warning with a next: step.
 */

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache", "coverage", ".resolve"]);
const CONTAINERS = new Set(["building-blocks", "blocks", "components", "primitives", "recipes", "patterns", "compositions"]);
const WRAP = new Set(["html", "head", "body", "link", "meta", "script", "style", "title", "base"]);
const posix = (path: string) => path.split("\\").join("/");
const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function isGitSpec(spec: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/.test(spec) || spec.endsWith(".git");
}

/** A local folder, or a clone of a git URL at `ref`. Never throws. */
export function openComponentSource(spec: string | undefined, ref?: string): { root?: string; warnings: string[] } {
  if (!spec) return { warnings: [] };
  if (existsSync(spec)) {
    try {
      if (statSync(spec).isDirectory()) return { root: spec, warnings: [] };
    } catch {
      return { warnings: [`${spec} could not be read. next: pass a folder, or a git URL and ref.`] };
    }
  }
  if (!isGitSpec(spec)) return { warnings: [] };
  return cloneGit(spec, ref);
}

function cloneGit(url: string, ref?: string): { root?: string; warnings: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "resolve-vanilla-"));
  const fail = (next: string) => ({ warnings: [`Could not read ${url}${ref ? ` at ${ref}` : ""}. next: ${next}`] });
  if (!ref) {
    const cloned = spawnSync("git", ["clone", "--depth", "1", "--quiet", url, dir], { encoding: "utf8", timeout: 20000 });
    return cloned.status === 0 ? { root: dir, warnings: [] } : fail("check the URL, or pass a local folder.");
  }
  const init = spawnSync("git", ["init", "--quiet", dir], { encoding: "utf8", timeout: 20000 });
  if (init.status !== 0) return fail("check that git is installed, or pass a local folder.");
  const fetched = spawnSync("git", ["fetch", "--depth", "1", "--quiet", url, ref], { cwd: dir, encoding: "utf8", timeout: 20000 });
  if (fetched.status !== 0) return fail("check the URL and ref, or pass a local folder.");
  const checked = spawnSync("git", ["checkout", "--quiet", "FETCH_HEAD"], { cwd: dir, encoding: "utf8", timeout: 20000 });
  return checked.status === 0 ? { root: dir, warnings: [] } : fail("check the ref, or pass a local folder.");
}

interface Hit {
  name: string;
  dsId?: string;
  classes: string[];
  tokens: string[];
  variants: string[];
  markup: string;
  files: string[];
}

export function emptyCodeCatalog(repoPath: string, warnings: string[]): CodeCatalog {
  return {
    version: 1,
    builtAt: new Date().toISOString(),
    repoPath,
    cssFiles: [],
    components: [],
    globalClasses: [],
    deprecated: {},
    tokens: { names: [], colors: {}, fonts: {} },
    ...(warnings.length ? { sourceWarnings: warnings } : {}),
  };
}

/** Adds vanilla components the CSS package scan did not already name. Returns warnings; each has a next: step. */
export function applyVanilla(root: string, entries: CatalogEntry[]): { warnings: string[]; jsonFiles: string[] } {
  const found = readVanilla(root);
  const have = new Map(entries.map((entry) => [entry.name, entry]));
  for (const hit of found.components) {
    const existing = have.get(hit.name);
    if (existing) {
      if (!existing.dsId && hit.dsId) existing.dsId = hit.dsId;
      continue;
    }
    const entry = toEntry(hit);
    entries.push(entry);
    have.set(entry.name, entry);
  }
  return found;
}

function readVanilla(root: string): { components: Hit[]; warnings: string[]; jsonFiles: string[] } {
  const warnings: string[] = [];
  const files = listFiles(root);
  const jsonFiles = files.filter((file) => file.rel.endsWith("/component.json") || file.rel === "component.json").map((file) => file.rel);
  const byDir = new Map<string, typeof files>();
  for (const file of files) {
    const dir = posix(relative(root, join(root, file.rel, "..")));
    const list = byDir.get(dir) ?? [];
    list.push(file);
    byDir.set(dir, list);
  }
  const components: Hit[] = [];
  const taken = new Set<string>();
  for (const [dir, group] of [...byDir.entries()].sort((a, b) => byCode(a[0], b[0]))) {
    if (!dir || dir === ".") continue;
    const name = dir.split("/").pop() as string;
    if (CONTAINERS.has(name.toLowerCase())) continue;
    const html = group.filter((file) => /\.html?$/i.test(file.name));
    const json = group.find((file) => file.name === "component.json");
    const css = group.filter((file) => file.name.toLowerCase().endsWith(".css"));
    if (!html.length && !json) continue;
    const docs = html.map((file) => ({ file, doc: readHtml(file.abs) }));
    const explicit = docs.some(({ doc }) => Boolean(rootTag(doc)?.attrs["data-ds-id"]?.trim()));
    if (!json && !explicit && docs.every(({ file, doc }) => isHub(doc, file.name, name, css.length > 0))) continue;
    const hit = compose(name, docs, css, json, warnings);
    if (taken.has(hit.name)) {
      warnings.push(`${hit.name}: two folders use this name. next: rename one folder. The first was kept.`);
      continue;
    }
    taken.add(hit.name);
    for (const file of html) taken.add(file.rel);
    components.push(hit);
  }
  for (const file of files.filter((item) => /\.html?$/i.test(item.name) && !taken.has(item.rel))) {
    const doc = readHtml(file.abs);
    const rootEl = rootTag(doc);
    const raw = rootEl?.attrs["data-ds-id"]?.trim();
    if (!raw) continue;
    const name = file.name.replace(/\.html?$/i, "");
    if (CONTAINERS.has(name.toLowerCase()) || taken.has(name)) continue;
    const hit = compose(name, [{ file, doc }], [], undefined, warnings);
    taken.add(name);
    components.push(hit);
  }
  components.sort((a, b) => byCode(a.name, b.name));
  return { components, warnings, jsonFiles };
}

function compose(
  name: string,
  docs: Array<{ file: { rel: string; abs: string }; doc: HtmlDoc }>,
  css: Array<{ rel: string; abs: string }>,
  json: { rel: string; abs: string } | undefined,
  warnings: string[],
): Hit {
  const classes = new Set<string>();
  const tokens = new Set<string>();
  const variants = new Set<string>();
  let markup = `<div class="${name}">`;
  let htmlId: string | undefined;
  for (const { doc } of docs) {
    const rootEl = rootTag(doc);
    if (rootEl) {
      const cls = rootEl.classes[0];
      markup = `<${rootEl.tag}${cls ? ` class="${cls}"` : ""}>`;
      htmlId = rootEl.attrs["data-ds-id"];
      for (const [key, value] of Object.entries(rootEl.attrs)) {
        if (!key.startsWith("data-") || key === "data-ds-id") continue;
        const label = key.slice("data-".length);
        if (label) variants.add(value ? `${label}=${value}` : label);
      }
      if (rootEl.attrs["style"]) for (const token of varRefs(rootEl.attrs["style"])) tokens.add(token);
    }
    for (const tag of doc.tags) for (const cls of [...tag.classes, ...tag.dynamicClasses]) classes.add(cls);
    for (const style of doc.styles) collectCss(style.css, classes, tokens);
  }
  for (const file of css) collectCss(readText(file.abs), classes, tokens);
  const fromJson = json ? readManifestId(json.rel, readText(json.abs), warnings) : {};
  const dsId = chooseId(name, htmlId, fromJson.dsId, warnings);
  return {
    name,
    ...(dsId ? { dsId } : {}),
    classes: [...classes].sort(byCode),
    tokens: [...tokens].sort(byCode).slice(0, 25),
    variants: [...variants].sort(byCode),
    markup,
    files: [...docs.map(({ file }) => file.rel), ...css.map((file) => file.rel), ...(json ? [json.rel] : [])].sort(byCode),
  };
}

function chooseId(name: string, htmlRaw: string | undefined, jsonRaw: string | undefined, warnings: string[]): string | undefined {
  const html = oneId(htmlRaw);
  const json = oneId(jsonRaw);
  if (html.bad) warnings.push(badId(name, html.raw as string));
  if (json.bad) warnings.push(badId(name, json.raw as string));
  if (html.id && json.id && html.id !== json.id) {
    warnings.push(`${name}: data-ds-id is "${html.id}" and component.json dsId is "${json.id}", so they are not linked. next: put the same ID on both.`);
    return undefined;
  }
  return html.id ?? json.id;
}

function oneId(raw: string | undefined): { raw?: string; id?: string; bad?: boolean } {
  if (typeof raw !== "string" || !raw.trim()) return {};
  const text = raw.trim();
  const id = parseDsId(text)?.id;
  return id ? { raw: text, id } : { raw: text, bad: true };
}

function badId(name: string, raw: string): string {
  return `${name}: shared ID "${raw}" is not ds@semver.tier.name, so it is not linked. next: write it as ${exampleId(name)} on data-ds-id or component.json dsId.`;
}

function exampleId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const safe = /^[a-z][a-z0-9-]*[a-z0-9]$/.test(slug) ? slug : "component";
  return `ds@1.0.0.core.${safe}`;
}

function readManifestId(rel: string, text: string, warnings: string[]): { dsId?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    warnings.push(`${rel} is not valid JSON, so its dsId was not read. next: fix component.json. HTML in the folder is still used.`);
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    warnings.push(`${rel} is not an object, so its dsId was not read. next: make component.json an object with dsId.`);
    return {};
  }
  const dsId = (parsed as { dsId?: unknown }).dsId;
  return typeof dsId === "string" ? { dsId } : {};
}

function collectCss(css: string, classes: Set<string>, tokens: Set<string>): void {
  const parsed = parseCss(css);
  for (const rule of parsed.rules) {
    for (const cls of selectorClasses(rule.selector)) classes.add(cls);
    for (const decl of rule.decls) {
      if (decl.prop.startsWith("--")) tokens.add(decl.prop);
      for (const token of varRefs(decl.value)) tokens.add(token);
    }
  }
}

function isHub(doc: HtmlDoc, fileName: string, folder: string, hasCss: boolean): boolean {
  const classes = doc.tags.flatMap((tag) => [...tag.classes, ...tag.dynamicClasses]);
  const named = (cls: string) => cls === folder || cls.startsWith(`${folder}--`) || cls.startsWith(`${folder}__`) || cls.startsWith(`${folder}-`);
  const body = doc.tags.some((tag) => tag.tag !== "a" && tag.tag !== "link" && (tag.classes.length > 0 || tag.dynamicClasses.length > 0));
  const owns = classes.some(named) || doc.styles.length > 0 || doc.links.length > 0 || hasCss || (fileName.replace(/\.html?$/i, "").toLowerCase() === folder.toLowerCase() && body);
  const index = /^index\.html?$/i.test(fileName);
  const linked = doc.tags.some((tag) => tag.tag === "a" && tag.attrs["href"]);
  return (index || linked) && !owns;
}

function rootTag(doc: HtmlDoc): HtmlTag | undefined {
  return doc.tags.find((tag) => !WRAP.has(tag.tag));
}

function readHtml(path: string): HtmlDoc {
  return parseHtml(readText(path));
}

function readText(path: string): string {
  try {
    if (statSync(path).size > 500_000) return "";
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

interface Listed { rel: string; abs: string; name: string }

function listFiles(root: string): Listed[] {
  const out: Listed[] = [];
  const visit = (dir: string) => {
    let items: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    try {
      items = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (item.name.startsWith(".") || SKIP.has(item.name)) continue;
      const abs = join(dir, item.name);
      if (item.isDirectory()) visit(abs);
      else if (item.isFile()) out.push({ rel: posix(relative(root, abs)), abs, name: item.name });
    }
  };
  visit(root);
  return out.sort((a, b) => byCode(a.rel, b.rel));
}

function toEntry(hit: Hit): CatalogEntry {
  const roots: string[] = [];
  const modifiers: Record<string, string[]> = {};
  const elements: string[] = [];
  const states: string[] = [];
  for (const cls of hit.classes) {
    if (/^(is|has)-/.test(cls)) states.push(cls);
    else if (cls.includes("__")) elements.push(cls);
    else if (cls.includes("--")) {
      const base = cls.slice(0, cls.indexOf("--"));
      (modifiers[base] ??= []).push(cls);
    } else roots.push(cls);
  }
  for (const list of Object.values(modifiers)) list.sort(byCode);
  const primary = roots.find((cls) => cls === hit.name) ?? roots[0] ?? hit.name;
  return {
    name: hit.name,
    kind: "block",
    description: "",
    variants: hit.variants,
    rules: [],
    ...(hit.dsId ? { dsId: hit.dsId } : {}),
    code: {
      roots: roots.sort(byCode),
      primary,
      modifiers,
      elements: elements.sort(byCode),
      states: states.sort(byCode),
      deprecated: [],
      markup: hit.markup,
      cssFile: hit.files[0] ?? hit.name,
      cssFiles: hit.files,
      tokens: hit.tokens,
      usedIn: 0,
    },
  };
}
