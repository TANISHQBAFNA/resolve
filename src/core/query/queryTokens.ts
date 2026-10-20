/** Recommend tokenizer. Stopwords stay here so other rankers keep their own lists. */


const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "page",
  "screen",
  "frame",
  "what",
  "which",
  "kind",
  "of",
  "to",
  "for",
  "should",
  "use",
  "uses",
  "using",
  "i",
  "im",
  "am",
  "building",
  "build",
  "requires",
  "require",
  "need",
  "needs",
  "this",
  "that",
  "our",
  "new",
  "and",
  "or",
  "not",
  "how",
  "does",
  "with",
  "from",
  "between",
  "find",
  "while",
  "during",
  "via",
  "in",
  "after",
  "before",
  "yet",
  "here",
  "there",
  "showing",
  "show",
  "shows",
  "where",
  "you",
  "your",
  "are",
  "is",
  "across",
  "away",
  "about",
  "around",
  "still",
  "also",
  "very",
  "please",
  "component",
  "element",
  "into",
  "onto",
  "over",
  "under",
  "within",
  "without",
  "through",
  "than",
  "then",
  "when",
  "its",
  "them",
  "they",
]);
export const tokensOf = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 1 && !STOPWORDS.has(part));
/** Shared UI nouns. One of these alone must not steal a more specific ask. */
export const GENERIC_NAME_TOKENS = new Set([
  "button",
  "bar",
  "field",
  "icon",
  "label",
  "box",
  "item",
  "text",
  "row",
  "card",
  "message",
  "input",
  "picker",
]);

/**
 * A navigation-type part: it says nav, or it is a header or footer, or a top or bottom bar when the
 * ask names that side (top or header, bottom or footer). An action, progress, or loading bar is not.
 */
export function navFamily(names: Iterable<string>, asked: readonly string[]): boolean {
  const set = new Set(names);
  if (set.has("nav") || set.has("navigation") || set.has("header") || set.has("footer")) return true;
  if (!set.has("bar")) return false;
  const side = (word: string, alias: string) => set.has(word) && asked.some((token) => token === word || token === alias);
  return side("top", "header") || side("bottom", "footer");
}

const DENSITY_WORD = new Map([
  ...["dense", "condensed", "tight"].map((word) => [word, "compact"] as const),
  ...["spacious", "roomy", "airy", "relaxed"].map((word) => [word, "comfortable"] as const),
]);

/**
 * A density word that modifies list or row is that density. Before: "a dense list" reads "a compact list",
 * "airy rows" reads "comfortable rows". After, joined by a comma, "but", or "that is": "a list, but dense",
 * "a list that is roomy", "payee list, tight". Not a row of another part: "a dense row of buttons" stays as
 * written, so Button wins. Anywhere else it stays as written too: "a tight deadline", "a tight nav bar",
 * and "a list of dense documents" (it describes the items) say nothing about list density.
 */
export function readDensity(text: string): string {
  const as = (word: string) => DENSITY_WORD.get(word.toLowerCase());
  const before = text.replace(/\b([a-z]+)(\s+)(?=(list|lists|row|rows)\b(\s+of\s+[a-z])?)/gi, (match, word: string, space: string, noun: string, rowOf?: string) => {
    if (rowOf && /^rows?$/i.test(noun)) return match;
    const density = as(word);
    return density ? `${density}${space}` : match;
  });
  return before.replace(/\b(list|lists|row|rows)((?:\s*,\s*|\s+)(?:but\s+|that\s+is\s+|that's\s+)?)([a-z]+)\b/gi, (match, noun: string, joint: string, word: string) => {
    const density = as(word);
    // A bare "list dense" with no comma, but, or that is is not a description of the list.
    return density && /,|but|that/i.test(joint) ? `${noun}${joint}${density}` : match;
  });
}
