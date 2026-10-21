import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { BRIEF_PLATFORM_IDS, BRIEF_SHAPE_IDS, BRIEF_STATE_IDS, type BriefCandidate, type BriefResult } from "./brief";
import type { HandoffPack, HandoffScreen } from "./handoff";

/**
 * Decision record: what was asked, which parts were picked and why, what was
 * rejected, and the recipe used or composed. Built from results Resolve already
 * returned (brief, compose, handoff); it never ranks or picks anything itself.
 * Pure: callers write the files.
 */

export const DECISION_SCHEMA_VERSION = 1 as const;

export const DECISION_KINDS = ["brief", "compose", "handoff"] as const;
/** Where a pick came from. */
export const PICK_SOURCES = ["brief", "answer", "recipe", "decision", "compose", "placed"] as const;
/** fit: every word matched; bound: a stored id (recipe or answer); placed: on the screen; to-add: an answer adds it; weak / name-guess: check it. */
export const PICK_MATCHES = ["fit", "bound", "placed", "to-add", "weak", "name-guess"] as const;
export const RECIPE_HOWS = ["saved", "composed", "matched", "asked"] as const;

export const BriefAnswerIdsSchema = z.object({
  shape: z.enum(BRIEF_SHAPE_IDS).optional(),
  platform: z.enum(BRIEF_PLATFORM_IDS).optional(),
  states: z.array(z.enum(BRIEF_STATE_IDS)),
});

export const DecisionPickSchema = z.object({
  name: z.string().min(1),
  /** Graph id when the result had one; handoff parts carry fileKey + figmaNodeId instead. */
  id: z.string().optional(),
  fileKey: z.string().optional(),
  figmaNodeId: z.string().optional(),
  source: z.enum(PICK_SOURCES),
  match: z.enum(PICK_MATCHES),
  why: z.string().optional(),
  screen: z.string().optional(),
  slot: z.string().optional(),
});

export const DecisionRejectSchema = z.object({ what: z.string(), reason: z.string(), screen: z.string().optional() });

/** One owner for the record shape: types below come from it, and stored records are checked against it. */
export const DecisionRecordSchema = z.object({
  schemaVersion: z.literal(DECISION_SCHEMA_VERSION),
  kind: z.enum(DECISION_KINDS),
  createdAt: z.string().min(1),
  request: z.string().optional(),
  screens: z.array(z.string()).optional(),
  context: z.record(z.string(), z.string()).optional(),
  asked: z.array(z.object({ topic: z.string(), prompt: z.string(), options: z.array(z.string()) })),
  answers: BriefAnswerIdsSchema.optional(),
  assumptions: z.array(z.string()),
  skip: z.string().optional(),
  picks: z.array(DecisionPickSchema),
  rejected: z.array(DecisionRejectSchema),
  recipe: z.object({ id: z.string().optional(), title: z.string().optional(), how: z.enum(RECIPE_HOWS), proposal: z.string().optional() }).optional(),
  readAsContext: z.array(z.string()).optional(),
  openQuestions: z.array(z.string()),
  /** brief's offer to compose, or the saved recipe it points to. */
  next: z.string().optional(),
});

export type DecisionKind = (typeof DECISION_KINDS)[number];
export type DecisionPick = z.infer<typeof DecisionPickSchema>;
export type DecisionReject = z.infer<typeof DecisionRejectSchema>;
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

/** A stored record, checked. Throws a plain sentence naming what is wrong. */
export function parseDecisionRecord(raw: unknown, name: string): DecisionRecord {
  const parsed = DecisionRecordSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new Error(`${name} is not a decision record (schemaVersion ${DECISION_SCHEMA_VERSION}): ${issue?.path.join(".") || "record"} ${issue?.message ?? "is invalid"}.`);
}

const pickOf = (row: { id?: string; name: string; fileKey?: string; figmaNodeId?: string }) => ({
  name: row.name,
  ...(row.id ? { id: row.id } : {}),
  ...(row.fileKey ? { fileKey: row.fileKey } : {}),
  ...(row.figmaNodeId ? { figmaNodeId: row.figmaNodeId } : {}),
});

function base(kind: DecisionKind, createdAt: string): DecisionRecord {
  return { schemaVersion: DECISION_SCHEMA_VERSION, kind, createdAt, asked: [], assumptions: [], picks: [], rejected: [], openQuestions: [] };
}

export interface BriefRecordInput {
  request: string;
  answers?: DecisionRecord["answers"];
  /** Parts the answers picked (briefAnswerParts), so a pick can say it came from an answer. */
  answerParts?: BriefCandidate[];
  context?: Record<string, string>;
  result: BriefResult;
  createdAt: string;
}

export function recordFromBrief(input: BriefRecordInput): DecisionRecord {
  const { result } = input;
  const record = base("brief", input.createdAt);
  record.request = input.request;
  if (input.context && Object.keys(input.context).length) record.context = input.context;
  if (input.answers) record.answers = input.answers;
  if ("questions" in result) {
    record.asked = result.questions.map((question) => ({ topic: question.topic, prompt: question.prompt, options: question.options.map((option) => option.label) }));
    record.openQuestions = result.questions.map((question) => question.prompt);
  } else {
    record.skip = result.skip;
    record.assumptions = result.assumptions;
    const fromAnswer = new Set((input.answerParts ?? []).map((part) => part.id));
    const source = result.skip === "recipe" ? "recipe" : result.skip === "decision" ? "decision" : "brief";
    record.picks = result.candidates.map((row) => ({
      ...pickOf(row),
      source: fromAnswer.has(row.id) ? "answer" : source,
      match: fromAnswer.has(row.id) || source !== "brief" ? "bound" : "fit",
      why: result.assumptions[0],
    }));
    if (result.skip === "no-match") record.rejected.push({ what: input.request, reason: "no match in the learned library" });
  }
  const next = result.savedRecipe ?? result.composeOffer;
  if (next) record.next = next;
  return record;
}

/** The parts of a compose card this module reads. */
export interface ComposeCardLike {
  composed?: boolean;
  query?: string;
  recipe?: { id?: string; title?: string };
  slots?: Array<{ role: string; status: string; master?: { id?: string; name: string; fileKey?: string; figmaNodeId?: string }; hint?: string }>;
  part?: { id?: string; name: string; fileKey?: string; figmaNodeId?: string };
  noMatch?: string[];
  weak?: string[];
  readAsContext?: string[];
  duplicates?: string[];
  proposal?: string;
  hint?: string;
}

export function recordFromCompose(input: { request: string; answers?: DecisionRecord["answers"]; card: ComposeCardLike; createdAt: string }): DecisionRecord {
  const { card } = input;
  const record = base("compose", input.createdAt);
  record.request = input.request;
  if (input.answers) record.answers = input.answers;
  if (card.hint) record.assumptions = [card.hint];
  // Weak fits: the card lists them under weak (also when it has no slots: one part, or every part weak).
  for (const line of card.weak ?? []) record.rejected.push({ what: line.replace(/ \(weak, check\)$/, ""), reason: "weak, check" });
  for (const slot of card.slots ?? []) {
    if (!slot.master || slot.status === "weak") continue;
    if (slot.status !== "filled" && slot.status !== "bound") continue;
    record.picks.push({ ...pickOf(slot.master), source: slot.status === "bound" ? "answer" : "compose", match: slot.status === "bound" ? "bound" : "fit", slot: slot.role });
  }
  if (card.part) record.picks.push({ ...pickOf(card.part), source: "compose", match: "fit", why: "One part fits; not a recipe." });
  for (const role of card.noMatch ?? []) record.rejected.push({ what: role, reason: "no match in the learned library" });
  for (const title of card.duplicates ?? []) record.rejected.push({ what: `composed recipe`, reason: `saved recipe ${title} already covers this` });
  if (card.recipe) record.recipe = { ...card.recipe, how: card.composed ? "composed" : "saved", ...(card.proposal && card.proposal !== "none" ? { proposal: card.proposal } : {}) };
  if (card.readAsContext?.length) record.readAsContext = card.readAsContext;
  return record;
}

function screenPicks(screen: HandoffScreen): DecisionPick[] {
  return screen.components.map((row) => ({
    ...pickOf(row),
    source: row.identity === "to-add" ? "answer" : "placed",
    match: row.identity === "to-add" ? "to-add" : row.identity === "confirmed" ? "placed" : "name-guess",
    screen: screen.screen.name,
    ...(row.slot ? { slot: row.slot } : {}),
    why: row.code === "unmapped" ? "No code link (unmapped, never guessed)." : `Code: ${row.code}`,
  }));
}

function screenRejects(screen: HandoffScreen): DecisionReject[] {
  const at = screen.screen.name;
  return [
    ...screen.verify.retired.map((what) => ({ what, reason: "retired", screen: at })),
    ...screen.verify.invents.map((what) => ({ what, reason: "not a library component", screen: at })),
    ...screen.verify.unresolved.map((what) => ({ what, reason: "not found in the learned files", screen: at })),
  ];
}

export function recordFromHandoff(input: { pack: Extract<HandoffPack, { ok: true }>; answers?: DecisionRecord["answers"]; createdAt: string }): DecisionRecord {
  const record = base("handoff", input.createdAt);
  const screens = input.pack.screens;
  record.screens = screens.map((screen) => screen.screen.name);
  const context = screens[0]?.context;
  if (context) record.context = Object.fromEntries(Object.entries(context).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  if (input.answers) record.answers = input.answers;
  record.assumptions = screens.flatMap((screen) => screen.briefing ?? []);
  record.picks = screens.flatMap(screenPicks);
  record.rejected = screens.flatMap(screenRejects);
  record.openQuestions = screens.flatMap((screen) => screen.openQuestions.map((line) => `${screen.screen.name}: ${line}`));
  const recipe = screens.find((screen) => screen.recipe)?.recipe;
  if (recipe) record.recipe = { id: recipe.id, title: recipe.title, how: recipe.matchedBy === "asked" ? "asked" : "matched" };
  return record;
}

const line = (pick: DecisionPick) =>
  `- ${pick.name}${pick.figmaNodeId ? ` (${pick.fileKey ? `${pick.fileKey} ` : ""}${pick.figmaNodeId})` : ""}: ${pick.match}, from ${pick.source}${pick.slot ? `, slot ${pick.slot}` : ""}${pick.screen ? `, on ${pick.screen}` : ""}${pick.why ? `. ${pick.why}` : ""}`;

/** Plain Markdown for people. Same facts as the JSON. */
export function formatDecisionRecord(record: DecisionRecord): string {
  const out = [`# Decision record (${record.kind})`, "", `Made: ${record.createdAt}`];
  if (record.request) out.push(`Request: ${record.request}`);
  if (record.screens?.length) out.push(`Screens: ${record.screens.join(", ")}`);
  if (record.context) out.push(`Context: ${Object.entries(record.context).map(([key, value]) => `${key} ${value}`).join(", ")}`);
  if (record.recipe) out.push(`Recipe: ${record.recipe.title ?? record.recipe.id} (${record.recipe.how}${record.recipe.proposal ? `, proposal ${record.recipe.proposal}` : ""})`);
  const section = (title: string, rows: string[]) => {
    if (rows.length) out.push("", `## ${title}`, "", ...rows);
  };
  section("Asked", record.asked.map((question) => `- ${question.prompt} Options: ${question.options.join(", ")}.`));
  section("Answers", record.answers ? Object.entries(record.answers).filter(([, value]) => (Array.isArray(value) ? value.length : value)).map(([topic, value]) => `- ${topic}: ${Array.isArray(value) ? value.join(", ") : value}`) : []);
  section("Assumptions", record.assumptions.map((text) => `- ${text}`));
  section("Picked", record.picks.map(line));
  section("Rejected", record.rejected.map((row) => `- ${row.what}: ${row.reason}${row.screen ? ` (${row.screen})` : ""}`));
  section("Read as context", (record.readAsContext ?? []).map((text) => `- ${text}`));
  section("Open questions", record.openQuestions.map((text) => `- ${text}`));
  if (record.next) out.push("", `Next: ${record.next}`);
  if (!record.picks.length) out.push("", "No part was picked. Nothing was invented.");
  return `${out.join("\n")}\n`;
}

/** File-safe, unique name: kind, the start of the request or screens, and a hash of the whole record. */
export function decisionSlug(record: DecisionRecord): string {
  const text = record.request ?? record.screens?.join(" ") ?? "record";
  const words = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48).replace(/-$/, "") || "record";
  const hash = createHash("sha1").update(JSON.stringify(record)).digest("hex").slice(0, 10);
  return `${record.kind}-${words}-${hash}`;
}
