/**
 * Meaning SOCK: one component's job, from that component's own data.
 * The ask is scored against that text. A pick is quoted from it, then checked.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GraphNode } from "@/core/model";
import { isNameInferredMaster } from "@/core/rules/names";
import { isRetired } from "@/core/rules/retired";
import type { GraphIndex } from "../GraphIndex";
import { VARIANT_PROP_NAME } from "../masterNames";
import { allSynonymGroups, loadSynonymOverlay } from "../recommendContext";
import { DOC_ATTRIBUTION, docsForLibrary } from "./materialDocs";

export type MeaningTier = "sure" | "weak";

export interface SockComponent {
  id: string;
  name: string;
  aliases: string[];
  description: string;
  /** Verbatim doc excerpt, when this library has one. */
  job: string;
  source?: string;
  properties: string[];
  /** Lowercased property name → allowed values. */
  propOptions: Record<string, string[]>;
  retired: boolean;
  thin: string[];
}

export interface MeaningPack {
  library: string;
  vocab: string;
  builtAt: string;
  components: SockComponent[];
}

export interface MeaningCandidate {
  id: string;
  name: string;
  confidence: MeaningTier;
  /** A sentence copied from this component's own text. */
  reason: string;
  score: number;
}

export type PickTier = "place" | "ask" | "no-fit";

export interface PickRequest {
  library: string;
  ask: string;
  shortlist: string[];
  pick?: string;
  props?: Record<string, string>;
  reason?: string;
  tier: string;
}

export type PickCheck = "exists" | "retired" | "props" | "quote" | "alias-quote" | "tier" | "thin-cap";

export interface ThinEntry {
  id: string;
  missing: string[];
}

export interface PickResult {
  tier: PickTier;
  id?: string;
  name?: string;
  reason?: string;
  failed: PickCheck[];
  thin: ThinEntry[];
  stale?: string;
}

const STOP = new Set([
  "a", "an", "the", "and", "or", "of", "to", "for", "with", "in", "at", "by", "from", "into",
  "my", "your", "our", "their", "its", "his", "her", "this", "that", "these", "those", "it", "is",
  "are", "be", "as", "up", "out", "when", "while", "before", "after", "than", "then", "just", "not",
  "i", "me", "we", "you", "they", "them", "someone", "something", "somewhere", "people", "person",
  "let", "make", "show", "shows", "shown", "using", "used", "use", "do", "does", "did", "can",
  "where", "such", "through", "along", "between", "very", "here", "yet", "holding", "hold", "holds",
  "about", "also", "only", "other", "another", "own", "per", "via", "around", "near", "like",
]);

const BREAK = /\b(?:for|while|under|holding)\b/i;

function stem(word: string): string {
  let value = word.toLowerCase();
  if (value.length > 6 && (value.endsWith("ible") || value.endsWith("able"))) value = value.slice(0, -4);
  if (value.length > 5 && value.endsWith("ing")) {
    value = value.slice(0, -3);
    if (value.length > 3 && value.at(-1) === value.at(-2)) value = value.slice(0, -1);
  } else if (value.length > 4 && value.endsWith("ied")) value = `${value.slice(0, -3)}y`;
  else if (value.length > 4 && value.endsWith("ed")) value = value.slice(0, -2);
  else if (value.length > 4 && value.endsWith("es")) value = value.slice(0, -2);
  else if (value.length > 3 && value.endsWith("s") && !value.endsWith("ss")) value = value.slice(0, -1);
  return value;
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 1 && !STOP.has(word));
}

function stems(text: string): string[] {
  return words(text).map(stem).filter((word) => word.length > 1 && !STOP.has(word));
}

export function slugId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "part";
}

function quoteFor(component: SockComponent, askStems: readonly string[]): string {
  const wanted = new Set(askStems);
  const sentences = [component.job, component.description].flatMap((text) => text.split(/(?<=\.)\s+/)).map((line) => line.trim()).filter(Boolean);
  let best = "";
  let hits = -1;
  for (const sentence of sentences) {
    const got = new Set(stems(sentence));
    const count = [...wanted].filter((token) => got.has(token)).length;
    if (count > hits) {
      hits = count;
      best = sentence;
    }
  }
  return hits > 0 ? best : "";
}

function ownText(component: SockComponent): string {
  return [component.name, component.job, component.description, component.aliases.join(" "), component.properties.join(" ")].join(" ");
}

interface Scored {
  component: SockComponent;
  score: number;
  hits: number;
  reason: string;
}

function idfOf(df: Map<string, number>, total: number, token: string): number {
  return Math.log((total + 1) / ((df.get(token) ?? 0) + 0.5));
}

function excludedIds(ask: string, components: readonly SockComponent[]): Set<string> {
  const match = /\b(?:rather\s+than|instead\s+of|not)\s+(.+)$/i.exec(ask);
  const tail = match?.[1]?.toLowerCase().trim();
  if (!tail) return new Set();
  const tailStems = new Set(stems(tail));
  const banned = new Set<string>();
  for (const component of components) {
    const names = [component.name, ...component.aliases].map((name) => name.toLowerCase());
    const named = names.some((name) => name.length > 2 && tail.includes(name));
    const stemmed = stems(component.name).some((token) => token.length > 3 && tailStems.has(token));
    if (named || stemmed) banned.add(component.id);
  }
  return banned;
}

function askedText(ask: string): string {
  return ask.replace(/\b(?:rather\s+than|instead\s+of|not)\b[\s\S]*$/i, " ");
}

function leftClause(ask: string): string {
  const match = BREAK.exec(ask);
  return match?.index ? ask.slice(0, match.index) : ask;
}

function loneInflected(ask: string, components: readonly SockComponent[]): boolean {
  const raw = words(ask);
  if (raw.length !== 1) return false;
  const token = raw[0] ?? "";
  if (!/(?:ed|ing)$/.test(token)) return false;
  const exact = token.toLowerCase();
  return !components.some((component) => !component.retired && [component.name, ...component.aliases].some((name) => name.toLowerCase() === exact));
}

/** Shortlist components whose own text overlaps the ask. Empty means no fit. */
export function meaningCandidates(ask: string, pack: MeaningPack): MeaningCandidate[] {
  const live = pack.components.filter((component) => !component.retired);
  if (loneInflected(ask, live)) return [];
  const corpus = new Set<string>(stems(pack.vocab));
  const docs = new Map<string, string[]>();
  for (const component of live) {
    const tokens = stems(ownText(component));
    docs.set(component.id, tokens);
    for (const token of tokens) corpus.add(token);
  }
  const clause = leftClause(ask);
  const clauseStems = stems(clause);
  const head = clauseStems.at(-1);
  if (clause !== ask && head && !corpus.has(head)) return [];
  const askStems = stems(askedText(ask));
  if (!askStems.length) return [];
  const df = new Map<string, number>();
  for (const tokens of docs.values()) for (const token of new Set(tokens)) df.set(token, (df.get(token) ?? 0) + 1);
  const banned = excludedIds(ask, live);
  const scored: Scored[] = [];
  for (const component of live) {
    if (banned.has(component.id)) continue;
    const have = docs.get(component.id) ?? [];
    const haveSet = new Set(have);
    let score = 0;
    let hits = 0;
    for (const token of new Set(askStems)) {
      if (!haveSet.has(token)) continue;
      score += idfOf(df, live.length, token);
      hits += 1;
    }
    for (let index = 0; index < askStems.length - 1; index += 1) {
      const pair = `${askStems[index]} ${askStems[index + 1]}`;
      if (have.join(" ").includes(pair)) score += 0.65;
    }
    const nameStems = stems(component.name);
    if (nameStems.length > 0 && nameStems.every((token) => askStems.includes(token))) score += 1.4;
    const nameHit = [component.name, ...component.aliases].some((label) => {
      const parts = stems(label);
      return parts.length > 0 && parts.every((token) => askStems.includes(token));
    });
    const unknown = [...new Set(askStems)].filter((token) => !corpus.has(token)).length;
    const quoted = quoteFor(component, askStems);
    const quoteHits = quoted ? stems(quoted).filter((token) => new Set(askStems).has(token)) : [];
    const nameOnly = quoteHits.length > 0 && quoteHits.every((token) => stems(component.name).includes(token));
    // A bare name inside an unknown phrase ("chip shop") is not that component.
    const reason = quoted && !(nameOnly && unknown > 0) ? quoted : nameHit ? component.name : "";
    if (!reason) continue;
    if (!quoted && hits < 2 && !nameHit) continue;
    if (!quoted && unknown >= hits && !nameHit) continue;
    scored.push({ component, score, hits, reason });
  }
  scored.sort((a, b) => b.score - a.score || a.component.name.localeCompare(b.component.name));
  return scored.slice(0, 3).map((row, index) => {
    const next = scored[index + 1];
    const margin = !next || row.score >= next.score * 1.28;
    const confidence: MeaningTier = margin && (row.hits >= 2 || row.score >= 1.6) ? "sure" : "weak";
    return { id: row.component.id, name: row.component.name, confidence, reason: row.reason, score: Number(row.score.toFixed(3)) };
  });
}

export function thinComponents(pack: MeaningPack): Array<{ id: string; name: string; missing: string[] }> {
  return pack.components.filter((component) => component.thin.length > 0).map((component) => ({
    id: component.id,
    name: component.name,
    missing: component.thin,
  }));
}

const PICK_TIERS = ["place", "ask", "no-fit"] as const;

function isPickTier(value: string): value is PickTier {
  return (PICK_TIERS as readonly string[]).includes(value);
}

function normQuote(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function ownedFragments(component: SockComponent): string[] {
  const fragments = [component.name, component.description, component.job, ...component.properties];
  for (const [key, values] of Object.entries(component.propOptions)) fragments.push(key, ...values);
  return fragments;
}

function quoteCheck(component: SockComponent, reason: string | undefined): "quote" | "alias-quote" | undefined {
  const quote = normQuote(reason ?? "");
  if (!quote) return "quote";
  const owned = ownedFragments(component).map(normQuote).filter(Boolean);
  if (owned.some((part) => part.includes(quote))) return undefined;
  const alias = component.aliases.some((name) => {
    const text = normQuote(name);
    return text.length > 0 && (text === quote || text.includes(quote));
  });
  return alias ? "alias-quote" : "quote";
}

function propsFail(component: SockComponent, props: Record<string, string>): boolean {
  for (const [key, value] of Object.entries(props)) {
    const options = component.propOptions[key.toLowerCase()];
    if (!options || !options.some((option) => option.toLowerCase() === value.toLowerCase())) return true;
  }
  return false;
}

function thinEntries(pack: MeaningPack): ThinEntry[] {
  return pack.components.filter((component) => component.thin.length > 0).map((component) => ({ id: component.id, missing: component.thin }));
}

function pickResult(tier: PickTier, failed: PickCheck[], thin: ThinEntry[], stale: string | undefined, shown?: { id: string; name: string; reason?: string }): PickResult {
  return {
    tier,
    failed,
    thin,
    ...(stale ? { stale } : {}),
    ...(shown ? { id: shown.id, name: shown.name, ...(shown.reason ? { reason: shown.reason } : {}) } : {}),
  };
}

export function validateAiPick(pack: MeaningPack, req: PickRequest, libraryBuiltAt?: string): PickResult {
  const thin = thinEntries(pack);
  const stale = libraryBuiltAt === undefined ? undefined : staleWarning(libraryBuiltAt, pack.builtAt);
  const tier = isPickTier(req.tier) ? req.tier : undefined;
  if (!tier) return pickResult("no-fit", ["tier"], thin, stale);
  if (tier === "no-fit") return pickResult("no-fit", [], thin, stale);
  const id = req.pick?.trim() ?? "";
  const component = id ? pack.components.find((item) => item.id === id) : undefined;
  if (!component) return pickResult("no-fit", ["exists"], thin, stale);
  if (component.retired) return pickResult("no-fit", ["retired"], thin, stale);
  const failed: PickCheck[] = [];
  if (propsFail(component, req.props ?? {})) failed.push("props");
  const quote = quoteCheck(component, req.reason);
  if (quote) failed.push(quote);
  if (failed.length) return pickResult("no-fit", failed, thin, stale);
  const shown = { id: component.id, name: component.name, ...(req.reason ? { reason: req.reason } : {}) };
  if (component.thin.length > 0 && tier === "place") return pickResult("ask", ["thin-cap"], thin, stale, shown);
  return pickResult(tier, [], thin, stale, shown);
}

function proseLines(markdown: string): string[] {
  return markdown.split("\n").map((line) => line.trim()).filter((line) => {
    if (!line || line.startsWith("# ") || line.startsWith("Aliases") || line.startsWith("Properties:") || line.startsWith("Thin:")) return false;
    if (line.startsWith("© ") || line.startsWith("Source:") || /^https?:\/\//.test(line)) return false;
    if (line === "status: deprecated" || /^\[[^\]]+\]\(index\.md\)$/.test(line)) return false;
    return true;
  });
}

export function componentFromMarkdown(id: string, markdown: string): SockComponent {
  const title = markdown.split("\n").find((line) => line.startsWith("# ")) ?? "";
  const name = title.includes(" / ") ? title.slice(title.lastIndexOf(" / ") + 3).trim() : id;
  const aliasLine = markdown.split("\n").find((line) => line.startsWith("Aliases")) ?? "";
  const aliases = aliasLine.slice(aliasLine.indexOf(":") + 1).split(",").map((item) => item.trim()).filter(Boolean);
  const propLine = markdown.split("\n").find((line) => line.startsWith("Properties:")) ?? "";
  const propOptions: Record<string, string[]> = {};
  const properties: string[] = [];
  if (propLine) {
    const body = propLine.slice("Properties:".length).trim();
    properties.push(body);
    for (const part of body.split(";")) {
      const splitAt = part.indexOf(":");
      if (splitAt < 0) continue;
      const key = part.slice(0, splitAt).trim().toLowerCase();
      const values = part.slice(splitAt + 1).split(",").map((item) => item.trim()).filter(Boolean);
      if (key && values.length) propOptions[key] = values;
    }
  }
  const thinLine = markdown.split("\n").find((line) => line.startsWith("Thin:")) ?? "";
  const missing = /missing\s+(.+)$/.exec(thinLine)?.[1] ?? "";
  const thin = missing.split(",").map((item) => item.trim()).filter(Boolean);
  const prose = proseLines(markdown);
  return {
    id,
    name,
    aliases,
    description: prose.join(" "),
    job: prose[0] ?? "",
    properties,
    propOptions,
    retired: markdown.split("\n").some((line) => line.trim() === "status: deprecated"),
    thin,
  };
}

export function packFromFiles(library: string, builtAt: string, files: ReadonlyMap<string, string>): MeaningPack {
  const components = [...files.entries()].map(([id, markdown]) => componentFromMarkdown(id, markdown));
  components.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { library, vocab: "", builtAt, components };
}

export function contextPack(pack: MeaningPack, candidates: readonly MeaningCandidate[], files: ReadonlyMap<string, string>): string {
  const lines = [`# ${pack.library}`, pack.vocab].filter(Boolean);
  for (const candidate of candidates) {
    const file = files.get(candidate.id);
    if (file) lines.push(file);
  }
  return lines.join("\n\n");
}

/** Rough token count used by the pack budget. Four characters to a token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function staleWarning(libraryBuiltAt: string, sockBuiltAt: string): string | undefined {
  if (!libraryBuiltAt || !sockBuiltAt) return undefined;
  if (libraryBuiltAt > sockBuiltAt) return `Meaning files are older than the library (${sockBuiltAt} < ${libraryBuiltAt}). Rebuild them.`;
  return undefined;
}

function propertiesOf(index: GraphIndex, node: GraphNode): { lines: string[]; options: Record<string, string[]> } {
  const options = new Map<string, Set<string>>();
  const add = (name: string, value: string): void => {
    const key = name.trim();
    const cleaned = value.trim();
    if (!key || !cleaned || cleaned.length > 40) return;
    const bucket = options.get(key) ?? new Set<string>();
    bucket.add(cleaned);
    options.set(key, bucket);
  };
  const family = node.type === "COMPONENT_SET" ? [node, ...index.getChildren(node.id)] : [node];
  for (const item of family) {
    for (const [key, value] of Object.entries(item.variantProperties ?? {})) if (value) add(key, value);
    for (const def of item.propertyDefinitions ?? []) {
      for (const option of def.options ?? []) add(def.name, option);
      if (def.defaultValue && def.type !== "INSTANCE_SWAP") add(def.name, def.defaultValue);
    }
  }
  const lines: string[] = [];
  const propOptions: Record<string, string[]> = {};
  for (const [key, values] of options) {
    const list = [...values].sort();
    propOptions[key.toLowerCase()] = list;
    lines.push(`${key}: ${list.join(", ")}`);
  }
  return { lines, options: propOptions };
}

function componentNodes(index: GraphIndex): GraphNode[] {
  const nodes: GraphNode[] = [];
  const seen = new Set<string>();
  for (const node of index.getNodesByType("COMPONENT_SET", "MAIN_COMPONENT", "VARIANT")) {
    if (isNameInferredMaster(node) || node.name.startsWith(".") || node.name.startsWith("_")) continue;
    if (VARIANT_PROP_NAME.test(node.name) || node.name.includes("=")) continue;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    nodes.push(node);
  }
  return nodes;
}

function aliasesFor(name: string): string[] {
  const full = name.toLowerCase();
  const out = new Set<string>();
  for (const group of allSynonymGroups()) {
    const terms = group.terms.map((term) => term.toLowerCase()).filter(Boolean);
    if (!terms.includes(full)) continue;
    for (const term of terms) if (term !== full) out.add(term);
  }
  return [...out].sort();
}

export function buildMeaningPack(
  index: GraphIndex,
  library: string,
  builtAt: string,
  libraryId?: string,
): MeaningPack {
  const docs = docsForLibrary(libraryId);
  loadSynonymOverlay();
  const used = new Set<string>();
  const components: SockComponent[] = [];
  for (const node of componentNodes(index)) {
    let id = slugId(node.name);
    let n = 2;
    while (used.has(id)) {
      id = `${slugId(node.name)}-${n}`;
      n += 1;
    }
    used.add(id);
    const doc = docs?.[node.name.trim()];
    const job = doc?.text ?? "";
    const description = (node.description ?? "").replace(/\s+/g, " ").trim();
    const props = propertiesOf(index, node);
    const retired = isRetired(index, node);
    const thin: string[] = [];
    if (description.length < 12) thin.push("description");
    if (!job && description.length < 12) thin.push("guidelines");
    components.push({
      id,
      name: node.name.trim(),
      aliases: aliasesFor(node.name),
      description,
      job,
      ...(doc?.url ? { source: doc.url } : {}),
      properties: props.lines,
      propOptions: props.options,
      retired,
      thin,
    });
  }
  components.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { library, vocab: "", builtAt, components };
}

export function renderComponent(component: SockComponent, library = ""): string {
  const job = component.job || component.description || component.name;
  const lines = [`# ${library || "library"} / ${component.name}`, job];
  if (component.description && component.description !== job) lines.push(component.description);
  if (component.source) {
    lines.push(component.source);
    lines.push(DOC_ATTRIBUTION);
  }
  if (component.aliases.length) lines.push(`Aliases: ${component.aliases.join(", ")}`);
  if (component.properties.length) lines.push(`Properties: ${component.properties.join("; ")}`);
  if (component.thin.length) lines.push(`Thin: ${library || "library"} ${component.id} missing ${component.thin.join(", ")}`);
  lines.push(`[${component.id}](index.md)`);
  return `${lines.join("\n")}\n`;
}

function indexLine(component: SockComponent): string {
  const prefix = `- [${component.id}](${component.id}.md) — `;
  const job = component.thin.length > 0 ? "thin" : (component.description || component.job || component.name).replace(/\s+/g, " ").trim();
  const body = component.thin.length > 0 ? job : `${job} — ${component.name}`;
  const room = 150 - prefix.length;
  const text = body.length <= room ? body : `${body.slice(0, Math.max(0, room - 1)).trimEnd()}…`;
  const line = `${prefix}${text}`;
  return line.length <= 150 ? line : line.slice(0, 150);
}

export function renderIndex(pack: MeaningPack): string {
  const lines = [`# ${pack.library}`, `built: ${pack.builtAt}`];
  if (pack.vocab) lines.push(pack.vocab);
  for (const component of pack.components) lines.push(indexLine(component));
  return `${lines.join("\n")}\n`;
}

export function writeMeaningPack(dir: string, pack: MeaningPack): Map<string, string> {
  mkdirSync(dir, { recursive: true });
  const files = new Map<string, string>();
  const index = renderIndex(pack);
  writeFileSync(join(dir, "index.md"), index);
  for (const component of pack.components) {
    const body = renderComponent(component, pack.library);
    if (Buffer.byteLength(body) > 4096) throw new Error(`${component.id}.md is over 4 KB`);
    writeFileSync(join(dir, `${component.id}.md`), body);
    files.set(component.id, body);
  }
  return files;
}
