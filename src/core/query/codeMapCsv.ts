import { readFileSync } from "node:fs";
import { checkEntry, type Twin } from "./codeMap";

/**
 * Fill the code map from a spreadsheet instead of hand-editing JSON.
 * `--init` writes one row per library component (filled in where the map already knows it);
 * `--import` turns the filled rows back into code-map.json, checked by the same rules as the loader.
 */
export const CSV_COLUMNS = [
  "fileKey",
  "id",
  "name",
  "component",
  "importPath",
  "framework",
  "selector",
  "module",
  "standalone",
  "inputs",
  "outputs",
  "status",
  "replacedBy",
  "relation",
  "figmaVersion",
  "packageVersion",
] as const;
type Column = (typeof CSV_COLUMNS)[number];

const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** RFC 4180-style: quoted cells, doubled quotes, CRLF or LF, a leading byte-order mark. Blank rows are dropped. */
export function parseCsv(text: string): string[][] {
  return csvRecords(text).filter((r) => !blank(r));
}

const blank = (r: string[]) => r.every((c) => c.trim() === "");

/** Every record, blank ones included, so record N is spreadsheet row N. */
function csvRecords(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (quoted) throw new Error("code-map CSV: a quoted cell is not closed.");
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function codeMapTemplate(rows: { fileKey: string; id: string; name: string; twin?: Twin }[]): string {
  const lines = rows.map((r) => {
    const t = r.twin;
    const m = t?.line.match(/^(.+) from '(.+)'$/);
    const a = t?.angular;
    const value: Record<Column, string> = {
      fileKey: r.fileKey,
      id: r.id,
      name: r.name,
      component: m?.[1] ?? "",
      importPath: m?.[2] ?? "",
      framework: a ? "angular" : "",
      selector: a?.selector ?? "",
      module: a?.module ?? "",
      standalone: a?.standalone ? "true" : "",
      inputs: a?.inputs?.join(" ") ?? "",
      outputs: a?.outputs?.join(" ") ?? "",
      status: t?.retired ? "retired" : "",
      replacedBy: t?.replacedBy ?? "",
      relation: "",
      figmaVersion: "",
      packageVersion: "",
    };
    return CSV_COLUMNS.map((c) => cell(value[c])).join(",");
  });
  return `${[CSV_COLUMNS.join(","), ...lines].join("\n")}\n`;
}

export interface CsvImport {
  entries: Record<string, unknown>[];
  /** Rows with no component and no import path: not filled in yet. */
  skipped: number;
  errors: string[];
  /** Components the CSV has a row for (filled or not), matched against `entryKeys`. Lets an import tell which map entries the CSV never mentions. */
  rowKeys: string[];
  /** Keys of the rows that became entries. */
  filledKeys: string[];
  /** Columns Resolve does not use (notes, owner, ...). Ignored, never refused. */
  ignoredColumns: string[];
}

/**
 * The keys a map entry is known by, for matching it to a CSV row. An entry with an id is known only by fileKey + id;
 * an entry with a name and no id by fileKey + name; the bare name only when it has neither fileKey nor id (a true name-only entry).
 * So a CSV row never matches another file's entry, or an entry with a different (stale) id, just because the names agree.
 */
export function entryKeys(e: unknown): string[] {
  if (typeof e !== "object" || e === null || Array.isArray(e)) return [];
  const o = e as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  if (s(o["id"])) return [`${s(o["fileKey"])}\n${s(o["id"])}`];
  if (s(o["name"])) return [`${s(o["fileKey"])}\n#${s(o["name"])}`];
  return [];
}

/** The keys a CSV row matches: its fileKey + id, plus name-only entries of its name (same file, or no file). */
function rowMatchKeys(fileKey: string, id: string, name: string): string[] {
  const keys: string[] = [];
  if (id) keys.push(`${fileKey}\n${id}`);
  if (name) keys.push(`${fileKey}\n#${name}`, `\n#${name}`);
  return [...new Set(keys)];
}

export interface CodeMapMerge {
  /** What to write: the CSV's entries, then the old entries the CSV has no row for (unless replacing). */
  entries: unknown[];
  /** Old entries the CSV has no row for. Kept when merging, dropped when replacing. */
  untouched: unknown[];
  /** Old entries whose CSV row was left empty: removed either way. */
  cleared: unknown[];
  /** Old entries a filled CSV row replaced with a different entry (listed so nothing changes without a word). */
  replaced: unknown[];
}

/**
 * `--import --force` keeps every old entry the CSV has no row for (other files, hand-added or stale entries) and lists it;
 * `--replace` drops them, and lists them too. A filled row replaces the old entry for that component; an emptied row removes it.
 * Every old entry lands in exactly one of untouched, cleared, or replaced (or is written back unchanged).
 */
export function mergeCodeMap(old: unknown[], csv: CsvImport, replace: boolean): CodeMapMerge {
  const rows = new Set(csv.rowKeys);
  const untouched = old.filter((e) => !entryKeys(e).some((k) => rows.has(k)));
  const filled = new Set(csv.filledKeys);
  const matched = old.filter((e) => !untouched.includes(e));
  const cleared = matched.filter((e) => !entryKeys(e).some((k) => filled.has(k)));
  const written = new Set(csv.entries.map((e) => JSON.stringify(e)));
  const replaced = matched.filter((e) => !cleared.includes(e) && !written.has(JSON.stringify(e)));
  const entries = [...csv.entries, ...(replace ? [] : untouched)];
  if (!replace) {
    const seen = new Set(entries.map((entry) => JSON.stringify(entry)));
    const silent = old.filter(
      (entry) => !seen.has(JSON.stringify(entry)) && !untouched.includes(entry) && !cleared.includes(entry) && !replaced.includes(entry),
    );
    if (silent.length) return { entries: [...entries, ...silent], untouched: [...untouched, ...silent], cleared, replaced };
  }
  return { entries, untouched, cleared, replaced };
}

/** Read a code map without dropping entries. A file that is not JSON, or has no entries list, throws and must not be overwritten. */
export function readCodeMapDocument(path: string): { entries: unknown[]; figmaVersion?: string; packageVersion?: string; packages?: Record<string, string> } {
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "").trim();
  if (!text) return { entries: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON. Nothing was written.`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path} is not a code map. Nothing was written.`);
  const doc = raw as Record<string, unknown>;
  if (!("entries" in doc)) {
    if (Object.keys(doc).length === 0) return { entries: [] };
    throw new Error(`${path} has no entries list. Nothing was written.`);
  }
  if (!Array.isArray(doc["entries"])) throw new Error(`${path} entries must be a list. Nothing was written.`);
  const figmaVersion = typeof doc["figmaVersion"] === "string" && doc["figmaVersion"].trim() ? doc["figmaVersion"].trim() : undefined;
  const packageVersion = typeof doc["packageVersion"] === "string" && doc["packageVersion"].trim() ? doc["packageVersion"].trim() : undefined;
  const packages = packageMap(doc["packages"]);
  return { entries: doc["entries"], ...(figmaVersion ? { figmaVersion } : {}), ...(packageVersion ? { packageVersion } : {}), ...(packages ? { packages } : {}) };
}

function packageMap(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  return Object.keys(out).length ? out : undefined;
}

export function codeMapJson(entries: unknown[], versions: { figmaVersion?: string; packageVersion?: string; packages?: Record<string, string> }): string {
  const body: Record<string, unknown> = {};
  if (versions.figmaVersion) body["figmaVersion"] = versions.figmaVersion;
  if (versions.packages && Object.keys(versions.packages).length) body["packages"] = versions.packages;
  else if (versions.packageVersion) body["packageVersion"] = versions.packageVersion;
  body["entries"] = entries;
  return `${JSON.stringify(body, null, 2)}\n`;
}

/** Review import: only an explicit mapped (or current) status is confirmed. Anything else stays a suggestion. */
export function reviewEntries(parsed: CsvImport): CsvImport {
  return {
    ...parsed,
    entries: parsed.entries.map((entry) => {
      const status = typeof entry["status"] === "string" ? entry["status"] : "";
      if (status === "mapped" || status === "current") return { ...entry, status: "mapped" };
      if (status === "retired" || status === "partial" || status === "unmapped" || status === "suggested") return entry;
      return { ...entry, status: "suggested" };
    }),
  };
}

/** `ACMEUI 30:10 Button`, for listing entries in import output. */
export function entryLabel(e: unknown): string {
  if (typeof e !== "object" || e === null || Array.isArray(e)) return "(not an entry)";
  const o = e as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v.replace(/\p{Cc}/gu, " ").trim().slice(0, 60) : "");
  return [s(o["fileKey"]), s(o["id"]), s(o["name"])].filter(Boolean).join(" ") || "(no fileKey, id or name)";
}

/** `variant size`, `variant, size`, `label: ariaLabel, size` -> names, keeping Angular's `property: alias` form. */
function ioList(value: string): string[] {
  return value
    .replace(/\s*:\s*/g, ":")
    .split(/[\s,;|]+/)
    .filter(Boolean)
    .map((x) => x.replace(":", ": "));
}

function importPathOf(line: string): string {
  const marker = " from '";
  const at = line.lastIndexOf(marker);
  if (at < 0) return "";
  const start = at + marker.length;
  const end = line.indexOf("'", start);
  return end < 0 ? "" : line.slice(start, end);
}

function textOf(entry: Record<string, unknown>, key: string): string {
  const value = entry[key];
  return typeof value === "string" ? value : "";
}

/** One row per stored entry, including suggestions. Used by `code-map review`. */
export function entriesToCsv(entries: unknown[]): string {
  const lines = entries.map((entry) => {
    const row = entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : {};
    const code = row["code"] && typeof row["code"] === "object" && !Array.isArray(row["code"]) ? (row["code"] as Record<string, unknown>) : {};
    const imported = importPathOf(textOf(code, "import"));
    const inputs = Array.isArray(code["inputs"]) ? (code["inputs"] as unknown[]).filter((item) => typeof item === "string").join(" ") : "";
    const outputs = Array.isArray(code["outputs"]) ? (code["outputs"] as unknown[]).filter((item) => typeof item === "string").join(" ") : "";
    const value: Record<Column, string> = {
      fileKey: textOf(row, "fileKey"),
      id: textOf(row, "id"),
      name: textOf(row, "name"),
      component: textOf(code, "component"),
      importPath: imported,
      framework: textOf(code, "framework"),
      selector: textOf(code, "selector"),
      module: textOf(code, "module"),
      standalone: code["standalone"] === true ? "true" : "",
      inputs,
      outputs,
      status: textOf(row, "status"),
      replacedBy: textOf(row, "replacedBy"),
      relation: textOf(row, "relation"),
      figmaVersion: textOf(row, "figmaVersion"),
      packageVersion: textOf(row, "packageVersion"),
    };
    return CSV_COLUMNS.map((column) => cell(value[column])).join(",");
  });
  return `${[CSV_COLUMNS.join(","), ...lines].join("\n")}\n`;
}

const REVIEW_STATUS = new Set(["mapped", "suggested", "partial", "current", "unmapped"]);

/** True when the sheet is a review (some row already has a review status). Blank cells then mean suggested. */
export function csvIsReviewSheet(parsed: CsvImport): boolean {
  return parsed.entries.some((entry) => REVIEW_STATUS.has(String(entry["status"] ?? "")));
}

/** Rows to entries. Any bad row is reported by its spreadsheet row number and nothing should be written. */
export function codeMapFromCsv(text: string, options?: { blankStatus?: "suggested" }): CsvImport {
  const records = csvRecords(text);
  const headAt = records.findIndex((r) => !blank(r));
  const head = records[headAt];
  const none = { entries: [], skipped: 0, rowKeys: [], filledKeys: [], ignoredColumns: [] };
  if (!head) return { ...none, errors: ["the file is empty"] };
  const names = head.map((h) => h.trim());
  const ignoredColumns = names.filter((h) => h && !(CSV_COLUMNS as readonly string[]).includes(h)).map((h) => h.slice(0, 30));
  const dupes = (CSV_COLUMNS as readonly string[]).filter((c) => names.filter((h) => h === c).length > 1);
  if (dupes.length) {
    return { ...none, errors: dupes.map((c) => `column '${c}' appears more than once in the header (columns ${names.flatMap((h, i) => (h === c ? [i + 1] : [])).join(" and ")}); keep one`) };
  }
  const unnamed = names.flatMap((h, i) => (!h && records.some((r, at) => at > headAt && (r[i] ?? "").trim()) ? [i + 1] : []));
  if (unnamed.length) {
    return { ...none, errors: [`column${unnamed.length > 1 ? "s" : ""} ${unnamed.join(", ")} hold${unnamed.length > 1 ? "" : "s"} values but ha${unnamed.length > 1 ? "ve" : "s"} no header name; name ${unnamed.length > 1 ? "them" : "it"} or delete ${unnamed.length > 1 ? "them" : "it"}`] };
  }
  for (const need of ["component", "importPath"] as const) {
    if (!names.includes(need)) return { ...none, errors: [`missing column '${need}'; columns are ${CSV_COLUMNS.join(", ")}`] };
  }
  const out: CsvImport = { entries: [], skipped: 0, errors: [], rowKeys: [], filledKeys: [], ignoredColumns };
  records.forEach((cells, i) => {
    if (i <= headAt || blank(cells)) return;
    const line = i + 1;
    const get = (c: Column) => (names.includes(c) ? (cells[names.indexOf(c)] ?? "").trim() : "");
    const keys = rowMatchKeys(get("fileKey"), get("id"), get("name"));
    out.rowKeys.push(...keys);
    if (!get("component") && !get("importPath")) {
      out.skipped += 1;
      return;
    }
    if (cells.length > names.length) {
      out.errors.push(`row ${line}: more cells than columns (quote a cell that holds a comma)`);
      return;
    }
    const list = (c: Column) => ioList(get(c));
    const standalone = get("standalone").toLowerCase();
    if (standalone && !["true", "false", "yes", "no"].includes(standalone)) {
      out.errors.push(`row ${line}: standalone must be true or false`);
      return;
    }
    const code: Record<string, unknown> = {
      ...(get("framework") ? { framework: get("framework").toLowerCase() } : {}),
      import: `import { ${get("component")} } from '${get("importPath")}'`,
      component: get("component"),
      ...(get("selector") ? { selector: get("selector") } : {}),
      ...(get("module") ? { module: get("module") } : {}),
      ...(standalone ? { standalone: standalone === "true" || standalone === "yes" } : {}),
      ...(list("inputs").length ? { inputs: list("inputs") } : {}),
      ...(list("outputs").length ? { outputs: list("outputs") } : {}),
    };
    const relation = get("relation").toLowerCase();
    const status = get("status").replace(/\u00a0/g, " ").trim().toLowerCase() || options?.blankStatus || "";
    const entry: Record<string, unknown> = {
      ...(get("fileKey") ? { fileKey: get("fileKey") } : {}),
      ...(get("id") ? { id: get("id") } : {}),
      // The design name is kept with the id too: `code-map --check "Old Button"` finds a retired part by the name designers use.
      ...(get("name") ? { name: get("name") } : {}),
      ...(status ? { status } : {}),
      ...(get("replacedBy") ? { replacedBy: get("replacedBy") } : {}),
      ...(relation ? { relation } : {}),
      ...(get("figmaVersion") ? { figmaVersion: get("figmaVersion") } : {}),
      ...(get("packageVersion") ? { packageVersion: get("packageVersion") } : {}),
      code,
    };
    if (!get("component") || !get("importPath")) {
      out.errors.push(`row ${line}: needs both component and importPath`);
      return;
    }
    const why = checkEntry(entry);
    if (why) out.errors.push(`row ${line}: ${why === "import needs from '<module>'" ? "importPath must be a package path like @acme/ui" : why}`);
    else {
      out.entries.push(entry);
      out.filledKeys.push(...keys);
    }
  });
  const seen = new Map<string, string>();
  for (const entry of out.entries) {
    const code = entry["code"] as Record<string, unknown> | undefined;
    const key = `${String(entry["fileKey"] ?? "")}\n${String(entry["id"] ?? "")}\n${String(code?.["component"] ?? "")}\n${String(entry["relation"] ?? "maps")}`;
    const status = String(entry["status"] ?? "");
    const previous = seen.get(key);
    if (previous !== undefined && previous !== status) {
      out.errors.push(`conflicting status for ${String(entry["name"] ?? entry["id"] ?? "a row")} (${previous || "blank"} and ${status || "blank"})`);
    } else if (previous === undefined) seen.set(key, status);
  }
  if (out.errors.length) return out;
  const unique: Record<string, unknown>[] = [];
  const kept = new Set<string>();
  for (const entry of out.entries) {
    const code = entry["code"] as Record<string, unknown> | undefined;
    const key = `${String(entry["fileKey"] ?? "")}\n${String(entry["id"] ?? "")}\n${String(code?.["component"] ?? "")}\n${String(entry["relation"] ?? "maps")}`;
    if (kept.has(key)) continue;
    kept.add(key);
    unique.push(entry);
  }
  out.entries = unique;
  return out;
}
