import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { visualSignal } from "@/core/query/visualMatch";
import { dsIdOf, parseDsId } from "@/core/rules/dsId";
import { nameWords, RELATED, tokens } from "@/server/code/words";

/**
 * Ranked draft for a Figma component and a coded component that do not share a name or an ID.
 * Props 30, visual 20, parts 15, tokens 15, mapping.json alias 15, recipe 10, name 10.
 * Visual match reads a PNG from `.resolve/figma-images` and stays 0 when that PNG or a browser is missing.
 * A shared ID is 100 and skips the rest. The number never links a pair.
 */

export const DRAFT_MAX = { props: 30, visual: 20, parts: 15, tokens: 15, alias: 15, recipe: 10, name: 10 } as const;

/** Below this, a draft is noise. Matches the old name cutoff, so one shared house word stays off the list. */
const MIN_DRAFT = 4;

export interface DraftCodeInput {
  name: string;
  variants: string[];
  modifiers: string[];
  elements: string[];
  tokens: string[];
  aliases: string[];
  dsId?: string;
  /** Repo-relative files: HTML, CSS, component.json. */
  files: string[];
}

export interface DraftFigmaInput {
  name: string;
  variants?: string[];
  properties?: Record<string, string[]>;
  description?: string;
  /** Names on the component itself, not mapping.json. */
  names?: string[];
  /** Part and slot names. */
  parts?: string[];
  /** Aliases from `.resolve/mapping.json` only. */
  aliases?: string[];
  dsId?: string;
  /** Figma node id, used to find `.resolve/figma-images/<id>.png`. */
  nodeId?: string;
}

export interface RankedDraft {
  code: string;
  score: number;
  reasons: string[];
}

interface FileRef { file: string; abs: string }
interface Side {
  name: string;
  names: string[];
  props: string[];
  parts: string[];
  tokens: string[];
  recipes: string[];
  aliases: string[];
  dsId?: string;
  nodeId?: string;
  files: FileRef[];
}

const SLOT_KEY = /^(slot|part)$/i;
const SLOT_VARIANT = /^(slot|part)=/i;

/** Score every coded component against one Figma component. Highest first. A score is not a link. */
export function scoreUnmatched(input: {
  figma: DraftFigmaInput;
  codes: DraftCodeInput[];
  repo?: string;
  aliasFile?: string;
  skip?: ReadonlySet<string>;
  namespaces?: ReadonlySet<string>;
  limit?: number;
}): RankedDraft[] {
  const skip = input.skip ?? new Set<string>();
  const namespaces = input.namespaces;
  const repo = input.repo ?? "";
  const alias = input.aliasFile && existsSync(input.aliasFile) ? { file: basename(input.aliasFile), abs: input.aliasFile } : undefined;
  const figma = figmaSide(input.figma, skip);
  const codes = input.codes.map((code) => codeSide(code, repo, skip));
  const drop = commonLabels(codes);
  const cache = new Map<string, string[]>();
  const ranked = codes.flatMap((code) => {
    const scored = scorePair(figma, code, drop, alias, cache, skip, namespaces, repo, input.aliasFile ? dirname(input.aliasFile) : "");
    return scored.score >= MIN_DRAFT ? [{ code: code.name, score: scored.score, reasons: scored.lines }] : [];
  });
  ranked.sort((a, b) => b.score - a.score || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return ranked.slice(0, Math.max(1, input.limit ?? ranked.length));
}

export function formatPackageDraft(
  pair: { name: string; component: string; id: string },
  inventory: { components: Array<{ component: string; file: string; inputs: Array<{ name: string; alias?: string }> }> },
  index: { allNodes: Array<{ id: string; figmaNodeId?: string; name: string; description?: string; propertyDefinitions?: Array<{ name: string; options?: string[] }> }>; getNestedInstances(id: string): Array<{ name: string }> },
  packageRoot: string,
): string {
  const node = index.allNodes.find((item) => (item.figmaNodeId ?? item.id) === pair.id);
  const code = inventory.components.find((item) => item.component === pair.component);
  const file = code && existsSync(join(packageRoot, code.file)) ? code.file : "";
  const scored = scorePair(
    figmaSide({
      name: pair.name,
      description: node?.description,
      variants: (node?.propertyDefinitions ?? []).flatMap((prop) => [prop.name, ...(prop.options ?? [])]),
      parts: node ? index.getNestedInstances(node.id).map((item) => item.name) : [],
      dsId: dsIdOf(node?.description, pair.name)?.id,
      nodeId: node?.figmaNodeId ?? pair.id,
    }, new Set()),
    codeSide({
      name: pair.component,
      variants: (code?.inputs ?? []).flatMap((input) => [input.name, ...(input.alias ? [input.alias] : [])]),
      modifiers: [],
      elements: [],
      tokens: [],
      aliases: [],
      files: file ? [file] : [],
    }, packageRoot, new Set()),
    emptyDrop(),
    undefined,
    new Map(),
    new Set(),
    undefined,
    packageRoot,
  );
  return scored.lines.join("\n");
}

/** Saved review rows have names, not source files. File:line comes from `code-map suggest`. */
export function formatReviewDrafts(entries: unknown[]): string {
  const rows = entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    const status = typeof row["status"] === "string" ? row["status"] : "";
    if (status !== "suggested" && status !== "partial") return [];
    const code = row["code"] && typeof row["code"] === "object" && !Array.isArray(row["code"]) ? (row["code"] as Record<string, unknown>) : {};
    const figma = typeof row["name"] === "string" ? row["name"] : "";
    const component = typeof code["component"] === "string" ? code["component"] : "";
    if (!figma || !component) return [];
    const inputs = Array.isArray(code["inputs"]) ? code["inputs"].filter((item): item is string => typeof item === "string") : [];
    const scored = scorePair(
      figmaSide({ name: figma }, new Set()),
      codeSide({ name: component, variants: inputs, modifiers: [], elements: [], tokens: [], aliases: [], files: [] }, "", new Set()),
      emptyDrop(),
      undefined,
      new Map(),
    );
    return [`${figma} -> ${component}  ${scored.lines.join("\n  ")}`];
  });
  if (!rows.length) return "";
  return `Draft scores (not links):\n${rows.join("\n")}\nnext: a score never confirms a row. Set status to mapped only for a pair you accept. file:line evidence is printed by code-map suggest.`;
}

/** On confirm, offer the shared ID. `--write-id` writes the code side. Figma is a line to paste. Never throws. */
export function confirmSharedId(input: {
  repo?: string;
  write: boolean;
  pairs: Array<{ figma: string; code: string }>;
  components: Array<{ name: string; dsId?: string; files: string[] }>;
  masters: Array<{ name: string; description?: string }>;
}): string[] {
  const lines: string[] = [];
  for (const pair of input.pairs) {
    const master = input.masters.find((item) => item.name === pair.figma);
    const code = input.components.find((item) => item.name === pair.code);
    const figmaId = dsIdOf(master?.description, pair.figma)?.id;
    const codeId = parseDsId(code?.dsId)?.id;
    if (figmaId && codeId && figmaId !== codeId) {
      lines.push(`${pair.figma} has ${figmaId} and ${pair.code} has ${codeId}. next: put the same ID on both sides. Nothing was written.`);
      continue;
    }
    const id = figmaId ?? codeId ?? mintedId(pair.figma);
    const paste = `Paste into the Figma description for ${pair.figma}: ${id}`;
    const figmaNext = "next: paste that line into the Figma component description. Resolve does not edit Figma.";
    if (!input.write) {
      lines.push(`${pair.figma} = ${pair.code} shared ID ${id} is not written yet.`, `next: run code-map --confirm "${pair.figma}=${pair.code}" --write-id to add data-ds-id and component.json dsId.`, paste, figmaNext);
      continue;
    }
    if (!input.repo) {
      lines.push(`No repo path, so ${id} was not written. next: pass --repo and run code-map --confirm "${pair.figma}=${pair.code}" --write-id again.`, paste, figmaNext);
      continue;
    }
    lines.push(...writeCodeId(input.repo, pair, id, code?.files ?? []), paste, figmaNext);
  }
  return lines;
}

function writeCodeId(repo: string, pair: { figma: string; code: string }, id: string, files: string[]): string[] {
  const root = resolve(repo);
  const html = files.filter((file) => /\.html?$/i.test(file));
  const lines: string[] = [];
  if (!html.length) lines.push(`${pair.code} has no HTML file, so data-ds-id was not written. next: add data-ds-id="${id}" on the root element.`);
  for (const rel of html) {
    const abs = join(root, rel);
    if (!inside(root, abs) || !existsSync(abs)) {
      lines.push(`${rel} could not be read, so data-ds-id was not written. next: add data-ds-id="${id}" on the root element.`);
      continue;
    }
    const edited = insertId(readFileSync(abs, "utf8"), id);
    if (edited.warning) lines.push(edited.warning);
    else if (edited.changed) {
      writeFileSync(abs, edited.text);
      lines.push(`Wrote data-ds-id="${id}" on ${rel}.`);
    } else lines.push(`${rel} already has data-ds-id="${id}".`);
  }
  const jsonRel = files.find((file) => file.endsWith("/component.json") || file === "component.json") ?? join(dirname(html[0] ?? files[0] ?? pair.code), "component.json").split(sep).join("/");
  const jsonAbs = join(root, jsonRel);
  if (!inside(root, jsonAbs)) {
    lines.push(`${jsonRel} is outside the repo, so dsId was not written. next: put dsId "${id}" in component.json yourself.`);
    return lines;
  }
  const wrote = writeDsId(jsonAbs, jsonRel, pair.code, id);
  lines.push(wrote);
  return lines;
}

function insertId(html: string, id: string): { text: string; warning?: string; changed: boolean } {
  if (/data-ds-id\s*=/.test(html)) {
    const have = parseDsId(html)?.id;
    if (have === id) return { text: html, changed: false };
    return { text: html, changed: false, warning: `data-ds-id is already ${have ?? "unreadable"}. next: set it to ${id} on the root element. Nothing was overwritten.` };
  }
  const wrap = new Set(["html", "head", "body", "link", "meta", "script", "style", "title", "base"]);
  let done = false;
  const text = html.replace(/<([a-zA-Z][\w:-]*)([^>]*)>/g, (full, tag: string, rest: string) => {
    if (done || wrap.has(tag.toLowerCase())) return full;
    done = true;
    return `<${tag} data-ds-id="${id}"${rest}>`;
  });
  if (!done) return { text: html, changed: false, warning: `No root element found, so data-ds-id was not written. next: add data-ds-id="${id}" on the root element.` };
  return { text, changed: true };
}

function writeDsId(abs: string, rel: string, code: string, id: string): string {
  try {
    if (!existsSync(abs)) {
      writeFileSync(abs, `${JSON.stringify({ id: code, dsId: id }, null, 2)}\n`);
      return `Wrote dsId "${id}" in ${rel}.`;
    }
    const parsed: unknown = JSON.parse(readFileSync(abs, "utf8").replace(/^\uFEFF/, ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return `${rel} is not an object, so dsId was not written. next: make component.json an object with dsId "${id}".`;
    const row = parsed as Record<string, unknown>;
    const have = typeof row["dsId"] === "string" ? parseDsId(row["dsId"])?.id : undefined;
    if (have && have !== id) return `${rel} dsId is ${have}. next: use one ID, ${id}. Nothing was overwritten.`;
    row["dsId"] = id;
    writeFileSync(abs, `${JSON.stringify(row, null, 2)}\n`);
    return have === id ? `${rel} already has dsId "${id}".` : `Wrote dsId "${id}" in ${rel}.`;
  } catch {
    return `${rel} could not be updated, so dsId was not written. next: set dsId to "${id}" in component.json.`;
  }
}

function mintedId(name: string): string {
  const leaf = name.split("/").pop() ?? name;
  const slug = leaf.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const safe = /^[a-z][a-z0-9-]*[a-z0-9]$/.test(slug) ? slug : "component";
  return `ds@1.0.0.core.${safe}`;
}

function inside(root: string, abs: string): boolean {
  const target = resolve(abs);
  return target === root || target.startsWith(`${root}${sep}`);
}

function figmaSide(figma: DraftFigmaInput, skip: ReadonlySet<string>): Side {
  const description = figma.description ?? "";
  const props: string[] = [];
  const parts: string[] = [];
  for (const [key, values] of Object.entries(figma.properties ?? {})) {
    if (SLOT_KEY.test(key)) parts.push(...values);
    else props.push(key, ...values);
  }
  for (const variant of figma.variants ?? []) (SLOT_VARIANT.test(variant) ? parts : props).push(variant);
  parts.push(...(figma.parts ?? []), ...[...description.matchAll(/\b(?:part|slot)s?\s*[:=]\s*([a-z0-9-]+)/gi)].map((match) => match[1] ?? ""));
  return {
    name: figma.name,
    names: figma.names?.length ? figma.names : [figma.name],
    props: wordList(props, skip),
    parts: wordList(parts, skip),
    tokens: tokenKeys([...description.matchAll(/--[\w-]+/g)].map((match) => match[0] ?? "")),
    recipes: recipeKeys(description),
    aliases: figma.aliases ?? [],
    dsId: figma.dsId ?? dsIdOf(description, figma.name)?.id,
    nodeId: figma.nodeId,
    files: [],
  };
}

function codeSide(code: DraftCodeInput, repo: string, skip: ReadonlySet<string>): Side {
  const files = fileRefs(repo, code.files);
  const props = wordList([...code.variants.filter((variant) => !SLOT_VARIANT.test(variant)), ...code.modifiers.map((name) => name.split("--").pop() ?? name)], skip);
  const parts = wordList([...code.elements.map((name) => name.split("__").pop() ?? name), ...code.variants.filter((variant) => SLOT_VARIANT.test(variant)).map((variant) => variant.split("=")[1] ?? "")], skip);
  const recipes = files.filter((file) => file.file.endsWith("component.json")).flatMap((file) => recipesFrom(file.abs));
  return { name: code.name, names: [code.name], props, parts, tokens: tokenKeys(code.tokens), recipes: [...new Set(recipes)], aliases: code.aliases, dsId: parseDsId(code.dsId)?.id, files };
}

function fileRefs(repo: string, files: string[]): FileRef[] {
  const listed = files.map((file) => ({ file: file.split(sep).join("/"), abs: repo ? join(repo, file) : file }));
  const extra = listed.flatMap((file) => {
    const rel = `${dirname(file.file).split(sep).join("/")}/component.json`.replace(/^\.\//, "");
    const abs = repo ? join(repo, rel) : "";
    return abs && existsSync(abs) && !listed.some((item) => item.file === rel) ? [{ file: rel, abs }] : [];
  });
  return [...listed, ...extra];
}

function recipesFrom(abs: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(abs, "utf8").replace(/^\uFEFF/, ""));
    const recipes = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { recipes?: unknown }).recipes : undefined;
    return Array.isArray(recipes) ? [...new Set(recipes.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim().toLowerCase()))] : [];
  } catch {
    return [];
  }
}

function recipeKeys(text: string): string[] {
  return [...new Set([...text.matchAll(/\brecipes?\s*[:=]\s*([a-z0-9-]+)/gi)].map((match) => (match[1] ?? "").toLowerCase()).filter(Boolean))];
}

function wordList(values: string[], skip: ReadonlySet<string>): string[] {
  return [...new Set(values.flatMap((value) => tokens(value.replace(/[=_]+/g, " "))).filter((word) => !skip.has(word)))];
}

function tokenKeys(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase().replace(/^--/, "")).filter((value) => value.length > 1))];
}

interface Drop { props: Set<string>; parts: Set<string>; tokens: Set<string>; recipes: Set<string> }

function emptyDrop(): Drop {
  return { props: new Set(), parts: new Set(), tokens: new Set(), recipes: new Set() };
}

function commonLabels(codes: Side[]): Drop {
  const frequent = (lists: string[][]) => {
    if (codes.length < 3) return new Set<string>();
    const count = new Map<string, number>();
    for (const list of lists) for (const item of new Set(list)) count.set(item, (count.get(item) ?? 0) + 1);
    return new Set([...count].filter(([, n]) => n > codes.length / 2).map(([item]) => item));
  };
  return { props: frequent(codes.map((code) => code.props)), parts: frequent(codes.map((code) => code.parts)), tokens: frequent(codes.map((code) => code.tokens)), recipes: frequent(codes.map((code) => code.recipes)) };
}

function scorePair(figma: Side, code: Side, drop: Drop, alias: FileRef | undefined, cache: Map<string, string[]>, skip: ReadonlySet<string> = new Set(), namespaces?: ReadonlySet<string>, repo = "", home = ""): { score: number; lines: string[] } {
  if (figma.dsId && code.dsId && figma.dsId === code.dsId) return { score: 100, lines: ["score 100/100", "shared ID 100/100 (other signals not measured)"] };
  const props = overlap(figma.props, code.props, DRAFT_MAX.props, drop.props);
  const parts = overlap(figma.parts, code.parts, DRAFT_MAX.parts, drop.parts);
  const token = overlap(figma.tokens, code.tokens, DRAFT_MAX.tokens, drop.tokens);
  const recipe = overlap(figma.recipes, code.recipes, DRAFT_MAX.recipe, drop.recipes);
  const aliasHit = aliasMatch(figma, code);
  const aliasPoints = aliasHit.length ? DRAFT_MAX.alias : 0;
  const like = bestName(figma.names, code.names, skip, namespaces);
  const namePoints = Math.round(DRAFT_MAX.name * like.score);
  const visual = visualSignal({ repo, home, figmaName: figma.name, nodeId: figma.nodeId, dsId: figma.dsId, codeName: code.name, files: code.files });
  const score = Math.min(100, props.points + visual.points + parts.points + token.points + aliasPoints + recipe.points + namePoints);
  const cite = (labels: string[], extra?: FileRef) => evidence(extra ? [extra, ...code.files] : code.files, labels, cache);
  return {
    score,
    lines: [
      `score ${score}/100`,
      signal("props", DRAFT_MAX.props, props.points, cite(props.shared)),
      visual.text,
      signal("parts", DRAFT_MAX.parts, parts.points, cite(parts.shared)),
      signal("tokens", DRAFT_MAX.tokens, token.points, cite(token.shared)),
      signal("alias", DRAFT_MAX.alias, aliasPoints, aliasPoints ? evidence(alias ? [alias] : code.files, aliasHit, cache) : ""),
      signal("recipe", DRAFT_MAX.recipe, recipe.points, cite(recipe.shared)),
      signal("name", DRAFT_MAX.name, namePoints, [cite([code.name]), like.reasons.join(", ")].filter(Boolean).join(" ")),
    ],
  };
}

function signal(name: string, max: number, points: number, evidence: string): string {
  return `${name} ${points}/${max}${evidence ? ` ${evidence}` : ""}`;
}

function overlap(figma: string[], code: string[], max: number, drop: Set<string>): { points: number; shared: string[] } {
  const left = new Set(figma.filter((item) => !drop.has(item)));
  const right = new Set(code.filter((item) => !drop.has(item)));
  if (!left.size || !right.size) return { points: 0, shared: [] };
  const shared = [...left].filter((item) => right.has(item)).sort();
  if (!shared.length) return { points: 0, shared: [] };
  return { points: Math.round((max * shared.length) / Math.min(left.size, right.size)), shared };
}

function aliasMatch(figma: Side, code: Side): string[] {
  const hit = figma.aliases.filter((alias) => sameFold(alias, code.name));
  const back = code.aliases.filter((alias) => sameFold(alias, figma.name));
  return [...new Set([...hit, ...back])];
}

function sameFold(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase() || tokens(nameWords(a)).join("") === tokens(nameWords(b)).join("");
}

function bestName(figmaNames: string[], codeNames: string[], skip: ReadonlySet<string>, namespaces?: ReadonlySet<string>): { score: number; reasons: string[] } {
  const words = (name: string) => tokens(nameWords(name, namespaces)).filter((word) => !skip.has(word));
  let best = { score: 0, reasons: [] as string[] };
  for (const figma of figmaNames) for (const code of codeNames) {
    const like = nameLike(words(figma), words(code));
    if (like.score > best.score) best = like;
  }
  return best;
}

function nameLike(a: string[], b: string[]): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let sum = 0;
  const right = new Set(b);
  for (const word of new Set(a)) {
    if (right.has(word)) sum += 1;
    else {
      const best = (RELATED.get(word) ?? []).filter(([other]) => right.has(other)).sort((left, next) => next[1] - left[1])[0];
      if (best) {
        sum += best[1];
        reasons.push(`${word}~${best[0]}`);
      }
    }
  }
  const width = Math.max(new Set(a).size, new Set(b).size);
  return { score: a.length && b.length ? sum / width : 0, reasons };
}

function evidence(files: FileRef[], labels: string[], cache: Map<string, string[]>): string {
  const hits: string[] = [];
  for (const file of files) {
    const lines = loadLines(file.abs, cache);
    for (const label of labels) {
      const needle = label.toLowerCase();
      const at = lines.findIndex((line) => line.toLowerCase().includes(needle));
      if (at >= 0) hits.push(`${file.file}:${at + 1}`);
    }
  }
  const where = [...new Set(hits)].slice(0, 3).join(", ");
  const detail = labels.slice(0, 4).join(", ");
  return [where, detail].filter(Boolean).join(" ");
}

function loadLines(abs: string, cache: Map<string, string[]>): string[] {
  const hit = cache.get(abs);
  if (hit) return hit;
  let lines: string[] = [];
  try {
    if (existsSync(abs)) lines = readFileSync(abs, "utf8").split(/\n/);
  } catch {
    lines = [];
  }
  cache.set(abs, lines);
  return lines;
}
