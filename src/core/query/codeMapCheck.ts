import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { listCodeMapEntries, type CodeMapListed, type CodeMapSkipped } from "./codeMap";

/**
 * Name check against the committed handoff sheet and code map.
 * No learned graph. A shared package is not a component. Nothing is guessed.
 */

export type CodeMapCheckStatus = "ok" | "retired" | "not-in-handoff" | "unmapped" | "other-library" | "not-found" | "error";

export type CodeMapCheckMatch = "name" | "selector" | "class" | "import";

export interface CodeMapCheckResult {
  ok: boolean;
  status: CodeMapCheckStatus;
  query: string;
  message: string;
  /** 0 ok, 1 error, 2 retired, 3 not-in-handoff, 4 unmapped, 5 not-found, 6 other-library. */
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
  "other-library": 6,
};

const CLASS_SUFFIX = "Component";
const DRAFT_MESSAGE = "This handoff is a draft, not for a build. Run resolve handoff again without --draft.";
const NOT_FOUND_MESSAGE = "Not in the design system or on this screen. Don't invent it.";
const NOT_IN_HANDOFF_MESSAGE = "Real component, but not on this screen. Ask the designer.";
const UNMAPPED_MESSAGE = "On the screen, no code yet. Build it or ask.";
const OTHER_LIBRARY_MESSAGE = "On the screen, from another library, no code twin.";
const IMPORT_LINE = /^import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?$/i;

interface Mention {
  name?: string;
  fileKey?: string;
  figmaNodeId?: string;
  selector?: string;
  className?: string;
  status?: string;
  identity?: string;
  unmapped: boolean;
  otherLibrary: boolean;
}

interface Asked {
  original: string;
  text: string;
  specs: string[];
  pkg?: string;
}

interface Candidate {
  entry: CodeMapListed;
  by: CodeMapCheckMatch;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const fold = (value: string) => value.trim().toLowerCase();
const sameName = (a: string, b: string) => fold(a) === fold(b);
const compact = (value: string) => fold(stripVariant(value)).replace(/[^a-z0-9]+/g, "");
const namesEqual = (a: string, b: string) => {
  const left = compact(a);
  const right = compact(b);
  return left.length > 0 && left === right;
};

function classAlias(component: string): string | undefined {
  if (!component.endsWith(CLASS_SUFFIX)) return undefined;
  const short = component.slice(0, -CLASS_SUFFIX.length);
  return short || undefined;
}

function stripVariant(value: string): string {
  return value.replace(/\s+\/\s+Variant=.*$/i, "").trim();
}

function stripHtml(value: string): string {
  const trimmed = value.trim();
  const paired = /^<\s*([A-Za-z][\w-]*)\b[^>]*>(?:\s*<\/\s*\1\s*>\s*)?$/i.exec(trimmed);
  if (paired?.[1]) return paired[1];
  return trimmed;
}

function selectorParts(selector: string): string[] {
  return selector.split(",").map((part) => part.trim()).filter(Boolean);
}

function selectorHit(query: string, selector: string): boolean {
  const asked = fold(query);
  const bare = asked.replace(/^\[|\]$/g, "");
  if (!asked) return false;
  if (fold(selector) === asked) return true;
  return selectorParts(selector).some((part) => {
    const folded = fold(part);
    return folded === asked || folded === `[${bare}]` || folded.replace(/^\[|\]$/g, "") === bare;
  });
}

function parseImport(text: string): { specs: string[]; pkg: string } | undefined {
  const match = IMPORT_LINE.exec(text.trim());
  if (!match?.[1] || !match[2]) return undefined;
  const specs = match[1]
    .split(",")
    .map((part) => part.trim().replace(/^type\s+/i, ""))
    .filter(Boolean);
  if (!specs.length) return undefined;
  return { specs, pkg: match[2].trim() };
}

function parseAsked(query: string): Asked {
  const original = query.trim();
  const text = stripVariant(stripHtml(original)).trim();
  const imported = parseImport(text);
  return imported ? { original, text, specs: imported.specs, pkg: imported.pkg } : { original, text, specs: [] };
}

function queryForms(text: string): string[] {
  const forms = [text];
  if (!text.includes(",")) return forms;
  for (const part of text.split(",").map((item) => item.trim()).filter(Boolean)) {
    if (!forms.includes(part)) forms.push(part);
  }
  return forms;
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

function useSentence(entry: CodeMapListed, label: string): string {
  const dropped = entry.angularDropped ? ` Angular fields were dropped (${entry.angularDropped}). Fix that code-map entry.` : "";
  if (entry.framework === "react" || (!entry.selector && !entry.angularDropped)) {
    return `${label}. Use ${entry.component} from '${entry.importPath}' (React).${dropped}`;
  }
  const how = entry.module ? entry.module : entry.standalone ? "standalone" : "no module";
  const selector = entry.selector ?? entry.component;
  return `${label}. Use \`<${selector}>\` (${how}).${dropped}`;
}

/** Follow replacedBy through the code map, at most 3 steps. The written name is kept when it is not itself retired. */
function replacementOf(entry: CodeMapListed, entries: CodeMapListed[]): string | undefined {
  let cursor = entry.replacedBy?.trim();
  if (!cursor) return undefined;
  const seen = new Set<number>();
  for (let hop = 0; hop < 3; hop += 1) {
    const next = entries.find(
      (row) => (row.name && namesEqual(row.name, cursor!)) || sameName(row.component, cursor!) || (classAlias(row.component) && sameName(classAlias(row.component)!, cursor!)),
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
  const code = record["code"];
  const angular = isRecord(record["angular"]) ? record["angular"] : undefined;
  const selector = typeof angular?.["selector"] === "string" ? angular["selector"] : undefined;
  let className: string | undefined;
  if (typeof code === "string" && code !== "unmapped" && code !== "unknown") {
    const parsed = /^(.+?) from '([^']+)'$/.exec(code);
    if (parsed?.[1]) className = parsed[1];
  }
  const status = typeof record["status"] === "string" ? record["status"] : undefined;
  const identity = typeof record["identity"] === "string" ? record["identity"] : undefined;
  return {
    ...(typeof record["name"] === "string" ? { name: record["name"] } : {}),
    ...(typeof record["fileKey"] === "string" ? { fileKey: record["fileKey"] } : {}),
    ...(typeof record["figmaNodeId"] === "string" ? { figmaNodeId: record["figmaNodeId"] } : {}),
    ...(selector ? { selector } : {}),
    ...(className ? { className } : {}),
    ...(status ? { status } : {}),
    ...(identity ? { identity } : {}),
    unmapped: code === "unmapped",
    otherLibrary: code === null || code === "unknown" || status === "other-library",
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

function samePart(entry: CodeMapListed, mention: Mention): boolean {
  return Boolean(entry.fileKey && entry.id && mention.fileKey === entry.fileKey && mention.figmaNodeId === entry.id);
}

function confirmedMention(entry: CodeMapListed, mentions: Mention[]): Mention | undefined {
  return mentions.find((mention) => mention.identity !== "name-guess" && samePart(entry, mention));
}

function guessOnly(entry: CodeMapListed, mentions: Mention[]): boolean {
  const hits = mentions.filter((mention) => samePart(entry, mention));
  return hits.length > 0 && hits.every((mention) => mention.identity === "name-guess");
}

function specHits(spec: string, entry: CodeMapListed): boolean {
  if (sameName(spec, entry.component)) return true;
  return Boolean(entry.module && sameName(spec, entry.module));
}

function addCandidate(found: Map<number, Candidate>, entry: CodeMapListed, by: CodeMapCheckMatch): void {
  if (!found.has(entry.entry)) found.set(entry.entry, { entry, by });
}

function candidatesFor(asked: Asked, entries: CodeMapListed[]): Candidate[] {
  const found = new Map<number, Candidate>();
  if (asked.pkg) {
    for (const entry of entries) {
      if (entry.importPath !== asked.pkg) continue;
      if (asked.specs.some((spec) => specHits(spec, entry))) addCandidate(found, entry, "import");
    }
    return [...found.values()];
  }
  const forms = queryForms(asked.text);
  for (const entry of entries) {
    let by: CodeMapCheckMatch | undefined;
    for (const form of forms) {
      if (entry.selector && selectorHit(form, entry.selector)) {
        by = "selector";
        break;
      }
      if (sameName(form, entry.component)) {
        by = "class";
        break;
      }
      const short = classAlias(entry.component);
      if (short && sameName(form, short)) {
        by = "class";
        break;
      }
      if (entry.name && namesEqual(form, entry.name)) {
        by = "name";
        break;
      }
    }
    if (by) addCandidate(found, entry, by);
  }
  return [...found.values()];
}

function mentionsForName(asked: Asked): string[] {
  return asked.pkg ? [] : queryForms(asked.text);
}

function linkFromSheet(asked: Asked, entries: CodeMapListed[], mentions: Mention[], found: Map<number, Candidate>): void {
  if (asked.pkg) return;
  const forms = mentionsForName(asked);
  for (const mention of mentions) {
    if (mention.identity === "name-guess" || !mention.name || !mention.fileKey || !mention.figmaNodeId) continue;
    if (!forms.some((form) => namesEqual(form, mention.name!))) continue;
    const entry = entries.find((row) => row.fileKey === mention.fileKey && row.id === mention.figmaNodeId);
    if (entry) addCandidate(found, entry, "name");
  }
}

function skippedHit(asked: Asked, skipped: CodeMapSkipped[]): CodeMapSkipped | undefined {
  const forms = asked.pkg ? asked.specs : queryForms(asked.text);
  return skipped.find((row) =>
    forms.some(
      (form) =>
        (row.name && namesEqual(form, row.name)) ||
        (row.component && (sameName(form, row.component) || namesEqual(form, row.component))) ||
        (row.selector && selectorHit(form, row.selector)),
    ),
  );
}

function sheetOnly(asked: Asked, mentions: Mention[]): Mention | undefined {
  if (asked.pkg) return undefined;
  const forms = queryForms(asked.text);
  const hits = mentions.filter((mention) => mention.identity !== "name-guess" && mention.name && forms.some((form) => namesEqual(form, mention.name!)));
  return hits.find((mention) => mention.otherLibrary) ?? hits.find((mention) => mention.unmapped);
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

function labelFor(entry: CodeMapListed, mention: Mention | undefined): string {
  return entry.name ?? mention?.name ?? entry.component;
}

function answerOne(hit: Candidate, mentions: Mention[], entries: CodeMapListed[], query: string): CodeMapCheckResult {
  if (guessOnly(hit.entry, mentions)) {
    return result("not-found", query, NOT_FOUND_MESSAGE);
  }
  const mention = confirmedMention(hit.entry, mentions);
  const label = labelFor(hit.entry, mention);
  const retired = hit.entry.status === "retired" || mention?.status === "retired";
  if (retired) {
    const use = replacementOf(hit.entry, entries);
    const message = use ? `Don't use. Use ${use}.` : "Don't use. There is no current replacement.";
    return result("retired", query, message, { ...twinFields(hit.entry, hit.by), ...(use ? { use } : {}) });
  }
  if (mention) return result("ok", query, useSentence(hit.entry, label), twinFields(hit.entry, hit.by));
  return result("not-in-handoff", query, NOT_IN_HANDOFF_MESSAGE, twinFields(hit.entry, hit.by));
}

/**
 * Classify one typed name. `query` is a display name, selector, class, module import, or HTML tag.
 * Package path alone never matches. The sheet's fileKey + figmaNodeId picks the entry when a name is shared.
 */
export function checkComponentName(query: string, codeMap: unknown, handoff: unknown): CodeMapCheckResult {
  const asked = parseAsked(query);
  if (!asked.original) {
    return result("error", query, "The name was empty.");
  }
  if (isRecord(handoff) && handoff["draft"] === true) {
    return result("error", asked.original, DRAFT_MESSAGE);
  }
  const listed = listCodeMapEntries(codeMap);
  if (listed.error) return result("error", asked.original, listed.error);
  const sheetError = handoffError(handoff);
  if (sheetError || !isRecord(handoff)) {
    return result("error", asked.original, sheetError ?? "This file is not a handoff sheet. Pass the handoff.json that resolve handoff writes.");
  }
  const mentions = mentionsIn(handoff);
  const found = new Map<number, Candidate>();
  for (const hit of candidatesFor(asked, listed.entries)) addCandidate(found, hit.entry, hit.by);
  linkFromSheet(asked, listed.entries, mentions, found);
  const unique = [...found.values()];
  if (!listed.entries.length && !unique.length) {
    const skip = skippedHit(asked, listed.skipped);
    if (skip) {
      return result("not-found", asked.original, `Entry ${skip.entry} was skipped (${skip.reason}). ${NOT_FOUND_MESSAGE}`);
    }
    const why = listed.problems[0] ? ` ${listed.problems[0]}.` : "";
    return result("error", asked.original, `The code map has no usable entries.${why} Fix .resolve/code-map.json, then try again. Nothing was guessed.`);
  }
  const onSheet = unique.filter((hit) => confirmedMention(hit.entry, mentions));
  const chosen = unique.length <= 1 ? unique : onSheet.length === 1 ? onSheet : [];
  if (unique.length > 1 && onSheet.length !== 1) {
    const retired = unique.filter((hit) => hit.entry.status === "retired");
    const current = unique.filter((hit) => hit.entry.status !== "retired");
    if (current.length && retired.length) {
      return result("error", asked.original, `${asked.text} matches a current component and a retired one. Name the selector or the class.`);
    }
    const names = unique.map((hit) => hit.entry.name ?? hit.entry.component).join(", ");
    return result("error", asked.original, `${asked.text} matches more than one code-map component (${names}). Name the selector or the class.`);
  }
  if (chosen.length === 1) return answerOne(chosen[0]!, mentions, listed.entries, asked.original);
  const only = sheetOnly(asked, mentions);
  if (only?.otherLibrary) return result("other-library", asked.original, OTHER_LIBRARY_MESSAGE);
  if (only?.unmapped) return result("unmapped", asked.original, UNMAPPED_MESSAGE);
  const skip = skippedHit(asked, listed.skipped);
  if (skip) {
    return result("not-found", asked.original, `Entry ${skip.entry} was skipped (${skip.reason}). ${NOT_FOUND_MESSAGE}`);
  }
  return result("not-found", asked.original, NOT_FOUND_MESSAGE);
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
  const map = readJson(mapPath, "the code map");
  if (map.error || map.raw === undefined) return result("error", asked || query, map.error ?? "The code map could not be read.", paths);
  const sheet = readJson(sheetPath, "the handoff file");
  if (sheet.error || sheet.raw === undefined) return result("error", asked || query, sheet.error ?? "The handoff file could not be read.", paths);
  return { ...checkComponentName(query, map.raw, sheet.raw), ...paths };
}
