import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { codeMapCard } from "@/core/query/replacements";
import type { ResolveConfig } from "../mode.ts";
import { resolveGraph } from "../store";
import type { CatalogEntry, CodeCatalog, FigmaMaster, MatchBy } from "./scan.ts";
import { nameWords, RELATED, tokens } from "./words.ts";

/**
 * How Figma components and coded components join. Strongest first:
 *   mapped    a line in .resolve/mapping.json names the pair (one-to-many and many-to-one allowed)
 *   exact     same name after case, spaces, hyphens, underscores and plurals are ignored
 *   alias     a name or alias on one side equals a name or alias on the other (only when one coded component fits)
 *   suggested related words, variants and modifiers look alike. Shown by `code-map --suggest`, never joined on its own.
 */
const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const plural = (w: string) => (w.length > 3 && w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith("s") && !/(ss|us|is)$/.test(w) ? w.slice(0, -1) : w);
export const norm = (name: string): string => (nameWords(name).toLowerCase().match(/[a-z0-9]+/g) ?? []).map(plural).join("");
const uniq = (items: string[]) => [...new Set(items)].sort(byCode);

/** One line of the mapping file. `figma` and `code` together make a pair; either alone gives that component aliases. */
export interface MapRule { figma?: string; code: string[]; aliases: string[] }

export const mappingPath = (cfg: ResolveConfig) => join(cfg.storeDir, "mapping.json");

function strings(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return list.flatMap((v) => (typeof v === "string" && v.trim() ? [v.trim()] : []));
}

/** Reads `.resolve/mapping.json`: `{ "mappings": [...] }` or a bare array. Never throws; problems are listed. */
export function readMapping(cfg: ResolveConfig): { rules: MapRule[]; problems: string[]; text: string } {
  const path = mappingPath(cfg);
  if (!existsSync(path)) return { rules: [], problems: [], text: "" };
  const text = readFileSync(path, "utf8");
  try {
    const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
    const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? (parsed as { mappings?: unknown }).mappings : undefined;
    if (!Array.isArray(list)) return { rules: [], problems: [`${path} needs a "mappings" list.`], text };
    const problems: string[] = [];
    const rules = list.flatMap((item, i): MapRule[] => {
      const row = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
      const figma = strings(row["figma"])[0];
      const code = strings(row["code"]);
      const aliases = strings(row["aliases"]);
      if (!figma && !code.length) {
        problems.push(`mappings[${i}] has neither "figma" nor "code".`);
        return [];
      }
      return [{ ...(figma ? { figma } : {}), code, aliases }];
    });
    return { rules, problems, text };
  } catch {
    return { rules: [], problems: [`${path} is not valid JSON. It was not used and not changed.`], text };
  }
}

export function mappingDigest(cfg: ResolveConfig): string {
  const { text } = readMapping(cfg);
  return text ? createHash("sha256").update(text).digest("hex").slice(0, 16) : "";
}

interface Link { master: FigmaMaster; entry: CatalogEntry; by: MatchBy; alias?: string }
const STRENGTH: Record<MatchBy, number> = { mapped: 0, exact: 1, alias: 2 };

function compute(catalog: CodeCatalog, cfg: ResolveConfig, given?: FigmaMaster[]) {
  const { rules, problems } = readMapping(cfg);
  const masters = (given ?? catalog.figmaMasters ?? []).slice().sort((a, b) => byCode(a.name, b.name) || byCode(a.nodeId ?? "", b.nodeId ?? ""));
  const byName = new Map(catalog.components.map((e) => [norm(e.name), e]));
  const codeAliases = new Map<CatalogEntry, string[]>();
  const figmaAliases = new Map<string, string[]>();
  const pairRules: MapRule[] = [];
  const targets = (rule: MapRule) =>
    rule.code.flatMap((name) => {
      const entry = byName.get(norm(name));
      if (!entry) problems.push(`mapping code "${name}" is not a component in the catalog.`);
      return entry ? [entry] : [];
    });
  for (const rule of rules) {
    const found = targets(rule);
    for (const entry of found) codeAliases.set(entry, [...(codeAliases.get(entry) ?? []), ...rule.aliases]);
    if (rule.figma) {
      figmaAliases.set(norm(rule.figma), [...(figmaAliases.get(norm(rule.figma)) ?? []), ...rule.aliases]);
      if (found.length) pairRules.push({ ...rule, code: found.map((e) => e.name) });
    }
  }
  const entryNames = (e: CatalogEntry) => [e.name, ...(codeAliases.get(e) ?? [])];
  const masterNames = (m: FigmaMaster) => [m.name, ...(m.aliases ?? []), ...(figmaAliases.get(norm(m.name)) ?? [])];

  const links: Link[] = [];
  const ambiguous = new Map<string, CatalogEntry[]>();
  for (const master of masters) {
    const mine = pairRules.filter((r) => norm(r.figma ?? "") === norm(master.name));
    if (mine.length) {
      for (const entry of uniqueEntries(mine.flatMap((r) => r.code.flatMap((n) => byName.get(norm(n)) ?? [])))) links.push({ master, entry, by: "mapped" });
      continue;
    }
    const exact = byName.get(norm(master.name));
    if (exact) {
      links.push({ master, entry: exact, by: "exact" });
      continue;
    }
    const names = masterNames(master);
    const hits = new Map<CatalogEntry, string>();
    for (const entry of catalog.components)
      for (const n of names) {
        const other = entryNames(entry).find((e) => norm(e) === norm(n));
        if (other !== undefined) hits.set(entry, norm(n) === norm(master.name) ? other : n);
      }
    const list = [...hits.keys()];
    if (list.length === 1) links.push({ master, entry: list[0] as CatalogEntry, by: "alias", alias: hits.get(list[0] as CatalogEntry) as string });
    else if (list.length > 1) ambiguous.set(master.name, list);
  }
  return { rules, problems: uniq(problems), masters, links, ambiguous, codeAliases, figmaAliases, masterNames, entryNames };
}

const uniqueEntries = (list: CatalogEntry[]) => [...new Set(list)];

/** Joins the catalog to the Figma components (given, else the ones kept from the last link). Rewrites figma, matchedBy, matched and aliases on every entry. */
export function linkFigma(catalog: CodeCatalog, cfg: ResolveConfig, given?: FigmaMaster[]) {
  if (given) catalog.figmaMasters = given.slice().sort((a, b) => byCode(a.name, b.name) || byCode(a.nodeId ?? "", b.nodeId ?? ""));
  for (const e of catalog.components) for (const k of ["figma", "figmaAlso", "matchedBy", "matched", "aliases"] as const) delete e[k];
  const r = compute(catalog, cfg);
  catalog.mappingDigest = mappingDigest(cfg);
  for (const [entry, aliases] of r.codeAliases) entry.aliases = uniq(aliases);
  const per = new Map<CatalogEntry, Link[]>();
  for (const l of r.links) per.set(l.entry, [...(per.get(l.entry) ?? []), l]);
  for (const [entry, list] of per) {
    list.sort((a, b) => STRENGTH[a.by] - STRENGTH[b.by] || byCode(a.master.name, b.master.name));
    const first = list[0] as Link;
    const aliases = uniq([...(first.master.aliases ?? []), ...(r.figmaAliases.get(norm(first.master.name)) ?? [])]);
    entry.figma = { ...first.master, ...(aliases.length ? { aliases } : {}) };
    entry.matchedBy = first.by;
    entry.matched = { figma: first.master.name, code: entry.name, ...(first.alias ? { alias: first.alias } : {}) };
    if (list.length > 1) entry.figmaAlso = uniq(list.slice(1).map((l) => l.master.name));
  }
  const matched = new Set(r.links.map((l) => l.master.name));
  const byKind = { mapped: 0, exact: 0, alias: 0 };
  for (const e of catalog.components) if (e.matchedBy) byKind[e.matchedBy] += 1;
  return { linked: per.size, byKind, figmaOnly: r.masters.filter((m) => !matched.has(m.name)).map((m) => m.name), problems: r.problems };
}

const variantWords = (entry: CatalogEntry) =>
  new Set(tokens([...entry.variants, ...Object.values(entry.code?.modifiers ?? {}).flat().map((c) => c.split("--").pop() ?? c)].join(" ").replace(/[-_]+/g, " ")));

/** How alike two names look as words: same word 1, related word (modal/dialog) 0.7. */
function nameLike(a: string[], b: string[]) {
  const reasons: string[] = [];
  let sum = 0;
  for (const w of new Set(a)) {
    if (b.includes(w)) sum += 1;
    else {
      const best = (RELATED.get(w) ?? []).filter(([o]) => b.includes(o)).sort((x, y) => y[1] - x[1])[0];
      if (best) {
        sum += best[1];
        reasons.push(`${w}~${best[0]}`);
      }
    }
  }
  return { score: a.length && b.length ? sum / Math.max(new Set(a).size, new Set(b).size) : 0, reasons };
}

export interface Suggestion { figma: string; code: string; confidence: "suggested"; score: number; reasons: string[] }

function suggestions(master: FigmaMaster, catalog: CodeCatalog, r: ReturnType<typeof compute>, limit: number): Suggestion[] {
  const mv = tokens((master.variants ?? []).join(" ").replace(/[-_]+/g, " "));
  const out = catalog.components.flatMap((entry): Suggestion[] => {
    let best = { score: 0, reasons: [] as string[] };
    for (const m of r.masterNames(master)) for (const e of r.entryNames(entry)) {
      const s = nameLike(tokens(nameWords(m)), tokens(nameWords(e)));
      if (s.score > best.score) best = s;
    }
    const ev = variantWords(entry);
    const shared = mv.filter((w) => ev.has(w));
    if (!best.score && shared.length < 2) return [];
    const vscore = mv.length && ev.size ? shared.length / Math.min(new Set(mv).size, ev.size) : 0;
    const score = Math.round((0.7 * best.score + 0.3 * vscore) * 100) / 100;
    if (score < 0.25) return [];
    const reasons = [...best.reasons, ...(r.ambiguous.get(master.name)?.includes(entry) ? ["alias shared with several coded components"] : []), ...(shared.length ? [`variants: ${uniq(shared).join(", ")}`] : [])];
    return [{ figma: master.name, code: entry.name, confidence: "suggested", score, reasons: reasons.length ? reasons : ["same words"] }];
  });
  return out.sort((a, b) => b.score - a.score || byCode(a.code, b.code)).slice(0, limit);
}

export function mapReport(catalog: CodeCatalog, cfg: ResolveConfig, opts: { suggest?: boolean; limit?: number; masters?: FigmaMaster[] } = {}) {
  const r = compute(catalog, cfg, opts.masters);
  const linkedMasters = new Set(r.links.map((l) => l.master.name));
  const linkedCode = new Set(r.links.map((l) => l.entry.name));
  const unmatchedFigma = r.masters.filter((m) => !linkedMasters.has(m.name));
  return {
    mappingFile: mappingPath(cfg),
    mappingExists: existsSync(mappingPath(cfg)),
    ...(r.problems.length ? { problems: r.problems } : {}),
    figmaComponents: r.masters.length,
    codeComponents: catalog.components.length,
    pairs: r.links.map((l) => ({ figma: l.master.name, code: l.entry.name, confidence: l.by, ...(l.alias ? { alias: l.alias } : {}) })).sort((a, b) => byCode(a.figma, b.figma) || byCode(a.code, b.code)),
    unmatchedFigma: unmatchedFigma.map((m) => m.name),
    unmatchedCode: r.masters.length ? catalog.components.filter((e) => !linkedCode.has(e.name)).map((e) => e.name) : [],
    ...(opts.suggest ? { suggestions: unmatchedFigma.flatMap((m) => suggestions(m, catalog, r, Math.max(1, opts.limit ?? 3))) } : {}),
    note: r.masters.length
      ? "A suggestion is not a link. Confirm pairs in the mapping file (or `resolve code-map --write \"Figma=code\"`); nothing is joined without that."
      : "No Figma components known yet. Run code_scan with figma components (or learn the Figma library in both mode), then ask again.",
  };
}

/** Appends confirmed pairs ("Figma name=code" or "Figma name=code1,code2") to the mapping file. Writes nothing if any pair is wrong. */
export function writeMappings(cfg: ResolveConfig, catalog: CodeCatalog, pairs: string[]) {
  const path = mappingPath(cfg);
  let doc: Record<string, unknown> | unknown[] = { mappings: [] };
  if (existsSync(path)) {
    const text = readFileSync(path, "utf8");
    try {
      doc = JSON.parse(text.replace(/^\uFEFF/, "")) as Record<string, unknown> | unknown[];
    } catch {
      throw new Error(`${path} is not valid JSON. Fix it first; nothing was written.`);
    }
  }
  const list = Array.isArray(doc) ? doc : Array.isArray(doc["mappings"]) ? (doc["mappings"] as unknown[]) : undefined;
  if (!list) throw new Error(`${path} needs a "mappings" list. Nothing was written.`);
  const masters = new Map((catalog.figmaMasters ?? []).map((m) => [norm(m.name), m.name]));
  const entries = new Map(catalog.components.map((e) => [norm(e.name), e.name]));
  const errors: string[] = [];
  const added: Array<{ figma: string; code: string | string[] }> = [];
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    const figma = masters.get(norm(pair.slice(0, at < 0 ? 0 : at)));
    const names = (at < 0 ? "" : pair.slice(at + 1)).split(",").map((n) => entries.get(norm(n)));
    if (at < 0 || !figma || !names.length || names.some((n) => !n)) {
      errors.push(`"${pair}": use "Figma name=code-name[,code-name]" with a Figma component and coded components that exist.`);
      continue;
    }
    const code = uniq(names as string[]);
    const have = list.some((r) => {
      const row = (r ?? {}) as { figma?: unknown; code?: unknown };
      return typeof row.figma === "string" && norm(row.figma) === norm(figma) && code.every((c) => strings(row.code).some((x) => norm(x) === norm(c)));
    });
    if (!have) added.push({ figma, code: code.length === 1 ? (code[0] as string) : code });
  }
  if (errors.length) throw new Error(errors.join("\n"));
  if (added.length) {
    list.push(...added);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
  }
  return { file: path, added, skipped: pairs.length - added.length };
}

/** The import map (`.resolve/code-map.json`) beside a coded-component join report. Null when no library is learned. */
export function attachImportReport<T extends object>(report: T): T & { imports: ReturnType<typeof codeMapCard> | null } {
  try {
    const resolved = resolveGraph();
    if (!resolved) return { ...report, imports: null };
    return { ...report, imports: codeMapCard(() => resolved.index) };
  } catch {
    return { ...report, imports: null };
  }
}
