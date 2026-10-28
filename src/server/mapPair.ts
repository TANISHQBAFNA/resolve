import type { CatalogEntry, FigmaMaster } from "./code/scan.ts";
import { nameWords, RELATED, stem, tokens } from "./code/words.ts";

/** One shared word from this set must not clear the suggestion floor by itself. */
export const GENERIC_PAIR_WORDS = new Set("group card input item list row icon text label box field view container wrapper content element block section panel tile set".split(" "));

const variantWords = (entry: CatalogEntry) =>
  new Set(tokens([...entry.variants, ...Object.values(entry.code?.modifiers ?? {}).flat().map((cls) => cls.split("--").pop() ?? cls)].join(" ").replace(/[-_]+/g, " ")));

/** Variant, class, or description overlap. Disagree only when both sides have that signal and share nothing. */
export function secondSignal(master: FigmaMaster, entry: CatalogEntry): { agree: boolean; disagree: boolean } {
  const mv = tokens((master.variants ?? []).join(" "));
  const extra = entry.code ? [...entry.code.elements, ...entry.code.states, ...Object.values(entry.code.modifiers).flat()] : [];
  const ev = [...new Set([...variantWords(entry), ...tokens(extra.join(" "))])];
  const md = tokens(master.description ?? "").filter((word) => !GENERIC_PAIR_WORDS.has(word));
  const ed = tokens(`${entry.description} ${entry.doc ?? ""}`).filter((word) => !GENERIC_PAIR_WORDS.has(word));
  const hit = (left: string[], right: readonly string[]) => left.some((word) => right.includes(word));
  const agree = hit(mv, ev) || hit(md, ed);
  const disagree = !agree && ((mv.length > 0 && ev.length > 0 && !hit(mv, ev)) || (md.length > 0 && ed.length > 0 && !hit(md, ed)));
  return { agree, disagree };
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
