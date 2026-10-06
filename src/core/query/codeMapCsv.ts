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

/** RFC 4180-style: quoted cells, doubled quotes, CRLF or LF, a leading byte-order mark. */
export function parseCsv(text: string): string[][] {
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
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
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
}

/** Rows to entries. Any bad row is reported by row number and nothing should be written. */
export function codeMapFromCsv(text: string): CsvImport {
  const [head, ...rows] = parseCsv(text);
  if (!head) return { entries: [], skipped: 0, errors: ["the file is empty"] };
  const names = head.map((h) => h.trim());
  const unknown = names.filter((h) => !(CSV_COLUMNS as readonly string[]).includes(h));
  if (unknown.length) return { entries: [], skipped: 0, errors: [`unknown column '${unknown[0]!.slice(0, 30)}'; columns are ${CSV_COLUMNS.join(", ")}`] };
  for (const need of ["component", "importPath"] as const) {
    if (!names.includes(need)) return { entries: [], skipped: 0, errors: [`missing column '${need}'`] };
  }
  const out: CsvImport = { entries: [], skipped: 0, errors: [] };
  rows.forEach((cells, i) => {
    const line = i + 2;
    const get = (c: Column) => (cells[names.indexOf(c)] ?? "").trim();
    if (!get("component") && !get("importPath")) {
      out.skipped += 1;
      return;
    }
    if (cells.length > names.length) {
      out.errors.push(`row ${line}: more cells than columns (quote a cell that holds a comma)`);
      return;
    }
    const list = (c: Column) => get(c).split(/[\s,;|]+/).filter(Boolean);
    const standalone = get("standalone").toLowerCase();
    if (standalone && !["true", "false", "yes", "no"].includes(standalone)) {
      out.errors.push(`row ${line}: standalone must be true or false`);
      return;
    }
    const code: Record<string, unknown> = {
      import: `import { ${get("component")} } from '${get("importPath")}'`,
      component: get("component"),
      ...(get("framework") ? { framework: get("framework").toLowerCase() } : {}),
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
    if (why) out.errors.push(`row ${line}: ${why}`);
    else out.entries.push(entry);
  });
  return out;
}
