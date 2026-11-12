import { appendFileSync } from "node:fs";
import type { DsckState } from "../codeKnowledge/dsck";
import type { GraphIndex } from "../read/GraphIndex";
import { meaningDictionary } from "../read/meaning/buildDictionary";
import { prepareAsk } from "../read/meaning/parse";
import { tokensOf } from "../read/queryTokens";
import { inflectionStems } from "../read/screenInventory";
import { buildComponentGraph } from "./componentGraph";
import type { GraphLead } from "./graphResolver";
import type { RecommendContext } from "./recommendSupport";

/**
 * Opt-in shadow report. One JSON line per recommend, written only when the
 * caller passes a path. Nothing here prints, and a write failure stays here.
 */

export const LEAD_STRENGTHS = ["strong", "weak", "empty"] as const;
export type LeadStrength = (typeof LEAD_STRENGTHS)[number];

export const DISAGREE_CATEGORIES = [
  "empty versus picked",
  "no job resolved",
  "density",
  "twin",
  "context pack",
  "plural or short",
  "other",
] as const;
export type DisagreeCategory = (typeof DISAGREE_CATEGORIES)[number];

export interface ShadowLeadView {
  id: string;
  name: string;
  strength: LeadStrength;
}

export interface ShadowReportLine {
  ask: string;
  live: ShadowLeadView;
  graph: ShadowLeadView;
  agree: boolean;
  jobs: string[];
  evidence: string;
  category?: DisagreeCategory;
}

const NOT_A_PLURAL = /(?:ss|us|is|ics|ous|ness)$/;
const PATTERN_LIMIT = 8;

export function liveLeadOf(card: unknown): ShadowLeadView {
  if (!card || typeof card !== "object") return { id: "", name: "", strength: "empty" };
  const record = card as { candidates?: unknown; match?: unknown };
  const first = Array.isArray(record.candidates) ? record.candidates[0] : undefined;
  if (!first || typeof first !== "object") return { id: "", name: "", strength: "empty" };
  const row = first as { id?: unknown; name?: unknown };
  const id = typeof row.id === "string" ? row.id : "";
  const name = typeof row.name === "string" ? row.name : "";
  if (!id && !name.trim()) return { id: "", name: "", strength: "empty" };
  return { id, name, strength: record.match === "weak match" ? "weak" : "strong" };
}

function graphLeadOf(lead: GraphLead | undefined): ShadowLeadView {
  if (!lead || lead.empty || !lead.lead.trim()) return { id: "", name: "", strength: "empty" };
  return { id: lead.id, name: lead.lead, strength: lead.weak ? "weak" : "strong" };
}

function sameLead(left: ShadowLeadView, right: ShadowLeadView): boolean {
  if (left.strength === "empty" && right.strength === "empty") return true;
  if (left.strength === "empty" || right.strength === "empty") return false;
  if (left.id && right.id && left.id === right.id) return true;
  const name = (value: string) => value.trim().toLowerCase();
  return name(left.name) !== "" && name(left.name) === name(right.name);
}

function mainEvidence(lead: GraphLead | undefined): string {
  if (!lead) return "shadow failed";
  return lead.evidence[0] ?? lead.next ?? "";
}

function noJob(lead: GraphLead | undefined, evidence: string): boolean {
  if (!lead || lead.jobs.length === 0) return true;
  return evidence === "tie-break" || evidence === "No component holds this job.";
}

function densityAsk(index: GraphIndex, ask: string, context?: RecommendContext): boolean {
  try {
    if (context?.constraints?.density) return true;
    const decision = prepareAsk(ask, meaningDictionary(index));
    return decision.attributes.some((row) => row.kind === "density") || decision.reasons.some((reason) => reason.toLowerCase().includes("density"));
  } catch {
    return false;
  }
}

function nameNests(left: string, right: string): boolean {
  const a = tokensOf(left);
  const b = tokensOf(right);
  if (!a.length || !b.length || a.length === b.length) return false;
  const smaller = a.length < b.length ? a : b;
  const larger = a.length < b.length ? b : a;
  return smaller.every((token) => larger.includes(token));
}

function twin(index: GraphIndex, live: ShadowLeadView, picked: ShadowLeadView, jobs: readonly string[], dsck?: DsckState): boolean {
  if (nameNests(live.name, picked.name)) return true;
  if (!live.id || !picked.id || live.id === picked.id) return false;
  try {
    const graph = buildComponentGraph(index, { ...(dsck ? { dsck } : {}) });
    const linked = graph.links.some(
      (link) =>
        link.review === "confirmed" &&
        link.kind === "stands-in-for" &&
        ((link.from === live.id && link.to === picked.id) || (link.from === picked.id && link.to === live.id)),
    );
    if (linked) return true;
    const held = (id: string) => {
      const node = graph.byId.get(id);
      return new Set((node?.jobs ?? []).filter((job) => job.review === "confirmed").map((job) => job.jobId));
    };
    const left = held(live.id);
    const right = held(picked.id);
    return jobs.some((job) => left.has(job) && right.has(job));
  } catch {
    return false;
  }
}

function hasContext(context?: RecommendContext): boolean {
  if (!context) return false;
  return Boolean(
    context.id ||
      context.domain ||
      context.screenType ||
      context.journey?.step ||
      context.journey?.screenJob ||
      context.product?.id ||
      context.product?.name ||
      context.client?.id ||
      context.client?.name,
  );
}

function pluralWord(word: string): boolean {
  return word.length >= 4 && !NOT_A_PLURAL.test(word) && inflectionStems(word).some((stem) => stem !== word);
}

/** A plural ask, a short content word, or two leads that are the same word with a plural ending. */
function pluralOrShort(ask: string, live: string, picked: string): boolean {
  const words = tokensOf(ask);
  if (words.some((word) => word.length <= 3 || pluralWord(word))) return true;
  const form = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const left = form(live);
  const right = form(picked);
  if (!left || !right || left === right) return false;
  const stems = (word: string) => new Set([word, ...inflectionStems(word)]);
  const known = stems(left);
  for (const stem of stems(right)) if (known.has(stem)) return true;
  return false;
}

function categoryFor(
  index: GraphIndex,
  ask: string,
  live: ShadowLeadView,
  picked: ShadowLeadView,
  lead: GraphLead | undefined,
  evidence: string,
  context: RecommendContext | undefined,
  dsck: DsckState | undefined,
): DisagreeCategory {
  const liveEmpty = live.strength === "empty";
  const graphEmpty = picked.strength === "empty";
  if (liveEmpty !== graphEmpty) return "empty versus picked";
  if (!lead || noJob(lead, evidence)) return "no job resolved";
  if (densityAsk(index, ask, context)) return "density";
  if (twin(index, live, picked, lead.jobs, dsck)) return "twin";
  if (hasContext(context)) return "context pack";
  if (pluralOrShort(ask, live.name, picked.name)) return "plural or short";
  return "other";
}

export function recordShadowReport(
  path: string,
  input: {
    index: GraphIndex;
    ask: string;
    lead: GraphLead | undefined;
    card: unknown;
    context?: RecommendContext;
    dsck?: DsckState;
  },
): void {
  try {
    const live = liveLeadOf(input.card);
    const picked = graphLeadOf(input.lead);
    const evidence = mainEvidence(input.lead);
    const agree = input.lead ? sameLead(live, picked) : false;
    const line: ShadowReportLine = {
      ask: input.ask,
      live,
      graph: picked,
      agree,
      jobs: input.lead?.jobs ?? [],
      evidence,
      ...(!agree
        ? { category: categoryFor(input.index, input.ask, live, picked, input.lead, evidence, input.context, input.dsck) }
        : {}),
    };
    appendFileSync(path, `${JSON.stringify(line)}\n`, "utf8");
  } catch {
    // A report file must never throw into recommend.
  }
}

export interface ShadowPattern {
  live: string;
  graph: string;
  category: DisagreeCategory;
  count: number;
}

export interface ShadowSummary {
  agree: number;
  disagree: number;
  categories: Record<DisagreeCategory, number>;
  patterns: ShadowPattern[];
  skipped: number;
}

function emptyCategories(): Record<DisagreeCategory, number> {
  return {
    "empty versus picked": 0,
    "no job resolved": 0,
    density: 0,
    twin: 0,
    "context pack": 0,
    "plural or short": 0,
    other: 0,
  };
}

function isCategory(value: unknown): value is DisagreeCategory {
  return typeof value === "string" && (DISAGREE_CATEGORIES as readonly string[]).includes(value);
}

function readReportLine(raw: unknown): { agree: boolean; category: DisagreeCategory; live: string; graph: string } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as { agree?: unknown; category?: unknown; live?: unknown; graph?: unknown };
  if (typeof row.agree !== "boolean") return undefined;
  const nameOf = (value: unknown): string => {
    if (!value || typeof value !== "object") return "";
    const name = (value as { name?: unknown }).name;
    return typeof name === "string" ? name : "";
  };
  const category = isCategory(row.category) ? row.category : "other";
  return { agree: row.agree, category, live: nameOf(row.live), graph: nameOf(row.graph) };
}

/** Counts from a shadow report file. Invalid lines are skipped. */
export function summarizeShadowReport(text: string): ShadowSummary {
  const categories = emptyCategories();
  const patterns = new Map<string, ShadowPattern>();
  let agree = 0;
  let disagree = 0;
  let skipped = 0;
  for (const rawLine of text.split(/\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      skipped += 1;
      continue;
    }
    const row = readReportLine(parsed);
    if (!row) {
      skipped += 1;
      continue;
    }
    if (row.agree) {
      agree += 1;
      continue;
    }
    disagree += 1;
    categories[row.category] += 1;
    const key = `${row.category}\0${row.live}\0${row.graph}`;
    const prior = patterns.get(key);
    if (prior) prior.count += 1;
    else patterns.set(key, { live: row.live, graph: row.graph, category: row.category, count: 1 });
  }
  const ranked = [...patterns.values()].sort(
    (a, b) => b.count - a.count || a.category.localeCompare(b.category) || a.live.localeCompare(b.live) || a.graph.localeCompare(b.graph),
  );
  return { agree, disagree, categories, patterns: ranked.slice(0, PATTERN_LIMIT), skipped };
}

export function formatShadowSummary(summary: ShadowSummary): string {
  const lines = [
    `agree ${summary.agree}`,
    `disagree ${summary.disagree}`,
    ...DISAGREE_CATEGORIES.map((category) => `${category} ${summary.categories[category]}`),
    ...summary.patterns.map((row) => `${row.live || "(empty)"} → ${row.graph || "(empty)"} · ${row.category} × ${row.count}`),
  ];
  if (summary.skipped) lines.push(`skipped ${summary.skipped}`);
  return `${lines.join("\n")}\n`;
}
