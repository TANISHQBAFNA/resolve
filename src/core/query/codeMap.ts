import { existsSync, readFileSync } from "node:fs";
import type { GraphNode } from "@/core/model";
import type { GraphIndex } from "./GraphIndex";
import { overlayFile } from "./overlayFile";
import { nodeFileKey } from "./workspaceMerge";

export const NO_CODE_MAP_HINT = "No code map. Add .graphify/code-map.json next to synonyms.json.";
const ENTRY_KEYS = ["fileKey", "id", "name", "code", "status", "replacedBy"];
const CODE_KEYS = ["import", "component"];
const FROM = /\bfrom\s+(['"])([^'"\s\p{Cc}]{1,120})\1\s*;?$/u;

/** What the host (agentSurface) knows about a master. Kept as hooks so this file has no cycle. */
export interface Hooks {
  retired(node: GraphNode): boolean;
  real(node: GraphNode): boolean;
  /** Name of the current part that replaces a retired one, following replacedBy up to 3 hops. */
  use(node: GraphNode, twinOf: (node: GraphNode) => Twin | undefined): string | undefined;
}
export interface Twin {
  line: string;
  retired: boolean;
  replacedBy?: string;
}
export interface Item {
  name?: string;
  fileKey?: string;
  id?: string;
  entry?: number;
  reason?: string;
  use?: string | null;
  code?: string | null;
}
export interface CodeMapReport {
  configured: boolean;
  hint: string | null;
  counts: Record<"masters" | "mapped" | "retired" | "unmapped" | "ambiguous" | "conflict" | "stale" | "ignored", number>;
  unmapped: Item[];
  ambiguous: Item[];
  conflicts: Item[];
  retired: Item[];
  stale: Item[];
  replacements: Item[];
  ignored: Item[];
}
export interface CodeView {
  twin(node: GraphNode): Twin | undefined;
  /** Retired by the library or by the map. */
  retired(node: GraphNode): boolean;
  report: CodeMapReport;
}

interface Row {
  n: number;
  fileKey: string;
  id?: string;
  name?: string;
  line: string;
  status?: string;
  replacedBy?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const clean = (s: string) => s.replace(/\p{Cc}|[\u2028\u2029]/gu, " ").trim();

function parseRow(raw: unknown, n: number): Row {
  if (!isRecord(raw)) throw "not an object";
  const bad = Object.keys(raw).find((k) => !ENTRY_KEYS.includes(k));
  if (bad) throw `unsupported field '${clean(bad).slice(0, 30)}'`;
  const text = (o: Record<string, unknown>, k: string) => {
    if (o[k] === undefined) return undefined;
    if (typeof o[k] !== "string") throw `'${k}' must be text`;
    return (o[k] as string).trim() || undefined;
  };
  const code = raw["code"];
  if (!isRecord(code)) throw "missing code";
  const badCode = Object.keys(code).find((k) => !CODE_KEYS.includes(k));
  if (badCode) throw `unsupported field 'code.${clean(badCode).slice(0, 30)}'`;
  const component = text(code, "component");
  if (!component) throw "missing component";
  if (!/^[A-Za-z_$][\w$.]{0,59}$/.test(component)) throw "component must be a plain name like Button";
  const module = text(code, "import")?.match(FROM)?.[2];
  if (!module) throw "import needs from '<module>'";
  const [fileKey = "", id, name, status, replacedBy] = [
    text(raw, "fileKey"),
    text(raw, "id"),
    text(raw, "name"),
    text(raw, "status"),
    text(raw, "replacedBy"),
  ];
  if (status && status !== "current" && status !== "retired") throw "status must be current or retired";
  if (id && !fileKey) throw "id needs fileKey";
  if (!id && !name) throw "needs fileKey + id, or name";
  return {
    n,
    fileKey,
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
    line: `${component} from '${module}'`,
    ...(status ? { status } : {}),
    ...(replacedBy ? { replacedBy: clean(replacedBy).slice(0, 60) } : {}),
  };
}

let warned = "";
const warnedClash = new Set<string>();

/** Missing, empty, BOM-only = no map, quietly. Not JSON = no map plus one stderr line. */
function load(): { rows: Row[]; ignored: Item[]; path: string } | undefined {
  const path = overlayFile("code-map.json");
  if (!path || !existsSync(path)) {
    warned = "";
    return undefined;
  }
  let raw: unknown;
  try {
    const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "").trim();
    if (!text) return undefined;
    raw = JSON.parse(text);
  } catch {
    raw = undefined;
  }
  const list = isRecord(raw) ? (raw["entries"] ?? []) : undefined;
  if (!Array.isArray(list)) {
    if (warned !== path) process.stderr.write("code-map.json is malformed; ignored\n");
    warned = path;
    return undefined;
  }
  warned = "";
  const rows: Row[] = [];
  const ignored: Item[] = Object.keys(raw as object)
    .filter((k) => k !== "entries")
    .map((k) => ({ reason: `unsupported field '${clean(k).slice(0, 30)}'${k === "namingRule" ? " (planned)" : ""}` }));
  list.forEach((item, i) => {
    try {
      rows.push(parseRow(item, i + 1));
    } catch (reason) {
      ignored.push({ entry: i + 1, reason: String(reason) });
    }
  });
  return { rows, ignored, path };
}

function resolveRows(index: GraphIndex, { rows, ignored, path }: { rows: Row[]; ignored: Item[]; path: string }, hooks: Hooks): CodeView {
  const fk = (n: GraphNode) => nodeFileKey(n, index.graph.fileKey) ?? "";
  const fid = (n: GraphNode) => n.figmaNodeId ?? n.id;
  const masters = index.graph.nodes.filter(
    (n) => (n.type === "COMPONENT_SET" || n.type === "MAIN_COMPONENT") && !n.componentSetId && !n.isRemote && hooks.real(n),
  );
  const byId = new Map(masters.map((n) => [`${fk(n)}\n${fid(n)}`, n]));
  const byName = new Map<string, GraphNode[]>();
  for (const n of masters) byName.set(n.name, [...(byName.get(n.name) ?? []), n]);

  const claims = new Map<GraphNode, Row[]>();
  const ambiguous = new Set<string>();
  const conflict = new Map<string, string>();
  const clash = new Set<string>();
  const stale: Item[] = [];
  const claim = (n: GraphNode, row: Row) => claims.set(n, [...(claims.get(n) ?? []), row]);
  for (const row of rows) {
    const where = { fileKey: row.fileKey, id: row.id, name: row.name, entry: row.n };
    const named = (byName.get(row.name ?? "") ?? []).filter((n) => !row.fileKey || fk(n) === row.fileKey);
    if (row.id) {
      const hit = byId.get(`${row.fileKey}\n${row.id}`);
      if (!hit) stale.push({ ...where, reason: "no such component" });
      else if (row.name && hit.name !== row.name && named.length) conflict.set(hit.id, "id and name point to different components");
      else claim(hit, row);
    } else if (named.length === 1) claim(named[0]!, row);
    else if (named.length) named.forEach((n) => ambiguous.add(n.id));
    else stale.push({ ...where, reason: "no component with that name" });
  }

  const twins = new Map<string, Twin>();
  for (const [node, list] of claims) {
    if (conflict.has(node.id)) continue;
    const opts = list.map((r) => ({ r, retired: r.status ? r.status === "retired" : hooks.retired(node) }));
    const distinct = [...new Map(opts.map((o) => [`${o.r.line}|${o.retired}|${o.r.replacedBy}`, o])).values()];
    const current = distinct.filter((o) => !o.retired);
    const pick = distinct.length === 1 ? distinct[0] : current.length === 1 ? current[0] : undefined;
    if (!pick) conflict.set(node.id, "entries disagree and none is the only current one");
    else {
      twins.set(node.id, { line: pick.r.line, retired: pick.retired, ...(pick.r.replacedBy ? { replacedBy: pick.r.replacedBy } : {}) });
      if (distinct.length > 1) clash.add(node.id);
    }
  }
  const twin = (node: GraphNode) => twins.get(node.id) ?? (node.componentSetId ? twins.get(node.componentSetId) : undefined);
  const retired = (node: GraphNode) => hooks.retired(node) || Boolean(twin(node)?.retired);

  const report = emptyReport(null, ignored);
  report.configured = true;
  report.counts.masters = masters.length;
  report.counts.stale = stale.length;
  report.stale = stale;
  for (const n of masters) {
    const item = { name: n.name, fileKey: fk(n), id: fid(n) };
    const t = twins.get(n.id);
    if (retired(n)) {
      const use = hooks.use(n, twin);
      report.retired.push({ ...item, use: use ?? null, code: t?.line ?? null });
      if (t?.replacedBy && !use) report.replacements.push({ ...item, reason: `replacedBy '${t.replacedBy}' does not lead to a current part` });
    }
    if (conflict.has(n.id)) report.conflicts.push({ ...item, reason: conflict.get(n.id) });
    else if (clash.has(n.id)) report.conflicts.push({ ...item, reason: "retired and current entries; the current one is used" });
    else if (t) report.counts[t.retired ? "retired" : "mapped"] += 1;
    else if (ambiguous.has(n.id)) report.ambiguous.push({ ...item, reason: "name is not unique" });
    else report.unmapped.push(item);
  }
  report.counts.unmapped = report.unmapped.length;
  report.counts.ambiguous = report.ambiguous.length;
  report.counts.conflict = report.conflicts.length;
  const said = `${path}\n${clash.size}`;
  if (clash.size && !warnedClash.has(said)) {
    warnedClash.add(said);
    process.stderr.write(`code-map.json: ${clash.size} component(s) have a retired and a current entry; using the current one\n`);
  }
  return { twin, retired, report };
}

function emptyReport(hint: string | null, ignored: Item[]): CodeMapReport {
  const counts = { masters: 0, mapped: 0, retired: 0, unmapped: 0, ambiguous: 0, conflict: 0, stale: 0, ignored: ignored.length };
  return { configured: false, hint, counts, unmapped: [], ambiguous: [], conflicts: [], retired: [], stale: [], replacements: [], ignored };
}

/** Undefined when there is no usable map. Reads the file fresh every call. */
export function codeView(index: GraphIndex, hooks: Hooks): CodeView | undefined {
  const loaded = load();
  return loaded?.rows.length ? resolveRows(index, loaded, hooks) : undefined;
}

/** The graph is only loaded when the map has something to match against it. */
export function codeMapReport(getIndex: () => GraphIndex, hooksFor: (index: GraphIndex) => Hooks): CodeMapReport {
  const loaded = load();
  if (!loaded) return emptyReport(NO_CODE_MAP_HINT, []);
  if (!loaded.rows.length) return emptyReport("code-map.json has no usable entries.", loaded.ignored);
  const index = getIndex();
  return resolveRows(index, loaded, hooksFor(index)).report;
}

export function formatCodeMapReport(report: CodeMapReport, retiredOnly = false, first = 8): string {
  const c = report.counts;
  const label = (i: Item) => {
    const name = clean(i.name ?? i.id ?? "");
    const where = [i.fileKey, i.id && i.name ? i.id : ""].filter(Boolean).join(" ");
    const use = i.use === undefined ? "" : `-> ${i.use ? `use ${clean(i.use)}` : "no current replacement"}${i.code ? ` (code: ${i.code})` : ""}`;
    return [i.entry ? `entry ${i.entry}` : "", name, where ? `[${clean(where)}]` : "", use, i.reason ? `- ${i.reason}` : ""]
      .filter(Boolean)
      .join(" ");
  };
  const section = (title: string, items: Item[]) =>
    items.length
      ? [`${title}: ${items.slice(0, first).map(label).join("; ")}${items.length > first ? ` (+${items.length - first} more)` : ""}`]
      : [];
  if (retiredOnly && report.configured) return report.retired.length ? [`Retired: ${report.retired.length}`, ...report.retired.map(label)].join("\n") : "No retired parts.";
  return [
    report.configured
      ? `Code map: ${c.masters} components: ${c.mapped} mapped, ${c.retired} retired (kept mapped), ${c.unmapped} unmapped, ${c.ambiguous} ambiguous, ${c.conflict} conflict. ${c.stale} stale, ${c.ignored} ignored entries.`
      : report.hint,
    ...section("Unmapped", report.unmapped),
    ...section("Ambiguous", report.ambiguous),
    ...section("Conflict", report.conflicts),
    ...section("Retired", report.retired),
    ...section("Bad replacedBy", report.replacements),
    ...section("Stale", report.stale),
    ...section("Ignored", report.ignored),
  ].join("\n");
}
