import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { dsIdOf, parseDsId, sameButVersion, type DsId } from "@/core/rules/dsId";
import { colorLiterals, parseCss, selectorClasses } from "@/server/code/css.ts";
import { parseHtml } from "@/server/code/html.ts";
import { readMapping } from "@/server/code/map.ts";
import { readComponentMap, readManifests, type ComponentMapEntry } from "@/server/componentMap.ts";
import type { ResolveConfig } from "@/server/mode.ts";
import { resolveGraph } from "@/server/store.ts";
import { READY_EXIT, READY_ITEMS, type ReadyFinding, type ReadyItem, type ReadyItemId, type ReadyResult } from "./types.ts";

const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const HASH_EXT = new Set([".css", ".html", ".htm", ".js", ".json", ".svg"]);
const SPACE_PROP = /^(margin|padding|gap|row-gap|column-gap|inset|top|right|bottom|left)(-[a-z]+)?$/i;
const COLOR_PROP = /color|background|fill|stroke|border|outline|shadow|column-rule|text-decoration|caret/i;
const NAMED = /\b(red|blue|green|yellow|orange|black|white|gray|grey|silver|maroon|navy|teal|aqua|fuchsia|lime|olive|purple|rebeccapurple)\b/i;
const ZERO = /^0+(?:\.0+)?(?:px|rem|em|vh|vw|vmin|vmax|ch|ex|%)?$/i;
const FINDING_CAP = 30;

interface Pin {
  name: string;
  source: string;
  ref: string;
}

interface Comp {
  code: string;
  dsId: string;
  roots: Set<string>;
  variants: Set<string>;
  confirmed: boolean;
  denied: boolean;
}

interface El {
  tag: string;
  attrs: Record<string, string>;
  line: number;
  parent?: El;
}

const cfg = (repoPath: string, storeDir: string): ResolveConfig => ({
  mode: "code",
  modeSource: "config",
  localPrefixes: [],
  repoPath,
  storeDir,
});

const isDir = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const posix = (path: string) => path.split("\\").join("/");
const show = (project: string, file: string, line?: number) => {
  const rel = posix(relative(project, file)) || file;
  return line ? `${rel}:${line}` : rel;
};
const safe = (value: string) => /^[A-Za-z0-9._-]+$/.test(value) && !value.includes("..");
const isGitSource = (source: string) => /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/i.test(source) || source.endsWith(".git");
const normGit = (source: string) => source.trim().replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function cap(findings: ReadyFinding[]): ReadyFinding[] {
  if (findings.length <= FINDING_CAP) return findings;
  const extra = findings.length - FINDING_CAP;
  return [...findings.slice(0, FINDING_CAP), { code: "more", message: `${extra} more findings in this item.`, next: "Fix the ones above, then run resolve ready again." }];
}

function item(id: ReadyItemId, summary: string, findings: ReadyFinding[]): ReadyItem {
  const kept = cap(findings);
  return {
    id,
    status: kept.length ? "warning" : "pass",
    summary: kept.length ? `${kept.length} warning${kept.length === 1 ? "" : "s"}.` : summary,
    findings: kept,
  };
}

function render(project: string, items: ReadyItem[], strictExitCode: number): string {
  const lines = ["# Readiness", "", `Project: ${project}`, "", "Each item is a pass or a warning. This check does not block.", ""];
  for (const row of items) {
    lines.push(`## ${row.id}`, "");
    if (row.status === "pass") lines.push(`- pass: ${row.summary}`, "  next: none.", "");
    else {
      if (row.summary) lines.push(row.summary, "");
      for (const finding of row.findings) lines.push(`- warning: ${finding.message}`, `  next: ${finding.next}`, "");
    }
  }
  lines.push(`--strict exit: ${strictExitCode}. Without --strict the exit is 0.`, "");
  return lines.join("\n");
}

function finish(project: string, items: ReadyItem[], strictExitCode: number): ReadyResult {
  const ok = items.every((row) => row.status === "pass");
  return {
    ok,
    project,
    reportPath: join(project, "5-readiness", "report.md"),
    written: false,
    exitCode: 0,
    strictExitCode: ok ? 0 : strictExitCode,
    items,
    markdown: render(project, items, ok ? 0 : strictExitCode),
  };
}

function readPinConfig(project: string): { pin?: Pin; problem?: string } {
  const path = join(project, "project.config.json");
  if (!existsSync(path)) return { problem: "project.config.json is missing." };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return { problem: "project.config.json is not valid JSON." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { problem: "project.config.json must be an object." };
  const ds = (parsed as Record<string, unknown>)["designSystem"];
  if (!ds || typeof ds !== "object" || Array.isArray(ds)) return { problem: "project.config.json needs a designSystem object." };
  const row = ds as Record<string, unknown>;
  const name = typeof row["name"] === "string" ? row["name"].trim() : "";
  const sourceRaw = row["source"] ?? row["path"] ?? row["url"];
  const source = typeof sourceRaw === "string" ? sourceRaw.trim() : "";
  const ref = typeof row["ref"] === "string" ? row["ref"].trim() : "";
  if (!name || !source || !ref) return { problem: "designSystem needs name, source, and ref. source is a local path or a git URL." };
  if (!safe(name) || !safe(ref)) return { problem: "designSystem name and ref must be a single folder name, such as acme and v1.4.0." };
  return { pin: { name, source, ref } };
}

function digest(root: string): string {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (item.name === ".git" || item.name === "node_modules" || item.name === "pin.json" || item.name.startsWith(".")) continue;
      const path = join(dir, item.name);
      if (item.isDirectory()) walk(path);
      else if (HASH_EXT.has(extname(item.name).toLowerCase())) files.push(path);
    }
  };
  if (isDir(root)) walk(root);
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(posix(relative(root, file)));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function gitAtRef(dir: string, ref: string): boolean | undefined {
  if (!existsSync(join(dir, ".git"))) return undefined;
  const head = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" });
  const pinned = spawnSync("git", ["-C", dir, "rev-parse", `${ref}^{commit}`], { encoding: "utf8" });
  if (head.status !== 0 || pinned.status !== 0) return false;
  return head.stdout.trim() === pinned.stdout.trim();
}

function readPinFile(dir: string): { source?: string; ref?: string; broken?: boolean } | undefined {
  const path = join(dir, "pin.json");
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { broken: true };
    const row = parsed as Record<string, unknown>;
    const source = typeof row["source"] === "string" ? row["source"] : typeof row["url"] === "string" ? row["url"] : undefined;
    const ref = typeof row["ref"] === "string" ? row["ref"] : undefined;
    return { ...(source ? { source } : {}), ...(ref ? { ref } : {}) };
  } catch {
    return { broken: true };
  }
}

function vendorCheck(project: string, prototype: string): { findings: ReadyFinding[]; summary: string } {
  const config = readPinConfig(project);
  if (!config.pin) {
    return {
      summary: "",
      findings: [{ code: "vendor-config", message: config.problem ?? "project.config.json could not be read.", next: "Add designSystem.name, designSystem.source (a local path or a git URL), and designSystem.ref." }],
    };
  }
  const { name, source, ref } = config.pin;
  const folder = `${name}@${ref}`;
  const vendorRoot = join(prototype, "vendor");
  const dest = join(vendorRoot, folder);
  const found = isDir(vendorRoot) ? readdirSync(vendorRoot).filter((entry) => !entry.startsWith(".") && isDir(join(vendorRoot, entry))) : [];
  if (!isDir(dest)) {
    const elsewhere = found.length ? ` Found ${found.join(", ")} instead.` : "";
    return {
      summary: "",
      findings: [{ code: "vendor-missing", message: `Vendor copy ${folder} is missing.${elsewhere}`, next: `Copy the design system at ${ref} into 4-code/prototype/vendor/${folder}.` }],
    };
  }
  if (!isGitSource(source)) {
    const local = isAbsolute(source) ? source : resolve(project, source);
    if (!isDir(local)) {
      return { summary: "", findings: [{ code: "vendor-mismatch", message: `Design system source ${source} is not a folder.`, next: "Point designSystem.source at the design system folder, or use a git URL and a ref." }] };
    }
    if (digest(local) !== digest(dest)) {
      return { summary: "", findings: [{ code: "vendor-mismatch", message: `Vendor copy ${folder} does not match ${source} at ${ref}.`, next: `Replace 4-code/prototype/vendor/${folder} with the design system at that ref.` }] };
    }
    return { summary: `Vendor copy ${folder} matches ${source} at ${ref}.`, findings: [] };
  }
  const git = gitAtRef(dest, ref);
  if (git === true) return { summary: `Vendor copy ${folder} is git ref ${ref}.`, findings: [] };
  const pin = readPinFile(dest);
  if (git === false) {
    return { summary: "", findings: [{ code: "vendor-ref", message: `Vendor copy ${folder} is a git checkout whose HEAD is not ${ref}.`, next: `Check out ${ref} in 4-code/prototype/vendor/${folder}.` }] };
  }
  if (pin?.broken) {
    return { summary: "", findings: [{ code: "vendor-ref", message: `pin.json in ${folder} is not valid JSON.`, next: `Record { "source": "${source}", "ref": "${ref}" } in pin.json, or check out that ref.` }] };
  }
  if (pin?.source && pin.ref && normGit(pin.source) === normGit(source) && pin.ref === ref) {
    return { summary: `Vendor copy ${folder} records ${source} at ${ref}.`, findings: [] };
  }
  const recorded = pin?.ref ? `records ref ${pin.ref}` : "does not record a ref";
  return { summary: "", findings: [{ code: "vendor-ref", message: `Vendor copy ${folder} ${recorded}, not ${source} at ${ref}.`, next: `Pin the copy to ${ref}: the folder name, pin.json source and ref, or a git checkout of that ref.` }] };
}

function walk(dir: string): string[] {
  const out: string[] = [];
  if (!isDir(dir)) return out;
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "vendor" || entry.name.startsWith(".")) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else out.push(path);
    }
  };
  visit(dir);
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function graphVariants(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  let loaded: ReturnType<typeof resolveGraph>;
  try {
    loaded = resolveGraph();
  } catch {
    return out;
  }
  if (!loaded) return out;
  for (const node of loaded.index.allNodes) {
    const ds = dsIdOf(node.description, node.name);
    if (!ds) continue;
    const variants = out.get(ds.id) ?? new Set<string>();
    for (const prop of node.propertyDefinitions ?? []) {
      if (prop.type !== "VARIANT") continue;
      for (const option of prop.options ?? []) variants.add(option.toLowerCase());
    }
    out.set(ds.id, variants);
  }
  return out;
}

function mapsOf(dir: string): { entries: ComponentMapEntry[]; problems: string[] } {
  if (!isDir(dir)) return { entries: [], problems: [] };
  const read = readComponentMap(cfg(dir, join(dir, ".resolve")));
  return { entries: read.entries, problems: read.problems };
}

function rulesOf(storeDir: string) {
  if (!isDir(storeDir)) return { rules: [], problems: [] as string[] };
  const read = readMapping(cfg(dirname(storeDir), storeDir));
  return { rules: read.rules, problems: read.problems };
}

function loadCatalog(vendorDir: string, project: string): { comps: Map<string, Comp>; problems: string[] } {
  const buckets = new Map<string, { code: string; dsIds: Set<string>; roots: Set<string>; variants: Set<string> }>();
  const bucket = (dir: string) => {
    const key = posix(relative(vendorDir, dir)) || ".";
    const have = buckets.get(key);
    if (have) return have;
    const made = { code: basename(dir), dsIds: new Set<string>(), roots: new Set<string>(), variants: new Set<string>() };
    buckets.set(key, made);
    return made;
  };
  const visit = (dir: string) => {
    if (!isDir(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      const hold = bucket(dir);
      if (entry.name === "component.json") {
        try {
          const parsed: unknown = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
          const dsId = parsed && typeof parsed === "object" && typeof (parsed as { dsId?: unknown }).dsId === "string" ? parseDsId((parsed as { dsId: string }).dsId) : undefined;
          if (dsId) hold.dsIds.add(dsId.id);
        } catch {
          // readManifests reports a broken file.
        }
      } else if (/\.html?$/i.test(entry.name)) {
        for (const tag of parseHtml(readFileSync(path, "utf8")).tags) {
          const ds = parseDsId(tag.attrs["data-ds-id"]);
          if (ds && ds.id === tag.attrs["data-ds-id"]?.trim().toLowerCase()) hold.dsIds.add(ds.id);
          for (const cls of tag.classes) {
            const at = cls.lastIndexOf("--");
            if (at > 0) hold.variants.add(cls.slice(at + 2).toLowerCase());
            else hold.roots.add(cls);
          }
        }
      } else if (entry.name.endsWith(".css")) {
        for (const rule of parseCss(readFileSync(path, "utf8")).rules) {
          for (const cls of selectorClasses(rule.selector)) {
            const at = cls.lastIndexOf("--");
            if (at > 0) hold.variants.add(cls.slice(at + 2).toLowerCase());
          }
        }
      }
    }
  };
  visit(vendorDir);

  const vendorMaps = mapsOf(vendorDir);
  const projectMaps = mapsOf(project);
  const maps = [...vendorMaps.entries, ...projectMaps.entries];
  const ruleRead = [rulesOf(join(vendorDir, ".resolve")), rulesOf(join(project, ".resolve"))];
  const rules = ruleRead.flatMap((read) => read.rules);
  const manifestRead = isDir(vendorDir) ? readManifests(vendorDir) : { entries: [], problems: [] as string[] };
  const manifests = manifestRead.entries;
  const problems = [...vendorMaps.problems, ...projectMaps.problems, ...ruleRead.flatMap((read) => read.problems), ...manifestRead.problems];
  const learned = graphVariants();
  const comps = new Map<string, Comp>();
  for (const hold of buckets.values()) {
    if (!hold.dsIds.size) continue;
    const denied = maps.some((entry) => entry.status === "denied" && same(entry.code, hold.code));
    const confirmed =
      !denied &&
      (manifests.some((entry) => same(entry.code, hold.code)) ||
        maps.some((entry) => entry.status === "confirmed" && same(entry.code, hold.code)) ||
        rules.some((rule) => !rule.deny && !rule.proposed && rule.code.some((code) => same(code, hold.code))) ||
        [...hold.dsIds].some((id) => learned.has(id)));
    for (const dsId of hold.dsIds) {
      const variants = new Set(hold.variants);
      for (const option of learned.get(dsId) ?? []) variants.add(option);
      const roots = new Set(hold.roots);
      if (!roots.size) roots.add(hold.code);
      comps.set(dsId, { code: hold.code, dsId, roots, variants, confirmed, denied });
    }
  }
  for (const [dsId, variants] of learned) {
    if (comps.has(dsId)) continue;
    comps.set(dsId, { code: dsId, dsId, roots: new Set(), variants, confirmed: true, denied: false });
  }
  return { comps, problems };
}

function nearId(id: DsId, known: Iterable<string>): string | undefined {
  for (const other of known) {
    const parsed = parseDsId(other);
    if (parsed && sameButVersion(id, parsed)) return parsed.id;
  }
  return undefined;
}

function usedVariants(tag: { classes: string[]; attrs: Record<string, string> }, comp: Comp): string[] {
  const out: string[] = [];
  for (const cls of tag.classes) {
    const at = cls.lastIndexOf("--");
    if (at <= 0) continue;
    const base = cls.slice(0, at);
    if (comp.roots.has(base) || base === comp.code) out.push(cls.slice(at + 2));
  }
  const data = tag.attrs["data-variant"];
  if (data) out.push(...data.split(/[\s,]+/).filter(Boolean));
  const spec = tag.attrs["data-ds-variant"];
  if (spec) {
    for (const part of spec.split(",")) {
      const value = part.split("=")[1]?.trim();
      if (value) out.push(value);
    }
  }
  return out;
}

function componentCheck(project: string, prototype: string, comps: Map<string, Comp>, problems: string[]): { components: ReadyFinding[]; variants: ReadyFinding[]; summary: string; variantSummary: string } {
  const components: ReadyFinding[] = problems.map((problem) => ({ code: "map-problem", message: problem, next: "Fix the component map, then run resolve ready again." }));
  const variants: ReadyFinding[] = [];
  const seenVariant = new Set<string>();
  let checked = 0;
  const html = walk(prototype).filter((file) => /\.html?$/i.test(file));
  for (const file of html) {
    for (const tag of parseHtml(readFileSync(file, "utf8")).tags) {
      if (!("data-ds-id" in tag.attrs)) continue;
      const raw = tag.attrs["data-ds-id"]?.trim() ?? "";
      const where = show(project, file, tag.line);
      const parsed = parseDsId(raw);
      if (!parsed || parsed.id !== raw.toLowerCase()) {
        components.push({ code: "made-up-id", message: `${where}: \`${raw || "(empty)"}\` is not a design-system id.`, next: "Use a real id, ds@<semver>.<tier>.<name>, from the design system.", file, line: tag.line });
        continue;
      }
      checked += 1;
      const comp = comps.get(parsed.id);
      if (!comp) {
        const near = nearId(parsed, comps.keys());
        components.push({
          code: "unknown-id",
          message: `${where}: \`${parsed.id}\` is not a component in DSCK.`,
          next: near ? `The design system has ${near}. Use that id, or add ${parsed.id} to DSCK.` : "Use a data-ds-id from the design system, or add the component to DSCK.",
          file,
          line: tag.line,
        });
        continue;
      }
      if (comp.denied || !comp.confirmed) {
        components.push({
          code: "unconfirmed-id",
          message: `${where}: \`${parsed.id}\` ${comp.denied ? "is denied, so it is not a confirmed Figma pair" : "has no confirmed Figma pair"}.`,
          next: "Confirm the pair in component.json (id plus a Figma name or key) or in .resolve/component-map.json. A proposed row is not a pair. A deny stays a deny.",
          file,
          line: tag.line,
        });
      }
      for (const variant of usedVariants(tag, comp)) {
        const key = `${file}\0${variant.toLowerCase()}`;
        if (seenVariant.has(key)) continue;
        seenVariant.add(key);
        if (comp.variants.has(variant.toLowerCase())) continue;
        const known = [...comp.variants].sort();
        variants.push({
          code: "unknown-variant",
          message: `${where}: variant \`${variant}\` is not on ${comp.code}.`,
          next: known.length ? `Use one of ${known.join(", ")}.` : `Remove the variant, or add it on ${comp.code}.`,
          file,
          line: tag.line,
        });
      }
    }
  }
  const summary = components.length
    ? `${checked} data-ds-id elements checked.`
    : checked
      ? `${checked} elements with data-ds-id resolve to DSCK and have a confirmed Figma pair.`
      : "No data-ds-id on the prototype.";
  return { components, variants, summary, variantSummary: "Variants used are on those components." };
}

function rawSpace(value: string): string[] {
  const outside = value.replace(/var\([^)]*\)/g, " ");
  const lengths = [...outside.matchAll(/-?\d*\.?\d+(?:px|rem|em|vh|vw|vmin|vmax|ch|ex|%)/gi)].map((match) => match[0]);
  const bare = [...outside.matchAll(/(?:^|[\s,])(\d*\.?\d+)(?=$|[\s,;])/g)].map((match) => match[1] ?? "");
  return [...lengths, ...bare].filter((token) => token && !ZERO.test(token));
}

function addRaw(findings: ReadyFinding[], file: string, line: number, prop: string, value: string, project: string) {
  const where = show(project, file, line);
  for (const lit of colorLiterals(value)) {
    findings.push({ code: "raw-colour", message: `${where}: ${prop} ${lit} is a raw colour.`, next: "Use a colour token from the design system, for example var(--ink).", file, line });
  }
  if (COLOR_PROP.test(prop)) {
    const named = NAMED.exec(value.replace(/var\([^)]*\)/g, " "));
    if (named) findings.push({ code: "raw-colour", message: `${where}: ${prop} ${named[1]} is a raw colour.`, next: "Use a colour token from the design system, for example var(--ink).", file, line });
  }
  if (SPACE_PROP.test(prop)) {
    for (const lit of rawSpace(value)) {
      findings.push({ code: "raw-spacing", message: `${where}: ${prop} ${lit} is raw spacing.`, next: "Use a spacing token from the design system, for example var(--space-2).", file, line });
    }
  }
}

function scanCss(text: string, file: string, lineOffset: number, project: string, findings: ReadyFinding[]) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (/^\s*(\/\*|\*|\/\/)/.test(line)) continue;
    const decl = /^\s*(--[\w-]+|[A-Za-z-]+)\s*:\s*(.+?)\s*;?\s*$/.exec(line);
    if (!decl) continue;
    addRaw(findings, file, lineOffset + i + 1, decl[1] ?? "", decl[2] ?? "", project);
  }
}

function tokenCheck(project: string, prototype: string): ReadyFinding[] {
  const findings: ReadyFinding[] = [];
  for (const file of walk(prototype)) {
    const ext = extname(file).toLowerCase();
    const text = readFileSync(file, "utf8");
    if (ext === ".css") scanCss(text, file, 0, project, findings);
    else if (ext === ".html" || ext === ".htm") {
      const doc = parseHtml(text);
      for (const tag of doc.tags) {
        const style = tag.attrs["style"];
        if (!style) continue;
        for (const part of style.split(";")) {
          const decl = /^\s*([A-Za-z-]+)\s*:\s*(.+)$/.exec(part.trim());
          if (decl) addRaw(findings, file, tag.line, decl[1] ?? "", decl[2] ?? "", project);
        }
      }
      for (const sheet of doc.styles) scanCss(sheet.css, file, sheet.line - 1, project, findings);
    } else if (ext === ".js") {
      text.split(/\r?\n/).forEach((line, index) => {
        if (colorLiterals(line).length || NAMED.test(line)) addRaw(findings, file, index + 1, "color", line, project);
        if (/\b(margin|padding|gap|inset|top|right|bottom|left)\b/i.test(line)) {
          for (const lit of rawSpace(line)) findings.push({ code: "raw-spacing", message: `${show(project, file, index + 1)}: ${lit} is raw spacing.`, next: "Use a spacing token from the design system, for example var(--space-2).", file, line: index + 1 });
        }
      });
    }
  }
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.code}\0${finding.file}\0${finding.line}\0${finding.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function slug(name: string): string {
  return name.trim().toLowerCase().replace(/[`*]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function screenRows(text: string): Array<{ name: string; file?: string }> {
  const rows: Array<{ name: string; file?: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const item = /^[-*]\s+(.+)$/.exec(line);
    if (item) {
      const body = item[1] ?? "";
      const link = /\[([^\]]+)\]\(([^)\s]+)\)/.exec(body);
      if (link) rows.push({ name: link[1] ?? "", file: link[2] });
      else {
        const file = body.match(/\S+\.html?/)?.[0];
        const name = body.replace(/\[[^\]]*\]\([^)]*\)/g, " ").replace(/[`*]/g, "").split(/[—–|]/)[0]?.trim() ?? "";
        if (name) rows.push({ name, ...(file ? { file } : {}) });
      }
      continue;
    }
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (!cells.length || cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
    const head = (cells[0] ?? "").toLowerCase();
    if (head === "screen" || head === "screens" || head === "name") continue;
    const name = (cells[0] ?? "").replace(/[`*]/g, "").trim();
    const file = cells.slice(1).find((cell) => /\.html?$/i.test(cell));
    if (name) rows.push({ name, ...(file ? { file } : {}) });
  }
  return rows;
}

function screenFile(prototype: string, project: string, name: string, explicit?: string): string | undefined {
  const candidates: string[] = [];
  if (explicit) candidates.push(resolve(prototype, explicit), resolve(project, explicit), resolve(dirname(prototype), explicit));
  const id = slug(name);
  candidates.push(join(prototype, "screens", `${id}.html`), join(prototype, `${id}.html`), join(prototype, "screens", `${name.trim()}.html`));
  if (id === "home" || id === "index" || id === "start") candidates.push(join(prototype, "index.html"));
  return candidates.find((path) => existsSync(path));
}

function screenCheck(project: string, prototype: string): { findings: ReadyFinding[]; summary: string } {
  const path = join(project, "2-brief", "screens.md");
  if (!existsSync(path)) {
    return { summary: "", findings: [{ code: "missing-screens", message: "2-brief/screens.md is missing.", next: "List each screen as a Markdown item or a table row. Each one needs an HTML file under 4-code/prototype." }] };
  }
  const rows = screenRows(readFileSync(path, "utf8"));
  if (!rows.length) {
    return { summary: "", findings: [{ code: "missing-screens", message: "2-brief/screens.md lists no screens.", next: "Add one Markdown item per screen, then add screens/<name>.html." }] };
  }
  const findings: ReadyFinding[] = [];
  for (const row of rows) {
    if (screenFile(prototype, project, row.name, row.file)) continue;
    const expected = row.file ?? `screens/${slug(row.name)}.html`;
    findings.push({ code: "missing-screen", message: `Screen \`${row.name}\` has no HTML file (looked for ${expected}).`, next: `Add 4-code/prototype/${expected.replace(/^\//, "")}.` });
  }
  return { findings, summary: findings.length ? "" : "Every screen in 2-brief/screens.md has an HTML file." };
}

function elements(html: string): El[] {
  const out: El[] = [];
  const stack: El[] = [];
  const re = /<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g;
  let line = 1;
  let last = 0;
  for (const match of html.matchAll(re)) {
    const index = match.index ?? 0;
    while (last < index) {
      if (html[last] === "\n") line += 1;
      last += 1;
    }
    if (match[0].startsWith("</")) {
      const name = (match[1] ?? "").toLowerCase();
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i]?.tag === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    if (!match[2]) continue;
    const tag = match[2].toLowerCase();
    const attrs: Record<string, string> = {};
    for (const attr of (match[3] ?? "").matchAll(ATTR)) attrs[(attr[1] ?? "").toLowerCase()] = attr[2] ?? attr[3] ?? attr[4] ?? "";
    const el: El = { tag, attrs, line, ...(stack.length ? { parent: stack[stack.length - 1] } : {}) };
    out.push(el);
    if (!match[4] && !VOID.has(tag)) stack.push(el);
  }
  return out;
}

function hasLabel(el: El, all: El[]): boolean {
  if ((el.attrs["aria-label"] ?? "").trim() || (el.attrs["aria-labelledby"] ?? "").trim()) return true;
  let parent = el.parent;
  while (parent) {
    if (parent.tag === "label") return true;
    parent = parent.parent;
  }
  const id = el.attrs["id"];
  return Boolean(id && all.some((node) => node.tag === "label" && node.attrs["for"] === id));
}

function a11yCheck(project: string, prototype: string): { findings: ReadyFinding[]; summary: string } {
  const findings: ReadyFinding[] = [];
  const html = walk(prototype).filter((file) => /\.html?$/i.test(file));
  if (!html.length) {
    return { summary: "", findings: [{ code: "missing-landmark", message: "4-code/prototype has no HTML file.", next: "Add index.html and screens/*.html, each with a main landmark." }] };
  }
  for (const file of html) {
    const all = elements(readFileSync(file, "utf8"));
    for (const el of all) {
      const where = show(project, file, el.line);
      if ((el.tag === "img" || el.attrs["role"] === "img") && !("alt" in el.attrs) && !(el.attrs["aria-label"] ?? "").trim()) {
        findings.push({ code: "missing-alt", message: `${where}: image has no alt text.`, next: "Add alt (alt=\"\" for a decorative image) or aria-label.", file, line: el.line });
      }
      if (el.tag === "input" || el.tag === "textarea" || el.tag === "select") {
        const type = (el.attrs["type"] ?? "text").toLowerCase();
        if (el.tag === "input" && ["hidden", "submit", "button", "reset", "image"].includes(type)) continue;
        if (!hasLabel(el, all)) findings.push({ code: "missing-label", message: `${where}: ${el.tag} has no label.`, next: "Wrap it in a label, or add a label for its id, or aria-label.", file, line: el.line });
      }
    }
    if (!all.some((el) => el.tag === "main" || el.attrs["role"] === "main")) {
      findings.push({ code: "missing-landmark", message: `${show(project, file)}: no main landmark.`, next: "Add a <main> element, or role=\"main\", on this screen.", file });
    }
  }
  return { findings, summary: "Alt text, labels, and a main landmark are present." };
}

/** Read-only. Does not write the report. */
export function checkReady(project: string): ReadyResult {
  const root = resolve(project);
  if (!isDir(root)) {
    const findings: ReadyFinding[] = [{ code: "project-missing", message: `${root} is not a project folder.`, next: "Pass the folder that holds project.config.json, 2-brief/screens.md and 4-code/prototype." }];
    const items = READY_ITEMS.map((id) => item(id, "", findings));
    return finish(root, items, 1);
  }
  const prototype = join(root, "4-code", "prototype");
  const prototypeMissing: ReadyFinding[] = isDir(prototype) ? [] : [{ code: "prototype-missing", message: "4-code/prototype is missing.", next: "Add index.html, screens/*.html, css, js, data, and vendor/<name>@<ref>." }];
  const vendor = prototypeMissing.length ? { summary: "", findings: prototypeMissing } : vendorCheck(root, prototype);
  const pin = readPinConfig(root).pin;
  const pinned = pin ? join(prototype, "vendor", `${pin.name}@${pin.ref}`) : join(prototype, "vendor");
  const catalog = prototypeMissing.length ? { comps: new Map<string, Comp>(), problems: [] as string[] } : loadCatalog(isDir(pinned) ? pinned : join(prototype, "vendor"), root);
  const parts = prototypeMissing.length
    ? { components: prototypeMissing, variants: prototypeMissing, summary: "", variantSummary: "" }
    : componentCheck(root, prototype, catalog.comps, catalog.problems);
  const tokens = prototypeMissing.length ? prototypeMissing : tokenCheck(root, prototype);
  const screens = screenCheck(root, prototype);
  const a11y = prototypeMissing.length ? { findings: prototypeMissing, summary: "" } : a11yCheck(root, prototype);
  const items = [
    item("components", parts.summary, parts.components),
    item("vendor", vendor.summary, vendor.findings),
    item("tokens", "No raw colours or spacing in the prototype.", tokens),
    item("variants", parts.variantSummary, parts.variants),
    item("screens", screens.summary, screens.findings),
    item("accessibility", a11y.summary, a11y.findings),
  ];
  const codes = items.filter((row) => row.status === "warning").map((row) => READY_EXIT[row.id]);
  return finish(root, items, codes.length ? Math.min(...codes) : 0);
}
