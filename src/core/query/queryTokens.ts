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
  ["compact", "compact"],
  ["comfortable", "comfortable"],
  ...["dense", "condensed", "tight"].map((word) => [word, "compact"] as const),
  ...["spacious", "roomy", "airy", "relaxed"].map((word) => [word, "comfortable"] as const),
]);

/** Device and platform words a density can be said for: "compact for phones", "on the tablet", "in landscape". */
const DEVICE_WORD = String.raw`(?:mobile|desktop|tablet|phone|web|ios|android|ipad|iphone|pixel|galaxy|laptop|watch|tv|handset|(?:small|large|big|wide|narrow)\s+(?:screen|display)|portrait|landscape)`;
/**
 * Where a density said after the list ends its clause: end, comma, ; ! . or please, or for/on/in a device that
 * itself ends the text or is followed by punctuation or please. "for a watch party" describes a party, not a device.
 */
const CLAUSE_END = new RegExp(
  String.raw`^(?:\s*$|\s*,|\s*[.;!]|\s+please\b|\s+(?:for|on|in)\s+(?:(?:the|a|an|my|your|our)\s+)?${DEVICE_WORD}(?:e?s)?(?=\s*$|\s*[,.;!]|\s+please\b))`,
  "i",
);

/**
 * A density word that modifies list or row is that density. Before: "a dense list" reads "a compact list",
 * "airy rows" reads "comfortable rows". After, joined by a comma, "but", or "that is": "a list, but dense",
 * "a list that is roomy", "payee list, tight". Not a row of another part: "a dense row of buttons" stays as
 * written, so Button wins. "row(s) with/containing/full of <part>" is the same: that named part wins.
 * Anywhere else it stays as written too: "a tight deadline", "a tight nav bar", and "a list of dense
 * documents" (it describes the items) say nothing about list density.
 */
/** Words that break a noun phrase, so a density word before them does not modify the list. */
const DENSITY_GAP_STOP = new Set(["a", "an", "the", "and", "or", "but", "of", "for", "to", "with", "on", "in", "my", "your", "our", "their", "from", "into"]);
/** Density words that can sit before a noun and still mean the list, when that noun is a listed thing. */
const LIST_DENSITY = new Set(["compact", "comfortable", "dense", "condensed", "tight", "roomy", "airy", "spacious"]);
/** Nouns a list holds. A density word before one of these is about the list, not the noun. */
const LIST_ITEM = new Set(["contact", "task", "payee", "person", "user", "friend", "message", "email", "file", "photo", "song", "product", "order", "invoice", "trip", "name", "result", "option", "chip", "card", "row", "item", "entry", "customer", "member", "guest", "ticket", "issue", "comment", "note", "image", "video", "link", "tag", "field", "button", "icon", "record"]);
/** Nouns these words describe on their own. "dense history", "tight deadline", "compact car". An unknown noun stays a question. */
const DESCRIBES: Record<string, Set<string>> = {
  dense: new Set(["history", "text", "prose", "fog", "forest", "crowd", "traffic", "story", "narrative", "book", "novel", "detail", "document", "material", "population", "archive", "data", "writing", "passage", "chapter", "copy", "thicket", "jungle", "biography", "chronicle"]),
  condensed: new Set(["milk", "version", "summary", "book", "novel", "text", "soup", "story", "prose"]),
  tight: new Set(["deadline", "budget", "schedule", "turnaround", "timeline", "margin", "race", "spot", "space", "squeeze"]),
  roomy: new Set(["room", "seat", "cabin", "interior", "pocket", "space", "kitchen", "car", "bag", "hall", "office", "house", "home", "loft", "apartment"]),
  airy: new Set(["room", "space", "kitchen", "layout", "loft", "hall", "office", "house", "home", "interior", "hero"]),
  spacious: new Set(["room", "kitchen", "interior", "cabin", "office", "home", "house", "hall", "apartment", "loft", "seat", "car", "hero"]),
  comfortable: new Set(["chair", "seat", "shoe", "bed", "sofa", "couch", "fit", "margin"]),
  compact: new Set(["car", "camera", "suv", "disc", "disk", "appliance", "kitchen", "form", "sedan"]),
};
function nounStem(word: string): string {
  const lower = word.toLowerCase();
  if (lower.length >= 5 && lower.endsWith("ies")) return `${lower.slice(0, -3)}y`;
  if (lower.length >= 4 && lower.endsWith("es")) {
    const stem = lower.slice(0, -2);
    if (/(?:s|x|z|ch|sh)$/.test(stem)) return stem;
  }
  if (lower.length >= 4 && lower.endsWith("s") && !lower.endsWith("ss")) return lower.slice(0, -1);
  return lower;
}
/** True when the density word describes the noun, false when the noun is a listed thing, otherwise unsure. */
function densityDescribesNoun(word: string, noun: string): boolean | "unsure" {
  const stem = nounStem(noun);
  const described = DESCRIBES[word.toLowerCase()];
  if (described?.has(stem) || described?.has(noun.toLowerCase())) return true;
  if (LIST_ITEM.has(stem) || LIST_ITEM.has(noun.toLowerCase())) return false;
  return "unsure";
}

export function readDensity(text: string): string {
  const as = (word: string) => DENSITY_WORD.get(word.toLowerCase());
  const beforeRow = text.replace(
    /\b([a-z]+)(\s+)(?=(rows?)\b((?:\s+of|\s+containing|\s+full\s+of|\s+with)\s+[a-z])?)/gi,
    (match, word: string, space: string, noun: string, rowPart?: string) => {
    const lower = word.toLowerCase();
    const density = as(word);
    if (rowPart && /^rows?$/i.test(noun)) {
      // "compact row of buttons" should not say list density.
      if (density && lower === density) return `${density === "compact" ? "dense" : "airy"}${space}`;
      return match;
    }
    return density ? `${density}${space}` : match;
  });
  // The head "list" can have up to two words between it and the density word: "a dense contact list".
  const densityWord = [...DENSITY_WORD.keys()].join("|");
  const before = beforeRow.replace(
    new RegExp(String.raw`\b(${densityWord})(\s+(?:[a-z]+\s+){0,2})(?=lists?\b)`, "gi"),
    (match, word: string, gap: string) => {
      const density = as(word);
      if (!density) return match;
      const between = gap.trim().split(/\s+/).filter(Boolean);
      if (between.some((token) => DENSITY_GAP_STOP.has(token))) return match;
      // Nothing between the word and list: "a dense list" is the list's density.
      if (between.length === 0) return `${density}${gap}`;
      // A noun in between: only a known density word, and only when it does not describe that noun.
      // An unknown noun keeps main's question instead of committing to Compact or Comfortable.
      if (!LIST_DENSITY.has(word.toLowerCase())) return match;
      if (between.some((token) => densityDescribesNoun(word, token) !== false)) {
        // "compact car list" is a list of compact cars, not Compact List. Drop the variant word.
        if (word.toLowerCase() === "compact" || word.toLowerCase() === "comfortable") return gap;
        return match;
      }
      return `${density}${gap}`;
    },
  );
  const after = before.replace(
    new RegExp(String.raw`\b(list|lists|row|rows)((?:\s*,\s*|\s+)(?:but\s+|that\s+is\s+|that\s+are\s+|which\s+is\s+|that's\s+)?)([a-z]+)\b(?=${CLAUSE_END.source.slice(1)})`, "gi"),
    (match, noun: string, joint: string, word: string) => {
      const density = as(word);
      // A bare "list dense" with no comma, but, which is, or that is/are is not a list density.
      return density && /,|but|that|which|that's/i.test(joint) ? `${noun}${joint}${density}` : match;
    },
  );
  return after;
}
