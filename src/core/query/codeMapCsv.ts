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
  /** Components the CSV has a row for (filled or not), see `entryKeys`. Lets an import tell which map entries the CSV never mentions. */
  rowKeys: string[];
  /** Keys of the rows that became entries. */
  filledKeys: string[];
  /** Columns Resolve does not use (notes, owner, ...). Ignored, never refused. */
  ignoredColumns: string[];
}

/**
 * The keys a component is known by: fileKey + id, fileKey + name, and the bare name.
 * A map entry and a CSV row are about the same component when they share any key (so a name-only entry
 * and a row with fileKey + id + name of that name count as the same component).
 */
export function entryKeys(e: unknown): string[] {
  if (typeof e !== "object" || e === null || Array.isArray(e)) return [];
  const o = e as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const keys: string[] = [];
  if (s(o["id"])) keys.push(`${s(o["fileKey"])}\n${s(o["id"])}`);
  if (s(o["name"])) keys.push(`${s(o["fileKey"])}\n#${s(o["name"])}`, `\n#${s(o["name"])}`);
  return keys;
}

export interface CodeMapMerge {
  /** What to write: the CSV's entries, then the old entries the CSV has no row for (unless replacing). */
  entries: unknown[];
  /** Old entries the CSV has no row for. Kept when merging, dropped when replacing. */
  untouched: unknown[];
  /** Old entries whose CSV row was left empty: removed either way. */
  cleared: unknown[];
}

/**
 * `--import --force` keeps every old entry the CSV has no row for (other files, hand-added or stale entries) and lists it;
 * `--replace` drops them, and lists them too. A filled row replaces the old entry for that component; an emptied row removes it.
 */
export function mergeCodeMap(old: unknown[], csv: CsvImport, replace: boolean): CodeMapMerge {
  const rows = new Set(csv.rowKeys);
  const untouched = old.filter((e) => !entryKeys(e).some((k) => rows.has(k)));
  const filled = new Set(csv.filledKeys);
  const cleared = old.filter((e) => !untouched.includes(e) && !entryKeys(e).some((k) => filled.has(k)));
  return { entries: [...csv.entries, ...(replace ? [] : untouched)], untouched, cleared };
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

/** Rows to entries. Any bad row is reported by its spreadsheet row number and nothing should be written. */
export function codeMapFromCsv(text: string): CsvImport {
  const records = csvRecords(text);
  const headAt = records.findIndex((r) => !blank(r));
  const head = records[headAt];
  const none = { entries: [], skipped: 0, rowKeys: [], filledKeys: [], ignoredColumns: [] };
  if (!head) return { ...none, errors: ["the file is empty"] };
  const names = head.map((h) => h.trim());
  const ignoredColumns = names.filter((h) => h && !(CSV_COLUMNS as readonly string[]).includes(h)).map((h) => h.slice(0, 30));
  for (const need of ["component", "importPath"] as const) {
    if (!names.includes(need)) return { ...none, errors: [`missing column '${need}'; columns are ${CSV_COLUMNS.join(", ")}`] };
  }
  const out: CsvImport = { entries: [], skipped: 0, errors: [], rowKeys: [], filledKeys: [], ignoredColumns };
  records.forEach((cells, i) => {
    if (i <= headAt || blank(cells)) return;
    const line = i + 1;
    const get = (c: Column) => (names.includes(c) ? (cells[names.indexOf(c)] ?? "").trim() : "");
    const keys = entryKeys({ fileKey: get("fileKey"), id: get("id"), name: get("name") });
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
    const entry: Record<string, unknown> = {
      ...(get("fileKey") ? { fileKey: get("fileKey") } : {}),
      ...(get("id") ? { id: get("id") } : get("name") ? { name: get("name") } : {}),
      code,
      ...(get("status") ? { status: get("status").toLowerCase() } : {}),
      ...(get("replacedBy") ? { replacedBy: get("replacedBy") } : {}),
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
  return out;
}
