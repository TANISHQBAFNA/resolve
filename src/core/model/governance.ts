import type { GraphNode } from "./graph";

export const DESIGN_STATUSES = ["draft", "approved", "deprecated", "experimental"] as const;
export type DesignStatus = (typeof DESIGN_STATUSES)[number];

export const EDGE_CONFIDENCES = ["EXTRACTED", "INFERRED", "AMBIGUOUS"] as const;
export type EdgeConfidence = (typeof EDGE_CONFIDENCES)[number];

export interface Governance {
  status?: DesignStatus;
  owner?: string;
  platforms?: string[];
  /** How status was established. Missing status => undefined. */
  statusSource?: "front-matter" | "name" | "keyword" | "inherited";
}

const STATUS_SET = new Set<string>(DESIGN_STATUSES);

function asStatus(value: string): DesignStatus | undefined {
  const normalised = value.trim().toLowerCase();
  return STATUS_SET.has(normalised) ? (normalised as DesignStatus) : undefined;
}

const RETIRE_WORD =
  /(?:do not use|no longer used|no longer supported|replaced by|deprecated|retired|legacy|obsolete)/i;
const RETIRE_PHRASE = new RegExp(`\\b${RETIRE_WORD.source}\\b`, "gi");
const COPULA_RETIRE = /\bthis\s+(?:component|set|variant|avatar|one)\s+is\s+(deprecated|retired|obsolete|legacy)\b/i;
const SCOPE_AFTER_DO_NOT_USE =
  /^(?:(?:this|the|a|an)\s+)?(?:inside|outside|in|for|on|with|without|when|within|gradients?)\b/i;
const TITLE_AFTER = /^(?:users?|data|warning|browsers?)\b/i;
const LEGACY_AFTER = /^(?:component|style|version|pattern|control|set|master)\b/i;
const STATUS_AFTER = /^(?:in|from|as|to|do|control|component|set|master|favour|favor)\b/i;
const NEGATION_BEFORE = /^(?:no|not|without)$/i;
const NEGATION_AFTER = /^(?:but|back)$/i;
const CLAUSE_BREAK = /[,.;!?\n]/;

function peelRetireDecor(text: string): string {
  let rest = text.replace(/\r/g, "");
  rest = rest
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1");
  rest = rest.trim();
  for (let step = 0; step < 8; step += 1) {
    const bracket = rest.match(/^\[([^\]]*)\]\s*/u);
    if (bracket) {
      const inner = bracket[1]!.trim();
      rest = RETIRE_WORD.test(inner)
        ? `${inner} ${rest.slice(bracket[0].length)}`.trim()
        : rest.slice(bracket[0].length).trim();
      continue;
    }
    const parens = rest.match(/^\(([^)]*)\)\s*/);
    if (parens) {
      const inner = parens[1]!.trim();
      rest = RETIRE_WORD.test(inner)
        ? `${inner} ${rest.slice(parens[0].length)}`.trim()
        : rest.slice(parens[0].length).trim();
      continue;
    }
    const emoji = rest.match(/^[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]+\s*/u);
    if (emoji) {
      rest = rest.slice(emoji[0].length).trim();
      continue;
    }
    const colon = rest.match(/^:+\s*/);
    if (colon) {
      rest = rest.slice(colon[0].length).trim();
      continue;
    }
    const bullet = rest.match(/^[-*•]\s+/);
    if (bullet) {
      rest = rest.slice(bullet[0].length).trim();
      continue;
    }
    break;
  }
  return rest;
}

function clauseStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch !== "." && ch !== "!" && ch !== "?" && ch !== ";" && ch !== "," && ch !== "\n") continue;
    let j = i + 1;
    while (j < text.length && /\s/.test(text[j]!)) j += 1;
    if (j < text.length) starts.push(j);
  }
  return starts;
}

function clauseSpan(text: string, index: number): { start: number; end: number } {
  let start = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (CLAUSE_BREAK.test(text[i]!)) {
      start = i + 1;
      break;
    }
  }
  let end = text.length;
  for (let i = index; i < text.length; i += 1) {
    if (CLAUSE_BREAK.test(text[i]!)) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function threeWords(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean);
}

function negatedNear(text: string, start: number, end: number): boolean {
  const span = clauseSpan(text, start);
  const before = threeWords(text.slice(span.start, start)).slice(-3);
  const after = threeWords(text.slice(end, span.end)).slice(0, 3);
  if (before.some((word) => NEGATION_BEFORE.test(word))) return true;
  if (after.some((word) => NEGATION_AFTER.test(word))) return true;
  return false;
}

function doNotUseScoped(after: string): boolean {
  return SCOPE_AFTER_DO_NOT_USE.test(after.trim());
}

function adjectiveTitle(after: string): boolean {
  const rest = after.trim();
  if (!rest) return false;
  if (STATUS_AFTER.test(rest)) return false;
  return TITLE_AFTER.test(rest);
}

/**
 * Description marks a set retired when a retire phrase starts the note or
 * its own sentence/clause. Markdown wrapping is peeled. Negation only in a
 * 3-word window (so "Deprecated, no replacement" still retires). "Do not use"
 * plus a scope phrase (inside/outside/in/for/…) stays live.
 */
export function descriptionIsRetired(description?: string): boolean {
  if (!description) return false;
  const lead = peelRetireDecor(description);
  if (!lead) return false;
  const copula = COPULA_RETIRE.exec(lead);
  if (copula && copula.index !== undefined) {
    const end = copula.index + copula[0].length;
    if (!negatedNear(lead, copula.index, end)) return true;
  }
  const starts = new Set(clauseStarts(lead));
  RETIRE_PHRASE.lastIndex = 0;
  let hit: RegExpExecArray | null;
  while ((hit = RETIRE_PHRASE.exec(lead))) {
    const at = hit.index;
    const phrase = hit[0]!.toLowerCase();
    const after = lead.slice(at + hit[0]!.length);
    if (!starts.has(at) && at !== 0) continue;
    if (negatedNear(lead, at, at + hit[0]!.length)) continue;
    if (phrase === "do not use" && doNotUseScoped(after)) continue;
    if (phrase === "legacy" && !LEGACY_AFTER.test(after.trim())) continue;
    if (
      (phrase === "retired" || phrase === "obsolete") &&
      adjectiveTitle(after)
    ) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Read governance from Figma text. Front-matter wins:
 *
 *   status: deprecated
 *   owner: payments
 *   platform: web, ios
 *
 * Name `[deprecated]` / word "deprecated" is a fallback, tagged INFERRED.
 */
export function parseGovernance(name: string, description?: string): Governance {
  const governance: Governance = {};
  const blob = description ?? "";

  for (const line of blob.split(/\n/)) {
    const match = line.match(/^\s*(status|owner|platform|platforms)\s*:\s*(.+?)\s*$/i);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const value = match[2]!;
    if (key === "status") {
      const status = asStatus(value);
      if (status) {
        governance.status = status;
        governance.statusSource = "front-matter";
      }
    } else if (key === "owner") {
      governance.owner = value;
    } else if (key === "platform" || key === "platforms") {
      governance.platforms = value
        .split(/[,/]/)
        .map((part) => part.trim())
        .filter(Boolean);
    }
  }

  if (!governance.status) {
    if (/\[deprecated\]|\bdeprecated\b/i.test(name)) {
      governance.status = "deprecated";
      governance.statusSource = "name";
    } else if (/\blegacy\b/i.test(name)) {
      governance.status = "deprecated";
      governance.statusSource = "keyword";
    } else if (descriptionIsRetired(blob)) {
      governance.status = "deprecated";
      governance.statusSource = "keyword";
    } else if (/\bexperimental\b/i.test(`${name} ${blob}`)) {
      governance.status = "experimental";
      governance.statusSource = "keyword";
    }
  }

  return governance;
}

export function applyGovernance(node: GraphNode): void {
  const parsed = parseGovernance(node.name, node.description);
  if (parsed.status) node.status = parsed.status;
  if (parsed.owner) node.owner = parsed.owner;
  if (parsed.platforms?.length) node.platforms = parsed.platforms;
  if (parsed.statusSource) {
    node.metadata = { ...node.metadata, statusSource: parsed.statusSource };
  }
}

export function inheritGovernance(instance: GraphNode, main: GraphNode): void {
  if (instance.status || !main.status) return;
  instance.status = main.status;
  if (main.owner && !instance.owner) instance.owner = main.owner;
  if (main.platforms && !instance.platforms) instance.platforms = main.platforms;
  instance.metadata = { ...instance.metadata, statusSource: "inherited" };
}
