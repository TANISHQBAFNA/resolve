import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { COMPONENT_DEFINITION_TYPES, type GraphNode } from "@/core/model";
import { collapseName as collapsed } from "@/core/rules/names";
import type { GraphIndex } from "./GraphIndex";
import synonymFile from "@/data/synonyms.json";
import {
  componentUsageCard,
  isNameInferredMaster,
  isPrivateMasterName,
  otherNamedMasters,
  preferNamedMaster,
  recommendMasters,
  verifyFrame,
} from "./agentSurface";
import type { BindRulesFile } from "./bindRules";
import { recipeCard, starterRecipes, type Recipe } from "./recipes";
import { TOP3_REPORT_MIN, top1Label, top3Label } from "./scoreLabels";
import type { SockState } from "./sock";
import type { WorkspaceManifest } from "./workspace";
import {
  asRecord,
  cardChars,
  contextFor,
  expectationFor,
  grade,
  inventsInCard,
  isCousinPick,
  isRecipeCase,
  percentile,
  rate,
  recipePicks,
  recommendPicks,
  resolveMasterByName,
  resolvePicks,
  verifyApproved,
  verifyNameHits,
  vocabOf,
  type BoundCase,
  type GraphVocab,
} from "./scoreScan";

export { sameFamily } from "@/core/rules/family";
export { inventsInCard, isCousinPick, recommendPicks, resolveMasterByName, vocabOf };

/**
 * Accuracy scoreboard. Scores recommend / resolve / recipe / verify cards
 * against a golden set. Expected masters are names, resolved to ids in the
 * current graph. Never invents an id. No Figma calls.
 */

export const SCORE_TOOLS = ["recommend", "resolve", "recipe", "verify"] as const;
export type ScoreTool = (typeof SCORE_TOOLS)[number];

/** Char budgets the agent cards must stay inside. A breach fails the run. */
export const SCORE_BUDGETS: Record<ScoreTool, number> = {
  recommend: 600,
  verify: 600,
  resolve: 2000,
  recipe: 2000,
};

const ToolNameSchema = z.enum(["recommend", "resolve", "recipe", "verify"]);

const ToolSpecSchema = z.object({
  expect: z.enum(["master", "empty", "skip"]).optional(),
  expected: z.string().trim().min(1).optional(),
  accept: z.array(z.string().trim().min(1)).optional(),
  mustNot: z.array(z.string().trim().min(1)).optional(),
});

const CaseSchema = z.object({
  id: z.string().trim().min(1),
  intent: z.string().trim().min(1),
  screenType: z.string().trim().min(1).optional(),
  journey: z.string().trim().min(1).optional(),
  slot: z.string().trim().min(1).optional(),
  expected: z.string().trim().min(1).optional(),
  accept: z.array(z.string().trim().min(1)).optional(),
  mustNot: z.array(z.string().trim().min(1)).optional(),
  expect: z.enum(["master", "empty"]).optional(),
  note: z.string().optional(),
  /** Object overrides one tool. `["recipe"]` marks a recipe case and still scores the others. */
  tools: z
    .union([
      z.array(ToolNameSchema).min(1),
      z.object({
        recommend: ToolSpecSchema.optional(),
        resolve: ToolSpecSchema.optional(),
        recipe: ToolSpecSchema.optional(),
        verify: ToolSpecSchema.optional(),
      }),
    ])
    .optional(),
});

const FileSchema = z.object({
  version: z.literal(1).optional(),
  cases: z.array(CaseSchema).min(1),
});

export interface ToolSpec {
  expect?: "master" | "empty" | "skip";
  expected?: string;
  accept?: string[];
  mustNot?: string[];
}

export interface GoldenCase {
  id: string;
  intent: string;
  screenType?: string;
  journey?: string;
  slot?: string;
  expected?: string;
  accept?: string[];
  mustNot?: string[];
  expect: "master" | "empty";
  /**
   * Object form overrides the expectation for the tools it names. Other tools
   * keep the case's normal expectation. An array (`["recipe"]`) only marks a
   * recipe case; it does not drop recommend or resolve.
   */
  tools?: Partial<Record<ScoreTool, ToolSpec>> | ScoreTool[];
  note?: string;
}

export interface ScorePick {
  id?: string;
  name: string;
  deprecated: boolean;
  private: boolean;
}

export interface ToolCaseResult {
  tool: ScoreTool;
  picks: ScorePick[];
  /** How many masters the card actually offered. One candidate makes top-3 meaningless. */
  candidates: number;
  chars: number;
  ms: number;
  expect: "master" | "empty";
  top1: boolean;
  top3: boolean;
  emptyOk: boolean;
  wrongCousin: boolean;
  leaked: boolean;
  invents: string[];
  applicable: boolean;
}

export interface ToolRollup {
  tool: ScoreTool;
  cases: number;
  scored: number;
  /** Null when the denominator is 0. Never report that as 0%. */
  top1: number | null;
  top3: number | null;
  emptyWhenWeak: number | null;
  wrongCousinRate: number | null;
  leakRate: number | null;
  top1Count: number;
  /** Hits among cards that offered 3 or more candidates. */
  top3Count: number;
  /** Cards that offered 3 or more candidates. 0 means top-3 is n/a. */
  top3Base: number;
  candidatesP50: number;
  candidatesMax: number;
  sizeP50: number;
  sizeMax: number;
  budget: number;
  overBudget: boolean;
}

export interface ScoreMiss {
  id: string;
  tool: ScoreTool;
  kind: "top1" | "empty" | "cousin" | "leak" | "invent";
  detail: string;
}

export interface ScoreReport {
  version: 1;
  at: string;
  workspace: string;
  golden: string;
  /** Hash of the golden files. Deltas compare only the same hash and workspace. */
  goldenHash?: string;
  storePath?: string;
  fileName?: string;
  builtAt?: string;
  cases: number;
  pass: boolean;
  inventRate: number;
  inventCount: number;
  wrongCousinRate: number | null;
  /** Run-level top-1 excludes verify. Null when nothing was scored. */
  top1: number | null;
  top1Count: number;
  top1Base: number;
  /** Run-level top-3 is only cards with 3+ candidates, verify excluded. */
  top3: number | null;
  top3Count: number;
  top3Base: number;
  emptyWhenWeak: number | null;
  leakRate: number | null;
  latencyP50Ms: number;
  latencyP95Ms: number;
  budgetBreach: boolean;
  tools: ToolRollup[];
  invents: ScoreMiss[];
  misses: ScoreMiss[];
}

export interface ScoreDelta {
  hasPrevious: boolean;
  previousAt?: string;
  top1: number | null;
  /** Omitted from the CLI line unless both runs have a top-3 base of at least 10. */
  top3: number | null;
  top3Reported: boolean;
  inventRate: number | null;
  wrongCousinRate: number | null;
  emptyWhenWeak: number | null;
  leakRate: number | null;
}



export function loadGoldenCases(path: string): GoldenCase[] {
  const stat = statSync(path);
  const files = stat.isDirectory()
    ? readdirSync(path)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => join(path, name))
    : [path];
  if (!files.length) throw new Error(`No golden JSON in ${path}.`);
  const cases: GoldenCase[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const parsed = FileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!parsed.success) {
      throw new Error(`Golden file ${file} is not valid. ${parsed.error.issues[0]?.message ?? "Check the shape."}`);
    }
    for (const row of parsed.data.cases) {
      if (seen.has(row.id)) throw new Error(`Duplicate golden case id "${row.id}".`);
      seen.add(row.id);
      const expect = row.expect ?? (row.expected ? "master" : "empty");
      if (expect === "master" && !row.expected) {
        throw new Error(`Golden case "${row.id}" expects a master but has no expected name.`);
      }
      if (expect === "empty" && row.expected) {
        throw new Error(`Golden case "${row.id}" expects an empty card but also names ${row.expected}.`);
      }
      cases.push({
        id: row.id,
        intent: row.intent,
        ...(row.screenType ? { screenType: row.screenType } : {}),
        ...(row.journey ? { journey: row.journey } : {}),
        ...(row.slot ? { slot: row.slot } : {}),
        ...(row.expected ? { expected: row.expected } : {}),
        ...(row.accept?.length ? { accept: row.accept } : {}),
        ...(row.mustNot?.length ? { mustNot: row.mustNot } : {}),
        ...(row.tools ? { tools: row.tools } : {}),
        expect,
        ...(row.note ? { note: row.note } : {}),
      });
    }
  }
  return cases;
}

function bindCases(index: GraphIndex, cases: GoldenCase[]): BoundCase[] {
  return cases.map((row) => {
    const expectedNode = row.expected ? resolveMasterByName(index, row.expected) : undefined;
    const acceptNodes = (row.accept ?? []).map((name) => resolveMasterByName(index, name));
    const mustNotNodes = (row.mustNot ?? []).map((name) => resolveMasterByName(index, name));
    return {
      ...row,
      expectedNode,
      expectedIds: new Set(expectedNode ? [expectedNode.id] : []),
      acceptIds: new Set(acceptNodes.map((node) => node.id)),
      mustNotIds: new Set(mustNotNodes.map((node) => node.id)),
    };
  });
}

export interface ScoreRunOptions {
  recipes?: Recipe[];
  sock?: SockState;
  bindRules?: BindRulesFile;
  workspace?: WorkspaceManifest;
  at?: string;
  workspaceName?: string;
  golden?: string;
  storePath?: string;
}

function leakPicksFor(
  tool: ScoreTool,
  card: unknown,
  vocab: GraphVocab,
  row: BoundCase,
): ScorePick[] {
  switch (tool) {
    case "recommend":
      return recommendPicks(card, vocab);
    case "resolve":
      return resolvePicks(card, vocab);
    case "recipe":
      return row.slot ? recipePicks(card, vocab, row.slot) : [];
    case "verify":
      return verifyApproved(card, vocab);
    default: {
      const _exhaustive: never = tool;
      return _exhaustive;
    }
  }
}

function candidateCount(tool: ScoreTool, card: unknown, picks: ScorePick[]): number {
  if (tool === "recommend") {
    const list = asRecord(card)?.["candidates"];
    return Array.isArray(list) ? list.length : picks.length;
  }
  return picks.length;
}

function picksFor(
  tool: ScoreTool,
  card: unknown,
  vocab: GraphVocab,
  row: BoundCase,
): ScorePick[] {
  switch (tool) {
    case "recommend":
      return recommendPicks(card, vocab);
    case "resolve":
      return resolvePicks(card, vocab);
    case "recipe":
      return recipePicks(card, vocab, row.slot);
    case "verify":
      return verifyNameHits(card, vocab);
    default: {
      const _exhaustive: never = tool;
      return _exhaustive;
    }
  }
}

function runTool(
  tool: ScoreTool,
  index: GraphIndex,
  row: BoundCase,
  options: ScoreRunOptions,
): unknown {
  const context = contextFor(row);
  const recipes = options.recipes ?? starterRecipes();
  switch (tool) {
    case "recommend":
      return recommendMasters(index, row.intent, {
        ...(context ? { context } : {}),
        ...(options.workspace ? { workspace: options.workspace } : {}),
        ...(options.sock ? { sock: options.sock } : {}),
        ...(options.bindRules ? { bindRules: options.bindRules } : {}),
      });
    case "resolve":
      return componentUsageCard(index, row.intent, {
        ...(context ? { context } : {}),
        ...(options.sock ? { sock: options.sock } : {}),
      });
    case "recipe":
      return recipeCard(
        recipes,
        row.intent,
        index,
        undefined,
        context
          ? {
              packs: [],
              ...(row.screenType ? { domain: row.screenType } : {}),
              ...(row.journey ? { journey: row.journey } : {}),
              ...(options.workspace ? { workspace: options.workspace } : {}),
            }
          : options.workspace
            ? { packs: [], workspace: options.workspace }
            : undefined,
        options.sock,
        options.bindRules,
      );
    case "verify":
      return verifyFrame(index, {
        components: [row.intent],
        ...(context ? { context } : {}),
        ...(options.bindRules ? { bindRules: options.bindRules } : {}),
        ...(options.sock ? { sock: options.sock } : {}),
      });
    default: {
      const _exhaustive: never = tool;
      return _exhaustive;
    }
  }
}

export function hashGoldenSet(path: string): string {
  const stat = statSync(path);
  const files = stat.isDirectory()
    ? readdirSync(path)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => join(path, name))
    : [path];
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(basename(file));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

export function scoreGraph(index: GraphIndex, cases: GoldenCase[], options: ScoreRunOptions = {}): ScoreReport {
  const bound = bindCases(index, cases);
  const vocab = vocabOf(index);
  const results: ToolCaseResult[] = [];
  const invents: ScoreMiss[] = [];
  const misses: ScoreMiss[] = [];
  const goldenHash = options.golden ? hashGoldenSet(options.golden) : undefined;

  for (const row of bound) {
    for (const tool of SCORE_TOOLS) {
      const started = performance.now();
      const card = runTool(tool, index, row, options);
      const ms = performance.now() - started;
      const cardInvents = inventsInCard(card, index);
      let spec = expectationFor(tool, row, index);
      if (tool === "recipe") {
        // Explicit recipe cases stay scored when the tool returns no card. That is a miss, not a skip.
        spec = { ...spec, applicable: isRecipeCase(row) && Boolean(row.slot) };
      }
      const picks = spec.applicable ? picksFor(tool, card, vocab, row) : [];
      const leaks = spec.applicable ? leakPicksFor(tool, card, vocab, row) : [];
      const graded = grade(tool, spec, picks, leaks, index);
      const candidates = candidateCount(tool, card, picks);
      results.push({ ...graded, picks, candidates, chars: cardChars(card), ms, invents: cardInvents });
      for (const detail of cardInvents) {
        invents.push({ id: row.id, tool, kind: "invent", detail });
      }
      if (!graded.applicable) continue;
      const expectedName = spec.expectedName ?? row.expected ?? "a master";
      if (spec.expect === "master" && !graded.top1) {
        const got = picks[0] ? picks[0].name : "empty card";
        misses.push({
          id: row.id,
          tool,
          kind: "top1",
          detail: `expected ${expectedName}, top pick ${got}`,
        });
      }
      if (spec.expect === "empty" && !graded.emptyOk) {
        misses.push({
          id: row.id,
          tool,
          kind: "empty",
          detail: `guessed ${picks.map((pick) => pick.name).join(", ")}`,
        });
      }
      if (graded.wrongCousin && picks[0]) {
        misses.push({ id: row.id, tool, kind: "cousin", detail: `top pick ${picks[0].name}` });
      }
      if (graded.leaked) {
        misses.push({
          id: row.id,
          tool,
          kind: "leak",
          detail: "deprecated or private master offered as a pick",
        });
      }
    }
  }

  const tools = SCORE_TOOLS.map((tool) => rollup(tool, results.filter((row) => row.tool === tool)));
  // Verify did-you-mean is a different question. It stays on its own row and out of the run-level figures.
  const accuracy = results.filter((row) => row.applicable && row.tool !== "verify");
  const masterResults = accuracy.filter((row) => row.expect === "master");
  const emptyResults = accuracy.filter((row) => row.expect === "empty");
  const top3Rows = masterResults.filter((row) => row.candidates >= 3);
  const cousinBase = masterResults.filter((row) => row.picks.length > 0);
  const latency = results.map((row) => row.ms);
  const budgetBreach = tools.some((tool) => tool.overBudget);
  const inventCount = invents.length;
  const top1Count = masterResults.filter((row) => row.top1).length;
  const top3Count = top3Rows.filter((row) => row.top3).length;

  return {
    version: 1,
    at: options.at ?? new Date().toISOString(),
    workspace: options.workspaceName ?? "default",
    golden: options.golden ?? "",
    ...(goldenHash ? { goldenHash } : {}),
    ...(options.storePath ? { storePath: options.storePath } : {}),
    ...(index.graph.fileName ? { fileName: index.graph.fileName } : {}),
    ...(index.graph.builtAt ? { builtAt: index.graph.builtAt } : {}),
    cases: cases.length,
    pass: inventCount === 0 && !budgetBreach,
    inventRate: rate(results.filter((row) => row.invents.length > 0).length, results.length) ?? 0,
    inventCount,
    wrongCousinRate: rate(cousinBase.filter((row) => row.wrongCousin).length, cousinBase.length),
    top1: rate(top1Count, masterResults.length),
    top1Count,
    top1Base: masterResults.length,
    top3: rate(top3Count, top3Rows.length),
    top3Count,
    top3Base: top3Rows.length,
    emptyWhenWeak: rate(emptyResults.filter((row) => row.emptyOk).length, emptyResults.length),
    leakRate: rate(accuracy.filter((row) => row.leaked).length, accuracy.length),
    latencyP50Ms: percentile(latency, 0.5),
    latencyP95Ms: percentile(latency, 0.95),
    budgetBreach,
    tools,
    invents,
    misses,
  };
}

function rollup(tool: ScoreTool, rows: ToolCaseResult[]): ToolRollup {
  const applicable = rows.filter((row) => row.applicable);
  const master = applicable.filter((row) => row.expect === "master");
  const empty = applicable.filter((row) => row.expect === "empty");
  const withPick = master.filter((row) => row.picks.length > 0);
  const sizes = rows.map((row) => row.chars);
  const sizeMax = sizes.length ? Math.max(...sizes) : 0;
  const budget = SCORE_BUDGETS[tool];
  const candidateCounts = applicable.map((row) => row.candidates);
  const candidatesMax = candidateCounts.length ? Math.max(...candidateCounts) : 0;
  const top1Count = master.filter((row) => row.top1).length;
  const top3Rows = master.filter((row) => row.candidates >= 3);
  const top3Count = top3Rows.filter((row) => row.top3).length;
  return {
    tool,
    cases: rows.length,
    scored: master.length,
    top1: rate(top1Count, master.length),
    top1Count,
    top3: rate(top3Count, top3Rows.length),
    top3Count,
    top3Base: top3Rows.length,
    candidatesP50: Math.round(percentile(candidateCounts, 0.5)),
    candidatesMax,
    emptyWhenWeak: rate(empty.filter((row) => row.emptyOk).length, empty.length),
    wrongCousinRate: rate(withPick.filter((row) => row.wrongCousin).length, withPick.length),
    leakRate: rate(applicable.filter((row) => row.leaked).length, applicable.length),
    sizeP50: Math.round(percentile(sizes, 0.5)),
    sizeMax,
    budget,
    overBudget: sizeMax > budget,
  };
}

export function scoreExitCode(report: Pick<ScoreReport, "inventCount" | "budgetBreach">): 0 | 1 {
  return report.inventCount > 0 || report.budgetBreach ? 1 : 0;
}

function deltaRate(current: number | null, previous: number | null | undefined): number | null {
  if (current == null || previous == null) return null;
  return current - previous;
}

export function deltaAgainst(
  current: ScoreReport,
  previous?: Pick<
    ScoreReport,
    "at" | "top1" | "top3" | "inventRate" | "wrongCousinRate" | "emptyWhenWeak" | "leakRate" | "goldenHash" | "workspace"
  > & { top3Base?: number },
): ScoreDelta {
  const sameSet =
    Boolean(previous?.goldenHash) &&
    previous?.goldenHash === current.goldenHash &&
    previous?.workspace === current.workspace;
  if (!previous || !sameSet) {
    return {
      hasPrevious: false,
      top1: null,
      top3: null,
      top3Reported: false,
      inventRate: null,
      wrongCousinRate: null,
      emptyWhenWeak: null,
      leakRate: null,
    };
  }
  const top3Reported = current.top3Base >= 10 && (previous.top3Base ?? 0) >= 10;
  return {
    hasPrevious: true,
    previousAt: previous.at,
    top1: deltaRate(current.top1, previous.top1),
    top3: top3Reported ? deltaRate(current.top3, previous.top3) : null,
    top3Reported,
    inventRate: deltaRate(current.inventRate, previous.inventRate),
    wrongCousinRate: deltaRate(current.wrongCousinRate, previous.wrongCousinRate),
    emptyWhenWeak: deltaRate(current.emptyWhenWeak, previous.emptyWhenWeak),
    leakRate: deltaRate(current.leakRate, previous.leakRate),
  };
}

function pct(rateValue: number | null): string {
  if (rateValue == null) return "n/a";
  return `${Math.round(rateValue * 100)}%`;
}

function points(delta: number | null): string {
  if (delta == null) return "n/a";
  const rounded = Math.round(delta * 100);
  if (rounded === 0) return "0";
  return rounded > 0 ? `+${rounded}` : `${rounded}`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
}

function top1Cell(tool: ToolRollup): string {
  return top1Label(tool.top1Count, tool.scored);
}

function top3Cell(tool: ToolRollup): string {
  return top3Label(tool.top3Count, tool.top3Base);
}

export function formatScoreTable(report: ScoreReport, delta?: ScoreDelta): string {
  const header = [
    pad("Tool", 12),
    pad("Top-1", 10),
    pad("Top-3", 20),
    pad("Empty ok", 10),
    pad("Wrong cousin", 14),
    pad("Leak", 8),
    pad("Cands", 8),
    pad("Size p50", 10),
    pad("Size max", 10),
    "Budget",
  ].join("");
  const lines = report.tools.map((tool) =>
    [
      pad(tool.tool, 12),
      pad(top1Cell(tool), 10),
      pad(top3Cell(tool), 20),
      pad(pct(tool.emptyWhenWeak), 10),
      pad(pct(tool.wrongCousinRate), 14),
      pad(pct(tool.leakRate), 8),
      pad(String(tool.candidatesP50), 8),
      pad(String(tool.sizeP50), 10),
      pad(String(tool.sizeMax), 10),
      tool.overBudget ? `${tool.budget} over` : String(tool.budget),
    ].join(""),
  );
  const recipe = report.tools.find((tool) => tool.tool === "recipe");
  const library = report.fileName ? ` — ${report.fileName}` : "";
  const result = report.pass ? "pass" : "fail";
  const deltaBits = delta?.hasPrevious
    ? [
        `top-1 ${points(delta.top1)}`,
        ...(delta.top3Reported ? [`top-3 ${points(delta.top3)}`] : []),
        `invent ${points(delta.inventRate)}`,
        `wrong cousin ${points(delta.wrongCousinRate)}`,
        `empty-ok ${points(delta.emptyWhenWeak)}`,
        `leak ${points(delta.leakRate)}`,
      ]
    : [];
  const compared = !delta?.hasPrevious
    ? "No earlier run to compare."
    : `Compared with ${delta.previousAt}: ${deltaBits.join(", ")} (points).`;
  const runTop1 = top1Label(report.top1Count, report.top1Base);
  const top3Note =
    report.top3Base >= TOP3_REPORT_MIN
      ? `Top-3: ${report.top3Count}/${report.top3Base}.`
      : `Top-3 is not reported (${report.top3Base} card${report.top3Base === 1 ? "" : "s"} with 3 or more candidates; needs ${TOP3_REPORT_MIN}).`;
  const notes = [
    `Golden tool rows, verify excluded: ${runTop1}. These rows are recommend, resolve, and recipe added together. Not the phrase scoreboard, and not ${report.cases} cases.`,
    top3Note,
    recipe ? `Recipe: ${recipe.top1Count}/${recipe.scored} on screen cases.` : "",
    "Verify top-1 is a did-you-mean hit, scored only on name-like intents. It is not part of the golden tool-row total.",
    "Top-3 counts only cards with three or more candidates, and only when that count is at least 10.",
  ].filter(Boolean);
  return [
    `Golden regression — ${report.cases} cases${library}`,
    "Secondary check. The headline number is the phrase scoreboard: resolve score phrases.",
    "",
    header,
    ...lines,
    "",
    ...notes,
    `Invent rate: ${pct(report.inventRate)} (target 0). Anything above 0 fails this run.`,
    `Latency: p50 ${report.latencyP50Ms.toFixed(1)} ms, p95 ${report.latencyP95Ms.toFixed(1)} ms.`,
    `Result: ${result}.`,
    compared,
  ].join("\n");
}

const EMPTY_PROBES = ["captcha widget", "hologram dial", "quantum gauge"];

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "case";
}

/** Other words in a synonym group that names this master, skipping names of other masters. */
function synonymIntentsFor(name: string, masterNames: ReadonlySet<string>): string[] {
  const target = collapsed(name);
  const intents: string[] = [];
  for (const group of synonymFile.groups) {
    const named = group.terms.some((term) => collapsed(term) === target);
    if (!named) continue;
    for (const term of group.terms) {
      const shown = term.trim();
      if (!shown || collapsed(shown) === target) continue;
      if (masterNames.has(shown.toLowerCase())) continue;
      intents.push(shown);
    }
  }
  return intents;
}

/** One case per public master, plus synonym asks, plus three asks that must stay empty. */
export function initGoldenCases(index: GraphIndex, skipped?: string[]): GoldenCase[] {
  const masters = index.getNodesByType(...COMPONENT_DEFINITION_TYPES).filter((node) => {
    if (node.type === "VARIANT") return false;
    if (node.status === "deprecated") return false;
    if (isPrivateMasterName(node.name) || isNameInferredMaster(node)) return false;
    return Boolean(node.name.trim());
  });
  const byName = new Map<string, GraphNode[]>();
  for (const node of masters) {
    const key = node.name.trim().toLowerCase();
    const list = byName.get(key) ?? [];
    list.push(node);
    byName.set(key, list);
  }
  const unique: GraphNode[] = [];
  for (const group of byName.values()) {
    const picked = preferNamedMaster(index, group);
    if (!picked) continue;
    const others = otherNamedMasters(index, group, picked);
    if (others.length) {
      skipped?.push(picked.name.trim());
      continue;
    }
    unique.push(picked);
  }
  const masterNames = new Set(unique.map((node) => node.name.trim().toLowerCase()));
  const cases: GoldenCase[] = [];
  const seen = new Set<string>();
  const usedIds = new Set<string>();
  const push = (row: GoldenCase) => {
    const key = `${row.expect}:${row.intent.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    let id = row.id;
    if (usedIds.has(id)) {
      let n = 2;
      while (usedIds.has(`${row.id}-${n}`)) n += 1;
      id = `${row.id}-${n}`;
    }
    usedIds.add(id);
    cases.push(id === row.id ? row : { ...row, id });
  };
  for (const node of unique) {
    const name = node.name.trim();
    push({ id: `name-${slug(name)}`, intent: name, expected: name, expect: "master" });
    for (const term of synonymIntentsFor(name, masterNames)) {
      push({
        id: `syn-${slug(name)}-${slug(term)}`,
        intent: term,
        expected: name,
        expect: "master",
      });
    }
  }
  let empties = 0;
  for (const probe of EMPTY_PROBES) {
    if ([...masterNames].some((name) => name.includes(probe))) continue;
    empties += 1;
    push({ id: `empty-${empties}`, intent: probe, expect: "empty" });
  }
  return cases;
}
