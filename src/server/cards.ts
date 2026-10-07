import {
  formatHandoffRefusal,
  formatHandoffScreen,
  formatIngredientCard,
  type HandoffPack,
  type IngredientCard,
} from "@/core/query";

/**
 * What an MCP tool shows the model.
 * Markdown is the default. `json` is the same card as compact JSON.
 * Both drop filler: the cost block, duplicate `node:` ids, rank score,
 * the repeated graph.json hint, learn's save-state dump, and a handoff
 * parts list that is already on each component.
 */
export type ToolCardFormat = "markdown" | "json";

const GRAPH_HINT = / ?Do not Read (?:`\.resolve\/graph\.json`|graph\.json)\.?/g;

export function cardTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stripHintSentence(text: string): string {
  return text.replace(GRAPH_HINT, "").replace(/[ \t]{2,}/g, " ").trim();
}

function isCostBlock(value: unknown): boolean {
  return isRecord(value) && typeof value["chars"] === "number" && typeof value["approxTokens"] === "number";
}

function isLearnCheckpoint(value: unknown): boolean {
  return isRecord(value) && (Array.isArray(value["completedHashes"]) || isRecord(value["mastersByUnit"]));
}

/** Graph id `node:…` sitting beside a Figma id on the same object. */
function isDuplicateGraphId(key: string, value: unknown, record: Record<string, unknown>): boolean {
  if (key !== "id" || typeof value !== "string" || !value.startsWith("node:")) return false;
  return typeof record["figmaNodeId"] === "string" || typeof record["nodeId"] === "string";
}

/**
 * Today's tool JSON with the filler removed. Key order of what remains is unchanged.
 * Exported so tests can show `format: "json"` is this object and nothing else.
 */
export function stripFiller(value: unknown): unknown {
  if (typeof value === "string") {
    const next = stripHintSentence(value);
    return next === value ? value : next;
  }
  if (Array.isArray(value)) return value.map((item) => stripFiller(item));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  const dropPackIngredients = Array.isArray(value["screens"]) && Array.isArray(value["ingredients"]);
  const dropScreenIngredients = Array.isArray(value["components"]) && Array.isArray(value["ingredients"]);
  for (const [key, raw] of Object.entries(value)) {
    if (key === "cost" && isCostBlock(raw)) continue;
    if (key === "score" && typeof raw === "number") continue;
    if (key === "checkpoint" && isLearnCheckpoint(raw)) continue;
    if ((dropPackIngredients || dropScreenIngredients) && key === "ingredients") continue;
    if (isDuplicateGraphId(key, raw, value)) continue;
    const next = stripFiller(raw);
    if (key === "hint" && typeof next === "string" && !next) continue;
    out[key] = next;
  }
  return out;
}

function isHandoff(value: unknown): value is HandoffPack {
  if (!isRecord(value)) return false;
  return typeof value["ok"] === "boolean" && typeof value["handoff"] === "number";
}

function isIngredient(value: unknown): value is IngredientCard {
  if (!isRecord(value) || value["found"] !== true) return false;
  return isRecord(value["component"]) && Array.isArray(value["parts"]) && typeof value["note"] === "string";
}

function isCodeMapCheck(value: unknown): value is { status: string; message: string; exitCode: number; query?: string; use?: string } {
  if (!isRecord(value)) return false;
  return typeof value["status"] === "string" && typeof value["message"] === "string" && typeof value["exitCode"] === "number" && typeof value["query"] === "string";
}

/** The flat ingredients table repeats the parts already listed on each component. */
function withoutSecondPartsList(markdown: string): string {
  return markdown.replace(/\n## Ingredients \([^)]*\)[\s\S]*?(?=\n## Verify\b)/, "\n");
}

const ID_KEYS = ["fileKey", "figmaNodeId", "componentKey", "ex", "exampleId"] as const;

function collectIds(value: unknown, out: Array<{ key: string; value: string }>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectIds(item, out);
    return;
  }
  if (!isRecord(value)) return;
  for (const key of ID_KEYS) {
    const raw = value[key];
    if (typeof raw === "string" && raw && raw !== "none") out.push({ key, value: raw });
  }
  for (const item of Object.values(value)) collectIds(item, out);
}

/** CLI sheets already print most ids. Any the sheet skips is added so the model still has it. */
function withRequiredIds(markdown: string, source: unknown): string {
  const ids: Array<{ key: string; value: string }> = [];
  collectIds(stripFiller(source), ids);
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const mark = `${id.key}=${id.value}`;
    if (seen.has(mark)) continue;
    seen.add(mark);
    if (!markdown.includes(id.value)) missing.push(`${id.key}: ${id.value}`);
  }
  if (!missing.length) return markdown;
  return `${markdown}\n\nIds:\n${missing.map((line) => `- ${line}`).join("\n")}`;
}

function handoffMarkdown(pack: HandoffPack): string {
  const body = !pack.ok
    ? formatHandoffRefusal(pack).replace(GRAPH_HINT, "").trim()
    : pack.screens.map((sheet) => withoutSecondPartsList(formatHandoffScreen(sheet, pack.draft)).trim()).join("\n\n---\n\n");
  return withRequiredIds(body, pack);
}

function codeMapMarkdown(row: { status: string; message: string; exitCode: number; query?: string; use?: string }): string {
  const lines = [`${row.status} (exit ${row.exitCode})`, row.message];
  if (row.use) lines.push(`use: ${row.use}`);
  if (row.query) lines.push(`query: ${row.query}`);
  return lines.join("\n");
}

function verifyHeadline(record: Record<string, unknown>): string | undefined {
  if (typeof record["pass"] !== "boolean") return undefined;
  if (record["result"] === "name-only") return "NAME-ONLY";
  if (record["result"] === "nothing checked") return "NOTHING CHECKED";
  return record["pass"] ? "PASS" : "FAIL";
}

function skipMarkdownValue(key: string, value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (value === false && key !== "ok" && key !== "found" && key !== "textChecked") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (isRecord(value) && Object.keys(value).length === 0) return true;
  return false;
}

function scalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function isScalar(value: unknown): boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isScalarArray(value: unknown): value is Array<string | number | boolean> {
  return Array.isArray(value) && value.every(isScalar);
}

function isShallow(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([key, item]) => skipMarkdownValue(key, item) || isScalar(item) || isScalarArray(item));
}

/** `nodeId` that repeats `figmaNodeId` is noise on the card. JSON keeps both. */
function dropEchoNodeId(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => dropEchoNodeId(item));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "nodeId" && typeof item === "string" && item === value["figmaNodeId"]) continue;
    out[key] = dropEchoNodeId(item);
  }
  return out;
}

/** Fold `audience` + `audienceFrom: document` into `audience: … (document)`. */
function foldSources(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const sources = new Map<string, string>();
  for (const [key, value] of Object.entries(record)) {
    if (key.endsWith("From") && typeof value === "string") sources.set(key.slice(0, -4), value);
  }
  for (const [key, value] of Object.entries(record)) {
    if (key.endsWith("From") && typeof value === "string" && key.slice(0, -4) in record) continue;
    if (typeof value === "string" && sources.has(key)) out[key] = `${value} (${sources.get(key)})`;
    else out[key] = value;
  }
  return out;
}

function inline(value: unknown): string | undefined {
  if (isScalar(value)) return scalar(value);
  if (isScalarArray(value)) return value.map((item) => scalar(item)).join(", ");
  if (!isShallow(value)) return undefined;
  const folded = foldSources(value);
  const parts = Object.entries(folded)
    .filter(([key, item]) => !skipMarkdownValue(key, item))
    .map(([key, item]) => `${key}: ${isScalarArray(item) ? item.map((part) => scalar(part)).join(", ") : scalar(item)}`);
  return parts.join(", ");
}

function oneLine(record: Record<string, unknown>): string {
  const folded = foldSources(record);
  return Object.entries(folded)
    .filter(([key, value]) => !skipMarkdownValue(key, value))
    .map(([key, value]) => {
      const text = inline(value);
      if (text === undefined) return `${key}: ${scalar(value)}`;
      if (isShallow(value)) return `${key}: (${text})`;
      return `${key}: ${text}`;
    })
    .join(" | ");
}

function fitsOneLine(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([key, item]) => skipMarkdownValue(key, item) || inline(item) !== undefined);
}

function render(value: unknown, indent: string): string[] {
  if (Array.isArray(value)) {
    if (isScalarArray(value)) return [`${indent}${value.map((item) => scalar(item)).join(", ")}`];
    const lines: string[] = [];
    for (const item of value) {
      if (fitsOneLine(item) || isShallow(item)) lines.push(`${indent}- ${oneLine(item)}`);
      else if (isRecord(item)) {
        const nested = render(item, `${indent}  `);
        if (nested.length) lines.push(`${indent}-`, ...nested);
      } else lines.push(`${indent}- ${scalar(item)}`);
    }
    return lines;
  }
  if (!isRecord(value)) return [`${indent}${scalar(value)}`];
  const folded = foldSources(value);
  if (indent && fitsOneLine(folded)) return [`${indent}${oneLine(folded)}`];
  const lines: string[] = [];
  for (const [key, item] of Object.entries(folded)) {
    if (skipMarkdownValue(key, item)) continue;
    const text = inline(item);
    if (text !== undefined) lines.push(`${indent}${key}: ${isShallow(item) ? `(${text})` : text}`);
    else if (Array.isArray(item) || isRecord(item)) {
      lines.push(`${indent}${key}:`);
      lines.push(...render(item, `${indent}  `));
    } else lines.push(`${indent}${key}: ${scalar(item)}`);
  }
  return lines;
}

function genericMarkdown(value: unknown): string {
  const stripped = stripFiller(value);
  if (!isRecord(stripped)) {
    const text = typeof stripped === "string" ? stripped : JSON.stringify(stripped);
    return text;
  }
  const headline = verifyHeadline(stripped);
  const bodySource = { ...(dropEchoNodeId(stripped) as Record<string, unknown>) };
  if (headline) {
    delete bodySource["pass"];
    delete bodySource["result"];
  }
  const body = render(bodySource, "");
  return [headline, ...body].filter((line) => line !== undefined && line !== "").join("\n");
}

export function markdownCard(result: unknown, tool?: string): string {
  if (tool === "get_handoff" || isHandoff(result)) return handoffMarkdown(result as HandoffPack);
  if (tool === "get_ingredients" || isIngredient(result)) {
    const text = formatIngredientCard(result as IngredientCard).replace(GRAPH_HINT, "").trim();
    return withRequiredIds(text, result);
  }
  if (isCodeMapCheck(result)) return codeMapMarkdown(result);
  return genericMarkdown(result);
}

export function presentToolResult(result: unknown, format: ToolCardFormat = "markdown", tool?: string): string {
  switch (format) {
    case "json":
      return JSON.stringify(stripFiller(result));
    case "markdown":
      return markdownCard(result, tool);
    default: {
      const unexpected: never = format;
      return unexpected;
    }
  }
}
