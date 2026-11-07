import { isPrivateMasterName, isNameInferredMaster, nameTokens } from "@/core/rules/names";
import { isRetired } from "@/core/rules/retired";
import type { GraphNode } from "@/core/model";
import type { GraphIndex } from "../read/GraphIndex";
import type { BindRulesFile } from "../codeKnowledge/bindRules";
import { exactRecipe, fillRecipe, type Recipe } from "./recipes";
import { meaningDictionary } from "../read/meaning/buildDictionary";
import { prepareAsk } from "../read/meaning/parse";
import { artShelf } from "../recommend/recommendContext";
import { recommendMasters } from "../recommend/recommendMasters";
import { askRole, roleFit } from "../recommend/recommendRole";
import type { RecommendContext } from "../recommend/recommendSupport";
import { composeParts, composeRecipe } from "./recipeCompose";
import { sameWordForm } from "../read/screenInventory";
import type { DsciProposal, DsckState } from "../codeKnowledge/dsck";
import type { WorkspaceManifest } from "../read/workspace";

/**
 * Designer briefing. At most 3 answers, and a question only when the request
 * already fits the library and the answer would change the component.
 * The screen-type goal question is not asked. States can take more than one answer.
 * No new store.
 */

export const BRIEF_QUESTION_CAP = 3;
export const BRIEF_TOPICS = ["shape", "states", "platform", "part"] as const;
export type BriefTopic = (typeof BRIEF_TOPICS)[number];

const TOPIC_NAME: Record<BriefTopic, string> = {
  shape: "data shape",
  states: "states",
  platform: "platform and density",
  part: "part",
};

/** Option ids a briefing answer resolves to. The decision record and a handoff export use these as enums. */
export const BRIEF_SHAPE_IDS = ["table", "cards", "form", "summary", "counts"] as const;
export const BRIEF_STATE_IDS = ["empty", "loading", "error", "pending"] as const;
export const BRIEF_PLATFORM_IDS = ["desktop", "mobile", "phone", "compact", "comfortable"] as const;
const PLATFORM_IDS = BRIEF_PLATFORM_IDS;
type PlatformId = (typeof PLATFORM_IDS)[number];
const PLATFORM_WORDS = new Set<string>(PLATFORM_IDS);
const PLATFORM_GENERIC = new Set(["nav", "bar", "list", "view", "shell", "layout", "screen", "row"]);

const FILLER = new Set([
  "a", "an", "the", "screen", "page", "frame", "please", "app", "view", "with", "and", "on", "in", "of", "to",
  "for", "me", "our", "build", "make", "create", "need", "want", "show", "new", "my", "this", "that", "just",
  "use", "using", "recent", "some", "when", "into", "from", "ahead", "without", "asking", "go",
  // Verbs say what the person does with the part, not which part or where it sits.
  "place", "put", "add", "scan", "compare", "read", "review", "display", "see", "browse",
]);

// "show all data", "list every data row": a collection with no shape named.
const LIST_ASK = /\b(?:all|every|lists?)\b/i;

// No /g: .test() on a /g regex keeps lastIndex between calls.
const JUST_BUILD = /\b(?:just build|just do it|don'?t ask|do not ask|no need to ask|skip (?:the )?questions|no questions|go ahead and build|without (?:asking|questions))\b/i;

interface Role {
  id: string;
  phrases: string[];
  contrast: string;
}

const SHAPE: Array<Role & { id: (typeof BRIEF_SHAPE_IDS)[number] }> = [
  { id: "table", phrases: ["data table", "table"], contrast: "compare rows" },
  { id: "cards", phrases: ["card list", "cards", "card"], contrast: "scan items" },
  { id: "form", phrases: ["text field", "input", "form"], contrast: "fill in fields" },
  { id: "summary", phrases: ["summary"], contrast: "review a summary" },
  { id: "counts", phrases: ["stat block", "counts", "count", "stat", "price"], contrast: "read counts" },
];

const STATES: Array<Role & { id: (typeof BRIEF_STATE_IDS)[number] }> = [
  { id: "empty", phrases: ["empty"], contrast: "empty" },
  { id: "loading", phrases: ["loading", "spinner", "skeleton"], contrast: "loading" },
  { id: "error", phrases: ["error", "alert"], contrast: "error" },
  { id: "pending", phrases: ["pending"], contrast: "pending" },
];

export class BriefAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BriefAnswerError";
  }
}

export interface BriefOption {
  id: string;
  label: string;
}

export interface BriefQuestion {
  topic: BriefTopic;
  prompt: string;
  options: BriefOption[];
  /** States can take more than one of these options. */
  multiple?: true;
}

export interface BriefCandidate {
  id: string;
  name: string;
  fileKey?: string;
  figmaNodeId?: string;
  /** Recommend's lead was a weak match: check before placing. */
  weak?: true;
}

export interface BriefAnswers {
  shape?: string;
  platform?: string;
  /** Which of two or more competing parts: a live master name or id. */
  part?: string;
  states: string[];
}

export type BriefSkip = "just-build" | "recipe" | "decision" | "answered" | "one-candidate" | "no-match";

export type BriefResult = (
  | { questions: BriefQuestion[] }
  | { ready: true; assumptions: string[]; candidates: BriefCandidate[]; skip: BriefSkip }
) & {
  /** An offer only. Brief never composes; the person or agent runs recipe compose. */
  composeOffer?: string;
  /** A saved recipe already covers the named parts (same check compose uses). Use it instead of composing. */
  savedRecipe?: string;
};

interface Choice extends BriefOption {
  contrast: string;
  masterId: string;
}

export interface BriefDecision {
  proposal: DsciProposal;
  who: string;
  when: string;
}

export interface BriefInput {
  request: string;
  answers?: BriefAnswers;
  index: GraphIndex;
  recipes?: Recipe[];
  decisions?: BriefDecision[];
  context?: RecommendContext;
  workspace?: WorkspaceManifest;
  dsck?: DsckState;
  bindRules?: BindRulesFile;
  placeholders?: string[];
}

interface Catalog {
  shape: Choice[];
  states: Choice[];
  /** Platform-named parts (Desktop Nav, Compact List). id is the platform word. */
  platform: Choice[];
  /** Every live part, for a part answer. */
  parts: Choice[];
}

/** Where the phrase's words sit in hay, in order, as [start, end). Plurals and stems count. */
function phraseSpan(hay: string, phrase: string): [number, number] | undefined {
  if (phrase.trim().length < 3) return undefined;
  const needle = nameTokens(phrase);
  const words = nameTokens(hay);
  if (!needle.length) return undefined;
  for (let start = 0; start + needle.length <= words.length; start += 1) {
    if (needle.every((word, offset) => sameWordForm(words[start + offset]!, word))) return [start, start + needle.length];
  }
  return undefined;
}

function containsPhrase(hay: string, phrase: string): boolean {
  return phraseSpan(hay, phrase) !== undefined;
}

/** hay without the words the phrase matched. */
function withoutPhrase(hay: string, phrase: string): string {
  const span = phraseSpan(hay, phrase);
  if (!span) return hay;
  const words = nameTokens(hay);
  return [...words.slice(0, span[0]), ...words.slice(span[1])].join(" ");
}

function contentTokens(request: string): string[] {
  return nameTokens(request).filter((token) => !FILLER.has(token) && !PLATFORM_WORDS.has(token));
}

/** Live parts. Artwork on an Illustrations page is not a screen part. */
function liveMasters(index: GraphIndex): GraphNode[] {
  return index.getNodesByType("COMPONENT_SET", "MAIN_COMPONENT").filter(
    (node) => !isPrivateMasterName(node.name) && !isRetired(index, node) && !isNameInferredMaster(node) && !artShelf(index, node),
  );
}

/** A name like Desktop Nav or Compact List is a platform label, not the screen's component. */
export function platformComponentName(name: string): boolean {
  const tokens = nameTokens(name);
  if (!tokens.some((token) => PLATFORM_WORDS.has(token))) return false;
  return tokens.every((token) => PLATFORM_WORDS.has(token) || PLATFORM_GENERIC.has(token));
}

function firstMaster(masters: GraphNode[], phrases: string[]): GraphNode | undefined {
  const ordered = phrases
    .map((phrase, index) => ({ phrase, index }))
    .sort((a, b) => b.phrase.length - a.phrase.length || a.index - b.index);
  // A role word or its plural names the part: "card" is Cards, but "stat" is not States.
  const names = (master: GraphNode, phrase: string) =>
    containsPhrase(master.name, phrase) && nameTokens(phrase).every((word) => nameTokens(master.name).some((own) => own === word || own === `${word}s`));
  for (const row of ordered) {
    const hits = masters.filter((master) => !platformComponentName(master.name) && names(master, row.phrase));
    if (!hits.length) continue;
    hits.sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
    return hits[0];
  }
  return undefined;
}

function roleOptions(masters: GraphNode[], roles: Role[]): Choice[] {
  const claimed = new Set<string>();
  const found: Choice[] = [];
  for (const role of roles) {
    const master = firstMaster(masters, role.phrases);
    if (!master || claimed.has(master.id)) continue;
    claimed.add(master.id);
    found.push({ id: role.id, label: master.name, contrast: role.contrast, masterId: master.id });
  }
  return found;
}

function platformWord(name: string): PlatformId | undefined {
  return PLATFORM_IDS.find((id) => nameTokens(name).includes(id));
}

function catalogFor(index: GraphIndex): Catalog {
  const masters = liveMasters(index);
  const platform = masters.flatMap((master) => {
    const id = platformComponentName(master.name) ? platformWord(master.name) : undefined;
    return id ? [{ id, label: master.name, contrast: id, masterId: master.id }] : [];
  });
  const parts = masters.map((master) => ({ id: master.id, label: master.name, contrast: "", masterId: master.id }));
  return { shape: roleOptions(masters, SHAPE), states: roleOptions(masters, STATES), platform, parts };
}

function findChoice(options: Choice[], raw: string): Choice | undefined {
  const needle = raw.trim().toLowerCase();
  return options.find((option) => option.id.toLowerCase() === needle || option.label.toLowerCase() === needle);
}

function valuesOf(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((item) => (typeof item === "string" ? item.trim() : ""));
  if (typeof raw === "string") return raw.split(",").map((item) => item.trim());
  return [];
}

function countAnswers(answers: BriefAnswers): number {
  return (answers.shape ? 1 : 0) + (answers.platform ? 1 : 0) + (answers.part ? 1 : 0) + answers.states.length;
}

function rejectOverCap(answers: BriefAnswers): void {
  if (countAnswers(answers) > BRIEF_QUESTION_CAP) {
    throw new BriefAnswerError("Briefing accepts at most 3 answers.");
  }
}

function assignTopic(answers: BriefAnswers, topic: string, raw: unknown, seenSingle: Set<string>): void {
  const id = topic.trim().toLowerCase();
  if (!id) throw new BriefAnswerError("Answer topic is empty.");
  if (!BRIEF_TOPICS.includes(id as BriefTopic)) {
    throw new BriefAnswerError(`Unknown briefing topic "${id}". Topics: shape, states, platform, part.`);
  }
  const values = valuesOf(raw);
  if (!values.length || values.some((value) => !value)) throw new BriefAnswerError(`Answer for ${id} is empty.`);
  if (id === "states") {
    for (const value of values) {
      const key = value.toLowerCase();
      if (answers.states.some((item) => item.toLowerCase() === key)) {
        throw new BriefAnswerError(`State "${value}" was given twice.`);
      }
      answers.states.push(value);
    }
    return;
  }
  if (seenSingle.has(id)) throw new BriefAnswerError(`Topic ${id} was given twice.`);
  if (values.length > 1) throw new BriefAnswerError(`Topic ${id} takes one answer.`);
  seenSingle.add(id);
  if (id === "shape") answers.shape = values[0];
  else if (id === "part") answers.part = values[0];
  else answers.platform = values[0];
}

/** Parse an answers object. Empty input is no answers. Bad input throws. */
export function briefAnswers(raw: unknown): BriefAnswers | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new BriefAnswerError("Briefing answers must be an object of topic to option.");
  }
  const entries = Object.entries(raw);
  if (!entries.length) return undefined;
  const answers: BriefAnswers = { states: [] };
  const seen = new Set<string>();
  for (const [topic, value] of entries) assignTopic(answers, topic, value, seen);
  rejectOverCap(answers);
  return answers;
}

/** `--answer topic=option`, repeated. States may repeat with a different option. */
export function briefAnswersFromFlags(args: string[]): BriefAnswers | undefined {
  const answers: BriefAnswers = { states: [] };
  const seen = new Set<string>();
  let any = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "--answer") continue;
    any = true;
    const raw = args[i + 1] ?? "";
    const eq = raw.indexOf("=");
    if (eq <= 0) throw new BriefAnswerError("Usage: --answer <topic>=<option>. Topics: shape, states, platform, part.");
    assignTopic(answers, raw.slice(0, eq), raw.slice(eq + 1), seen);
  }
  if (!any) return undefined;
  rejectOverCap(answers);
  return answers;
}

function assertKnown(answers: BriefAnswers | undefined, catalog: Catalog): Map<BriefTopic, Choice[]> {
  const resolved = new Map<BriefTopic, Choice[]>();
  if (!answers) return resolved;
  if (answers.shape) {
    const choice = findChoice(catalog.shape, answers.shape);
    if (!choice) {
      const options = catalog.shape.map((option) => option.id).join(", ") || "none";
      throw new BriefAnswerError(`Unknown option "${answers.shape}" for data shape. Options: ${options}.`);
    }
    resolved.set("shape", [choice]);
  }
  if (answers.platform) {
    const id = findChoice(catalog.platform, answers.platform)?.id ?? answers.platform.trim().toLowerCase();
    if (!PLATFORM_IDS.includes(id as PlatformId)) {
      throw new BriefAnswerError(`Unknown option "${answers.platform}" for platform and density. Options: ${PLATFORM_IDS.join(", ")}.`);
    }
    resolved.set("platform", [{ id, label: id, contrast: id, masterId: "" }]);
  }
  if (answers.part) {
    const choice = findChoice(catalog.parts, answers.part);
    if (!choice) throw new BriefAnswerError(`Unknown option "${answers.part}" for part. Name one of the parts the question listed.`);
    resolved.set("part", [choice]);
  }
  if (answers.states.length) {
    const choices: Choice[] = [];
    for (const value of answers.states) {
      const choice = findChoice(catalog.states, value);
      if (!choice) {
        const options = catalog.states.map((option) => option.id).join(", ") || "none";
        throw new BriefAnswerError(`Unknown option "${value}" for states. Options: ${options}.`);
      }
      choices.push(choice);
    }
    resolved.set("states", choices);
  }
  return resolved;
}

function componentChoices(resolved: Map<BriefTopic, Choice[]>): Choice[] {
  return [...(resolved.get("part") ?? []), ...(resolved.get("shape") ?? []), ...(resolved.get("states") ?? [])].filter((choice) => choice.masterId);
}

/** Check answers against the learned library. No answers is a no-op. */
export function assertBriefAnswers(answers: BriefAnswers | undefined, index: GraphIndex): Map<BriefTopic, Choice[]> {
  return assertKnown(answers, catalogFor(index));
}

/** The request with the other shapes it named taken out, so the chosen shape leads. */
function steerShape(request: string, shapes: Choice[], chosen: Choice): string {
  let rest = request;
  for (const other of shapes) {
    if (other.id === chosen.id) continue;
    const role = SHAPE.find((row) => row.id === other.id);
    for (const phrase of [other.label, ...(role?.phrases ?? [])]) {
      while (containsPhrase(rest, phrase)) rest = withoutPhrase(rest, phrase);
    }
  }
  return rest;
}

/** The request already asks for the part a platform word picks (nav, list), so the word can steer it. */
function asksPlatformPart(request: string, catalog: Catalog): boolean {
  return catalog.platform.some((choice) => {
    const rest = nameTokens(choice.label).filter((token) => !PLATFORM_WORDS.has(token));
    return rest.length > 0 && rest.every((token) => containsPhrase(request, token));
  });
}

/** Component names from shape and state answers. A platform answer adds its word only when the request asks for a platform part. */
export function applyBriefIntent(request: string, answers: BriefAnswers | undefined, index: GraphIndex): string {
  if (!answers) return request;
  const catalog = catalogFor(index);
  const resolved = assertKnown(answers, catalog);
  const labels = componentChoices(resolved).map((choice) => choice.label);
  const platform = resolved.get("platform")?.[0]?.id;
  if (platform && asksPlatformPart(request, catalog) && !containsPhrase(request, platform)) labels.push(platform);
  if (!labels.length) return request;
  const shape = resolved.get("shape")?.[0];
  const base = shape ? steerShape(request, catalog.shape, shape) : request;
  return `${base} ${labels.join(" ")}`.trim();
}

export function briefAnswerLines(answers: BriefAnswers | undefined, index: GraphIndex): string[] {
  if (!answers) return [];
  const resolved = assertBriefAnswers(answers, index);
  const lines: string[] = [];
  for (const topic of BRIEF_TOPICS) {
    const choices = resolved.get(topic);
    if (!choices?.length) continue;
    lines.push(`You answered ${TOPIC_NAME[topic]}: ${choices.map((choice) => choice.label).join(", ")}.`);
  }
  return lines;
}

/** Answers as option ids (a label like "Data Table" becomes "table"), for records and a handoff export. */
export interface BriefAnswerIds {
  shape?: (typeof BRIEF_SHAPE_IDS)[number];
  platform?: (typeof BRIEF_PLATFORM_IDS)[number];
  states: Array<(typeof BRIEF_STATE_IDS)[number]>;
}

export function briefAnswerIds(answers: BriefAnswers | undefined, index: GraphIndex): BriefAnswerIds | undefined {
  if (!answers) return undefined;
  const resolved = assertBriefAnswers(answers, index);
  // Choice ids come from SHAPE, STATES and PLATFORM_IDS, which are typed to these lists.
  const shape = resolved.get("shape")?.[0]?.id as BriefAnswerIds["shape"];
  const platform = resolved.get("platform")?.[0]?.id as BriefAnswerIds["platform"];
  const states = (resolved.get("states") ?? []).map((choice) => choice.id) as BriefAnswerIds["states"];
  return { ...(shape ? { shape } : {}), ...(platform ? { platform } : {}), states };
}

/** Masters the answers selected. These are the parts a handoff must add. */
export function briefAnswerParts(answers: BriefAnswers | undefined, index: GraphIndex): BriefCandidate[] {
  if (!answers) return [];
  const masters = new Map(liveMasters(index).map((master) => [master.id, master]));
  const seen = new Set<string>();
  const parts: BriefCandidate[] = [];
  for (const choice of componentChoices(assertBriefAnswers(answers, index))) {
    const master = masters.get(choice.masterId);
    if (!master || seen.has(master.id)) continue;
    seen.add(master.id);
    parts.push(candidateOf(master));
  }
  return parts;
}

/** Options the request names: the option's own label or id. A word that only leads to it ("price" for counts) does not answer the topic. */
function mentioned(request: string, options: Choice[]): Choice[] {
  const hits: Choice[] = [];
  let rest = request;
  for (const option of [...options].sort((a, b) => b.label.length - a.label.length)) {
    const said = [option.label, option.id].find((phrase) => containsPhrase(rest, phrase));
    if (!said) continue;
    hits.push(option);
    rest = withoutPhrase(rest, said);
  }
  return hits;
}

function platformSaid(request: string, index: GraphIndex): PlatformId | undefined {
  const decision = prepareAsk(request, meaningDictionary(index));
  const density = decision.attributes.find((row) => row.kind === "density");
  if (density?.value === "compact" || density?.value === "comfortable") return density.value;
  const said = PLATFORM_IDS.filter((id) => id !== "compact" && id !== "comfortable" && containsPhrase(decision.text, id));
  said.sort((a, b) => b.length - a.length);
  return said[0];
}

function namedMasters(request: string, masters: GraphNode[]): GraphNode[] {
  return masters
    .filter((master) => containsPhrase(request, master.name))
    .sort((a, b) => b.name.length - a.name.length);
}

/** Words that name a data shape or a screen, not a distinct part. */
const SHAPE_WORD = new Set(["form", "forms", "screen", "screens", "page", "pages", "input", "inputs", "value", "values", "text", "item", "items"]);

/**
 * Masters the request names by a word of their own, apart from a shape word.
 * "Input value" does not count for "form". "Checkbox" and "Button" do.
 */
function lastSegment(name: string): string {
  return name.split("/").map((part) => part.trim()).filter(Boolean).pop() ?? name;
}

function segmentHeads(name: string): string[] {
  return nameTokens(lastSegment(name)).filter((token) => token.length > 2 && !SHAPE_WORD.has(token));
}

function requirementGroups(request: string, masters: GraphNode[]): Map<string, GraphNode[]> {
  const words = contentTokens(request);
  const groups = new Map<string, GraphNode[]>();
  for (const master of masters) {
    const own = segmentHeads(master.name);
    const head = own[own.length - 1];
    if (!head || !words.some((word) => sameWordForm(word, head))) continue;
    const list = groups.get(head) ?? [];
    list.push(master);
    groups.set(head, list);
  }
  return groups;
}

function plainRequirements(group: GraphNode[], head: string): GraphNode[] {
  const plain = group.filter((master) => {
    const tokens = nameTokens(lastSegment(master.name)).filter((token) => token.length > 2);
    return tokens.length === 1 && tokens[0] === head;
  });
  return plain.length ? plain : group;
}

function partsNamed(request: string, masters: GraphNode[]): GraphNode[] {
  const words = contentTokens(request);
  const hits = masters.filter((master) => {
    const own = nameTokens(lastSegment(master.name)).filter((token) => token.length > 2 && !SHAPE_WORD.has(token));
    const head = own[own.length - 1];
    return Boolean(head && words.some((word) => sameWordForm(word, head)));
  });
  const kept = hits.filter((master) => {
    const own = nameTokens(master.name);
    return !hits.some((other) => other.id !== master.id && nameTokens(other.name).length > own.length && own.every((token) => nameTokens(other.name).includes(token)));
  });
  return kept.sort((a, b) => {
    const at = (master: GraphNode) => {
      const token = nameTokens(master.name).find((part) => !SHAPE_WORD.has(part));
      return token ? words.findIndex((word) => sameWordForm(word, token)) : words.length;
    };
    return at(a) - at(b);
  });
}

function joinOr(parts: string[]): string {
  if (parts.length <= 2) return parts.join(" or ");
  return `${parts.slice(0, -1).join(", ")}, or ${parts[parts.length - 1]}`;
}

function recipeMatch(recipes: Recipe[], request: string): Recipe | undefined {
  const exact = exactRecipe(recipes, request);
  if (exact) return exact;
  const hits = recipes.filter((recipe) => {
    const phrases = [recipe.title, ...recipe.intentAliases];
    return phrases.some((phrase) => {
      if (!containsPhrase(request, phrase)) return false;
      return contentTokens(withoutPhrase(request, phrase)).length === 0;
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
      .filter((master) => !platformComponentName(master.name) && containsPhrase(text, master.name))
      .sort((a, b) => b.name.length - a.name.length);
    const master = named[0];
    if (!master) continue;
    const own = nameTokens(master.name);
    // "tables" is the part's own word too, not a word that ties the request to this decision.
    if (tokens.some((token) => containsPhrase(text, token) && !own.some((word) => sameWordForm(word, token)))) {
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

const NO_MATCH = "No match. Name a component from the learned library or check the spelling, then brief again.";

/** Brief, plus an offer to compose when no saved recipe or decision fits and the request names two or more parts. */
export function briefScreen(input: BriefInput): BriefResult {
  const result = briefRequest(input);
  if ("skip" in result && ["recipe", "decision", "no-match"].includes(result.skip)) return result;
  const request = input.request.replace(new RegExp(JUST_BUILD.source, "gi"), " ").trim();
  if (composeParts(request).phrases.length < 2) return result;
  // Same answer compose would give: a saved recipe that covers it, a recipe it would build, or nothing to offer.
  const preview = composeRecipe({
    request,
    index: input.index,
    recipes: input.recipes ?? [],
    ...(input.workspace ? { bind: { packs: [], workspace: input.workspace } } : {}),
    dsck: input.dsck,
    bindRules: input.bindRules,
    placeholders: input.placeholders,
  });
  const saved = preview.duplicates?.[0] ?? (preview.card.composed === false && "recipe" in preview.card ? preview.card.recipe?.title : undefined);
  if (saved) return { ...result, savedRecipe: `Saved recipe ${saved} already covers this. Use recipe "${saved}"; no need to compose.` };
  if (!preview.recipe) return result;
  return {
    ...result,
    composeOffer: `No saved recipe fits. To compose one from the parts you named, run recipe "${request}" with compose (CLI --compose; MCP compose: true, advanced). Not run.`,
  };
}

function briefRequest(input: BriefInput): BriefResult {
  const recipes = input.recipes ?? [];
  const catalog = catalogFor(input.index);
  const resolved = assertKnown(input.answers, catalog);
  const justBuild = JUST_BUILD.test(input.request);
  const stripped = input.request.replace(new RegExp(JUST_BUILD.source, "gi"), " ").replace(/\s+/g, " ").trim();
  const masters = liveMasters(input.index);
  /** platformRows is empty unless recommend's top pick is itself a platform part. */
  type Ranked = { rows: BriefCandidate[]; platformRows: BriefCandidate[]; weak: boolean };
  const cache = new Map<string, Ranked>();
  const rank = (intent: string): Ranked => {
    const key = intent.trim().toLowerCase();
    const hit = cache.get(key);
    if (hit) return hit;
    const card = recommendMasters(input.index, intent || "screen", {
      budgetChars: 4000,
      ...(input.context ? { context: input.context } : {}),
      workspace: input.workspace,
      dsck: input.dsck,
      bindRules: input.bindRules,
      placeholders: input.placeholders,
    }) as { match?: string; candidates?: Array<{ id?: string; name?: string; fileKey?: string; figmaNodeId?: string }> };
    const all = (card.candidates ?? []).slice(0, 3).flatMap((row, i) => {
      if (!row.id || !row.name) return [];
      const lead = candidateOf({ id: row.id, name: row.name, fileKey: row.fileKey, figmaNodeId: row.figmaNodeId });
      return [i === 0 && card.match === "weak match" ? { ...lead, weak: true as const } : lead];
    });
    const value = {
      rows: all.filter((row) => !platformComponentName(row.name)),
      platformRows: all[0] && platformComponentName(all[0].name) ? all.filter((row) => platformComponentName(row.name)) : [],
      weak: card.match === "weak match",
    };
    cache.set(key, value);
    return value;
  };

  const shapes = mentioned(stripped, catalog.shape);
  const states = mentioned(stripped, catalog.states);
  const platform = platformSaid(stripped, input.index);
  // A role read from the wording ("Buy/Sell toggle") drops a named part that does another job (Toggle).
  const role = askRole(stripped);
  const named = namedMasters(stripped, masters).filter((master) => roleFit(role, master.name).points >= 0).filter((master) => !platformComponentName(master.name) || containsPhrase(stripped, master.name));
  const parts = partsNamed(stripped, masters).filter((master) => !platformComponentName(master.name));
  const groups = requirementGroups(stripped, parts);
  const recipe = recipeMatch(recipes, stripped);
  const decision = recipe ? undefined : decisionMatch(stripped, input.decisions ?? [], masters);
  const lead = rank(stripped);
  // Recommend's own ranking decides fit. A weak lead fits only when the request names one of its words.
  const asks = contentTokens(stripped);
  // A weak recommend lead counts only when the request names one of the part's words.
  const fitRows = (ranked: Ranked, words: string[]) =>
    ranked.weak ? ranked.rows.filter((row) => nameTokens(row.name).some((token) => words.some((word) => sameWordForm(word, token)))) : ranked.rows;
  const trusted = (rows: BriefCandidate[]) => fitRows({ ...lead, rows }, asks);
  const leadRows = trusted(lead.rows);
  // Platform parts (Desktop Nav) only when other words ask for them: "on desktop" alone picks nothing.
  const platformRows = asks.length ? trusted(lead.platformRows) : [];
  const leadFit = leadRows.length > 0 || platformRows.length > 0;
  const answerFit = componentChoices(resolved).length > 0;
  // Product rule (r3): a list ask with no shape or part named, where a card list and a table both exist, asks list or table.
  // r4: only when recommend finds a part from the other words. The list words alone ("all", "list of") never fit.
  const listWords = asks.filter((word) => !LIST_ASK.test(word));
  const listFound = LIST_ASK.test(stripped) && listWords.length > 0 && fitRows(rank(listWords.join(" ")), listWords).length > 0;
  const listShapes =
    listFound && !resolved.has("shape") && !shapes.length && !named.length && LIST_ASK.test(stripped)
      ? catalog.shape.filter((choice) => choice.id === "cards" || choice.id === "table")
      : [];
  const listAsk = listShapes.length === 2;
  const fits = Boolean(recipe || decision || shapes.length || states.length || named.length || parts.length || leadFit || answerFit);

  const notes: string[] = [];
  const fromAnswer = (topic: BriefTopic) => resolved.has(topic);
  const manyParts = parts.length >= 2;
  if (!manyParts && (fromAnswer("shape") || shapes.length === 1)) {
    const choice = resolved.get("shape")?.[0] ?? shapes[0];
    if (choice) notes.push(`${fromAnswer("shape") ? "You answered" : "Request already says"} ${TOPIC_NAME.shape}: ${choice.label}.`);
  }
  if (fromAnswer("states") || states.length) {
    const choices = resolved.get("states") ?? states;
    notes.push(`${fromAnswer("states") ? "You answered" : "Request already says"} ${TOPIC_NAME.states}: ${choices.map((choice) => choice.label).join(", ")}.`);
  }
  if (fromAnswer("platform") || platform) {
    const label = resolved.get("platform")?.[0]?.label ?? platform;
    if (label) notes.push(`${fromAnswer("platform") ? "You answered" : "Request already says"} ${TOPIC_NAME.platform}: ${label}.`);
  }

  const answeredShape = fromAnswer("shape") || (!manyParts && shapes.length === 1);
  const answeredStates = fromAnswer("states") || states.length > 0;
  const shapeFork = !answeredShape && shapes.length >= 2 ? shapes : listShapes;

  const forks: Array<{ topic: BriefTopic; options: Choice[]; multiple?: true }> = [];
  const consider = (topic: BriefTopic, options: Choice[]) => {
    if (options.length < 2 || !fits) return;
    const distinct: Choice[] = [];
    for (const option of options) {
      const base = topic === "shape" ? steerShape(stripped, catalog.shape, option) : stripped;
      const top = rank(`${base} ${option.label}`.trim());
      const listed = top.rows.some((row) => row.name === option.label);
      if (top.weak || (top.rows[0]?.name !== option.label && !(topic === "shape" && listAsk && listed))) continue;
      distinct.push(option);
    }
    if (distinct.length < 2) return;
    forks.push({ topic, options: distinct });
  };
  consider("shape", shapeFork);

  // Platform: recommend's own top parts differ only by platform word, so the answer picks one.
  const chosenPlatform = resolved.get("platform")?.[0]?.id ?? platform;
  let platformPick: BriefCandidate | undefined;
  // When recommend already picked a density variant, that is the part. A desktop or phone word does not replace it.
  const densityLead = lead.platformRows[0];
  if (densityLead && (platformWord(densityLead.name) === "compact" || platformWord(densityLead.name) === "comfortable")) {
    platformPick = densityLead;
  }
  if (chosenPlatform && platformRows.length) {
    const top = rank(`${stripped} ${chosenPlatform}`).platformRows[0];
    if (top && platformWord(top.name) === chosenPlatform) platformPick = top;
  } else if (fits && platformRows.length >= 2 && !shapes.length && !named.length) {
    // A request that already names its part or shape ("a form with a list") is not asked platform.
    const options: Choice[] = [];
    for (const row of platformRows) {
      const id = platformWord(row.name);
      if (!id || options.some((option) => option.id === id)) continue;
      if (rank(`${stripped} ${id}`).platformRows[0]?.name !== row.name) continue;
      options.push({ id, label: row.name, contrast: id, masterId: row.id });
    }
    if (options.length >= 2) forks.push({ topic: "platform", options });
  }
  // The request states a density or platform ("a dense list of rows") and the library has that version of
  // the asked part (Compact List): pick it, even when a plainer part (List Row) ranks first.
  if (chosenPlatform && !platformPick) {
    const kind = (choice: Choice) => nameTokens(choice.label).filter((token) => token !== choice.id);
    const own = catalog.platform.find((choice) => choice.id === chosenPlatform && kind(choice).length > 0 && kind(choice).every((token) => asks.some((word) => sameWordForm(word, token))));
    const master = own ? masters.find((item) => item.id === own.masterId) : undefined;
    if (master) platformPick = candidateOf(master);
  }
  // States: the pick is a real part that is not a platform part (a nav has no empty or loading state),
  // and the request names no state. Each answer adds its own part (Empty Message, Error Alert).
  // A request that names a part plus a context ("summary cards for the order") is specific: no states question.
  const partWords = [...shapes.map((choice) => choice.label), ...named.map((master) => master.name)].flatMap(nameTokens);
  const context = asks.filter((word) => !partWords.some((part) => sameWordForm(part, word)));
  const specific = (shapes.length > 0 || named.length > 0) && context.length > 0;
  // A state option only when picking it adds a part the request does not already have.
  const have = new Set([...named.map((master) => master.id), ...leadRows.map((row) => row.id)]);
  const stateOptions = catalog.states.filter((choice) => !have.has(choice.masterId));
  const statePart = !platformRows.length && !platformPick && (leadRows.length > 0 || shapes.length > 0 || named.length > 0 || answerFit);
  if (fits && statePart && !specific && !answeredStates && !listAsk && stateOptions.length >= 2) {
    forks.push({ topic: "states", options: stateOptions, multiple: true });
  }

  // Two or more parts compete for the one asked part, and nothing in the request or an answer picked one: ask which.
  const competing = [...new Map(leadRows.map((row) => [row.name, row])).values()];
  if (fits && !forks.length && !resolved.size && !named.length && !shapes.length && !states.length && !platformRows.length && competing.length >= 2) {
    forks.push({ topic: "part", options: competing.map((row) => ({ id: row.id, label: row.name, contrast: "", masterId: row.id })) });
  }

  const realCandidates = (): BriefCandidate[] => {
    const rows: BriefCandidate[] = [];
    const seen = new Set<string>();
    const push = (row: BriefCandidate, allowPlatform = false) => {
      if (seen.has(row.id)) return;
      if (!allowPlatform && platformComponentName(row.name)) return;
      seen.add(row.id);
      rows.push(row);
    };
    if (recipe) for (const row of recipeCandidates(input, recipe)) push(row);
    else if (decision) push(candidateOf(decision.master));
    else {
      for (const master of named) push(candidateOf(master), containsPhrase(stripped, master.name));
      const chosenPart = resolved.get("part")?.[0];
      for (const [head, group] of groups) {
        const pool = plainRequirements(group, head);
        if (pool.length === 1 && pool[0]) {
          push(candidateOf(pool[0]));
          continue;
        }
        const chosen = pool.find((master) => chosenPart && (chosenPart.id === master.id || chosenPart.label === master.name || chosenPart.masterId === master.id));
        if (chosen) push(candidateOf(chosen));
      }
      for (const choice of [...(parts.length >= 2 ? [] : answeredShape ? shapes.slice(0, 1) : []), ...states]) {
        const master = masters.find((item) => item.id === choice.masterId);
        if (master) push(candidateOf(master));
      }
      for (const choice of componentChoices(resolved)) {
        const master = masters.find((item) => item.id === choice.masterId);
        if (master) push(candidateOf(master));
      }
      if (platformPick) push(platformPick, true);
      if (!rows.length) for (const row of leadRows) push(row);
      if (!rows.length) for (const row of platformRows) push(row, true);
    }
    return rows;
  };

  if (!fits) return ready(justBuild ? "just-build" : "no-match", [NO_MATCH], []);
  if (recipe && !realCandidates().length) return ready(justBuild ? "just-build" : "no-match", [NO_MATCH], []);

  if (justBuild) {
    const assumptions = forks.length
      ? forks.slice(0, BRIEF_QUESTION_CAP).map((fork) => `Assumed ${TOPIC_NAME[fork.topic]}: none named. No questions asked.`)
      : ["No questions asked."];
    if (recipe) assumptions.unshift(`Assumed the ${recipe.title} recipe.`);
    if (decision) assumptions.unshift(`Assumed the approved decision: ${decision.summary}`);
    return ready("just-build", assumptions, realCandidates());
  }

  if (recipe) return ready("recipe", [`Recipe ${recipe.title} matches. Slots decide the parts.`], realCandidates());
  if (decision) return ready("decision", [`Approved decision: ${decision.summary}`], realCandidates());

  const chosenPart = resolved.get("part")?.[0];
  for (const [head, group] of groups) {
    const pool = plainRequirements(group, head);
    if (pool.length < 2) continue;
    const answered = pool.some((master) => chosenPart && (chosenPart.id === master.id || chosenPart.label === master.name || chosenPart.masterId === master.id));
    if (answered) continue;
    forks.unshift({ topic: "part", options: pool.map((master) => ({ id: master.id, label: master.name, contrast: "", masterId: master.id })) });
  }

  const asked = forks.slice(0, BRIEF_QUESTION_CAP);
  if (asked.length) {
    return {
      questions: asked.map((fork) => ({
        topic: fork.topic,
        prompt: fork.topic === "part"
          ? `Which part: ${joinOr(fork.options.map((option) => option.label))}?`
          : `${joinOr(fork.options.map((option) => option.label))}: ${joinOr(fork.options.map((option) => option.contrast))}?${fork.multiple ? " Pick any that apply." : ""}`,
        options: fork.options.map((option) => ({ id: option.id, label: option.label })),
        ...(fork.multiple ? { multiple: true as const } : {}),
      })),
    };
  }

  const candidates = realCandidates();
  if (!candidates.length) return ready("no-match", [NO_MATCH], []);
  const weakPick = candidates.find((row) => row.weak);
  const fallback = weakPick
    ? `Weak, check: ${weakPick.name} is a weak match for this request. Confirm it before placing.`
    : candidates.length === 1 ? "Only one candidate fits." : "No question would change the component.";
  const assumptions = notes.length ? (weakPick ? [...notes, fallback] : notes) : [fallback];
  return ready(candidates.length === 1 ? "one-candidate" : "answered", assumptions, candidates);
}

function recipeCandidates(input: BriefInput, recipe: Recipe): BriefCandidate[] {
  const filled = fillRecipe(
    input.index,
    recipe,
    undefined,
    undefined,
    input.workspace,
    input.dsck,
    input.bindRules,
    input.placeholders,
  );
  const seen = new Set<string>();
  const rows: BriefCandidate[] = [];
  for (const slot of filled.slots) {
    const master = slot.master;
    if (!master || slot.status === "deprecated" || seen.has(master.id) || platformComponentName(master.name)) continue;
    seen.add(master.id);
    rows.push(candidateOf(master));
  }
  return rows;
}
