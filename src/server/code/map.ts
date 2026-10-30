import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { figmaFolderKind, figmaIdentity, namespaceSet } from "@/core/rules/figmaNamespaces";
import { codeMapCard } from "@/core/query/replacements";
import { buildDeclaredLinks, componentMapPath, manifestBodies, readComponentMap, readManifests } from "../componentMap.ts";
import type { ResolveConfig } from "../mode.ts";
import { awaitsReview, mappingStatus } from "../mappingStatus.ts";
import { demoteSharedLinks, evidencePair, GENERIC_PAIR_WORDS, houseWords, pairDenySet, partOwner, sameNameRow, secondSignal } from "../mapPair.ts";
import { resolveGraph } from "../store";
import type { CatalogEntry, CodeCatalog, FigmaMaster, MatchBy } from "./scan.ts";
import { nameWords, namespaceStems, RELATED, tokens } from "./words.ts";

/** Joins, strongest first: mapped (a confirmed mapping.json line; a proposed line only awaits review; a deny line wins), exact (same name plus a specific variant, modifier, description phrase, or base parts that match elements). Generic states do not count. A denied name (built-in stepper, plus config pairDeny) does not auto-pair on the name alone. Anything else is suggested, never joined. */
const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const plural = (w: string) => (w.length > 3 && w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith("s") && !/(ss|us|is)$/.test(w) ? w.slice(0, -1) : w);
export const norm = (name: string, namespaces: ReadonlySet<string> = namespaceSet()): string =>
  (nameWords(name, namespaces).toLowerCase().match(/[a-z0-9]+/g) ?? []).map(plural).join("");
const uniq = (items: string[]) => [...new Set(items)].sort(byCode);

/** One line of the mapping file. `figma` and `code` together make a pair; either alone gives that component aliases. A proposed line does neither. */
export interface MapRule { figma?: string; code: string[]; aliases: string[]; deny?: boolean; proposed?: true; source?: "manifest" }

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
      const status = mappingStatus(row["status"], `mappings[${i}]`, problems);
      const deny = row["deny"] === true || status === "denied";
      if (!figma && !code.length) {
        problems.push(`mappings[${i}] has neither "figma" nor "code".`);
        return [];
      }
      return [{ ...(figma ? { figma } : {}), code, aliases, ...(deny ? { deny } : {}), ...(status === "proposed" && !deny ? { proposed: true as const } : {}) }];
    });
    return { rules, problems, text };
  } catch {
    return { rules: [], problems: [`${path} is not valid JSON. It was not used and not changed.`], text };
  }
}

export function mappingDigest(cfg: ResolveConfig): string {
  const { text } = readMapping(cfg);
  const body = [text, readComponentMap(cfg).text, manifestBodies(cfg.repoPath)].filter(Boolean).join("\n");
  return body ? createHash("sha256").update(body).digest("hex").slice(0, 16) : "";
}

interface Link { master: FigmaMaster; entry: CatalogEntry; by: MatchBy; alias?: string; source?: "map" | "manifest" }
const STRENGTH: Record<MatchBy, number> = { mapped: 0, exact: 1, alias: 2 };

function compute(catalog: CodeCatalog, cfg: ResolveConfig, given?: FigmaMaster[], infer = false) {
  const { rules, problems } = readMapping(cfg);
  const ns = namespaceSet(cfg.figmaNamespaces);
  const same = (name: string) => norm(name, ns);
  const ordered = (given ?? catalog.figmaMasters ?? []).filter((m) => m.published !== false).slice().sort((a, b) => byCode(a.name, b.name) || byCode(a.nodeId ?? "", b.nodeId ?? ""));
  const parts = ordered.filter((m) => figmaFolderKind(m.name, ns) === "part");
  const masters = ordered.filter((m) => figmaFolderKind(m.name, ns) !== "part");
  const codeAliases = new Map<CatalogEntry, string[]>();
  const figmaAliases = new Map<string, string[]>();
  const pairRules: MapRule[] = [];
  const awaiting = rules.filter((rule) => rule.proposed && rule.figma && rule.code.length).map((rule) => ({ figma: rule.figma as string, code: rule.code }));
  const denied = new Set<string>();
  const blocked = (figma: string, code: string) => {
    const key = figmaIdentity(figma);
    return denied.has(`${key}\0*`) || denied.has(`${key}\0${same(code)}`);
  };
  const targets = (rule: MapRule) =>
    rule.code.flatMap((name) => {
      const hits = catalog.components.filter((e) => same(e.name) === same(name));
      const folder = rule.figma ? figmaFolderKind(rule.figma, ns) : undefined;
      const allowed = folder && folder !== "part" ? hits.filter((e) => e.kind === folder) : hits;
      const entry = allowed.length === 1 ? allowed[0] : hits.length === 1 ? hits[0] : undefined;
      if (!entry) problems.push(hits.length ? `mapping code "${name}" matches more than one coded component.` : `mapping code "${name}" is not a component in the catalog.`);
      return entry ? [entry] : [];
    });
  for (const rule of rules) {
    if (rule.deny) {
      if (rule.figma && !rule.code.length) denied.add(`${figmaIdentity(rule.figma)}\0*`);
      if (rule.figma) for (const name of rule.code) denied.add(`${figmaIdentity(rule.figma)}\0${same(name)}`);
      continue;
    }
    if (rule.proposed) continue;
    const found = targets(rule);
    for (const entry of found) codeAliases.set(entry, [...(codeAliases.get(entry) ?? []), ...rule.aliases]);
    if (rule.figma) {
      const key = figmaIdentity(rule.figma);
      figmaAliases.set(key, [...(figmaAliases.get(key) ?? []), ...rule.aliases]);
      if (found.length) pairRules.push({ ...rule, code: found.map((e) => e.name) });
    }
  }
  const entryNames = (e: CatalogEntry) => [e.name, ...(codeAliases.get(e) ?? [])];
  const masterNames = (m: FigmaMaster) => [m.name, ...(m.aliases ?? []), ...(figmaAliases.get(figmaIdentity(m.name)) ?? [])];
  const folderOk = (name: string, kind: CatalogEntry["kind"]) => {
    const folder = figmaFolderKind(name, ns);
    return folder !== "part" && (!folder || folder === kind);
  };
  const partMap = new Map<CatalogEntry, string[]>();
  const blocks = catalog.components.filter((e) => e.kind === "block");
  for (const part of parts) {
    const parent = partOwner(part.name, blocks, ns, plural, byCode);
    if (parent) partMap.set(parent, uniq([...(partMap.get(parent) ?? []), part.name]));
  }
  const deny = pairDenySet(cfg.pairDeny);
  const choose = (master: FigmaMaster, hits: CatalogEntry[]) => {
    const kinded = hits.filter((e) => folderOk(master.name, e.kind));
    const pool = kinded.length ? kinded : hits;
    const agreed = pool.filter((entry) => secondSignal(master, entry, partMap.get(entry) ?? [], deny).agree);
    return agreed.length === 1 ? agreed[0] : undefined;
  };

  const links: Link[] = [];
  const ambiguous = new Map<string, CatalogEntry[]>();
  const mapFile = infer ? undefined : readComponentMap(cfg);
  const manifests = infer ? undefined : readManifests(cfg.repoPath);
  if (mapFile) problems.push(...mapFile.problems);
  if (manifests) problems.push(...manifests.problems);
  const usingMap = Boolean(mapFile?.exists);
  let covered = new Set<string>();
  let unlinkedCode: string[] | undefined;
  let stale: Array<{ figma: string; code: string; missing: "figma" | "code" | "both" }> | undefined;
  let conflicts: string[] | undefined;
  let denies: string[] | undefined;
  if (usingMap && mapFile && manifests) {
    const built = buildDeclaredLinks({ mapEntries: mapFile.entries, manifests: manifests.entries, masters, components: catalog.components, same, folderKind: (name) => figmaFolderKind(name, ns) });
    problems.push(...built.problems);
    covered = new Set(built.covered);
    unlinkedCode = built.unlinkedCode;
    stale = built.stale;
    conflicts = built.conflicts;
    denies = built.denies;
    for (const link of built.links) {
      const master = masters.find((item) => item.name === link.masterName && (link.nodeId === undefined || item.nodeId === link.nodeId));
      const entry = catalog.components.find((item) => item.name === link.code);
      if (!master || !entry) continue;
      links.push({ master, entry, by: "mapped", source: link.source });
    }
  } else {
    if (manifests) {
      for (const row of manifests.entries) {
        const keys = [row.figma, row.name, row.key].filter((token): token is string => Boolean(token));
        const hits = masters.filter((master) => keys.some((token) => figmaIdentity(master.name) === figmaIdentity(token) || master.nodeId === token || master.fileKey === token));
        if (hits.length === 1) pairRules.push({ figma: hits[0]!.name, code: [row.code], aliases: [], source: "manifest" });
        else problems.push(hits.length ? `${row.file} matches more than one Figma component.` : `${row.file} names ${row.name ?? row.figma}, which is not a Figma component.`);
      }
    }
    for (const master of masters) {
      const mine = pairRules.filter((r) => figmaIdentity(r.figma ?? "") === figmaIdentity(master.name));
      if (mine.length) {
        for (const rule of mine) for (const entry of uniqueEntries(targets(rule))) {
          if (blocked(master.name, entry.name) || links.some((have) => have.master === master && have.entry === entry)) continue;
          links.push({ master, entry, by: "mapped", ...(rule.source ? { source: rule.source } : {}) });
        }
        continue;
      }
      const named = catalog.components.filter((e) => same(e.name) === same(master.name));
      if (named.length) {
        const exact = choose(master, named);
        if (exact && !blocked(master.name, exact.name)) links.push({ master, entry: exact, by: "exact" });
        else if (named.filter((e) => folderOk(master.name, e.kind)).length > 1) ambiguous.set(master.name, named.filter((e) => folderOk(master.name, e.kind)));
        continue;
      }
      const names = masterNames(master);
      const hits = new Map<CatalogEntry, string>();
      for (const entry of catalog.components) {
        if (!folderOk(master.name, entry.kind)) continue;
        for (const n of names) {
          const other = entryNames(entry).find((e) => same(e) === same(n));
          if (other !== undefined) hits.set(entry, same(n) === same(master.name) ? other : n);
        }
      }
      const list = [...hits.keys()];
      if (list.length > 1) ambiguous.set(master.name, list);
    }
  }
  return { rules, problems: uniq(problems), masters, parts, partMap, ns, deny, links, ambiguous, codeAliases, figmaAliases, masterNames, entryNames, blocked, covered, unlinkedCode, stale, conflicts, denies, awaiting, declared: usingMap };
}

const uniqueEntries = (list: CatalogEntry[]) => [...new Set(list)];

/** Joins the catalog to the Figma components (given, else the ones kept from the last link). Rewrites figma, matchedBy, matched and aliases on every entry. */
export function linkFigma(catalog: CodeCatalog, cfg: ResolveConfig, given?: FigmaMaster[]) {
  if (given) catalog.figmaMasters = given.filter((m) => m.published !== false).slice().sort((a, b) => byCode(a.name, b.name) || byCode(a.nodeId ?? "", b.nodeId ?? ""));
  for (const e of catalog.components) for (const k of ["figma", "figmaAlso", "matchedBy", "matched", "aliases", "parts"] as const) delete e[k];
  const r = compute(catalog, cfg);
  catalog.mappingDigest = mappingDigest(cfg);
  for (const [entry, aliases] of r.codeAliases) entry.aliases = uniq(aliases);
  for (const [entry, names] of r.partMap) entry.parts = names;
  const per = new Map<CatalogEntry, Link[]>();
  for (const l of r.links) per.set(l.entry, [...(per.get(l.entry) ?? []), l]);
  for (const [entry, list] of per) {
    list.sort((a, b) => STRENGTH[a.by] - STRENGTH[b.by] || byCode(a.master.name, b.master.name));
    const first = list[0] as Link;
    const aliases = uniq([...(first.master.aliases ?? []), ...(r.figmaAliases.get(figmaIdentity(first.master.name)) ?? [])]);
    entry.figma = { ...first.master, ...(aliases.length ? { aliases } : {}) };
    entry.matchedBy = first.by;
    entry.matched = { figma: first.master.name, code: entry.name, ...(first.alias ? { alias: first.alias } : {}) };
    if (list.length > 1) entry.figmaAlso = uniq(list.slice(1).map((l) => l.master.name));
  }
  const matched = new Set(r.links.map((l) => l.master.name));
  const attached = new Set([...r.partMap.values()].flat());
  const byKind = { mapped: 0, exact: 0, alias: 0 };
  for (const e of catalog.components) if (e.matchedBy) byKind[e.matchedBy] += 1;
  const open = [...r.masters, ...r.parts.filter((part) => !attached.has(part.name))];
  return { linked: per.size, byKind, figmaOnly: open.filter((m) => !matched.has(m.name)).map((m) => m.name), problems: r.problems };
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

export interface Suggestion { figma: string; code: string; confidence: "suggested" | "risky: same name only"; score: number; reasons: string[] }

function suggestions(master: FigmaMaster, catalog: CodeCatalog, r: ReturnType<typeof compute>, limit: number): Suggestion[] {
  const skip = new Set([...namespaceStems(r.ns), ...houseWords(r.masters.map((m) => tokens(nameWords(m.name, r.ns))), catalog.components.map((e) => tokens(nameWords(e.name, r.ns))))]);
  const words = (name: string) => tokens(nameWords(name, r.ns)).filter((word) => !skip.has(word));
  const mv = tokens((master.variants ?? []).join(" ").replace(/[-_]+/g, " ")).filter((word) => !skip.has(word));
  const folder = figmaFolderKind(master.name, r.ns);
  const leaf = master.name.split("/").map((part) => part.trim()).filter(Boolean).pop() ?? master.name; // the last path segment, so a folder prefix (acme-lib/button) does not hide a same name
  const out = catalog.components.flatMap((entry): Suggestion[] => {
    if (folder === "part" || (folder && folder !== entry.kind) || r.blocked(master.name, entry.name)) return [];
    if (norm(entry.name, r.ns) === norm(master.name, r.ns) || norm(entry.name, r.ns) === norm(leaf, r.ns)) {
      const signal = secondSignal(master, entry, r.partMap.get(entry) ?? [], r.deny);
      if (!signal.agree) return [sameNameRow(master.name, entry.name, signal.disagree)];
    }
    let best = { score: 0, reasons: [] as string[] };
    for (const m of [...r.masterNames(master), leaf]) for (const e of r.entryNames(entry)) {
      const leftWords = words(m);
      const rightWords = words(e);
      const sharedWords = [...new Set(leftWords)].filter((word) => rightWords.includes(word));
      const genericOnly = sharedWords.length > 0 && sharedWords.every((word) => GENERIC_PAIR_WORDS.has(word)) && norm(m, r.ns) !== norm(e, r.ns);
      const s = nameLike(genericOnly ? leftWords.filter((word) => !GENERIC_PAIR_WORDS.has(word)) : leftWords, genericOnly ? rightWords.filter((word) => !GENERIC_PAIR_WORDS.has(word)) : rightWords);
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

export function mapReport(catalog: CodeCatalog, cfg: ResolveConfig, opts: { suggest?: boolean; limit?: number; masters?: FigmaMaster[]; infer?: boolean } = {}) {
  const r = compute(catalog, cfg, opts.masters, opts.infer === true);
  const linkedMasters = new Set(r.links.map((l) => l.master.name));
  const linkedCode = new Set(r.links.map((l) => l.entry.name));
  const attached = new Set([...r.partMap.values()].flat());
  const unmatchedFigma = r.masters.filter((m) => !linkedMasters.has(m.name) && !r.covered.has(m.name));
  const orphans = r.parts.filter((part) => !attached.has(part.name) && !r.covered.has(part.name));
  const heldFigma = r.masters.filter((m) => !linkedMasters.has(m.name) && r.covered.has(m.name)).map((m) => m.name);
  const known = r.masters.length + r.parts.length;
  const unpairedParts = catalog.components.flatMap((entry) => {
    const names = r.partMap.get(entry);
    return names?.length && !linkedCode.has(entry.name) ? [{ code: entry.name, parts: names }] : [];
  }).sort((a, b) => byCode(a.code, b.code));
  const suggested = opts.suggest ? unmatchedFigma.flatMap((m) => suggestions(m, catalog, r, Math.max(1, opts.limit ?? 3))) : undefined;
  return {
    mappingFile: mappingPath(cfg),
    mappingExists: existsSync(mappingPath(cfg)),
    componentMapFile: componentMapPath(cfg),
    componentMapExists: r.declared,
    ...(r.problems.length ? { problems: r.problems } : {}),
    figmaComponents: known,
    codeComponents: catalog.components.length,
    pairs: r.links.map((l) => ({ figma: l.master.name, code: l.entry.name, confidence: l.by, ...(l.alias ? { alias: l.alias } : {}), ...(l.source ? { source: l.source } : {}), ...(r.partMap.get(l.entry)?.length ? { parts: r.partMap.get(l.entry) } : {}) })).sort((a, b) => byCode(a.figma, b.figma) || byCode(a.code, b.code)),
    unmatchedFigma: [...unmatchedFigma, ...orphans].map((m) => m.name),
    unmatchedCode: r.declared ? (r.unlinkedCode ?? []) : known ? catalog.components.filter((e) => !linkedCode.has(e.name)).map((e) => e.name) : [],
    ...(r.declared ? { unlinkedFigma: [...unmatchedFigma, ...orphans].map((m) => m.name), unlinkedCode: r.unlinkedCode ?? [] } : {}),
    ...(heldFigma.length ? { heldFigma } : {}),
    ...(r.stale?.length ? { stale: r.stale } : {}),
    ...(r.conflicts?.length ? { conflicts: r.conflicts } : {}),
    ...(r.denies?.length ? { denies: r.denies } : {}),
    ...(r.awaiting.length ? { awaitingReview: r.awaiting } : {}),
    ...(unpairedParts.length ? { unpairedParts } : {}),
    ...(suggested ? { suggestions: suggested, bulkConfirm: demoteSharedLinks(r.links.filter((link) => link.by === "exact" || link.by === "mapped").map((link) => ({ figma: link.master.name, code: link.entry.name, tier: evidencePair(link.master.name, link.entry.name) ? "evidence" as const : "suggested" as const }))).flatMap((row) => row.tier === "evidence" ? [`${row.figma}=${row.code}`] : []) } : {}),
    ...(!r.declared && !opts.infer ? { draftHint: "No component map yet. Run code-map --draft." } : {}),
    note: r.declared
      ? "Pairs come only from the component map and from component.json manifests. A proposed row is not a link. Nothing is guessed."
      : known
        ? "A suggestion is not a link. Confirm one pair with `resolve code-map --write \"Figma=code\"`. A batch confirms evidence rows only, so confirm a suggested row on its own."
        : "No Figma components known yet. Run code_scan with figma components (or learn the Figma library in both mode), then ask again.",
  };
}

/** Writes a batch of pairs. Only evidence rows are written. Confirm a suggested row on its own. */
export function confirmBulk(cfg: ResolveConfig, catalog: CodeCatalog, pairs: string[]) {
  const report = mapReport(catalog, cfg, { suggest: true, limit: catalog.components.length || 1 });
  const allowed = new Set(report.bulkConfirm ?? []);
  return writeMappings(cfg, catalog, pairs.filter((pair) => allowed.has(pair)));
}

/** Appends confirmed pairs ("Figma name=code" or "Figma name=code1,code2") to the mapping file, or marks a proposed line for that pair confirmed. Writes nothing if any pair is wrong. */
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
  const ns = namespaceSet(cfg.figmaNamespaces);
  const same = (name: string) => norm(name, ns);
  const pool = (catalog.figmaMasters ?? []).filter((m) => m.published !== false);
  const entries = new Map(catalog.components.map((e) => [same(e.name), e.name]));
  const errors: string[] = [];
  const added: Array<{ figma: string; code: string | string[] }> = [];
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    const key = figmaIdentity(at < 0 ? "" : pair.slice(0, at));
    const hits = pool.filter((m) => figmaIdentity(m.name) === key);
    const figma = hits.length === 1 ? hits[0]!.name : undefined;
    const names = (at < 0 ? "" : pair.slice(at + 1)).split(",").map((n) => entries.get(same(n)));
    if (at < 0 || !figma || !names.length || names.some((n) => !n)) {
      errors.push(`"${pair}": use "Figma name=code-name[,code-name]" with a Figma component and coded components that exist.`);
      continue;
    }
    const code = uniq(names as string[]);
    const have = list.find((r) => {
      const row = (r ?? {}) as { figma?: unknown; code?: unknown };
      return typeof row.figma === "string" && figmaIdentity(row.figma) === figmaIdentity(figma) && code.every((c) => strings(row.code).some((x) => same(x) === same(c)));
    }) as Record<string, unknown> | undefined;
    if (have && !awaitsReview(have)) continue;
    added.push({ figma, code: code.length === 1 ? (code[0] as string) : code });
    if (have) have["status"] = "confirmed"; else list.push(added[added.length - 1]);
  }
  if (errors.length) throw new Error(errors.join("\n"));
  if (added.length) {
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
