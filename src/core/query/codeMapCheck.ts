import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { listCodeMapEntries, type CodeMapListed } from "./codeMap";

/**
 * Name check against the committed handoff sheet and code map.
 * No learned graph. Never guesses a code twin.
 */

export type CodeMapCheckStatus = "ok" | "retired" | "not-in-handoff" | "unmapped" | "not-found" | "error";

export type CodeMapCheckMatch = "name" | "selector" | "class" | "import";

export interface CodeMapCheckResult {
  ok: boolean;
  status: CodeMapCheckStatus;
  query: string;
  message: string;
  /** 0 ok, 1 error, 2 retired, 3 not-in-handoff, 4 unmapped, 5 not-found. */
  exitCode: number;
  component?: string;
  selector?: string;
  module?: string;
  standalone?: true;
  import?: string;
  /** Replacement to use when status is retired. */
  use?: string;
  matchedBy?: CodeMapCheckMatch;
  codeMapPath?: string;
  handoffPath?: string;
}

const EXIT: Record<CodeMapCheckStatus, number> = {
  ok: 0,
  error: 1,
  retired: 2,
  "not-in-handoff": 3,
  unmapped: 4,
  "not-found": 5,
};

const CLASS_SUFFIX = "Component";

interface Mention {
  name?: string;
  selector?: string;
  className?: string;
  importPath?: string;
  unmapped: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const fold = (value: string) => value.trim().toLowerCase();
const sameName = (a: string, b: string) => fold(a) === fold(b);

function classAlias(component: string): string | undefined {
  if (!component.endsWith(CLASS_SUFFIX)) return undefined;
  const short = component.slice(0, -CLASS_SUFFIX.length);
  return short || undefined;
}

function selectorParts(selector: string): string[] {
  return selector.split(",").map((part) => part.trim()).filter(Boolean);
}

function selectorHit(query: string, selector: string): boolean {
  const asked = query.trim();
  if (asked === selector) return true;
  return selectorParts(selector).includes(asked);
}

function importHit(query: string, importPath: string): boolean {
  const asked = query.trim();
  if (asked === importPath) return true;
  const from = /\bfrom\s+(['"])([^'"\s]+)\1/.exec(asked);
  return from?.[2] === importPath;
}

function matchedBy(query: string, entry: CodeMapListed): CodeMapCheckMatch | undefined {
  if (entry.selector && selectorHit(query, entry.selector)) return "selector";
  if (sameName(query, entry.component)) return "class";
  const short = classAlias(entry.component);
  if (short && sameName(query, short)) return "class";
  if (importHit(query, entry.importPath)) return "import";
  if (entry.name && sameName(query, entry.name)) return "name";
  return undefined;
}

function result(
  status: CodeMapCheckStatus,
  query: string,
  message: string,
  extra: Partial<CodeMapCheckResult> = {},
): CodeMapCheckResult {
  return { ok: status === "ok", status, query, message, exitCode: EXIT[status], ...extra };
}

function twinFields(entry: CodeMapListed, by: CodeMapCheckMatch): Partial<CodeMapCheckResult> {
  return {
    component: entry.component,
    matchedBy: by,
    import: entry.importPath,
    ...(entry.selector ? { selector: entry.selector } : {}),
    ...(entry.module ? { module: entry.module } : {}),
    ...(entry.standalone ? { standalone: true as const } : {}),
  };
}

function angularSentence(entry: CodeMapListed): string {
  const selector = entry.selector ? `selector ${entry.selector}` : "no selector";
  const module = entry.module ? `module ${entry.module}` : entry.standalone ? "standalone" : "no module";
  const dropped = entry.angularDropped ? ` Angular fields were dropped (${entry.angularDropped}). Fix that code-map entry.` : "";
  return `Angular ${selector}, ${module}, import ${entry.importPath}.${dropped}`;
}

/** Follow replacedBy through the code map, at most 3 steps. The written name is kept when it is not itself retired. */
function replacementOf(entry: CodeMapListed, entries: CodeMapListed[]): string | undefined {
  let cursor = entry.replacedBy?.trim();
  if (!cursor) return undefined;
  const seen = new Set<number>();
  for (let hop = 0; hop < 3; hop += 1) {
    const next = entries.find(
      (row) => (row.name && sameName(row.name, cursor!)) || sameName(row.component, cursor!) || (classAlias(row.component) && sameName(classAlias(row.component)!, cursor!)),
    );
    if (!next || next.status !== "retired") return cursor;
    if (seen.has(next.entry)) return undefined;
    seen.add(next.entry);
    const followed = next.replacedBy?.trim();
    if (!followed) return undefined;
    cursor = followed;
  }
  return undefined;
}

function mentionOf(record: Record<string, unknown>): Mention {
  const code = typeof record["code"] === "string" ? record["code"] : undefined;
  const angular = isRecord(record["angular"]) ? record["angular"] : undefined;
  const selector = typeof angular?.["selector"] === "string" ? angular["selector"] : undefined;
  const importPath = typeof angular?.["importPath"] === "string" ? angular["importPath"] : undefined;
  let className: string | undefined;
  let fromCode: string | undefined;
  if (code && code !== "unmapped" && code !== "unknown") {
    const parsed = /^(.+?) from '([^']+)'$/.exec(code);
    if (parsed?.[1] && parsed[2]) {
      className = parsed[1];
      fromCode = parsed[2];
    }
  }
  return {
    ...(typeof record["name"] === "string" ? { name: record["name"] } : {}),
    ...(selector ? { selector } : {}),
    ...(className ? { className } : {}),
    ...(importPath || fromCode ? { importPath: importPath ?? fromCode } : {}),
    unmapped: code === "unmapped",
  };
}

function takeList(value: unknown, out: Mention[]): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (!isRecord(item)) continue;
    out.push(mentionOf(item));
    takeList(item["parts"], out);
  }
}

function mentionsIn(handoff: Record<string, unknown>): Mention[] {
  const out: Mention[] = [];
  const screens = Array.isArray(handoff["screens"]) ? handoff["screens"] : [];
  for (const screen of screens) {
    if (!isRecord(screen)) continue;
    takeList(screen["components"], out);
    takeList(screen["ingredients"], out);
    const recipe = screen["recipe"];
    if (isRecord(recipe) && Array.isArray(recipe["slots"])) {
      for (const slot of recipe["slots"]) {
        if (isRecord(slot) && isRecord(slot["component"])) out.push(mentionOf(slot["component"]));
      }
    }
  }
  takeList(handoff["ingredients"], out);
  return out;
}

function overlaps(entry: CodeMapListed, mention: Mention): boolean {
  if (mention.name && entry.name && sameName(mention.name, entry.name)) return true;
  if (mention.name && sameName(mention.name, entry.component)) return true;
  const short = classAlias(entry.component);
  if (mention.name && short && sameName(mention.name, short)) return true;
  if (mention.className && sameName(mention.className, entry.component)) return true;
  if (mention.selector && entry.selector && (selectorHit(mention.selector, entry.selector) || selectorHit(entry.selector, mention.selector))) return true;
  if (mention.importPath && mention.importPath === entry.importPath) return true;
  return false;
}

function onHandoff(entry: CodeMapListed, mentions: Mention[]): boolean {
  return mentions.some((mention) => overlaps(entry, mention));
}

function unmappedName(query: string, mentions: Mention[]): string | undefined {
  const hit = mentions.find((mention) => mention.unmapped && mention.name && sameName(mention.name, query));
  return hit?.name;
}

function handoffError(raw: unknown): string | undefined {
  if (!isRecord(raw)) return "This file is not a handoff sheet. Pass the handoff.json that resolve handoff writes.";
  if (raw["ok"] === false) {
    const refused = Array.isArray(raw["refused"]) ? raw["refused"] : [];
    const first = refused.find(isRecord);
    const why = first && typeof first["message"] === "string" ? first["message"] : "The sheet was refused.";
    return `This handoff was refused, so there is no screen to check. ${why} Export the sheet again after that is fixed.`;
  }
  if (!Array.isArray(raw["screens"])) {
    return "This file is not a handoff sheet. Pass the handoff.json that resolve handoff writes.";
  }
  return undefined;
}

/**
 * Classify one typed name. `query` is a display name, Angular selector, class name, or import path.
 * Exactly one of ok, retired, not-in-handoff, unmapped, or not-found when both documents can be read.
 */
export function checkComponentName(query: string, codeMap: unknown, handoff: unknown): CodeMapCheckResult {
  const asked = query.trim();
  if (!asked) {
    return result("error", query, "Name the component. Pass a display name, an Angular selector, a class name, or an import path.");
  }
  const listed = listCodeMapEntries(codeMap);
  if (listed.error) return result("error", asked, listed.error);
  if (!listed.entries.length) {
    const why = listed.problems[0] ? ` ${listed.problems[0]}.` : "";
    return result("error", asked, `The code map has no usable entries.${why} Fix .resolve/code-map.json, then try again. Nothing was guessed.`);
  }
  const sheetError = handoffError(handoff);
  if (sheetError || !isRecord(handoff)) return result("error", asked, sheetError ?? "This file is not a handoff sheet. Pass the handoff.json that resolve handoff writes.");
  const mentions = mentionsIn(handoff);
  const hits = listed.entries.flatMap((entry) => {
    const by = matchedBy(asked, entry);
    return by ? [{ entry, by }] : [];
  });
  const current = hits.filter((hit) => hit.entry.status !== "retired");
  const retired = hits.filter((hit) => hit.entry.status === "retired");
  if (current.length > 1) {
    const names = current.map((hit) => hit.entry.name ?? hit.entry.component).join(", ");
    return result("error", asked, `${asked} matches more than one code-map component (${names}). Name the selector or the class. Nothing was guessed.`);
  }
  if (retired.length > 1 && current.length === 0) {
    const names = retired.map((hit) => hit.entry.name ?? hit.entry.component).join(", ");
    return result("error", asked, `${asked} matches more than one retired component (${names}). Name the selector or the class. Nothing was guessed.`);
  }
  if (current.length === 1 && retired.length >= 1) {
    return result("error", asked, `${asked} matches a current component and a retired one. Name the selector or the class. Nothing was guessed.`);
  }
  if (retired.length === 1 && current.length === 0) {
    const hit = retired[0]!;
    const use = replacementOf(hit.entry, listed.entries);
    const message = use ? `${asked} is retired: use ${use}.` : `${asked} is retired. The code map names no current replacement.`;
    return result("retired", asked, message, { ...twinFields(hit.entry, hit.by), ...(use ? { use } : {}) });
  }
  if (current.length === 1) {
    const hit = current[0]!;
    if (onHandoff(hit.entry, mentions)) {
      return result("ok", asked, `${asked} is on this handoff. ${angularSentence(hit.entry)}`, twinFields(hit.entry, hit.by));
    }
    return result(
      "not-in-handoff",
      asked,
      `${asked} is in the code map, but this handoff does not use it.`,
      twinFields(hit.entry, hit.by),
    );
  }
  const unmapped = unmappedName(asked, mentions);
  if (unmapped) {
    return result("unmapped", asked, `${asked} is on this handoff, but it has no code twin yet. Nothing was guessed.`);
  }
  return result("not-found", asked, `Nothing named ${asked} is in the code map or this handoff. Nothing was guessed.`);
}

function readJson(path: string, label: string): { raw?: unknown; error?: string } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { error: `Could not read ${label} at ${path}. Check the path and try again.` };
  }
  try {
    return { raw: JSON.parse(text.replace(/^\uFEFF/, "")) as unknown };
  } catch {
    return { error: `${label} is not valid JSON, so it cannot be checked. Fix the file and try again. Nothing was guessed.` };
  }
}

/** `handoff` may be handoff.json or the folder resolve handoff --out wrote. */
export function handoffJsonPath(given: string): string {
  const target = resolve(given);
  if (existsSync(target) && statSync(target).isDirectory()) return join(target, "handoff.json");
  return target;
}

/** File-backed check. Does not read or write a learned graph. */
export function checkComponentFiles(query: string, codeMapPath: string, handoffPath: string): CodeMapCheckResult {
  const mapPath = resolve(codeMapPath);
  const sheetPath = handoffJsonPath(handoffPath);
  const paths = { codeMapPath: mapPath, handoffPath: sheetPath };
  const asked = query.trim();
  if (!existsSync(mapPath)) {
    return result("error", asked || query, `No code map at ${mapPath}. Add the team's code-map.json, then try again. Nothing was guessed.`, paths);
  }
  if (!existsSync(sheetPath)) {
    return result(
      "error",
      asked || query,
      `No handoff sheet at ${sheetPath}. Run resolve handoff --out <folder>, then pass --handoff with the handoff.json it writes.`,
      paths,
    );
  }
  const map = readJson(mapPath, "The code map");
  if (map.error || map.raw === undefined) return result("error", asked || query, map.error ?? "The code map could not be read.", paths);
  const sheet = readJson(sheetPath, "The handoff file");
  if (sheet.error || sheet.raw === undefined) return result("error", asked || query, sheet.error ?? "The handoff file could not be read.", paths);
  return { ...checkComponentName(query, map.raw, sheet.raw), ...paths };
}
