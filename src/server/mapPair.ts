import type { CatalogEntry, FigmaMaster } from "./code/scan.ts";
import { nameWords, RELATED, stem, tokens } from "./code/words.ts";

/** One shared word from this set must not clear the suggestion floor by itself. */
export const GENERIC_PAIR_WORDS = new Set("group card input item list row icon text label box field view container wrapper content element block section panel tile set".split(" "));

/** States and sizes. A shared one is not evidence. Compared after stemming, same as `tokens`. */
const GENERIC_STATES = new Set(
  "disabled hover hovered focus focused focus-visible active default selected error size pressed checked enabled loading open closed expanded collapsed invalid success warning visited readonly visible small medium large xs sm md lg xl style state variant type mode appearance".split(" ").map((word) => stem(word)),
);

const specific = (words: string[]) => words.filter((word) => !GENERIC_STATES.has(word) && !GENERIC_PAIR_WORDS.has(word));

/** Positive overlap only: a specific variant value, class modifier, or description phrase. A missing signal is not agreement, and a generic state never counts. */
export function secondSignal(master: FigmaMaster, entry: CatalogEntry): { agree: boolean; disagree: boolean } {
  const mv = specific(tokens((master.variants ?? []).join(" ").replace(/[-_]+/g, " ")));
  const modifiers = Object.values(entry.code?.modifiers ?? {}).flat().map((cls) => cls.split("--").pop() ?? cls);
  const ev = specific(tokens([...entry.variants, ...modifiers].join(" ").replace(/[-_]+/g, " ")));
  const own = new Set(tokens(`${nameWords(master.name)} ${nameWords(entry.name)}`));
  const phrase = (text: string) => specific(tokens(text)).filter((word) => !own.has(word));
  const md = phrase(master.description ?? "");
  const ed = phrase(`${entry.description} ${entry.doc ?? ""}`);
  const hit = (left: string[], right: readonly string[]) => left.some((word) => right.includes(word));
  const agree = hit(mv, ev) || hit(md, ed);
  const disagree = !agree && ((mv.length > 0 && ev.length > 0 && !hit(mv, ev)) || (md.length > 0 && ed.length > 0 && !hit(md, ed)));
  return { agree, disagree };
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
