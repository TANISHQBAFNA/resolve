import { existsSync, readFileSync } from "node:fs";
import type { GraphNode } from "@/core/model";
import type { GraphIndex } from "./GraphIndex";
import { overlayFile } from "./overlayFile";
import { nodeFileKey } from "./workspaceMerge";

export const NO_CODE_MAP_HINT = "No code map. Add .resolve/code-map.json next to synonyms.json.";
const ENTRY_KEYS = ["fileKey", "id", "name", "code", "status", "replacedBy"];
const CODE_KEYS = ["import", "component", "framework", "selector", "module", "standalone", "inputs", "outputs"];
const PLAIN = /^[A-Za-z_$][\w$]{0,59}$/;
const SELECTOR = /^(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)+|(?:[a-z][a-z0-9-]*)?\[[A-Za-z][\w-]{0,40}\])$/;
const FROM = /\bfrom\s+(['"])([^'"\s\p{Cc}]{1,120})\1\s*;?$/u;

/** What the host (agentSurface) knows about a master. Kept as hooks so this file has no cycle. */
export interface Hooks {
  retired(node: GraphNode): boolean;
  real(node: GraphNode): boolean;
  /** The current part that replaces a retired one (replacedBy followed up to 3 hops); `guess` when only the library's name guess found it. */
  use(node: GraphNode, twinOf: (node: GraphNode) => Twin | undefined): { name: string; guess: boolean } | undefined;
  /** Why a replacedBy cannot be used: "is a variant", "is a remote stub", "is not unique", "matches no component", or undefined when it is fine. */
  why(ask: string): string | undefined;
}
/** How a replacement reads on a card, in the report and in the notes. */
export const useText = (name?: string | null, guess?: boolean) =>
  name ? (guess ? `closest current part (guess): ${name}` : `use ${name}`) : "no current replacement";
/** Angular fields of a code twin. Only present when the entry is an Angular one. */
export interface AngularTwin {
  /** `acme-button` (element) or `[acmeTooltip]` (attribute). */
  selector: string;
  /** NgModule to import, for a component that is not standalone. */
  module?: string;
  standalone?: true;
  /** Module path from the import line, e.g. `@acme/ui-angular`. */
  importPath: string;
  inputs?: string[];
  outputs?: string[];
}
export interface Twin {
  line: string;
  retired: boolean;
  replacedBy?: string;
  angular?: AngularTwin;
}
/** `<acme-button>, AcmeButtonModule` (short) or with `; inputs: ...; outputs: ...` (full). */
export function angularText(a: AngularTwin, full = false): string {
  const tag = /^[a-z][\w-]*$/.test(a.selector) ? `<${a.selector}>` : a.selector;
  const bits = [tag, a.module ?? (a.standalone ? "standalone" : "")].filter(Boolean).join(", ");
  if (!full) return bits;
  return [bits, a.inputs?.length ? `inputs: ${a.inputs.join(", ")}` : "", a.outputs?.length ? `outputs: ${a.outputs.join(", ")}` : ""]
    .filter(Boolean)
    .join("; ");
}
/** The code line, plus the Angular selector and module when the entry has them. */
export const codeText = (t: { line: string; angular?: AngularTwin }) => (t.angular ? `${t.line}, ${angularText(t.angular)}` : t.line);
export interface Item {
  name?: string;
  fileKey?: string;
  id?: string;
  entry?: number;
  reason?: string;
  use?: string | null;
  guess?: true;
  code?: string | null;
  angular?: AngularTwin;
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
  /** Only when the map has Angular entries: how many mapped components carry Angular fields. */
  angular?: { mapped: number; standalone: number; module: number; inputsOrOutputs: number };
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
  angular?: AngularTwin;
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
  const angular = parseAngular(code, module, text);
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
    ...(angular ? { angular } : {}),
  };
}

/** Angular fields, checked; a bad value rejects the whole entry with a reason (never silently changed). */
function parseAngular(
  code: Record<string, unknown>,
  importPath: string,
  text: (o: Record<string, unknown>, k: string) => string | undefined,
): AngularTwin | undefined {
  const framework = text(code, "framework");
  if (framework && framework !== "angular" && framework !== "react") throw "framework must be angular or react";
  const selector = text(code, "selector");
  const extra = ["module", "standalone", "inputs", "outputs"].find((k) => code[k] !== undefined);
  if (framework === "react") {
    if (selector || extra) throw `'${selector ? "selector" : extra}' is an Angular field; set framework to angular`;
    return undefined;
  }
  if (!selector) {
    if (framework === "angular") throw "an angular entry needs a selector";
    if (extra) throw `'${extra}' needs an Angular selector`;
    return undefined;
  }
  if (selector.length > 60 || !SELECTOR.test(selector)) throw "selector must look like acme-button or [acmeTooltip]";
  const module = text(code, "module");
  if (module && !PLAIN.test(module)) throw "module must be a plain name like AcmeButtonModule";
  const standalone = code["standalone"];
  if (standalone !== undefined && typeof standalone !== "boolean") throw "standalone must be true or false";
  if (module && standalone === true) throw "use module or standalone: true, not both";
  const names = (k: "inputs" | "outputs") => {
    const v = code[k];
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.length > 40 || v.some((x) => typeof x !== "string" || !/^[A-Za-z_$][\w$]{0,39}$/.test(x))) {
      throw `${k} must be a list of plain names like ${k === "inputs" ? "variant" : "pressed"}`;
    }
    const list = [...new Set(v as string[])];
    return list.length ? list : undefined;
  };
  const inputs = names("inputs");
  const outputs = names("outputs");
  return {
    selector,
    ...(module ? { module } : {}),
    ...(standalone === true ? { standalone: true as const } : {}),
    importPath,
    ...(inputs ? { inputs } : {}),
    ...(outputs ? { outputs } : {}),
  };
}

/** Parse one entry exactly as the loader does; used by the CSV import so both paths share one set of rules. */
export function checkEntry(raw: unknown): string | undefined {
  try {
    parseRow(raw, 1);
    return undefined;
  } catch (reason) {
    return String(reason);
  }
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
    const distinct = [...new Map(opts.map((o) => [`${o.r.line}|${o.retired}|${o.r.replacedBy}|${JSON.stringify(o.r.angular ?? null)}`, o])).values()];
    const current = distinct.filter((o) => !o.retired);
    const pick = distinct.length === 1 ? distinct[0] : current.length === 1 ? current[0] : undefined;
    const mixed = distinct.some((o) => o.r.angular) && distinct.some((o) => !o.r.angular);
    if (!pick) {
      conflict.set(node.id, mixed ? "a React and an Angular entry disagree; keep one entry per component" : "entries disagree and none is the only current one");
    } else {
      twins.set(node.id, {
        line: pick.r.line,
        retired: pick.retired,
        ...(pick.r.replacedBy ? { replacedBy: pick.r.replacedBy } : {}),
        ...(pick.r.angular ? { angular: pick.r.angular } : {}),
      });
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
      report.retired.push({
        ...item,
        use: use?.name ?? null,
        ...(use?.guess ? { guess: true as const } : {}),
        code: t?.line ?? null,
        ...(t?.angular ? { angular: t.angular } : {}),
      });
      const bad = t?.replacedBy && !use ? hooks.why(t.replacedBy) : undefined;
      if (t?.replacedBy && !use) report.replacements.push({ ...item, reason: bad ? `replacedBy ${bad}: '${t.replacedBy}'` : `replacedBy '${t.replacedBy}' leads to no current part` });
    }
    if (conflict.has(n.id)) report.conflicts.push({ ...item, reason: conflict.get(n.id) });
    else if (clash.has(n.id)) report.conflicts.push({ ...item, reason: "retired and current entries; the current one is used" });
    else if (t) report.counts[t.retired ? "retired" : "mapped"] += 1;
    else if (ambiguous.has(n.id)) report.ambiguous.push({ ...item, reason: "name is not unique" });
    else report.unmapped.push(item);
  }
  const ng = masters.filter((n) => !conflict.has(n.id)).flatMap((n) => twins.get(n.id)?.angular ?? []);
  if (ng.length) {
    report.angular = {
      mapped: ng.length,
      standalone: ng.filter((a) => a.standalone).length,
      module: ng.filter((a) => a.module).length,
      inputsOrOutputs: ng.filter((a) => a.inputs || a.outputs).length,
    };
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

/** The components a code map can name (real sets and standalone components), in library order. */
export function codeMapTargets(index: GraphIndex, hooks: Hooks): { fileKey: string; id: string; name: string; node: GraphNode }[] {
  return index.graph.nodes
    .filter((n) => (n.type === "COMPONENT_SET" || n.type === "MAIN_COMPONENT") && !n.componentSetId && !n.isRemote && hooks.real(n))
    .map((n) => ({ fileKey: nodeFileKey(n, index.graph.fileKey) ?? "", id: n.figmaNodeId ?? n.id, name: n.name, node: n }));
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
    const code = i.code ? (i.angular ? `${i.code}, ${angularText(i.angular)}` : i.code) : "";
    const use = i.use === undefined ? "" : `-> ${useText(i.use && clean(i.use), i.guess)}${code ? ` (code: ${code})` : ""}`;
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
    ...(report.angular
      ? [
          `Angular: ${report.angular.mapped} mapped components have a selector (${report.angular.standalone} standalone, ${report.angular.module} with a module, ${report.angular.inputsOrOutputs} list inputs or outputs).`,
        ]
      : []),
    ...section("Unmapped", report.unmapped),
    ...section("Ambiguous", report.ambiguous),
    ...section("Conflict", report.conflicts),
    ...section("Retired", report.retired),
    ...section("Bad replacedBy", report.replacements),
    ...section("Stale", report.stale),
    ...section("Ignored", report.ignored),
  ].join("\n");
}
