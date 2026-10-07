/**
 * Strict context-pack check. Ranking still uses the lenient parser.
 * Call this before a pack is written, and when Resolve loads one.
 */

export const A11Y_LEVELS = ["wcag-a", "wcag-aa", "wcag-aaa"] as const;

export type A11yLevel = (typeof A11Y_LEVELS)[number];

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FILE_KEY = /^[A-Za-z0-9]{22,128}$/;
const NODE_ID = /^\d{1,12}:\d{1,12}$/;
const NODE_IN_TEXT = /\b\d{1,12}:\d{1,12}\b/;
const FORBIDDEN_KEYS = new Set(["filekey", "figmanodeid", "nodeid", "node-id", "componentkey", "figmaurl"]);

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
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function issue(field: string, message: string, pack?: string): PackIssue {
  return pack ? { field, message, pack } : { field, message };
}

export function formatPackIssues(errors: PackIssue[]): string {
  return errors.map((item) => `${item.field}: ${item.message}`).join("\n");
}

function stringProblem(value: string, field: string, pack?: string): PackIssue | undefined {
  if (/figma\.com/i.test(value) || /node-id=\d+-\d+/i.test(value)) {
    return issue(field, "This contains a Figma link or node id. Remove it. A context pack does not store Figma files or component ids. Recommend fills those after the library is learned.", pack);
  }
  if (NODE_ID.test(value) || NODE_IN_TEXT.test(value)) {
    return issue(field, "This contains a Figma node id. Remove it. Recommend fills component ids after the library is learned.", pack);
  }
  if (FILE_KEY.test(value)) {
    return issue(field, "This looks like a Figma file key. Remove it. Name the workspace label (the name in workspace.json), not the Figma file key.", pack);
  }
  return undefined;
}

function walk(value: unknown, field: string, pack: string | undefined, errors: PackIssue[]): void {
  if (typeof value === "string") {
    const found = stringProblem(value, field, pack);
    if (found) errors.push(found);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${field}[${index}]`, pack, errors));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const next = field ? `${field}.${key}` : key;
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      errors.push(issue(next, `Figma ids are not allowed in a context pack. Remove ${key}. Recommend fills component ids after the library is learned.`, pack));
      continue;
    }
    walk(child, next, pack, errors);
  }
}

function checkPack(raw: unknown, index: number, recipeIds: ReadonlySet<string>, errors: PackIssue[]): string | undefined {
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
    if (typeof a11y !== "string" || !A11Y_LEVELS.includes(a11y as A11yLevel)) {
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
  walk(raw, field, pack, errors);
  return pack;
}

/** Plain-English problems for one context-pack document. `recipeIds` is the catalog (starter recipes plus the team overlay). */
export function validateContextPackDocument(raw: unknown, recipeIds: ReadonlySet<string>): PackIssue[] {
  if (!isRecord(raw)) {
    return [issue("(file)", "The context pack file must be a JSON object with a packs list. Copy src/data/context-packs.example.json.")];
  }
  const lists = raw["packs"] ?? raw["contextPacks"];
  if (!Array.isArray(lists)) {
    return [issue("packs", "This file needs a packs list. Copy src/data/context-packs.example.json and edit that.")];
  }
  if (!lists.length) {
    return [issue("packs", "This file has no packs. Add one pack with a slug id, or point at the file that has them.")];
  }
  const errors: PackIssue[] = [];
  const ids: string[] = [];
  lists.forEach((pack, index) => {
    const id = checkPack(pack, index, recipeIds, errors);
    if (id) ids.push(id);
  });
  const seen = new Set<string>();
  ids.forEach((id, index) => {
    if (seen.has(id)) errors.push(issue(`packs[${index}].id`, `Pack id "${id}" is already used. Each pack needs its own id.`, id));
    seen.add(id);
  });
  if (raw["active"] !== undefined) {
    if (typeof raw["active"] !== "string" || !SLUG.test(raw["active"].trim())) {
      errors.push(issue("active", "active must be a pack id slug, like checkout-summary. Set it to an id in this file, or remove it."));
    } else if (!ids.includes(raw["active"].trim())) {
      errors.push(issue("active", `active "${raw["active"].trim()}" does not match a pack id in this file. Set active to one of those ids, or remove it.`));
    }
  }
  walk(
    Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "packs" && key !== "contextPacks")),
    "",
    undefined,
    errors,
  );
  return errors.slice(0, 30);
}

export function packValidation(raw: unknown, recipeIds: ReadonlySet<string>): PackValidation {
  const errors = validateContextPackDocument(raw, recipeIds);
  const packs = isRecord(raw) && Array.isArray(raw["packs"]) ? raw["packs"].length : isRecord(raw) && Array.isArray(raw["contextPacks"]) ? raw["contextPacks"].length : 0;
  if (!errors.length) {
    const noun = packs === 1 ? "pack" : "packs";
    return { ok: true, packs, message: `Context pack is ok. ${packs} ${noun} checked.`, exitCode: 0, errors: [] };
  }
  return {
    ok: false,
    packs,
    message: formatPackIssues(errors),
    exitCode: 1,
    errors,
  };
}

/** Throw the plain-English problems. Use before writing a pack and when Resolve loads one. */
export function assertContextPackDocument(raw: unknown, recipeIds: ReadonlySet<string>): void {
  const errors = validateContextPackDocument(raw, recipeIds);
  if (errors.length) throw new Error(formatPackIssues(errors));
}
