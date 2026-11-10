/** Recommend tokenizer. Stopwords stay here so other rankers keep their own lists. */


export const STOPWORDS = new Set([
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
  "titled",
]);
export const tokensOf = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 1 && !STOPWORDS.has(part));
/** Words that start a description of the part: what it is for, what it holds, where it sits, what it does ("switch that turns"). */
export const DESCRIBING_WORD = new Set(["for", "to", "with", "when", "while", "on", "at", "under", "above", "below", "after", "before", "showing", "holding", "that", "which", "whose"]);
/** Words that only stand in for a part: "a way to pick a date", "a tool to save the draft". */
export const FILLER_HEAD = new Set(["something", "anything", "stuff", "thing", "things", "widget", "control", "way", "tool"]);
/** "a calendar to choose the date" is a chooser of what it chooses. */
export const CHOOSE = new Set(["choose", "pick", "grab", "select"]);
/** A bare entry word takes its kind from what it takes: "field to pick the date". */
export const ENTRY_NOUN = new Set(["field", "input", "box", "picker"]);
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

