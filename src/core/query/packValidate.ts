/**
 * Strict context-pack check. Loading a pack is lenient: a bad pack or field is skipped.
 * `resolve pack validate` stays strict.
 */

import { normaliseA11y } from "./contextPacks";

export const A11Y_LEVELS = ["wcag-a", "wcag-aa", "wcag-aaa"] as const;

export type A11yLevel = (typeof A11Y_LEVELS)[number];

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FILE_KEY = /^(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[A-Z])[A-Za-z0-9]{22,128}$/;
const FILE_KEY_IN_TEXT = /(?<![A-Za-z0-9])(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[A-Z])[A-Za-z0-9]{22,128}(?![A-Za-z0-9])/g;
const RATIOS = new Set(["16:9", "9:16", "4:3", "3:4", "21:9", "9:21", "1:1", "3:2", "2:3", "5:4", "4:5", "32:9", "9:32", "18:9"]);
const SECRET_MARK = "fig" + "d_";
const FORBIDDEN_KEYS = new Set(["filekey", "figmanodeid", "nodeid", "componentkey", "figmaurl", "figmalink"]);
const KNOWN_TOP = new Set(["version", "howtoadd", "packs", "contextpacks", "active"]);
const KNOWN_PACK = new Set(["id", "product", "client", "domain", "journey", "audience", "constraints", "recipeids", "recipes", "files", "libraryrules", "bindrules"]);
const KNOWN_NAMED = new Set(["id", "name"]);
const KNOWN_JOURNEY = new Set(["step", "screenjob"]);
const KNOWN_CONSTRAINTS = new Set(["density", "a11y"]);

export interface PackIssue {
  field: string;
  message: string;
  pack?: string;
}

export interface PackValidation {
  ok: boolean;
  packs: number;
  message: string;
  exitCode: 0 | 1;
  errors: PackIssue[];
  warnings: PackIssue[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normKey = (key: string) => key.toLowerCase().replace(/[_-]/g, "");

function issue(field: string, message: string, pack?: string): PackIssue {
  return pack ? { field, message, pack } : { field, message };
}

export function formatPackIssues(errors: PackIssue[]): string {
  return errors.map((item) => `${item.field}: ${item.message}`).join("\n");
}

function isClockTime(token: string): boolean {
  const match = /^(\d{1,2}):(\d{2})$/.exec(token);
  if (!match?.[1] || !match[2]) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59;
}

function isNodeToken(token: string): boolean {
  if (!/^\d{1,12}:\d{1,12}$/.test(token)) return false;
  if (RATIOS.has(token) || isClockTime(token)) return false;
  return true;
}

function hasNodeId(value: string): boolean {
  const trimmed = value.trim();
  if (/^\d{1,12}-\d{1,12}$/.test(trimmed)) return true;
  if (/\d{1,12}%3a\d{1,12}/i.test(value)) return true;
  const matches = value.match(/\d{1,12}:\d{1,12}/g) ?? [];
  return matches.some((token) => isNodeToken(token));
}

function hasFileKey(value: string): boolean {
  if (FILE_KEY.test(value.trim())) return true;
  FILE_KEY_IN_TEXT.lastIndex = 0;
  return FILE_KEY_IN_TEXT.test(value);
}

function hasSecret(value: string): boolean {
  return value.toLowerCase().includes(SECRET_MARK);
}

function forbiddenKey(key: string): boolean {
  if (FORBIDDEN_KEYS.has(normKey(key))) return true;
  if (FILE_KEY.test(key)) return true;
  if (/^\d{1,12}-\d{1,12}$/.test(key)) return true;
  if (/^\d{1,12}%3a\d{1,12}$/i.test(key)) return true;
  return false;
}

function stringProblem(value: string, field: string, pack?: string): PackIssue | undefined {
  if (hasSecret(value)) {
    return issue(field, "This contains a Figma token. Remove it. A context pack must not store tokens.", pack);
  }
  if (/figma\.com/i.test(value) || /node-id=\d+-\d+/i.test(value)) {
    return issue(field, "This contains a Figma link or node id. Remove it. A context pack does not store Figma files or component ids. Recommend fills those after the library is learned.", pack);
  }
  if (hasNodeId(value)) {
    return issue(field, "This contains a Figma node id. Remove it. Recommend fills component ids after the library is learned.", pack);
  }
  if (hasFileKey(value)) {
    return issue(field, "This looks like a Figma file key. Remove it. Name the workspace label (the name in workspace.json), not the Figma file key.", pack);
  }
  return undefined;
}

function knownFor(field: string): Set<string> | undefined {
  if (!field || field === "packs" || field === "contextPacks") return KNOWN_TOP;
  if (/\.(product|client)$/.test(field)) return KNOWN_NAMED;
  if (field.endsWith(".journey")) return KNOWN_JOURNEY;
  if (field.endsWith(".constraints")) return KNOWN_CONSTRAINTS;
  if (/^packs\[\d+\]$/.test(field) || /^contextPacks\[\d+\]$/.test(field)) return KNOWN_PACK;
  return undefined;
}

function walk(value: unknown, field: string, pack: string | undefined, errors: PackIssue[], warnings: PackIssue[]): void {
  if (typeof value === "string") {
    const found = stringProblem(value, field, pack);
    if (found) errors.push(found);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${field}[${index}]`, pack, errors, warnings));
    return;
  }
  if (!isRecord(value)) return;
  const known = knownFor(field);
  for (const [key, child] of Object.entries(value)) {
    const next = field ? `${field}.${key}` : key;
    if (known && !known.has(normKey(key)) && !forbiddenKey(key)) {
      warnings.push(issue(next, `Unknown field "${key}". Resolve does not use it. Remove it, or fix the spelling.`, pack));
    }
    if (forbiddenKey(key)) {
      errors.push(issue(next, `Figma ids are not allowed in a context pack. Remove ${key}. Recommend fills component ids after the library is learned.`, pack));
    }
    walk(child, next, pack, errors, warnings);
  }
}

function checkPack(raw: unknown, index: number, recipeIds: ReadonlySet<string>, errors: PackIssue[], warnings: PackIssue[]): string | undefined {
  const field = `packs[${index}]`;
  if (!isRecord(raw)) {
    errors.push(issue(field, "Each pack must be an object with an id. See src/data/context-packs.example.json."));
    return undefined;
  }
  const idRaw = raw["id"];
  const pack = typeof idRaw === "string" ? idRaw.trim() : undefined;
  if (typeof idRaw !== "string" || !pack) {
    errors.push(issue(`${field}.id`, "Every pack needs an id. Use a slug such as checkout-summary (lowercase letters, numbers, and hyphens).", pack));
  } else if (!SLUG.test(pack)) {
    errors.push(issue(`${field}.id`, `Pack id "${pack}" is not a slug. Use lowercase letters, numbers, and hyphens only, for example ${pack.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "checkout-summary"}.`, pack));
  }
  const constraints = raw["constraints"];
  if (constraints !== undefined && !isRecord(constraints)) {
    errors.push(issue(`${field}.constraints`, "constraints must be an object. Set a11y to wcag-a, wcag-aa, or wcag-aaa, or remove constraints.", pack));
  } else if (isRecord(constraints) && constraints["a11y"] !== undefined) {
    const a11y = constraints["a11y"];
    const known = A11Y_LEVELS.join(", ");
    const normalised = typeof a11y === "string" ? normaliseA11y(a11y) : "";
    if (!normalised || !A11Y_LEVELS.includes(normalised as A11yLevel)) {
      const shown = typeof a11y === "string" ? a11y : "that value";
      errors.push(issue(`${field}.constraints.a11y`, `Accessibility level "${shown}" is not a known value. Use ${known}, or remove constraints.a11y.`, pack));
    }
  }
  const recipes = raw["recipeIds"] ?? raw["recipes"];
  const recipeField = raw["recipeIds"] !== undefined ? "recipeIds" : "recipes";
  if (recipes !== undefined && !Array.isArray(recipes)) {
    errors.push(issue(`${field}.${recipeField}`, 'recipeIds must be a list of recipe ids, for example ["checkout-summary"].', pack));
  } else if (Array.isArray(recipes)) {
    recipes.forEach((id, at) => {
      if (typeof id !== "string" || !id.trim()) {
        errors.push(issue(`${field}.${recipeField}[${at}]`, "A recipe id must be text, like checkout-summary.", pack));
        return;
      }
      if (!recipeIds.has(id)) {
        errors.push(issue(`${field}.${recipeField}[${at}]`, `Recipe id "${id}" does not exist. Use an id from resolve recipe list, for example checkout-summary. Use the id, not the title.`, pack));
      }
    });
  }
  walk(raw, field, pack, errors, warnings);
  return pack;
}

/** Plain-English problems for one context-pack document. `recipeIds` is the catalog (starter recipes plus the team overlay). */
export function validateContextPackDocument(raw: unknown, recipeIds: ReadonlySet<string>): PackIssue[] {
  return collectPackIssues(raw, recipeIds).errors;
}

export function collectPackIssues(raw: unknown, recipeIds: ReadonlySet<string>): { errors: PackIssue[]; warnings: PackIssue[] } {
  const warnings: PackIssue[] = [];
  if (Array.isArray(raw)) {
    return { errors: [issue("(file)", "The context pack file must be a JSON object with a packs list. Copy src/data/context-packs.example.json.")], warnings };
  }
  if (!isRecord(raw)) {
    return { errors: [issue("(file)", "The context pack file must be a JSON object with a packs list. Copy src/data/context-packs.example.json.")], warnings };
  }
  const lists = raw["packs"] ?? raw["contextPacks"];
  if (!Array.isArray(lists)) {
    return { errors: [issue("packs", "This file needs a packs list. Copy src/data/context-packs.example.json and edit that.")], warnings };
  }
  if (!lists.length) {
    return { errors: [issue("packs", "This file has no packs. Add one pack with a slug id, or point at the file that has them.")], warnings };
  }
  const errors: PackIssue[] = [];
  const seen = new Map<string, number>();
  lists.forEach((pack, index) => {
    const id = checkPack(pack, index, recipeIds, errors, warnings);
    if (!id) return;
    if (seen.has(id)) errors.push(issue(`packs[${index}].id`, `Pack id "${id}" is already used. Each pack needs its own id.`, id));
    else seen.set(id, index);
  });
  const ids = [...seen.keys()];
  if (raw["active"] !== undefined) {
    if (typeof raw["active"] !== "string" || !SLUG.test(raw["active"].trim())) {
      errors.push(issue("active", "active must be a pack id slug, like checkout-summary. Set it to an id in this file, or remove it."));
    } else if (!ids.includes(raw["active"].trim())) {
      errors.push(issue("active", `active "${raw["active"].trim()}" does not match a pack id in this file. Set active to one of those ids, or remove it.`));
    }
  }
  for (const [key, child] of Object.entries(raw)) {
    if (key === "packs" || key === "contextPacks") continue;
    if (!KNOWN_TOP.has(normKey(key)) && !forbiddenKey(key)) {
      warnings.push(issue(key, `Unknown field "${key}". Resolve does not use it. Remove it, or fix the spelling.`));
    }
    if (forbiddenKey(key)) {
      errors.push(issue(key, `Figma ids are not allowed in a context pack. Remove ${key}. Recommend fills component ids after the library is learned.`));
    }
    walk(child, key, undefined, errors, warnings);
  }
  return { errors, warnings };
}

function present(errors: PackIssue[]): { shown: PackIssue[]; message: string } {
  if (errors.length <= 30) return { shown: errors, message: formatPackIssues(errors) };
  const shown = errors.slice(0, 30);
  const more = errors.length - 30;
  return { shown, message: `${formatPackIssues(shown)}\nand ${more} more` };
}

export function packValidation(raw: unknown, recipeIds: ReadonlySet<string>): PackValidation {
  const { errors, warnings } = collectPackIssues(raw, recipeIds);
  const packs = isRecord(raw) && Array.isArray(raw["packs"]) ? raw["packs"].length : isRecord(raw) && Array.isArray(raw["contextPacks"]) ? raw["contextPacks"].length : Array.isArray(raw) ? raw.length : 0;
  const warningText = warnings.length ? formatPackIssues(warnings) : "";
  if (!errors.length) {
    const noun = packs === 1 ? "pack" : "packs";
    const base = `Context pack is ok. ${packs} ${noun} checked.`;
    return { ok: true, packs, message: warningText ? `${base}\n${warningText}` : base, exitCode: 0, errors: [], warnings };
  }
  const capped = present(errors);
  return {
    ok: false,
    packs,
    message: warningText ? `${capped.message}\n${warningText}` : capped.message,
    exitCode: 1,
    errors: capped.shown,
    warnings,
  };
}

/** Throw the plain-English problems. Use before writing a pack. Loading does not throw. */
export function assertContextPackDocument(raw: unknown, recipeIds: ReadonlySet<string>): void {
  const errors = validateContextPackDocument(raw, recipeIds);
  if (errors.length) throw new Error(formatPackIssues(errors.slice(0, 30)));
}

const DROP = Symbol("drop");

function markSkip(flag: { skipped: boolean }): void {
  flag.skipped = true;
}

function cleanValue(value: unknown, flag: { skipped: boolean }): unknown {
  if (typeof value === "string") {
    if (stringProblem(value, "field")) {
      markSkip(flag);
      return DROP;
    }
    return value;
  }
  if (Array.isArray(value)) {
    const next: unknown[] = [];
    for (const item of value) {
      const cleaned = cleanValue(item, flag);
      if (cleaned === DROP) continue;
      next.push(cleaned);
    }
    return next;
  }
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKey(key)) {
      markSkip(flag);
      continue;
    }
    const cleaned = cleanValue(child, flag);
    if (cleaned === DROP) continue;
    out[key] = cleaned;
  }
  return out;
}

function softenPack(item: unknown, recipeIds: ReadonlySet<string> | undefined, flag: { skipped: boolean }): unknown {
  if (!isRecord(item)) {
    markSkip(flag);
    return DROP;
  }
  const id = typeof item["id"] === "string" ? item["id"].trim() : "";
  if (!SLUG.test(id)) {
    markSkip(flag);
    return DROP;
  }
  const cleaned = cleanValue(item, flag);
  if (!isRecord(cleaned)) return DROP;
  const recipeKey = cleaned["recipeIds"] !== undefined ? "recipeIds" : cleaned["recipes"] !== undefined ? "recipes" : undefined;
  if (recipeKey && recipeIds && Array.isArray(cleaned[recipeKey])) {
    const before = cleaned[recipeKey].length;
    const kept = cleaned[recipeKey].filter((entry): entry is string => typeof entry === "string" && recipeIds.has(entry));
    if (kept.length !== before) markSkip(flag);
    if (kept.length) cleaned[recipeKey] = kept;
    else delete cleaned[recipeKey];
  }
  const constraints = cleaned["constraints"];
  if (isRecord(constraints) && typeof constraints["a11y"] === "string") {
    const next = normaliseA11y(constraints["a11y"]);
    if (A11Y_LEVELS.includes(next as A11yLevel)) constraints["a11y"] = next;
    else {
      delete constraints["a11y"];
      markSkip(flag);
    }
    if (!Object.keys(constraints).length) delete cleaned["constraints"];
  }
  return cleaned;
}

/**
 * Drop a bad pack or a bad field so commands can keep running.
 * `resolve pack validate` does not use this. `skipped` is true when anything was left out.
 */
export function softenContextPackFile(raw: unknown, recipeIds: ReadonlySet<string> | undefined): { raw: unknown; skipped: boolean } {
  const flag = { skipped: false };
  if (Array.isArray(raw)) {
    const packs = raw.flatMap((item) => {
      const one = softenPack(item, recipeIds, flag);
      return one === DROP ? [] : [one];
    });
    return { raw: packs, skipped: flag.skipped };
  }
  if (!isRecord(raw)) return { raw: { packs: [] }, skipped: true };
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "packs" || key === "contextPacks") continue;
    if (forbiddenKey(key)) {
      markSkip(flag);
      continue;
    }
    const cleaned = cleanValue(value, flag);
    if (cleaned === DROP) continue;
    copy[key] = cleaned;
  }
  const listKey = Array.isArray(raw["packs"]) ? "packs" : Array.isArray(raw["contextPacks"]) ? "contextPacks" : undefined;
  if (listKey) {
    const source = raw[listKey] as unknown[];
    copy[listKey] = source.flatMap((item) => {
      const one = softenPack(item, recipeIds, flag);
      return one === DROP ? [] : [one];
    });
  }
  return { raw: copy, skipped: flag.skipped };
}
