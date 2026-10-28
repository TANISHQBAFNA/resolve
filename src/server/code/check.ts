import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ResolveConfig } from "../mode.ts";
import type { CodeCatalog } from "./scan.ts";
import { importChain } from "./scan.ts";
import { colorLiterals, normHex, parseCss, selectorClasses, varRefs } from "./css.ts";
import { parseHtml } from "./html.ts";

export interface Finding {
  severity: "error" | "warn" | "info";
  rule: string;
  line: number;
  count?: number;
  message: string;
  fix?: string;
}

export interface CheckResult {
  file: string;
  ok: boolean;
  counts: { error: number; warn: number; info: number };
  classesChecked: number;
  componentsUsed: Record<string, number>;
  /** Classes the page's own (non design-system) stylesheets define, plus configured local prefixes. Not unknown, not verified. */
  localClasses: number;
  localStylesheets: string[];
  missingStylesheets: string[];
  findings: Finding[];
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0] as number;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = row[j] as number;
      row[j] = Math.min(tmp + 1, (row[j - 1] as number) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length] as number;
}

function asset(htmlFile: string, repo: string, href: string): { path?: string; remote?: boolean } {
  const clean = href.split(/[?#]/)[0] as string;
  if (!clean || /^(https?:)?\/\/|^data:/i.test(clean)) return { remote: true };
  const direct = resolve(dirname(htmlFile), clean);
  if (existsSync(direct)) return { path: direct };
  // Flattened prototypes: ../ds.css may live at the repo root.
  const rooted = resolve(repo, clean.replace(/^(\.{1,2}\/)+/, "").replace(/^\//, ""));
  return existsSync(rooted) ? { path: rooted } : {};
}

export function checkHtml(catalog: CodeCatalog, cfg: ResolveConfig, fileArg: string): CheckResult {
  const repo = catalog.repoPath;
  const file = isAbsolute(fileArg) ? fileArg : existsSync(resolve(fileArg)) ? resolve(fileArg) : resolve(repo, fileArg);
  if (!existsSync(file)) throw new Error(`HTML file not found: ${fileArg}`);
  const doc = parseHtml(readFileSync(file, "utf8"));

  const owner = new Map<string, string>();
  for (const entry of catalog.components) {
    const code = entry.code;
    if (!code) continue;
    for (const cls of [...code.roots, ...code.elements, ...code.states, ...Object.values(code.modifiers).flat()]) if (!owner.has(cls)) owner.set(cls, entry.name);
  }
  const globals = new Set(catalog.globalClasses);
  const dsFiles = new Set(catalog.cssFiles.map((rel) => resolve(repo, rel)));
  const tokenNames = new Set(catalog.tokens.names);
  const findings: Finding[] = [];
  const groups = new Map<string, Finding>();
  const add = (f: Finding, key?: string) => {
    const id = key ? `${f.rule}|${key}` : undefined;
    const prev = id ? groups.get(id) : undefined;
    if (prev) prev.count = (prev.count ?? 1) + 1;
    else {
      findings.push(f);
      if (id) groups.set(id, f);
    }
  };

  // Stylesheets the page loads, and what they define.
  const reached = new Set<string>();
  const pageLocal = new Set<string>();
  const missing: string[] = [];
  const sheets: Array<{ css: string; line: number }> = [...doc.styles];
  const localSheets = new Set<string>();
  // Follow a stylesheet and its @import chain; classes from files outside the design system become page-local.
  const follow = (entry: string) => {
    const chain = importChain(entry);
    for (const f of chain.files) {
      reached.add(f);
      if (dsFiles.has(f)) continue;
      localSheets.add(relative(dirname(file), f).split("\\").join("/"));
      for (const rule of parseCss(readFileSync(f, "utf8")).rules) for (const cls of selectorClasses(rule.selector)) pageLocal.add(cls);
    }
    for (const gone of chain.missing) missing.push(relative(dirname(file), gone).split("\\").join("/"));
  };
  for (const href of doc.links) {
    const found = asset(file, repo, href);
    if (found.remote) continue;
    if (found.path) follow(found.path);
    else missing.push(href);
  }
  for (const sheet of doc.styles) {
    const css = parseCss(sheet.css);
    for (const rule of css.rules) for (const cls of selectorClasses(rule.selector)) pageLocal.add(cls);
    for (const spec of css.imports) {
      const found = asset(file, repo, spec);
      if (found.path) follow(found.path);
      else if (!found.remote) missing.push(spec);
    }
  }
  const declared = new Set<string>();
  for (const f of reached) if (!dsFiles.has(f)) for (const rule of parseCss(readFileSync(f, "utf8")).rules) for (const d of rule.decls) if (d.prop.startsWith("--")) declared.add(d.prop);
  for (const sheet of sheets) for (const rule of parseCss(sheet.css).rules) for (const d of rule.decls) if (d.prop.startsWith("--")) declared.add(d.prop);

  const entryAbs = catalog.cssEntry ? resolve(repo, catalog.cssEntry) : undefined;
  if (entryAbs && !reached.has(entryAbs)) {
    add(missing.length
      ? { severity: "info", rule: "ds-unverified", line: 1, message: `Design system not confirmed: ${missing.join(", ")} not found locally.` }
      : { severity: "warn", rule: "ds-not-loaded", line: 1, message: `No linked stylesheet reaches ${catalog.cssEntry}.`, fix: `Link a stylesheet that imports ${catalog.cssEntry}.` });
  }
  const themeAbs = catalog.theme?.file ? resolve(repo, catalog.theme.file) : undefined;
  if (themeAbs && !reached.has(themeAbs)) add({ severity: "warn", rule: "theme-not-loaded", line: 1, message: `Theme ${catalog.theme?.file} is not linked.`, fix: `<link rel="stylesheet" href="…/${catalog.theme?.file}"> after the design system.` });
  if (catalog.theme?.name && !doc.tags.some((t) => t.attrs["data-theme"] === catalog.theme?.name)) add({ severity: "info", rule: "theme-attribute", line: 1, message: `No element sets data-theme="${catalog.theme.name}".` });

  // Classes.
  const used: Record<string, number> = {};
  const localSeen = new Set<string>();
  let checked = 0;
  const looseSeverity = missing.length ? "warn" : "error";
  for (const tag of doc.tags) {
    const all = [...tag.classes, ...tag.dynamicClasses];
    for (const cls of all) {
      if (cls.startsWith("js-")) continue;
      checked += 1;
      const dep = catalog.deprecated[`.${cls}`];
      const own = owner.get(cls);
      if (dep) add({ severity: "error", rule: "deprecated-class", line: tag.line, message: `.${cls} is deprecated: ${dep.note}`, fix: "Use the replacement the note names, or pick another component." }, cls);
      else if (own) used[own] = (used[own] ?? 0) + 1;
      else if (globals.has(cls)) continue;
      else if (pageLocal.has(cls) || cfg.localPrefixes.some((p) => cls.startsWith(p))) localSeen.add(cls);
      else {
        const dash = cls.indexOf("--");
        const base = dash > 0 ? cls.slice(0, dash) : "";
        const siblings = base ? [...owner.keys()].filter((c) => c.startsWith(`${base}--`)).slice(0, 8) : [];
        const near = siblings.length ? siblings : [...owner.keys(), ...globals].filter((c) => Math.abs(c.length - cls.length) <= 3 && distance(c, cls) <= Math.max(2, Math.floor(cls.length / 4))).slice(0, 3);
        add({ severity: looseSeverity, rule: "unknown-class", line: tag.line, message: `.${cls} is not in the design system.`, ...(near.length ? { fix: `Did you mean ${near.map((c) => `.${c}`).join(", ")}?` } : { fix: "Pick a real component with resolve code pick, or define it as a page-local class." }) }, cls);
      }
      const dash = cls.indexOf("--");
      if (dash > 0 && owner.has(cls.slice(0, dash)) && !all.includes(cls.slice(0, dash))) add({ severity: "warn", rule: "modifier-without-base", line: tag.line, message: `.${cls} is used without .${cls.slice(0, dash)} on the same element.`, fix: `Add class "${cls.slice(0, dash)}".` }, cls);
    }
  }

  // Colours, fonts and tokens in inline styles and <style> blocks.
  const byHex = new Map<string, string>();
  for (const [name, value] of Object.entries(catalog.tokens.colors)) {
    const hex = normHex(value);
    if (hex && !byHex.has(hex)) byHex.set(hex, name);
  }
  const fontToken = Object.keys(catalog.tokens.fonts)[0];
  const scan = (css: string, line: number) => {
    for (const rule of parseCss(css.includes("{") ? css : `x{${css}}`).rules) {
      for (const { prop, value } of rule.decls) {
        for (const lit of colorLiterals(value)) {
          const token = byHex.get(normHex(lit) ?? "");
          add({ severity: "warn", rule: "hardcoded-color", line, message: `${prop}: ${lit} is a literal colour.`, fix: token ? `Use var(${token}).` : "Use a colour token from the design system." }, lit.toLowerCase());
        }
        if (/^font-family$/i.test(prop) && !/var\(/.test(value)) add({ severity: "warn", rule: "hardcoded-font", line, message: `font-family: ${value.slice(0, 40)} is hardcoded.`, ...(fontToken ? { fix: `Use var(${fontToken}).` } : {}) }, value);
        for (const ref of varRefs(value)) if (!tokenNames.has(ref) && !declared.has(ref)) add({ severity: "error", rule: "unknown-token", line, message: `var(${ref}) is not a design token.` }, ref);
      }
    }
  };
  for (const tag of doc.tags) if (tag.attrs["style"]) scan(tag.attrs["style"], tag.line);
  for (const sheet of doc.styles) scan(sheet.css, sheet.line);

  if (missing.length) add({ severity: "info", rule: "stylesheet-missing", line: 1, message: `Not found locally: ${missing.join(", ")}. Unknown classes are warnings because they may live there.` });
  if (localSeen.size) {
    add({ severity: "info", rule: "page-local-classes", line: 1, message: `${localSeen.size} project-local classes${localSheets.size ? ` from ${[...localSheets].slice(0, 3).join(", ")}` : ""} (not design system, not verified): ${[...localSeen].slice(0, 8).map((c) => `.${c}`).join(" ")}${localSeen.size > 8 ? " …" : ""}.`, fix: "Keep page-local classes to layout only; use design-system components for anything visual." });
  }
  const order = { error: 0, warn: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.line - b.line);
  const counts = { error: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return { file, ok: counts.error === 0, counts, classesChecked: checked, componentsUsed: used, localClasses: localSeen.size, localStylesheets: [...localSheets].sort(), missingStylesheets: [...new Set(missing)], findings };
}
