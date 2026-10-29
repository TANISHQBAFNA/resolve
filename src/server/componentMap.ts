import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { z } from "zod";
import { figmaIdentity } from "@/core/rules/figmaNamespaces";
import { demoteSharedLinks, evidencePair, forBulkConfirm, suggestionTier } from "./mapPair.ts";
import type { ResolveConfig } from "./mode.ts";

/**
 * Reviewed Figma ↔ code pairs. `.resolve/component-map.json` in the design-system
 * repo is the only source of pairs once it exists. The matcher only drafts it.
 * A `component.json` in a component folder is a confirmed pair from source `manifest`.
 */

const SKIP = new Set(["node_modules", "dist", "build", "coverage", ".git"]);
const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const TIER = ["evidence", "suggested", "risky"] as const;
export type MapTier = (typeof TIER)[number];
export type MapSource = "map" | "manifest";

const figmaName = z.string().trim().min(1);
const reviewed = {
  figma: figmaName,
  code: figmaName,
  by: figmaName,
  at: z.string().trim().min(1).refine((value) => !Number.isNaN(Date.parse(value)), { message: "must be a date" }),
  tier: z.enum(TIER).optional(),
  reason: figmaName.optional(),
};
const ConfirmedSchema = z.object({ ...reviewed, status: z.literal("confirmed") });
const DeniedSchema = z.object({ ...reviewed, status: z.literal("denied") });
const ProposedSchema = z.object({
  figma: figmaName,
  code: figmaName,
  status: z.literal("proposed"),
  tier: z.enum(TIER),
  reason: figmaName,
});
const EntrySchema = z.discriminatedUnion("status", [ConfirmedSchema, DeniedSchema, ProposedSchema]);
const FileSchema = z.object({ entries: z.array(EntrySchema) });
export type ComponentMapEntry = z.infer<typeof EntrySchema>;
export type ProposedEntry = z.infer<typeof ProposedSchema>;

const ManifestSchema = z.object({
  id: figmaName,
  figma: z.object({ key: figmaName.optional(), name: figmaName.optional() }).refine((figma) => Boolean(figma.key || figma.name), { message: "needs a key or a name" }),
  version: figmaName.optional(),
  recipes: z.array(figmaName).optional(),
});

export interface ManifestRow {
  /** Coded component id. Same as the component folder name. */
  code: string;
  /** Key when the manifest has one, otherwise the Figma name. */
  figma: string;
  name?: string;
  key?: string;
  file: string;
}

export interface MasterRef { name: string; nodeId?: string; fileKey?: string }
export interface CodeRef { name: string; kind: "block" | "recipe" }
export interface DeclaredLink { masterName: string; nodeId?: string; code: string; source: MapSource }
export interface StalePair { figma: string; code: string; missing: "figma" | "code" | "both" }

export interface DeclaredBuild {
  links: DeclaredLink[];
  problems: string[];
  /** Figma component names that appear in the map or a manifest, linked or not. */
  covered: string[];
  unlinkedCode: string[];
  stale: StalePair[];
  conflicts: string[];
  denies: string[];
}

export function componentMapPath(cfg: ResolveConfig): string {
  return join(cfg.repoPath ?? cfg.storeDir, cfg.repoPath ? join(".resolve", "component-map.json") : "component-map.json");
}

function componentJsonFiles(repo?: string): string[] {
  if (!repo || !existsSync(repo)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    try {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        if (item.name.startsWith(".") || SKIP.has(item.name)) continue;
        const path = join(dir, item.name);
        if (item.isDirectory()) walk(path);
        else if (item.name === "component.json") out.push(path);
      }
    } catch {
      return;
    }
  };
  walk(repo);
  return out.sort(byCode);
}

/** Raw manifest text, sorted by path, so a catalog can tell when a manifest changed. */
export function manifestBodies(repo?: string): string {
  return componentJsonFiles(repo).map((path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  }).join("\n");
}

export function readComponentMap(cfg: ResolveConfig): { exists: boolean; path: string; entries: ComponentMapEntry[]; problems: string[]; text: string } {
  const path = componentMapPath(cfg);
  if (!existsSync(path)) return { exists: false, path, entries: [], problems: [], text: "" };
  const text = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return { exists: true, path, entries: [], problems: [`${path} is not valid JSON. It was not used and not changed.`], text };
  }
  const result = FileSchema.safeParse(parsed);
  if (result.success) return { exists: true, path, entries: result.data.entries, problems: [], text };
  const issues = result.error.issues.slice(0, 8).map((issue) => `${issue.path.join(".") || "file"}: ${issue.message}`);
  return { exists: true, path, entries: [], problems: [`${path} ${issues.join("; ")}`], text };
}

export function readManifests(repo?: string): { entries: ManifestRow[]; problems: string[] } {
  const entries: ManifestRow[] = [];
  const problems: string[] = [];
  if (!repo) return { entries, problems };
  for (const path of componentJsonFiles(repo)) {
    const rel = relative(repo, path);
    const folder = dirname(path).split(/[/\\]/).pop() ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
    } catch {
      problems.push(`${rel} is not valid JSON.`);
      continue;
    }
    const result = ManifestSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues.slice(0, 4).map((issue) => `${issue.path.join(".") || "file"}: ${issue.message}`);
      problems.push(`${rel} ${issues.join("; ")}`);
      continue;
    }
    if (result.data.id !== folder) {
      problems.push(`${rel} id is "${result.data.id}" but the folder is "${folder}". The id is the coded component name.`);
      continue;
    }
    const key = result.data.figma.key;
    const name = result.data.figma.name;
    entries.push({ code: result.data.id, figma: key ?? name ?? result.data.id, ...(name ? { name } : {}), ...(key ? { key } : {}), file: rel });
  }
  return { entries, problems };
}

function tokensOf(row: { figma: string; name?: string; key?: string }): string[] {
  return [row.figma, row.name, row.key].filter((token): token is string => Boolean(token));
}

function masterHits(tokens: string[], masters: MasterRef[]): MasterRef[] {
  const hits = masters.filter((master) => tokens.some((token) => figmaIdentity(master.name) === figmaIdentity(token) || master.nodeId === token || master.fileKey === token || (master.fileKey && master.nodeId && token === `${master.fileKey}:${master.nodeId}`)));
  const seen = new Set<string>();
  return hits.filter((master) => {
    const id = `${master.name}\0${master.nodeId ?? ""}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function codeHits(code: string, components: CodeRef[], same: (name: string) => string, folder?: "block" | "recipe" | "part"): CodeRef[] {
  const hits = components.filter((entry) => same(entry.name) === same(code));
  if (folder && folder !== "part") {
    const kinded = hits.filter((entry) => entry.kind === folder);
    if (kinded.length === 1) return kinded;
  }
  return hits;
}

function pairSame(left: { figma: string; name?: string; key?: string; code: string }, right: { figma: string; name?: string; key?: string; code: string }, masters: MasterRef[], same: (name: string) => string): boolean {
  if (same(left.code) !== same(right.code)) return false;
  const a = masterHits(tokensOf(left), masters);
  const b = masterHits(tokensOf(right), masters);
  if (a.length === 1 && b.length === 1) return a[0]!.name === b[0]!.name && (a[0]!.nodeId ?? "") === (b[0]!.nodeId ?? "");
  return tokensOf(left).some((token) => tokensOf(right).some((other) => figmaIdentity(token) === figmaIdentity(other) || token === other));
}

/** Merge the map and manifests. A deny in the map wins. A confirmed disagreement is a conflict, not a guess. */
export function buildDeclaredLinks(input: {
  mapEntries: ComponentMapEntry[];
  manifests: ManifestRow[];
  masters: MasterRef[];
  components: CodeRef[];
  same: (name: string) => string;
  folderKind: (name: string) => "block" | "recipe" | "part" | undefined;
}): DeclaredBuild {
  const problems: string[] = [];
  const denies: string[] = [];
  const stale: StalePair[] = [];
  const conflicts: string[] = [];
  const covered = new Set<string>();
  const referenced = new Set<string>();
  for (const entry of input.mapEntries) referenced.add(input.same(entry.code));
  for (const row of input.manifests) referenced.add(input.same(row.code));

  const denied = input.mapEntries.filter((entry) => entry.status === "denied");
  const confirmed = input.mapEntries.filter((entry) => entry.status === "confirmed" && !denied.some((row) => pairSame(entry, row, input.masters, input.same)));
  const touch = (tokens: string[]) => {
    for (const master of masterHits(tokens, input.masters)) covered.add(master.name);
  };
  for (const entry of input.mapEntries) touch(tokensOf(entry));
  for (const row of input.manifests) touch(tokensOf(row));

  interface Group {
    label: string;
    master?: MasterRef;
    map: Map<string, { code: string; ok: boolean; entry: ComponentMapEntry }>;
    manifest: Map<string, { code: string; ok: boolean; row: ManifestRow }>;
  }
  const groups = new Map<string, Group>();
  const groupFor = (tokens: string[], fallback: string): Group => {
    const hits = masterHits(tokens, input.masters);
    const master = hits.length === 1 ? hits[0] : undefined;
    if (hits.length > 1) problems.push(`"${fallback}" matches more than one Figma component.`);
    const id = master ? `m:${master.name}\0${master.nodeId ?? ""}` : `t:${figmaIdentity(fallback)}`;
    const existing = groups.get(id);
    if (existing) return existing;
    const created: Group = { label: master?.name ?? fallback, ...(master ? { master } : {}), map: new Map(), manifest: new Map() };
    groups.set(id, created);
    return created;
  };

  const missingOf = (figmaOk: boolean, codeOk: boolean): StalePair["missing"] | undefined => (!figmaOk && !codeOk ? "both" : !figmaOk ? "figma" : !codeOk ? "code" : undefined);
  const remember = (group: Group, side: "map" | "manifest", code: string, resolved: string, ok: boolean, entry?: ComponentMapEntry, row?: ManifestRow) => {
    if (side === "map" && entry) group.map.set(input.same(code), { code: resolved, ok, entry });
    if (side === "manifest" && row) group.manifest.set(input.same(code), { code: resolved, ok, row });
  };
  for (const entry of confirmed) {
    const hits = masterHits(tokensOf(entry), input.masters);
    const folder = hits.length === 1 ? input.folderKind(hits[0]!.name) : input.folderKind(entry.figma);
    const codes = codeHits(entry.code, input.components, input.same, folder);
    const missing = missingOf(hits.length === 1, codes.length === 1);
    if (missing) stale.push({ figma: entry.figma, code: entry.code, missing });
    if (codes.length > 1) problems.push(`mapping code "${entry.code}" matches more than one coded component.`);
    if (hits.length === 1) remember(groupFor(tokensOf(entry), entry.figma), "map", entry.code, codes[0]?.name ?? entry.code, codes.length === 1, entry);
  }
  for (const row of input.manifests) {
    if (denied.some((entry) => pairSame(entry, row, input.masters, input.same))) {
      denies.push(`${row.name ?? row.figma} -> ${row.code} (manifest ignored)`);
      continue;
    }
    const hits = masterHits(tokensOf(row), input.masters);
    const folder = hits.length === 1 ? input.folderKind(hits[0]!.name) : input.folderKind(row.figma);
    const codes = codeHits(row.code, input.components, input.same, folder);
    const missing = missingOf(hits.length === 1, codes.length === 1);
    if (missing) stale.push({ figma: row.name ?? row.figma, code: row.code, missing });
    if (codes.length > 1) problems.push(`manifest ${row.file} code "${row.code}" matches more than one coded component.`);
    if (hits.length === 1) remember(groupFor(tokensOf(row), row.name ?? row.figma), "manifest", row.code, codes[0]?.name ?? row.code, codes.length === 1, undefined, row);
  }

  const links: DeclaredLink[] = [];
  for (const group of groups.values()) {
    const mapCodes = [...group.map.keys()];
    const manifestCodes = [...group.manifest.keys()];
    const differs = mapCodes.length > 0 && manifestCodes.length > 0 && (mapCodes.some((code) => !manifestCodes.includes(code)) || manifestCodes.some((code) => !mapCodes.includes(code)));
    if (differs) {
      const master = group.master;
      const label = master?.name ?? group.label;
      const manifestNames = manifestCodes.map((code) => group.manifest.get(code)?.row.code ?? code).join(", ");
      const mapNames = mapCodes.map((code) => group.map.get(code)?.entry.code ?? code).join(", ");
      conflicts.push(`${label} is ${manifestNames} in the manifest and ${mapNames} in the map`);
      continue;
    }
    const codes = new Set([...mapCodes, ...manifestCodes]);
    for (const code of codes) {
      const fromMap = group.map.get(code);
      const fromManifest = group.manifest.get(code);
      const master = group.master;
      const resolved = fromMap?.ok ? fromMap.code : fromManifest?.ok ? fromManifest.code : undefined;
      if (!master || !resolved) continue;
      links.push({ masterName: master.name, ...(master.nodeId ? { nodeId: master.nodeId } : {}), code: resolved, source: fromMap?.ok ? "map" : "manifest" });
    }
  }

  const unlinkedCode = input.components.filter((entry) => !referenced.has(input.same(entry.name))).map((entry) => entry.name).sort(byCode);
  stale.sort((a, b) => byCode(a.figma, b.figma) || byCode(a.code, b.code));
  return { links, problems, covered: [...covered].sort(byCode), unlinkedCode, stale, conflicts: conflicts.sort(byCode), denies: denies.sort(byCode) };
}

const EVIDENCE: Record<"mapped" | "exact" | "alias", string> = {
  mapped: "named in the mapping file",
  exact: "same name and a shared variant, modifier, or description",
  alias: "shared alias",
};

/** The current matcher, written as proposals. Never confirmed. Evidence is a same-name pair with a real signal. A shared side, a related word, or a different `-container` name stays suggested. */
export function proposalsFromReport(report: {
  pairs: Array<{ figma: string; code: string; confidence: "mapped" | "exact" | "alias" }>;
  suggestions?: Array<{ figma: string; code: string; confidence?: string; reasons: string[] }>;
}): ProposedEntry[] {
  const out = new Map<string, ProposedEntry>();
  const key = (figma: string, code: string) => `${figmaIdentity(figma)}\0${code.trim().toLowerCase()}`;
  const rank: Record<MapTier, number> = { evidence: 0, suggested: 1, risky: 2 };
  const put = (entry: ProposedEntry) => {
    const id = key(entry.figma, entry.code);
    const have = out.get(id);
    if (!have || rank[entry.tier] < rank[have.tier]) out.set(id, entry);
  };
  for (const pair of report.pairs) {
    const reason = EVIDENCE[pair.confidence];
    put({ figma: pair.figma, code: pair.code, status: "proposed", tier: evidencePair(pair.figma, pair.code) ? "evidence" : "suggested", reason });
  }
  for (const row of report.suggestions ?? []) {
    put({ figma: row.figma, code: row.code, status: "proposed", tier: suggestionTier(row), reason: row.reasons.join("; ") || "similar names" });
  }
  return demoteSharedLinks([...out.values()]).sort((a, b) => rank[a.tier] - rank[b.tier] || byCode(a.figma, b.figma) || byCode(a.code, b.code));
}

function reviewedRow(pair: { figma: string; code: string }, status: "confirmed" | "denied", who: string, at: string, tier?: MapTier, reason?: string): ComponentMapEntry {
  const extra = { ...(tier ? { tier } : {}), ...(reason ? { reason } : {}) };
  if (status === "confirmed") return { figma: pair.figma, code: pair.code, status: "confirmed", by: who, at, ...extra };
  return { figma: pair.figma, code: pair.code, status: "denied", by: who, at, ...extra };
}

function present(entry: ComponentMapEntry): ComponentMapEntry {
  if (entry.status === "proposed") return { figma: entry.figma, code: entry.code, status: "proposed", tier: entry.tier, reason: entry.reason };
  return reviewedRow(entry, entry.status, entry.by, entry.at, entry.tier, entry.reason);
}

function writeEntries(path: string, entries: ComponentMapEntry[]) {
  mkdirSync(dirname(path), { recursive: true });
  const checked = FileSchema.parse({ entries: entries.map(present) });
  writeFileSync(path, `${JSON.stringify(checked, null, 2)}\n`);
}

function taken(figma: string, code: string, kept: ComponentMapEntry[], manifests: ManifestRow[], masters: MasterRef[], same: (name: string) => string): boolean {
  const pair = { figma, code };
  return kept.some((entry) => pairSame(entry, pair, masters, same)) || manifests.some((row) => pairSame(row, pair, masters, same));
}

/** Writes proposals. Confirmed and denied rows already in the file stay as they are. */
export function writeDraft(cfg: ResolveConfig, proposals: ProposedEntry[], same: (name: string) => string, masters: MasterRef[] = []): { file: string; proposed: number; kept: number } {
  const current = readComponentMap(cfg);
  if (current.exists && current.problems.length) throw new Error(current.problems.join("\n"));
  const kept = current.entries.filter((entry) => entry.status === "confirmed" || entry.status === "denied");
  const manifests = readManifests(cfg.repoPath).entries;
  const proposed = proposals.filter((entry) => entry.status === "proposed" && !taken(entry.figma, entry.code, kept, manifests, masters, same));
  writeEntries(current.path, [...kept, ...proposed]);
  return { file: current.path, proposed: proposed.length, kept: kept.length };
}

function resolvePair(pair: string, masters: MasterRef[], components: CodeRef[], same: (name: string) => string): { figma: string; code: string } | string {
  const at = pair.indexOf("=");
  const figma = at < 0 ? "" : pair.slice(0, at).trim();
  const code = at < 0 ? "" : pair.slice(at + 1).trim();
  if (at < 0 || !figma || !code || code.includes(",")) return `"${pair}": use "Figma name=code" with one coded component.`;
  const hits = masterHits([figma], masters);
  const codes = codeHits(code, components, same);
  if (hits.length !== 1 || codes.length !== 1) return `"${pair}": use "Figma name=code" with a Figma component and a coded component that exist.`;
  return { figma: hits[0]!.name, code: codes[0]!.name };
}

/** Confirm or deny the named pairs. One pair each. Does not confirm a whole tier. */
export function confirmComponentPairs(input: {
  cfg: ResolveConfig;
  pairs: string[];
  action: "confirm" | "deny";
  who: string;
  at: string;
  masters: MasterRef[];
  components: CodeRef[];
  same: (name: string) => string;
}): { file: string; updated: Array<{ figma: string; code: string; status: "confirmed" | "denied" }>; skipped: number } {
  const current = readComponentMap(input.cfg);
  if (current.exists && current.problems.length) throw new Error(current.problems.join("\n"));
  const status = input.action === "confirm" ? "confirmed" : "denied";
  const errors: string[] = [];
  const resolved = input.pairs.flatMap((pair) => {
    const found = resolvePair(pair, input.masters, input.components, input.same);
    if (typeof found === "string") {
      errors.push(found);
      return [];
    }
    return [found];
  });
  if (errors.length) throw new Error(errors.join("\n"));
  const entries = [...current.entries];
  const updated: Array<{ figma: string; code: string; status: "confirmed" | "denied" }> = [];
  let skipped = 0;
  for (const pair of resolved) {
    const have = entries.find((entry) => pairSame(entry, pair, input.masters, input.same));
    if (have && have.status === status && have.by === input.who && have.at === input.at && have.figma === pair.figma && have.code === pair.code) {
      skipped += 1;
      continue;
    }
    const next = reviewedRow(pair, status, input.who, input.at, have?.tier, have?.reason);
    if (have) entries[entries.indexOf(have)] = next;
    else entries.push(next);
    updated.push({ figma: pair.figma, code: pair.code, status });
  }
  if (updated.length) writeEntries(current.path, entries);
  return { file: current.path, updated, skipped };
}

/** Confirms proposed rows whose tier is evidence. Suggested and risky rows stay proposed. */
export function confirmEvidenceTier(cfg: ResolveConfig, who: string, at: string): { file: string; confirmed: number; left: number } {
  const current = readComponentMap(cfg);
  if (!current.exists) throw new Error(`No component map at ${current.path}. Run code-map --draft first.`);
  if (current.problems.length) throw new Error(current.problems.join("\n"));
  const rows = current.entries.flatMap((entry) => entry.status === "proposed" ? [{ entry, tier: entry.tier }] : []);
  const allowed = new Set<ComponentMapEntry>(forBulkConfirm(rows).map((row) => row.entry));
  let confirmed = 0;
  const entries = current.entries.map((entry) => {
    if (!allowed.has(entry) || entry.status !== "proposed") return entry;
    confirmed += 1;
    return reviewedRow(entry, "confirmed", who, at, entry.tier, entry.reason);
  });
  writeEntries(current.path, entries);
  return { file: current.path, confirmed, left: entries.filter((entry) => entry.status === "proposed").length };
}
