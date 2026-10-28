import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { STORE_DIRS } from "../../core/query/overlayFile.ts";
import type { ResolveConfig } from "../mode.ts";
import { normHex, parseCss, selectorClasses, varRefs } from "./css.ts";
import { parseHtml } from "./html.ts";
import { linkFigma, mappingDigest } from "./map.ts";

/** A Figma component as the catalog keeps it. */
export interface FigmaRef { name: string; fileKey?: string; nodeId?: string; variants?: string[]; aliases?: string[]; published?: boolean; description?: string }
export type MatchBy = "exact" | "alias" | "mapped";

/** One entry per component. `figma` and `code` are both optional; they join by name, alias or the mapping file (see map.ts). */
export interface CatalogEntry {
  name: string;
  kind: "block" | "recipe";
  description: string;
  /** Longer comment text from the CSS, for matching only. */
  doc?: string;
  variants: string[];
  rules: string[];
  status?: string;
  figma?: FigmaRef;
  /** Other Figma components joined to this one (many-to-one). Names only. */
  figmaAlso?: string[];
  matchedBy?: MatchBy;
  /** The names that made the join: the Figma name, this name, and the alias when one was used. */
  matched?: { figma: string; code: string; alias?: string };
  /** Alias names from the mapping file. */
  aliases?: string[];
  /** Figma `base/*` sub-parts of this block. Not separate pairs. */
  parts?: string[];
  code?: {
    roots: string[];
    primary: string;
    modifiers: Record<string, string[]>;
    elements: string[];
    states: string[];
    deprecated: string[];
    markup: string;
    cssFile: string;
    cssFiles: string[];
    tokens: string[];
    usedIn: number;
  };
}

export interface CodeCatalog {
  version: 1;
  builtAt: string;
  repoPath: string;
  cssEntry?: string;
  theme?: { file?: string; name?: string };
  cssFiles: string[];
  components: CatalogEntry[];
  globalClasses: string[];
  deprecated: Record<string, { in: string; note: string }>;
  tokens: { names: string[]; colors: Record<string, string>; fonts: Record<string, string> };
  /** Figma components from the last link, kept so a rescan or a mapping edit can join again offline. */
  figmaMasters?: FigmaMaster[];
  /** Hash of the mapping file the links were made with. */
  mappingDigest?: string;
}

export type FigmaMaster = FigmaRef;

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache", "coverage", ...STORE_DIRS]);
const BLOCK_DIRS = new Set(["building-blocks", "blocks", "components", "primitives"]);
const RECIPE_DIRS = new Set(["recipes", "patterns", "compositions"]);
const MARKER = /\bDS-(STABLE|DEPRECATED|EXPERIMENTAL|BETA)\b/i;
const posix = (path: string) => path.split("\\").join("/");
/** Locale-free string order, so results do not depend on the machine. */
export const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** JSON with every object key sorted: the same catalog always serializes to the same text. */
export function stableJson(value: unknown, space?: number): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => byCode(a, b)).map(([k, x]) => [k, sort(x)])) : v;
  return JSON.stringify(sort(value), null, space);
}

/** Hash of the catalog content. `builtAt` is left out, so a rescan of unchanged files gives the same digest. */
export function catalogDigest(catalog: CodeCatalog): string {
  return createHash("sha256").update(stableJson({ ...catalog, builtAt: "" })).digest("hex").slice(0, 16);
}

const sortedRecord = <T>(record: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(record).sort(([a], [b]) => byCode(a, b)));

export function walkFiles(root: string, ext: string, cap = 2000): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => byCode(a.name, b.name))) {
      if (out.length >= cap) return;
      if (item.isDirectory()) {
        if (!SKIP.has(item.name)) visit(join(dir, item.name));
      } else if (item.name.toLowerCase().endsWith(ext)) out.push(join(dir, item.name));
    }
  };
  visit(root);
  return out;
}

/** Follow @import from an entry stylesheet. Remote and missing imports are reported, not fetched. */
export function importChain(entry: string): { files: string[]; missing: string[] } {
  const files: string[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    files.push(file);
    for (const spec of parseCss(readFileSync(file, "utf8")).imports) {
      if (/^(https?:)?\/\//i.test(spec) || spec.startsWith("data:")) continue;
      const target = resolve(dirname(file), spec.split(/[?#]/)[0] as string);
      if (existsSync(target)) visit(target);
      else missing.push(target);
    }
  };
  visit(entry);
  return { files, missing };
}

function classify(cls: string): { kind: "root" | "modifier" | "element" | "state"; base: string } {
  if (/^(is|has)-/.test(cls)) return { kind: "state", base: "" };
  const mod = cls.indexOf("--");
  if (mod > 0) return { kind: "modifier", base: cls.slice(0, mod) };
  if (cls.includes("__")) return { kind: "element", base: cls.split("__")[0] as string };
  return { kind: "root", base: cls };
}

function componentOf(rel: string): { name: string; kind: "block" | "recipe" } | undefined {
  const parts = rel.split("/");
  for (let i = 0; i < parts.length - 1; i += 1) {
    const dir = (parts[i] as string).toLowerCase();
    const kind = BLOCK_DIRS.has(dir) ? "block" : RECIPE_DIRS.has(dir) ? "recipe" : undefined;
    if (!kind) continue;
    const next = parts[i + 1] as string;
    return { name: i + 2 < parts.length ? next : next.replace(/\.(css|html?)$/i, ""), kind };
  }
  return undefined;
}

function sentences(comments: string[]): string[] {
  const out: string[] = [];
  for (const comment of comments) {
    if (MARKER.test(comment) && comment.includes("|")) continue;
    for (const part of comment.split(/\n|(?<=[.!?])\s+/)) {
      const text = part.trim();
      if (text.length > 12 && text.length <= 200 && (/(?<!-)\b(do not|don't|never|must|only|always|avoid|should)\b(?!-)/i.test(text) || /^use\b/i.test(text))) out.push(text);
    }
  }
  return out;
}

function describe(comments: string[], name: string): string {
  for (const comment of comments) {
    if (MARKER.test(comment) || /^[\W_]+$/.test(comment) || comment.length < 12) continue;
    const text = (comment.split("\n").find((line) => /\w{3}/.test(line)) as string).replace(/^[=\-\s]+|[=\-\s]+$/g, "").replace(/\s*(component\s*)?[-—]\s*css$/i, "").replace(new RegExp(`^${name}\\s*[—:-]\\s*`, "i"), "");
    return (text.split(/(?<=[.!?])\s/)[0] as string).slice(0, 160);
  }
  return "";
}

/** Comment prose (markers and rule banners dropped), kept short: only used to match requests. */
function docText(comments: string[]): string {
  return comments.filter((c) => !MARKER.test(c)).join(" ").replace(/[=\-*_]{3,}/g, " ").replace(/\s+/g, " ").trim().slice(0, 400);
}

function defaultTag(name: string): string {
  if (/button|^btn/.test(name)) return "button";
  if (/input|field|textarea/.test(name)) return "input";
  if (/^select/.test(name)) return "select";
  if (/^table|data-table/.test(name)) return "table";
  if (/^(link|breadcrumb)/.test(name)) return "a";
  if (/^form/.test(name)) return "form";
  return "div";
}

interface Acc {
  name: string;
  kind: "block" | "recipe";
  files: string[];
  counts: Map<string, number>;
  tokens: Set<string>;
  comments: string[];
  status?: string;
}

/** `order` only reorders the files before the build (used by the repeat check). Output does not depend on it. */
export function buildCatalog(cfg: ResolveConfig, order: <T>(items: T[]) => T[] = (items) => items): CodeCatalog {
  const repo = cfg.repoPath;
  if (!repo || !existsSync(repo) || !statSync(repo).isDirectory()) {
    throw new Error(`repoPath is missing or not a folder${repo ? `: ${repo}` : ". Set repoPath in .resolve/config.json or RESOLVE_REPO_PATH."}`);
  }
  let files: string[];
  if (cfg.cssEntry) {
    const entry = resolve(repo, cfg.cssEntry);
    if (!existsSync(entry)) throw new Error(`cssEntry not found: ${entry}`);
    files = importChain(entry).files;
  } else files = walkFiles(repo, ".css");
  const themeFile = cfg.theme && existsSync(resolve(repo, cfg.theme)) && statSync(resolve(repo, cfg.theme)).isFile() ? resolve(repo, cfg.theme) : undefined;
  // Canonical order: stylesheets by path, theme last. The scan never depends on the order the files were found in.
  files = [...order(files).filter((f) => f !== themeFile)].sort((a, b) => byCode(posix(relative(repo, a)), posix(relative(repo, b))));
  if (themeFile) files.push(themeFile);

  const flat = !files.some((f) => componentOf(posix(relative(repo, f))));
  const accs = new Map<string, Acc>();
  const globals = new Set<string>();
  const names = new Set<string>();
  const colors: Record<string, string> = {};
  const fonts: Record<string, string> = {};
  const deprecated: CodeCatalog["deprecated"] = {};
  const pending: Array<{ cls: string; in: string; note: string }> = [];
  const known = new Set<string>();

  for (const file of files) {
    const rel = posix(relative(repo, file));
    const css = parseCss(readFileSync(file, "utf8"));
    const comp = file === themeFile ? undefined : componentOf(rel) ?? (flat ? { name: (rel.split("/").pop() as string).replace(/\.css$/i, ""), kind: "block" as const } : undefined);
    let acc: Acc | undefined;
    if (comp) {
      acc = accs.get(`${comp.kind}:${comp.name}`) ?? { name: comp.name, kind: comp.kind, files: [], counts: new Map(), tokens: new Set(), comments: [] };
      accs.set(`${comp.kind}:${comp.name}`, acc);
      acc.files.push(rel);
      acc.comments.push(...css.comments);
      const marker = css.comments.map((c) => MARKER.exec(c)?.[1]).find(Boolean);
      if (marker) acc.status = marker.toLowerCase();
    }
    const mark = (cls: string, note: string) => pending.push({ cls, in: comp?.name ?? rel, note: note.replace(/[=\-]{3,}/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) });
    for (const comment of css.comments) {
      for (const m of comment.matchAll(/deprecated\W{0,4}\.(-?[A-Za-z_][\w-]*)/gi)) mark(m[1] as string, comment);
    }
    for (const rule of css.rules) {
      const simple = rule.selector.split(",").every((part) => /^\.[\w-]+(::?[\w-]+)?$/.test(part.trim()));
      if (rule.lead && simple && /^[\W_]*@?deprecated\b/i.test(rule.lead)) for (const cls of selectorClasses(rule.selector)) mark(cls, rule.lead);
    }
    for (const rule of css.rules) {
      const classes = selectorClasses(rule.selector);
      for (const cls of classes) {
        known.add(cls);
        if (acc) acc.counts.set(cls, (acc.counts.get(cls) ?? 0) + 1);
        else globals.add(cls);
      }
      for (const { prop, value } of rule.decls) {
        if (prop.startsWith("--")) {
          names.add(prop);
          if (!classes.length && !rule.selector.startsWith("@")) {
            const hex = normHex(value);
            if (hex || /^(rgb|hsl)a?\(/i.test(value)) colors[prop] = hex ?? value;
            else if (/font-family/.test(prop)) fonts[prop] = value;
          }
        }
        if (acc) for (const ref of varRefs(value)) acc.tokens.add(ref);
      }
    }
  }
  // A deprecation counts when the class exists in the CSS, or the comment names a plain kebab-case class outright. Stray ".Min" or ".group" in prose does not.
  const plain = (cls: string) => /^-?[a-z][a-z0-9_]*(-[a-z0-9_]+)*$/.test(cls) && cls.length >= 3;
  for (const item of pending.sort((a, b) => byCode(a.cls, b.cls))) if (known.has(item.cls) || plain(item.cls)) deprecated[`.${item.cls}`] = { in: item.in, note: item.note };
  const isDep = (cls: string) => Boolean(deprecated[`.${cls}`]);

  const htmlPaths = order(walkFiles(repo, ".html", 300)).sort(byCode);
  for (const file of htmlPaths) {
    if (statSync(file).size > 500_000) continue;
    const rel = posix(relative(repo, file));
    const comp = componentOf(rel);
    if (!comp || accs.has(`${comp.kind}:${comp.name}`)) continue;
    const doc = parseHtml(readFileSync(file, "utf8"));
    const classes = doc.tags.flatMap((tag) => [...tag.classes, ...tag.dynamicClasses]);
    const base = rel.split("/").pop() ?? "";
    const named = (cls: string) => cls === comp.name || cls.startsWith(`${comp.name}--`) || cls.startsWith(`${comp.name}__`) || cls.startsWith(`${comp.name}-`);
    const body = doc.tags.some((tag) => tag.tag !== "a" && tag.tag !== "link" && (tag.classes.length > 0 || tag.dynamicClasses.length > 0));
    const owns = classes.some(named) || doc.styles.length > 0 || doc.links.length > 0 || readdirSync(dirname(file)).some((name) => name.toLowerCase().endsWith(".css")) || (base.replace(/\.html?$/i, "").toLowerCase() === comp.name.toLowerCase() && body);
    if ((/^index\.html?$/i.test(base) || doc.tags.some((tag) => tag.tag === "a" && tag.attrs["href"])) && !owns) continue;
    const acc: Acc = { name: comp.name, kind: comp.kind, files: [rel], counts: new Map(), tokens: new Set(), comments: [] };
    accs.set(`${comp.kind}:${comp.name}`, acc);
    for (const cls of classes) acc.counts.set(cls, (acc.counts.get(cls) ?? 0) + 1);
  }

  const entries: CatalogEntry[] = [];
  const owner = new Map<string, string>();
  const ordered = [...accs.values()].sort((a, b) => (a.kind === b.kind ? byCode(a.name, b.name) : a.kind === "block" ? -1 : 1));
  for (const acc of ordered) {
    const roots: string[] = [];
    const modifiers: Record<string, string[]> = {};
    const elements: string[] = [];
    const states: string[] = [];
    const variants = new Set<string>();
    for (const cls of [...acc.counts.keys()].filter((c) => !isDep(c))) {
      const { kind, base } = classify(cls);
      if (kind === "root") roots.push(cls);
      else if (kind === "element") elements.push(cls);
      else if (kind === "state") states.push(cls);
      else {
        (modifiers[base] ??= []).push(cls);
        if (!base.includes("__")) variants.add(cls.slice(base.length + 2));
      }
      if (!owner.has(cls)) owner.set(cls, acc.name);
    }
    for (const list of Object.values(modifiers)) list.sort(byCode);
    const desc = describe(acc.comments, acc.name);
    const doc = docText(acc.comments);
    const flat = acc.name.replace(/-/g, "");
    const weight = (r: string) => (modifiers[r]?.length ?? 0) * 2 + elements.filter((e) => e.startsWith(`${r}__`)).length + (acc.counts.get(r) ?? 0) / 10;
    const primary = roots.find((r) => r === acc.name || r.replace(/-/g, "") === flat) ?? [...roots].sort((a, b) => weight(b) - weight(a))[0] ?? acc.name;
    entries.push({
      name: acc.name,
      kind: acc.kind,
      description: desc,
      ...(doc ? { doc } : {}),
      variants: [...variants].sort(),
      rules: [...new Set(sentences(acc.comments))].filter((r) => !(desc && r.includes(desc)) && !Object.values(deprecated).some((d) => d.note.includes(r))).slice(0, 6),
      ...(acc.status ? { status: acc.status } : {}),
      code: {
        roots: roots.sort(),
        primary,
        modifiers: Object.fromEntries(Object.entries(modifiers).sort(([a], [b]) => byCode(a, b))),
        elements: elements.sort(),
        states: states.sort(),
        deprecated: Object.keys(deprecated).filter((k) => deprecated[k]?.in === acc.name).map((k) => k.slice(1)),
        markup: `<${defaultTag(acc.name)} class="${primary}">`,
        cssFile: acc.files[0] as string,
        cssFiles: acc.files,
        tokens: [...acc.tokens].sort().slice(0, 25),
        usedIn: 0,
      },
    });
  }

  // Real markup from the repo's own HTML beats a guessed tag.
  const usage = new Map<string, { tags: Map<string, number>; combos: Map<string, number>; files: Set<string> }>();
  const entryOf = new Map(entries.map((e) => [e.name, e]));
  for (const file of htmlPaths) {
    if (statSync(file).size > 500_000) continue;
    for (const tag of parseHtml(readFileSync(file, "utf8")).tags) {
      for (const cls of tag.classes) {
        const own = owner.get(cls);
        const entry = own ? entryOf.get(own) : undefined;
        if (!entry?.code || cls !== entry.code.primary) continue; // markup shows the component's own root, not a helper root
        const u = usage.get(entry.name) ?? { tags: new Map(), combos: new Map(), files: new Set() };
        usage.set(entry.name, u);
        u.tags.set(tag.tag, (u.tags.get(tag.tag) ?? 0) + 1);
        const combo = tag.classes.filter((c) => entry.code?.roots.includes(c) && owner.get(c) === entry.name).join(" ");
        u.combos.set(`${tag.tag}|${combo}`, (u.combos.get(`${tag.tag}|${combo}`) ?? 0) + 1);
        u.files.add(file);
      }
    }
  }
  for (const [name, u] of usage) {
    const entry = entryOf.get(name);
    if (!entry?.code) continue;
    const best = [...u.combos.entries()].sort((a, b) => b[1] - a[1] || byCode(a[0], b[0]))[0];
    if (best) {
      const [tag, combo] = best[0].split("|") as [string, string];
      entry.code.markup = `<${tag} class="${combo}">`;
    }
    entry.code.usedIn = u.files.size;
  }

  return {
    version: 1,
    builtAt: new Date().toISOString(),
    repoPath: repo,
    ...(cfg.cssEntry ? { cssEntry: cfg.cssEntry } : {}),
    ...(cfg.theme ? { theme: themeFile ? { file: posix(relative(repo, themeFile)) } : { name: cfg.theme } } : {}),
    cssFiles: [...files.map((f) => posix(relative(repo, f))), ...htmlPaths.map((file) => posix(relative(repo, file)))],
    components: entries,
    globalClasses: [...globals].filter((c) => !owner.has(c) && !isDep(c)).sort(),
    deprecated,
    tokens: { names: [...names].sort(), colors: sortedRecord(colors), fonts: sortedRecord(fonts) },
  };
}

export function catalogPath(cfg: ResolveConfig): string {
  return join(cfg.storeDir, "code-catalog.json");
}

export function saveCatalog(cfg: ResolveConfig, catalog: CodeCatalog): string {
  const path = catalogPath(cfg);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stableJson(catalog, 1) + "\n");
  return path;
}

/** Saved catalog when it still matches the repo config and CSS files; otherwise rebuild and save. */
export function loadCatalog(cfg: ResolveConfig): CodeCatalog {
  const path = catalogPath(cfg);
  if (existsSync(path)) {
    try {
      const saved = JSON.parse(readFileSync(path, "utf8")) as CodeCatalog;
      const built = Date.parse(saved.builtAt);
      const fresh =
        saved.version === 1 &&
        saved.repoPath === cfg.repoPath &&
        (saved.cssEntry ?? "") === (cfg.cssEntry ?? "") &&
        saved.cssFiles.every((rel) => existsSync(join(saved.repoPath, rel)) && statSync(join(saved.repoPath, rel)).mtimeMs <= built);
      if (fresh) {
        if (mappingDigest(cfg) !== (saved.mappingDigest ?? "")) {
          linkFigma(saved, cfg);
          saveCatalog(cfg, saved);
        }
        return saved;
      }
    } catch {
      // fall through and rebuild
    }
  }
  return rescan(cfg);
}

/** Rebuild from the repo, join the Figma components known from the last scan (by name, alias or the mapping file), and save. */
export function rescan(cfg: ResolveConfig): CodeCatalog {
  const catalog = buildCatalog(cfg);
  try {
    const old = JSON.parse(readFileSync(catalogPath(cfg), "utf8")) as CodeCatalog;
    catalog.figmaMasters = old.figmaMasters ?? old.components.flatMap((c) => (c.figma ? [c.figma] : []));
  } catch {
    // no earlier catalog
  }
  linkFigma(catalog, cfg);
  saveCatalog(cfg, catalog);
  return catalog;
}

export function summarize(catalog: CodeCatalog) {
  const blocks = catalog.components.filter((c) => c.kind === "block");
  const recipes = catalog.components.filter((c) => c.kind === "recipe");
  const classCount = catalog.components.reduce((n, c) => n + (c.code ? c.code.roots.length + c.code.elements.length + c.code.states.length + Object.values(c.code.modifiers).flat().length : 0), 0);
  return {
    repoPath: catalog.repoPath,
    cssEntry: catalog.cssEntry,
    theme: catalog.theme,
    cssFiles: catalog.cssFiles.filter((file) => !/\.html?$/i.test(file)).length,
    htmlFiles: catalog.cssFiles.filter((file) => /\.html?$/i.test(file)).length,
    components: catalog.components.length,
    blocks: blocks.length,
    recipes: recipes.length,
    componentClasses: classCount,
    globalClasses: catalog.globalClasses.length,
    tokens: catalog.tokens.names.length,
    colorTokens: Object.keys(catalog.tokens.colors).length,
    deprecated: Object.keys(catalog.deprecated),
    withFigma: catalog.components.filter((c) => c.figma).length,
    sample: catalog.components.slice(0, 12).map((c) => c.name),
  };
}
