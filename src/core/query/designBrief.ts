/**
 * Completeness check for a design brief (templates/design-brief/brief.md) or a Resolve handoff pack.
 * Pure: text in, report out. No Figma, no library, no model. A hand-written brief and a handoff pack
 * go through the same exit codes, so a delivery process does not care which one a ticket used.
 */

export type BriefFailure = "frontmatter" | "screens" | "fields" | "questions" | "status" | "handoff";

/** 0 pass. 1 is for input that cannot be read at all (the CLI's usual error). When several types fail, the lowest code is the exit code. */
export const BRIEF_EXIT: Record<BriefFailure, number> = {
  frontmatter: 2,
  screens: 3,
  fields: 4,
  questions: 5,
  status: 6,
  handoff: 7,
};

export interface BriefIssue {
  type: BriefFailure;
  where: string;
  message: string;
}

export interface BriefReport {
  ok: boolean;
  input: "brief" | "handoff";
  exitCode: number;
  issues: BriefIssue[];
  note?: string;
}

export const REQUIRED_KEYS = ["ticket", "product", "journey", "ui_scope", "requirements_source", "status"] as const;
export const SCREEN_STATES = ["default", "empty", "loading", "error", "success", "permission"] as const;
export const PROVENANCE = ["contract", "inferred", "proposed"] as const;
const JOURNEY_ID = /^journey-[a-z0-9]+(?:-[a-z0-9]+)+$/;

const unquote = (value: string) => value.trim().replace(/^(["'])(.*)\1$/, "$2").trim();

/** Flat `key: value`, inline `[a, b]` lists and `- item` lists. Enough for the template; not a YAML parser. */
export function parseFrontmatter(markdown: string): { data: Record<string, string | string[]>; body: string } | undefined {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(markdown);
  if (!match) return undefined;
  const data: Record<string, string | string[]> = {};
  let listKey: string | undefined;
  for (const raw of match[1]!.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      const list = Array.isArray(data[listKey]) ? (data[listKey] as string[]) : [];
      list.push(unquote(item[1]!));
      data[listKey] = list;
      continue;
    }
    const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!pair) continue;
    const [, key, value] = pair;
    const text = value!.trim();
    listKey = key!;
    if (!text) data[key!] = "";
    else if (text.startsWith("[") && text.endsWith("]")) data[key!] = text.slice(1, -1).split(",").map(unquote).filter(Boolean);
    else data[key!] = unquote(text);
  }
  return { data, body: markdown.slice(match[0].length) };
}

/** An unfilled cell: empty, a <placeholder>, or a to-do word. */
export const isBlank = (cell: string | undefined): boolean => {
  const text = (cell ?? "").trim();
  return !text || /^<[^>]*>$/.test(text) || /^(tbd|todo|\?+|-+|…|\.{3})$/i.test(text);
};

/** `N/A — reason`. A dash, an en dash or a hyphen, then at least one word. */
const NA = /^n\/a\b/i;
const NA_WITH_REASON = /^n\/a\s*[—–-]+\s*\S/i;

interface Table {
  header: string[];
  rows: string[][];
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, "|").trim());
}

/** The first GFM table in a block of lines. */
function firstTable(lines: string[]): Table | undefined {
  const start = lines.findIndex((line) => /^\s*\|/.test(line));
  if (start < 0) return undefined;
  const rows: string[][] = [];
  for (const line of lines.slice(start)) {
    if (!/^\s*\|/.test(line)) break;
    if (/^[\s|:-]+$/.test(line)) continue;
    rows.push(cells(line));
  }
  const [header, ...body] = rows;
  return header ? { header: header.map((cell) => cell.toLowerCase()), rows: body } : undefined;
}

function sections(body: string): Array<{ title: string; lines: string[] }> {
  const out: Array<{ title: string; lines: string[] }> = [];
  let fenced = false;
  for (const raw of body.split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) fenced = !fenced;
    const heading = !fenced ? /^##\s+(.*)$/.exec(raw) : null;
    if (heading) out.push({ title: heading[1]!.trim(), lines: [] });
    else out.at(-1)?.lines.push(raw);
  }
  return out;
}

const find = (all: ReturnType<typeof sections>, pattern: RegExp) => all.find((section) => pattern.test(section.title));
const column = (table: Table, ...names: string[]) => table.header.findIndex((cell) => names.some((name) => cell.includes(name)));

function stateOf(cell: string): (typeof SCREEN_STATES)[number] | undefined {
  const text = cell.toLowerCase().replace(/[`*_]/g, "").trim();
  return SCREEN_STATES.find((state) => (state === "permission" ? /^(permission|role)/.test(text) : text.startsWith(state)));
}

function checkFrontmatter(data: Record<string, string | string[]>): BriefIssue[] {
  const issues: BriefIssue[] = [];
  const add = (where: string, message: string) => issues.push({ type: "frontmatter", where, message });
  for (const key of REQUIRED_KEYS) {
    const value = data[key];
    if (value === undefined || (Array.isArray(value) ? !value.length : isBlank(value))) add(key, `Frontmatter \`${key}\` is missing or empty.`);
  }
  const scope = data["ui_scope"];
  if (typeof scope === "string" && scope && scope !== "true" && scope !== "false") add("ui_scope", "`ui_scope` must be true or false.");
  const status = data["status"];
  if (typeof status === "string" && status && status !== "draft" && status !== "complete") add("status", "`status` must be draft or complete.");
  const journeys = ([] as string[]).concat(data["journey"] ?? []).flatMap((value) => value.split(",").map((part) => part.trim()).filter(Boolean));
  for (const id of journeys) if (!isBlank(id) && !JOURNEY_ID.test(id)) add("journey", `\`${id}\` is not a journey id. Use journey-<verb>-<noun>, for example journey-approve-payment.`);
  return issues;
}

function checkScreens(section: { lines: string[] } | undefined): BriefIssue[] {
  const issues: BriefIssue[] = [];
  const add = (where: string, message: string) => issues.push({ type: "screens", where, message });
  const table = section && firstTable(section.lines);
  if (!table) return [{ type: "screens", where: "Screen inventory", message: "No screen inventory table. One row per screen and state." }];
  const screenAt = column(table, "screen");
  const stateAt = column(table, "state");
  if (screenAt < 0 || stateAt < 0) return [{ type: "screens", where: "Screen inventory", message: "The table needs a Screen column and a State column." }];
  if (!table.rows.length) return [{ type: "screens", where: "Screen inventory", message: "The table has no rows." }];
  const seen = new Map<string, Set<string>>();
  table.rows.forEach((row, at) => {
    const label = `Screen inventory row ${at + 1}${row[screenAt] ? ` (${row[screenAt]} / ${row[stateAt] ?? ""})` : ""}`;
    table.header.forEach((name, col) => {
      const cell = row[col];
      if (isBlank(cell)) add(label, `The ${name || `column ${col + 1}`} cell is empty. Fill it in, or write N/A — <reason>.`);
      else if (NA.test(cell!) && !NA_WITH_REASON.test(cell!)) add(label, `N/A in the ${name || `column ${col + 1}`} cell has no reason. Write N/A — <reason>.`);
    });
    const state = stateOf(row[stateAt] ?? "");
    const screen = (row[screenAt] ?? "").toLowerCase();
    if (!isBlank(row[screenAt]) && state) seen.set(screen, (seen.get(screen) ?? new Set()).add(state));
    else if (!isBlank(row[stateAt])) add(label, `\`${row[stateAt]}\` is not a state. Use default, empty, loading, error, success or permission.`);
  });
  for (const [screen, states] of seen) {
    const missing = SCREEN_STATES.filter((state) => !states.has(state));
    if (missing.length) add(`Screen inventory: ${screen}`, `No row for ${missing.join(", ")}. Add the row, or a row marked N/A — <reason>.`);
  }
  return issues;
}

function checkFields(section: { lines: string[] } | undefined): BriefIssue[] {
  const issues: BriefIssue[] = [];
  const add = (where: string, message: string) => issues.push({ type: "fields", where, message });
  const table = section && firstTable(section.lines);
  if (!table) return [{ type: "fields", where: "Content and data", message: "No content and data table. One row per displayed field." }];
  const fieldAt = column(table, "field");
  const sourceAt = column(table, "source");
  const provenanceAt = column(table, "provenance");
  if (fieldAt < 0 || sourceAt < 0 || provenanceAt < 0) return [{ type: "fields", where: "Content and data", message: "The table needs Field, Source and Provenance columns." }];
  if (!table.rows.length) return [{ type: "fields", where: "Content and data", message: "The table has no rows." }];
  table.rows.forEach((row, at) => {
    const label = `Content and data row ${at + 1}${isBlank(row[fieldAt]) ? "" : ` (${row[fieldAt]})`}`;
    if (isBlank(row[fieldAt])) add(label, "The field name is empty.");
    const source = row[sourceAt];
    if (isBlank(source) || (NA.test(source!) && !NA_WITH_REASON.test(source!))) add(label, "No source. Name the API field, column or static copy.");
    const provenance = (row[provenanceAt] ?? "").replace(/[`*_]/g, "").trim().toLowerCase();
    if (!(PROVENANCE as readonly string[]).includes(provenance)) add(label, `Provenance is ${isBlank(provenance) ? "empty" : `\`${provenance}\``}. Use contract, inferred or proposed.`);
  });
  return issues;
}

function checkQuestions(section: { lines: string[] } | undefined): BriefIssue[] {
  const table = section && firstTable(section.lines);
  if (!table) return [{ type: "questions", where: "Open questions", message: "No open questions table. Keep the table; write None in a row if there are no questions." }];
  const questionAt = Math.max(0, column(table, "question"));
  const answerAt = column(table, "answer");
  if (answerAt < 0) return [{ type: "questions", where: "Open questions", message: "The table needs an Answer column." }];
  return table.rows.flatMap((row, at): BriefIssue[] =>
    isBlank(row[questionAt]) || /^none\.?$/i.test(row[questionAt]!.trim()) || !isBlank(row[answerAt])
      ? []
      : [{ type: "questions", where: `Open questions row ${at + 1}`, message: `Unanswered: ${row[questionAt]}` }],
  );
}

function finish(input: BriefReport["input"], issues: BriefIssue[], note?: string): BriefReport {
  const codes = issues.map((issue) => BRIEF_EXIT[issue.type]);
  return { ok: !issues.length, input, exitCode: codes.length ? Math.min(...codes) : 0, issues, ...(note ? { note } : {}) };
}

/** The screen-inventory table as Markdown, without N/A rows, for `resolve spec`. Empty when there is none. */
export function inventoryTable(markdown: string): string {
  const parsed = parseFrontmatter(markdown);
  const section = find(sections(parsed?.body ?? markdown), /screen inventory/i);
  const lines = (section?.lines ?? []).filter((line) => /^\s*\|/.test(line));
  return lines.filter((line, at) => at < 2 || !cells(line).some((cell) => NA.test(cell))).join("\n");
}

export function checkBrief(markdown: string): BriefReport {
  const parsed = parseFrontmatter(markdown);
  if (!parsed) return finish("brief", [{ type: "frontmatter", where: "frontmatter", message: "No frontmatter. Start the file with a --- block: ticket, product, journey, ui_scope, requirements_source, status." }]);
  const issues = checkFrontmatter(parsed.data);
  if (parsed.data["ui_scope"] === "false") return finish("brief", issues, issues.length ? undefined : "ui_scope is false: backend only, so no brief is needed.");
  const all = sections(parsed.body);
  issues.push(...checkScreens(find(all, /screen inventory/i)), ...checkFields(find(all, /content and data/i)));
  if (parsed.data["status"] === "complete") issues.push(...checkQuestions(find(all, /open questions/i)));
  else if (!issues.some((issue) => issue.where === "status")) issues.push({ type: "status", where: "status", message: "`status` is draft. Set it to complete when the brief is done; a ticket is ready for planning only with a complete brief." });
  return finish("brief", issues);
}

/** A Resolve handoff pack (handoff.json): not a draft, not refused, and verify passed on every screen. */
export function checkHandoffPack(pack: unknown): BriefReport {
  const issues: BriefIssue[] = [];
  const add = (where: string, message: string) => issues.push({ type: "handoff", where, message });
  const body = (pack && typeof pack === "object" ? pack : {}) as { ok?: unknown; draft?: unknown; screens?: unknown };
  if (body.ok !== true) add("handoff.json", "The handoff was refused, so there is no pack to pass. Fix what it names and run handoff again.");
  else {
    if (body.draft === true) add("handoff.json", "The handoff is a draft. Run handoff again without --draft.");
    const screens = Array.isArray(body.screens) ? (body.screens as Array<{ name?: unknown; verify?: { pass?: unknown } }>) : [];
    if (!screens.length) add("handoff.json", "The handoff has no screens.");
    for (const screen of screens) if (screen?.verify?.pass !== true) add(`screen ${typeof screen?.name === "string" ? screen.name : "(unnamed)"}`, "Verify did not pass on this screen.");
  }
  return finish("handoff", issues, issues.length ? undefined : "The handoff is not a draft and verify passed on every screen.");
}
