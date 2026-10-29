import type { CatalogEntry, FigmaMaster } from "./code/scan.ts";
import { nameWords, RELATED, stem, STOP, tokens } from "./code/words.ts";

/** Names that never auto-pair on the name alone. Config `pairDeny` adds more. A mapping deny still beats a confirm. */
export const BUILTIN_PAIR_DENY = ["stepper"];
export const RISKY_TIER = "risky: same name only";

const plural = (word: string) => (word.length > 3 && word.endsWith("ies") ? `${word.slice(0, -3)}y` : word.length > 3 && word.endsWith("s") && !/(ss|us|is)$/.test(word) ? word.slice(0, -1) : word);
const NEGATIVE = /avoid\s*:|don['’]?t\s+use|do\s+not\s+use|instead\s+use/gi;

/** Comparable key for a Figma or code name. Same folding as the pairer: case, hyphen, plural. */
export function pairKey(name: string): string {
  return (nameWords(name).toLowerCase().match(/[a-z0-9]+/g) ?? []).map(plural).join("");
}

export function pairDenySet(extra?: readonly string[]): Set<string> {
  return new Set([...BUILTIN_PAIR_DENY, ...(extra ?? [])].map((name) => pairKey(name)));
}

/** Whole tokens, hyphen kept. `multi-step` stays one token and does not equal `stepper`. Stems compare as whole tokens too. */
function phraseKeys(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [];
  const out: string[] = [];
  for (const word of words) {
    if (!word.includes("-")) {
      out.push(...tokens(word));
      continue;
    }
    const key = word.split("-").map((part) => stem(part)).join("-");
    if (key.length > 1 && !STOP.has(word) && !key.split("-").every((part) => STOP.has(part))) out.push(key);
  }
  return out;
}

/** Text after Avoid:, Don't use, Do not use, or instead use is negative. The rest of that sentence only. */
function poles(text: string): { yes: string; no: string } {
  let yes = "";
  let no = "";
  let cursor = 0;
  for (const mark of text.matchAll(new RegExp(NEGATIVE.source, "gi"))) {
    const at = mark.index ?? 0;
    if (at < cursor) continue;
    yes += ` ${text.slice(cursor, at)}`;
    const from = at + mark[0].length;
    const rest = text.slice(from);
    const stop = rest.search(/[.!?](?:\s|$)/);
    const end = stop < 0 ? text.length : from + stop + 1;
    no += ` ${text.slice(from, end)}`;
    cursor = end;
  }
  yes += ` ${text.slice(cursor)}`;
  return { yes, no };
}

function nameFragment(word: string, names: readonly string[]): boolean {
  return word.split("-").some((part) => {
    const piece = stem(part);
    return piece.length >= 4 && names.some((name) => name.length >= 4 && name !== piece && (name.startsWith(piece) || piece.startsWith(name)));
  });
}

function partSlug(name: string): string {
  return nameWords(name).toLowerCase().trim().replace(/\s+/g, "-");
}

function specificPart(name: string): boolean {
  return partSlug(name).split("-").map((word) => stem(word)).some((word) => word && !GENERIC_STATES.has(word) && !GENERIC_PAIR_WORDS.has(word));
}

/** Attached base parts match code elements (`tabs__tab` lines up with `base/tab`). A generic state alone does not. */
export function partsLineUp(entry: CatalogEntry, partNames: readonly string[]): boolean {
  const tails = new Set((entry.code?.elements ?? []).map((cls) => (cls.split("__").pop() ?? cls).toLowerCase()));
  const specific = partNames.filter(specificPart);
  if (!specific.length || tails.size === 0) return false;
  return specific.every((name) => tails.has(partSlug(name)));
}

/** One shared word from this set must not clear the suggestion floor by itself. */
export const GENERIC_PAIR_WORDS = new Set("group card input item list row icon text label box field view container wrapper content element block section panel tile set".split(" "));

/** States and sizes. A shared one is not evidence. Compared after stemming, same as `tokens`. */
const GENERIC_STATES = new Set(
  "disabled hover hovered focus focused focus-visible active default selected error size pressed checked enabled loading open closed expanded collapsed invalid success warning visited readonly visible small medium large xs sm md lg xl style state variant type mode appearance".split(" ").map((word) => stem(word)),
);

const specific = (words: string[]) => words.filter((word) => !GENERIC_STATES.has(word) && !GENERIC_PAIR_WORDS.has(word));

/** Positive overlap only: a specific variant, modifier, description phrase, or base parts that match elements. A missing signal is not agreement. Generic states never count. Negative description text never counts as agreement. */
export function secondSignal(master: FigmaMaster, entry: CatalogEntry, partNames: readonly string[] = [], deny: ReadonlySet<string> = pairDenySet()): { agree: boolean; disagree: boolean } {
  const mv = specific(tokens((master.variants ?? []).join(" ").replace(/[-_]+/g, " ")));
  const modifiers = Object.values(entry.code?.modifiers ?? {}).flat().map((cls) => cls.split("--").pop() ?? cls);
  const ev = specific(tokens([...entry.variants, ...modifiers].join(" ").replace(/[-_]+/g, " ")));
  const names = [pairKey(master.name), pairKey(entry.name)];
  const denied = names.some((name) => deny.has(name));
  const own = new Set(tokens(`${nameWords(master.name)} ${nameWords(entry.name)}`));
  const keep = (text: string) => specific(phraseKeys(text)).filter((word) => !own.has(word) && !(denied && nameFragment(word, names)));
  const left = poles(master.description ?? "");
  const right = poles(`${entry.description} ${entry.doc ?? ""}`);
  const posL = keep(left.yes);
  const posR = keep(right.yes);
  const negL = keep(left.no);
  const negR = keep(right.no);
  const hit = (a: string[], b: readonly string[]) => a.some((word) => b.includes(word));
  const variantHit = hit(mv, ev);
  const textAgree = hit(posL, posR);
  const textConflict = posL.length > 0 && posR.length > 0 && !textAgree;
  const negConflict = hit(negL, posR) || hit(negR, posL);
  const variantConflict = mv.length > 0 && ev.length > 0 && !variantHit;
  const structural = partsLineUp(entry, partNames) && !negConflict && !textConflict && !variantConflict;
  const agree = variantHit || (textAgree && !negConflict) || structural;
  const disagree = !agree && (variantConflict || textConflict || negConflict);
  return { agree, disagree };
}

export function sameNameRow(figma: string, code: string, disagree: boolean): { figma: string; code: string; confidence: "suggested" | typeof RISKY_TIER; score: number; reasons: string[] } {
  if (disagree) return { figma, code, confidence: "suggested", score: 1, reasons: ["same name, no evidence"] };
  return { figma, code, confidence: RISKY_TIER, score: 1, reasons: [RISKY_TIER, "same name, no evidence"] };
}

/** Bulk confirm skips a same-name row with no positive evidence. Confirm that pair on its own. */
export function forBulkConfirm<T extends { confidence?: string; reasons?: readonly string[] }>(rows: readonly T[]): T[] {
  return rows.filter((row) => row.confidence !== RISKY_TIER && !(row.reasons ?? []).some((reason) => reason === RISKY_TIER || reason === "same name, no evidence"));
}

/** `paired + parts + unmatched` against the Figma total. Parts on a pair and parts on an unpaired block both count once. */
export function figmaTotalCheck(report: { figmaComponents: number; pairs: Array<{ figma: string; parts?: string[] }>; unpairedParts?: Array<{ parts: string[] }>; unmatchedFigma: string[]; heldFigma?: string[] }): string {
  const paired = new Set(report.pairs.map((pair) => pair.figma)).size;
  const parts = new Set([...report.pairs.flatMap((pair) => pair.parts ?? []), ...(report.unpairedParts ?? []).flatMap((row) => row.parts)]).size;
  const open = report.unmatchedFigma.length;
  const held = report.heldFigma?.length ?? 0;
  const sum = paired + parts + open + held;
  const review = held ? ` + ${held} in review` : "";
  return `${paired} paired + ${parts} parts + ${open} unmatched${review} = ${sum}${sum === report.figmaComponents ? "" : `, not ${report.figmaComponents}`}`;
}

/** Block a part belongs on: plural (tab/tabs), compound (field-label), or a prefix family (steps/stepper). */
export function partOwner(partName: string, blocks: CatalogEntry[], namespaces: ReadonlySet<string>, plural: (word: string) => string, order: (a: string, b: string) => number): CatalogEntry | undefined {
  const words = nameWords(partName, namespaces).toLowerCase().split(/\s+/).filter(Boolean).map(plural);
  const slug = words.join("-");
  const head = stem(words[0] ?? "");
  return blocks.filter((entry) => {
    const body = entry.name.toLowerCase().split("-").map(plural);
    const block = body.join("-");
    if (slug && (slug === block || slug.startsWith(`${block}-`))) return true;
    const other = stem(body[0] ?? "");
    const prefixed = head.length >= 4 && other.length >= 4 && head !== other && (head.startsWith(other) || other.startsWith(head));
    return prefixed && ((RELATED.get(head) ?? []).some(([word]) => word === other) || (RELATED.get(other) ?? []).some(([word]) => word === head));
  }).sort((a, b) => b.name.length - a.name.length || order(a.name, b.name))[0];
}
