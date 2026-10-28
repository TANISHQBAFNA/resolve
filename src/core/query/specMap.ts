import type { GraphIndex } from "./GraphIndex";
import { recommendMasters } from "./recommendMasters";

/**
 * Reads the Markdown of a Figma spec (the text under a SPEC_BLOCK document) and maps each line that asks for
 * something on screen to a real library component. The agent fetches the Markdown; Resolve never calls Figma.
 * Deterministic: the same text and library give the same rows. A line is never mapped to a part Resolve did not return.
 */

export interface SpecLine {
  section: string;
  text: string;
}

/** Only what the document says. A field the text does not state stays off. */
export interface SpecContext {
  product?: string;
  journey?: string;
  audience?: string;
  a11y?: string;
}

export interface SpecRead {
  title: string;
  context: SpecContext;
  lines: SpecLine[];
}

export type SpecStatus = "mapped" | "weak" | "no-match" | "not-ui";

export interface SpecPick {
  name: string;
  figmaNodeId?: string;
  fileKey?: string;
  why?: string;
}

export interface SpecRow extends SpecLine {
  status: SpecStatus;
  /** The shorter phrase that was ranked, when the full line found nothing better. */
  asked?: string;
  pick?: SpecPick;
  alternatives?: string[];
}

export interface SpecMap {
  title: string;
  context: SpecContext;
  rows: SpecRow[];
  counts: Record<SpecStatus, number>;
}

const MAX_LINES = 300;
const KEYS: Array<[RegExp, keyof SpecContext]> = [
  [/^product$/i, "product"],
  [/^(user )?journey$/i, "journey"],
  [/^audience$/i, "audience"],
  [/^(accessibility|a11y)$/i, "a11y"],
];

function clean(text: string): string {
  return text
    .replace(/\[\/?comment:[0-9a-f-]+\]/gi, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/\*\*|__|[*`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** WCAG 2.1 AA, wcag-aa and WCAG AA all read as wcag-aa. Anything else is left off, not guessed. */
function a11yLevel(value: string): string | undefined {
  const match = /wcag[\s-]*(?:2\.\d[\s-]*)?(aaa|aa|a)\b/i.exec(value);
  return match ? `wcag-${match[1]!.toLowerCase()}` : undefined;
}

function setContext(context: SpecContext, key: string, value: string): boolean {
  const hit = KEYS.find(([pattern]) => pattern.test(key.trim()));
  if (!hit) return false;
  const field = hit[1];
  const text = field === "a11y" ? a11yLevel(value) : value.trim();
  if (text && !context[field]) context[field] = text;
  return true;
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);
}

export function readSpec(markdown: string): SpecRead {
  const context: SpecContext = {};
  const lines: SpecLine[] = [];
  let title = "";
  let section = "";
  let fenced = false;
  let inTable = false;
  const add = (raw: string) => {
    const text = clean(raw);
    const words = text.split(" ").length;
    if (text && words >= 2 && text.length <= 300 && lines.length < MAX_LINES) lines.push({ section, text });
  };
  for (const raw of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      const text = clean(heading[2]!);
      if (heading[1] === "#" && !title) title = text;
      else section = text;
      inTable = false;
      continue;
    }
    const row = /^\s*\|(.*)\|\s*$/.exec(raw);
    if (row) {
      const cells = row[1]!.split("|").map(clean).filter(Boolean);
      const header = !inTable;
      inTable = true;
      if (header || /^[\s|:-]+$/.test(raw) || cells.length === 0) continue;
      if (cells.length >= 2 && setContext(context, cells[0]!, cells[1]!)) continue;
      add([...cells].sort((a, b) => b.split(" ").length - a.split(" ").length)[0]!);
      continue;
    }
    inTable = false;
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(raw);
    const body = clean(item ? item[1]! : raw);
    if (!body) continue;
    const pair = /^([A-Za-z0-9 ]{2,20}?)\s*[:–-]\s+(.+)$/.exec(body);
    if (pair && setContext(context, pair[1]!, pair[2]!)) continue;
    if (item) add(body);
    else for (const sentence of sentences(body)) add(sentence);
  }
  return { title, context, lines };
}

interface Card {
  candidates?: Array<{ name: string; figmaNodeId?: string; fileKey?: string; why?: string; confidence?: string }>;
  match?: string;
}

/** Lines about dates, speed, audit or people are not screen parts. ponytail: a cue list, not a classifier; widen it when a real spec shows another. */
const NOT_SCREEN = /\b(q[1-4]|sprint|quarter|deadline|ship|release|budget|seconds?|milliseconds?|latency|uptime|compliance|audit|sla|weekly|daily|monthly|stakeholders?|team)\b/i;
const CLAUSE = /\s+(?:that|which|who|to|so|when|while|before|after|and|with|for|where|if)\s+/i;

/** Long sentences defeat the ranking, so the phrase before the first clause word is tried too. */
function phrases(text: string): string[] {
  const head = text.split(CLAUSE)[0]!.trim();
  return head && head !== text ? [text, head] : [text];
}

/** Each line goes through the same ranking as `recommend`. A line is never mapped to a part Resolve did not return. */
export function mapSpec(index: GraphIndex, read: SpecRead, options: Parameters<typeof recommendMasters>[2] = {}): SpecMap {
  const counts: Record<SpecStatus, number> = { mapped: 0, weak: 0, "no-match": 0, "not-ui": 0 };
  const rank = (status: SpecStatus) => (status === "mapped" ? 2 : status === "weak" ? 1 : 0);
  const rows = read.lines.map((line): SpecRow => {
    let row: SpecRow = { ...line, status: "no-match" };
    for (const phrase of phrases(line.text)) {
      const card = recommendMasters(index, phrase, options) as Card;
      const [top, ...rest] = card.candidates ?? [];
      if (!top) continue;
      const status: SpecStatus = card.match === "weak match" || top.confidence === "low" ? "weak" : "mapped";
      if (rank(status) <= rank(row.status)) continue;
      row = {
        ...line,
        status,
        ...(phrase !== line.text ? { asked: phrase } : {}),
        pick: { name: top.name, ...(top.figmaNodeId ? { figmaNodeId: top.figmaNodeId } : {}), ...(top.fileKey ? { fileKey: top.fileKey } : {}), ...(top.why ? { why: top.why } : {}) },
        ...(rest.length ? { alternatives: rest.map((item) => item.name) } : {}),
      };
    }
    if (row.status !== "mapped" && NOT_SCREEN.test(line.text)) row = { ...line, status: "not-ui" };
    counts[row.status] += 1;
    return row;
  });
  return { title: read.title, context: read.context, rows, counts };
}

export function formatSpecMap(map: SpecMap, all = false): string {
  const stated = Object.entries(map.context).map(([key, value]) => `${key}: ${value}`);
  const out = [
    `Spec: ${map.title || "(untitled)"}`,
    `Context stated: ${stated.length ? stated.join(", ") : "none"}`,
    `Mapped ${map.counts.mapped} · weak ${map.counts.weak} · no match ${map.counts["no-match"]} · not on screen ${map.counts["not-ui"]}`,
  ];
  const group = (status: SpecStatus, label: string) => {
    const rows = map.rows.filter((row) => row.status === status);
    if (!rows.length || (status === "not-ui" && !all)) return;
    out.push("", label);
    for (const row of rows) {
      const where = row.section ? `[${row.section}] ` : "";
      const pick = row.pick
        ? ` -> ${row.pick.name}${row.pick.figmaNodeId ? ` (${row.pick.fileKey ? `${row.pick.fileKey} ` : ""}${row.pick.figmaNodeId})` : ""}${row.alternatives?.length ? `; also ${row.alternatives.join(", ")}` : ""}`
        : "";
      out.push(`- ${where}${row.text}${pick}`);
    }
  };
  group("mapped", "Mapped");
  group("weak", "Weak: check before placing");
  group("no-match", "No match: nothing in the library fits, or this is not a screen part. Check; never invent");
  group("not-ui", "Not on screen (--all)");
  return `${out.join("\n")}\n`;
}
