import { isPrivateMasterName, isNameInferredMaster, nameTokens } from "@/core/rules/names";
import { isRetired } from "@/core/rules/retired";
import type { GraphNode } from "@/core/model";
import type { GraphIndex } from "./GraphIndex";
import type { BindRulesFile } from "./bindRules";
import { exactRecipe, fillRecipe, type Recipe } from "./recipes";
import { recommendMasters } from "./recommendMasters";
import type { RecommendContext } from "./recommendSupport";
import type { SociProposal, SockState } from "./sock";
import type { WorkspaceManifest } from "./workspace";

/**
 * Designer briefing. At most 3 multiple-choice questions, and only when the
 * answer changes the component recommend would pick. Options are live masters
 * in the learned library. No new store: recipes, approved decisions, and
 * recommend already hold the facts.
 */

export const BRIEF_QUESTION_CAP = 3;
export const BRIEF_TOPICS = ["shape", "goal", "states", "platform"] as const;
export type BriefTopic = (typeof BRIEF_TOPICS)[number];

const TOPIC_NAME: Record<BriefTopic, string> = {
  shape: "data shape",
  goal: "user goal",
  states: "states",
  platform: "platform and density",
};

const FILLER = new Set([
  "a", "an", "the", "screen", "page", "frame", "please", "app", "view", "with", "and", "on", "in", "of", "to",
  "for", "me", "our", "build", "make", "create", "need", "want", "show", "new", "my", "this", "that", "just",
  "use", "using", "recent", "some", "when", "into", "from",
]);

const JUST_BUILD = /\b(?:just build|just do it|don'?t ask|do not ask|skip questions|no questions)\b/gi;

interface Role {
  id: string;
  phrases: string[];
  contrast: string;
}

const SHAPE: Role[] = [
  { id: "table", phrases: ["data table", "table"], contrast: "compare rows" },
  { id: "cards", phrases: ["card list", "cards", "card"], contrast: "scan items" },
  { id: "form", phrases: ["text field", "input", "form"], contrast: "fill in fields" },
  { id: "summary", phrases: ["summary"], contrast: "review a summary" },
  { id: "counts", phrases: ["stat block", "counts", "count", "stat", "price"], contrast: "read counts" },
];

const STATES: Role[] = [
  { id: "empty", phrases: ["empty"], contrast: "empty" },
  { id: "loading", phrases: ["loading", "spinner", "skeleton"], contrast: "loading" },
  { id: "error", phrases: ["error", "alert"], contrast: "error" },
  { id: "pending", phrases: ["pending"], contrast: "pending" },
];

const PLATFORM: Role[] = [
  { id: "mobile", phrases: ["mobile", "phone"], contrast: "phone" },
  { id: "desktop", phrases: ["desktop"], contrast: "desktop" },
  { id: "compact", phrases: ["compact"], contrast: "compact density" },
  { id: "comfortable", phrases: ["comfortable"], contrast: "comfortable density" },
];

/** Component phrases come from the library. Request phrases are how a designer names that goal. */
const GOAL: Array<Role & { recipeId: string; request: string[] }> = [
  { id: "checkout-summary", recipeId: "checkout-summary", phrases: ["pay cta", "pay"], request: ["checkout", "order summary", "cart", "pay"], contrast: "checkout summary" },
  { id: "settings-form", recipeId: "settings-form", phrases: ["save cta", "save"], request: ["settings", "preferences", "save"], contrast: "settings form" },
  { id: "search-results", recipeId: "search-results", phrases: ["search field", "search"], request: ["search results", "search"], contrast: "search results" },
  { id: "list-detail", recipeId: "list-detail", phrases: ["card list", "list row"], request: ["list detail", "master detail", "inbox"], contrast: "list and detail" },
  { id: "sign-in", recipeId: "sign-in", phrases: ["text field"], request: ["sign in", "login", "log in"], contrast: "sign in" },
  { id: "empty-state", recipeId: "empty-state", phrases: ["empty message"], request: ["zero state", "blank"], contrast: "empty state" },
  { id: "nav-content-shell", recipeId: "nav-content-shell", phrases: ["desktop nav", "mobile nav", "nav"], request: ["app shell", "navigation"], contrast: "app shell" },
  { id: "confirm-dialog", recipeId: "confirm-dialog", phrases: ["button"], request: ["confirm", "dialog", "modal"], contrast: "confirm dialog" },
];

export interface BriefOption {
  id: string;
  label: string;
}

export interface BriefQuestion {
  topic: BriefTopic;
  prompt: string;
  options: BriefOption[];
}

export interface BriefCandidate {
  id: string;
  name: string;
  fileKey?: string;
  figmaNodeId?: string;
}

export type BriefSkip = "just-build" | "recipe" | "decision" | "answered" | "one-candidate";

export type BriefResult =
  | { questions: BriefQuestion[] }
  | { ready: true; assumptions: string[]; candidates: BriefCandidate[]; skip: BriefSkip };

interface Choice extends BriefOption {
  contrast: string;
  masterId: string;
}

export interface BriefDecision {
  proposal: SociProposal;
  who: string;
  when: string;
}

export interface BriefInput {
  request: string;
  answers?: Record<string, string>;
  index: GraphIndex;
  recipes?: Recipe[];
  decisions?: BriefDecision[];
  context?: RecommendContext;
  workspace?: WorkspaceManifest;
  sock?: SockState;
  bindRules?: BindRulesFile;
  placeholders?: string[];
}

interface Catalog {
  shape: Choice[];
  goal: Choice[];
  states: Choice[];
  platform: Choice[];
}

function containsPhrase(hay: string, phrase: string): boolean {
  const needle = phrase.trim().toLowerCase();
  if (needle.length < 3) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`).test(hay.toLowerCase());
}

function liveMasters(index: GraphIndex): GraphNode[] {
  return index.getNodesByType("COMPONENT_SET", "MAIN_COMPONENT").filter(
    (node) => !isPrivateMasterName(node.name) && !isRetired(index, node) && !isNameInferredMaster(node),
  );
}

function firstMaster(masters: GraphNode[], phrases: string[]): GraphNode | undefined {
  const ordered = phrases
    .map((phrase, index) => ({ phrase, index }))
    .sort((a, b) => b.phrase.length - a.phrase.length || a.index - b.index);
  for (const row of ordered) {
    const hits = masters.filter((master) => containsPhrase(master.name, row.phrase));
    if (!hits.length) continue;
    hits.sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
    return hits[0];
  }
  return undefined;
}

function roleOptions(masters: GraphNode[], roles: Role[]): Choice[] {
  const claimed = new Set<string>();
  const options: Choice[] = [];
  const pending = roles.map((role) => ({ role, master: firstMaster(masters, role.phrases) }));
  pending.sort((a, b) => {
    const al = a.role.phrases.find((phrase) => a.master && containsPhrase(a.master.name, phrase))?.length ?? 0;
    const bl = b.role.phrases.find((phrase) => b.master && containsPhrase(b.master.name, phrase))?.length ?? 0;
    return bl - al;
  });
  for (const row of pending) {
    if (!row.master || claimed.has(row.master.id)) continue;
    claimed.add(row.master.id);
    options.push({
      id: row.role.id,
      label: row.master.name,
      contrast: row.role.contrast,
      masterId: row.master.id,
    });
  }
  return roles.flatMap((role) => options.filter((option) => option.id === role.id));
}

function goalOptions(recipes: Recipe[], masters: GraphNode[]): Choice[] {
  const ids = new Set(recipes.map((recipe) => recipe.id));
  const claimed = new Set<string>();
  const options: Choice[] = [];
  for (const row of GOAL) {
    if (!ids.has(row.recipeId)) continue;
    const master = firstMaster(masters, row.phrases);
    if (!master || claimed.has(master.id)) continue;
    claimed.add(master.id);
    options.push({ id: row.id, label: master.name, contrast: row.contrast, masterId: master.id });
    if (options.length === 4) break;
  }
  return options;
}

function catalogFor(index: GraphIndex, recipes: Recipe[]): Catalog {
  const masters = liveMasters(index);
  return {
    shape: roleOptions(masters, SHAPE),
    goal: goalOptions(recipes, masters),
    states: roleOptions(masters, STATES),
    platform: roleOptions(masters, PLATFORM),
  };
}

function findChoice(options: Choice[], raw: string): Choice | undefined {
  const needle = raw.trim().toLowerCase();
  if (!needle) return undefined;
  return options.find((option) => option.id.toLowerCase() === needle || option.label.toLowerCase() === needle);
}

export function briefAnswers(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && value.trim()) out[key.trim().toLowerCase()] = value.trim();
  }
  return Object.keys(out).length ? out : undefined;
}

export function briefAnswersFromFlags(args: string[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "--answer") continue;
    const raw = args[i + 1] ?? "";
    const eq = raw.indexOf("=");
    if (eq <= 0) throw new Error("Usage: --answer <topic>=<option>. Topics: goal, platform, states, shape.");
    out[raw.slice(0, eq).trim().toLowerCase()] = raw.slice(eq + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

function chosenLabels(catalog: Catalog, answers: Record<string, string> | undefined): string[] {
  if (!answers) return [];
  const labels: string[] = [];
  for (const topic of BRIEF_TOPICS) {
    const raw = answers[topic];
    if (!raw) continue;
    const choice = findChoice(catalog[topic], raw);
    if (choice) labels.push(choice.label);
  }
  return labels;
}

/** Fold briefing answers into an intent. No answers leaves the request unchanged. */
export function applyBriefIntent(
  request: string,
  answers: Record<string, string> | undefined,
  index: GraphIndex,
  recipes: Recipe[],
): string {
  if (!answers || !Object.keys(answers).length) return request;
  const labels = chosenLabels(catalogFor(index, recipes), answers);
  return labels.length ? `${request} ${labels.join(" ")}`.trim() : request;
}

/** Lines for a handoff sheet. Unknown options are left out. */
export function briefAnswerLines(answers: Record<string, string> | undefined, index: GraphIndex, recipes: Recipe[]): string[] {
  if (!answers) return [];
  const catalog = catalogFor(index, recipes);
  const lines: string[] = [];
  for (const topic of BRIEF_TOPICS) {
    const raw = answers[topic];
    if (!raw) continue;
    const choice = findChoice(catalog[topic], raw);
    if (choice) lines.push(`${TOPIC_NAME[topic]}: ${choice.label}`);
  }
  return lines;
}

function answered(request: string, topic: BriefTopic, options: Choice[]): Choice | undefined {
  const labels = [...options].sort((a, b) => b.label.length - a.label.length);
  for (const option of labels) {
    if (containsPhrase(request, option.label)) return option;
  }
  if (topic === "goal") {
    const rows = GOAL.filter((row) => options.some((option) => option.id === row.id));
    const phrases = rows.flatMap((row) => row.request.map((phrase, index) => ({ phrase, index, id: row.id })));
    phrases.sort((a, b) => b.phrase.length - a.phrase.length || a.index - b.index);
    for (const row of phrases) {
      if (!containsPhrase(request, row.phrase)) continue;
      return options.find((option) => option.id === row.id);
    }
    return undefined;
  }
  const roles = topic === "shape" ? SHAPE : topic === "states" ? STATES : PLATFORM;
  const phrases = roles.flatMap((role) => role.phrases.map((phrase, index) => ({ phrase, index, id: role.id })));
  phrases.sort((a, b) => b.phrase.length - a.phrase.length || a.index - b.index);
  for (const row of phrases) {
    if (!containsPhrase(request, row.phrase)) continue;
    const option = options.find((item) => item.id === row.id);
    if (option) return option;
  }
  return undefined;
}

function joinOr(parts: string[]): string {
  if (parts.length <= 2) return parts.join(" or ");
  return `${parts.slice(0, -1).join(", ")}, or ${parts[parts.length - 1]}`;
}

function promptFor(options: Choice[]): string {
  return `${joinOr(options.map((option) => option.label))}: ${joinOr(options.map((option) => option.contrast))}?`;
}

function contentTokens(request: string): string[] {
  return nameTokens(request).filter((token) => !FILLER.has(token));
}

function recipeMatch(recipes: Recipe[], request: string): Recipe | undefined {
  const exact = exactRecipe(recipes, request);
  if (exact) return exact;
  const hits = recipes.filter((recipe) => {
    const phrases = [recipe.title, ...recipe.intentAliases];
    return phrases.some((phrase) => {
      if (!containsPhrase(request, phrase)) return false;
      const rest = request.toLowerCase().replace(phrase.toLowerCase(), " ");
      return contentTokens(rest).length === 0;
    });
  });
  return hits.length === 1 ? hits[0] : undefined;
}

function decisionMatch(
  request: string,
  decisions: BriefDecision[],
  masters: GraphNode[],
): { summary: string; master: GraphNode } | undefined {
  const tokens = contentTokens(request).filter((token) => token.length > 3);
  for (const row of decisions) {
    const text = [row.proposal.summary, row.proposal.decisionNote, row.proposal.namingFix].filter(Boolean).join(" ");
    const named = masters
      .filter((master) => containsPhrase(text, master.name))
      .sort((a, b) => b.name.length - a.name.length);
    const master = named[0];
    if (!master) continue;
    const own = new Set(nameTokens(master.name));
    if (tokens.some((token) => containsPhrase(text, token) && !own.has(token))) {
      return { summary: row.proposal.summary, master };
    }
  }
  return undefined;
}

function candidateOf(node: { id: string; name: string; fileKey?: string; figmaNodeId?: string }): BriefCandidate {
  return {
    id: node.id,
    name: node.name,
    ...(node.fileKey ? { fileKey: node.fileKey } : {}),
    ...(node.figmaNodeId ? { figmaNodeId: node.figmaNodeId } : {}),
  };
}

function ready(skip: BriefSkip, assumptions: string[], candidates: BriefCandidate[]): BriefResult {
  return { ready: true, skip, assumptions, candidates };
}

export function briefScreen(input: BriefInput): BriefResult {
  const recipes = input.recipes ?? [];
  const catalog = catalogFor(input.index, recipes);
  const answers = input.answers;
  const justBuild = JUST_BUILD.test(input.request);
  JUST_BUILD.lastIndex = 0;
  const stripped = input.request.replace(JUST_BUILD, " ").replace(/\s+/g, " ").trim();
  const request = [stripped, ...chosenLabels(catalog, answers)].filter(Boolean).join(" ");
  const cache = new Map<string, BriefCandidate[]>();
  const rank = (intent: string): BriefCandidate[] => {
    const key = intent.trim().toLowerCase();
    const hit = cache.get(key);
    if (hit) return hit;
    const card = recommendMasters(input.index, intent || "screen", {
      budgetChars: 4000,
      ...(input.context ? { context: input.context } : {}),
      workspace: input.workspace,
      sock: input.sock,
      bindRules: input.bindRules,
      placeholders: input.placeholders,
    }) as { candidates?: Array<{ id?: string; name?: string; fileKey?: string; figmaNodeId?: string }> };
    const rows = (card.candidates ?? []).slice(0, 3).flatMap((row) => {
      if (!row.id || !row.name) return [];
      return [candidateOf({ id: row.id, name: row.name, fileKey: row.fileKey, figmaNodeId: row.figmaNodeId })];
    });
    cache.set(key, rows);
    return rows;
  };

  const masters = liveMasters(input.index);
  const recipe = recipeMatch(recipes, request);
  const decision = recipe ? undefined : decisionMatch(request, input.decisions ?? [], masters);

  const forks: Array<{ topic: BriefTopic; options: Choice[]; assumed: Choice }> = [];
  const notes: string[] = [];
  for (const topic of BRIEF_TOPICS) {
    const options = catalog[topic];
    if (options.length < 2) continue;
    const known = answered(request, topic, options);
    if (known) {
      notes.push(`Request already says ${TOPIC_NAME[topic]}: ${known.label}.`);
      continue;
    }
    const distinct: Choice[] = [];
    for (const option of options) {
      const name = rank(`${request} ${option.label}`.trim())[0]?.name;
      // The choice counts only when recommend would actually place that component.
      if (name !== option.label) continue;
      distinct.push(option);
    }
    if (distinct.length < 2) continue;
    const base = rank(request)[0]?.name;
    const assumed = distinct.find((option) => rank(`${request} ${option.label}`.trim())[0]?.name === base) ?? distinct[0]!;
    forks.push({ topic, options: distinct, assumed });
  }

  if (justBuild) {
    if (recipe) {
      return ready("just-build", [`Assumed the ${recipe.title} recipe. No questions asked.`], recipeCandidates(input, recipe));
    }
    if (decision) {
      return ready("just-build", [`Assumed the approved decision: ${decision.summary}`], [candidateOf(decision.master)]);
    }
    const assumed = forks.slice(0, BRIEF_QUESTION_CAP);
    const assumptions = assumed.map(
      (fork) => `Assumed ${TOPIC_NAME[fork.topic]}: ${fork.assumed.label} (${fork.assumed.contrast}).`,
    );
    const candidates = rank(request);
    for (const fork of assumed) {
      if (candidates.some((row) => row.name === fork.assumed.label)) continue;
      const picked = rank(fork.assumed.label)[0];
      if (picked) candidates.push(picked);
    }
    return ready("just-build", assumptions.length ? assumptions : ["No open question. Nothing assumed."], candidates);
  }

  if (recipe) {
    return ready("recipe", [`Recipe ${recipe.title} matches. Slots decide the parts.`], recipeCandidates(input, recipe));
  }
  if (decision) {
    return ready("decision", [`Approved decision: ${decision.summary}`], [candidateOf(decision.master)]);
  }

  const asked = forks.slice(0, BRIEF_QUESTION_CAP);
  if (asked.length) {
    return {
      questions: asked.map((fork) => ({
        topic: fork.topic,
        prompt: promptFor(fork.options),
        options: fork.options.map((option) => ({ id: option.id, label: option.label })),
      })),
    };
  }

  const candidates = rank(request);
  const skip: BriefSkip = candidates.length <= 1 ? "one-candidate" : "answered";
  const assumptions = notes.length ? notes : [candidates.length <= 1 ? "Only one candidate fits." : "No question would change the component."];
  return ready(skip, assumptions, candidates);
}

function recipeCandidates(input: BriefInput, recipe: Recipe): BriefCandidate[] {
  const filled = fillRecipe(
    input.index,
    recipe,
    undefined,
    undefined,
    input.workspace,
    input.sock,
    input.bindRules,
    input.placeholders,
  );
  const seen = new Set<string>();
  const rows: BriefCandidate[] = [];
  for (const slot of filled.slots) {
    const master = slot.master;
    if (!master || slot.status === "deprecated" || seen.has(master.id)) continue;
    seen.add(master.id);
    rows.push(candidateOf(master));
  }
  return rows;
}
