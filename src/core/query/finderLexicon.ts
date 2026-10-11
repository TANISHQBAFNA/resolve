/**
 * Words the finder uses for every ask. Team synonyms live in src/data/synonyms.json.
 * UI modifiers live in src/data/ui-modifiers.json. Nothing here names one phrase.
 */

/** Dropped before matching. They are grammar, not a component. */
export const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "page",
  "screen",
  "frame",
  "component",
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
]);

/** Label words that can sit beside a control. They match, and the card is partial. */
export const LABEL_FILLER = new Set(["sign", "terms", "submit", "submitting", "phone", "number", "country", "edit"]);

/** Unasked position words. "app bar" is the top bar, not the bottom bar. */
export const DEMOTE_UNASKED = new Set(["bottom", "secondary", "right"]);

/** Slot words that pick a variant, not a different component family. */
export const SLOT_QUALIFIERS = new Set(["primary", "secondary", "tertiary", "danger", "ghost"]);

/**
 * Words that mark journey.step as a component slot (primary-cta, input, message).
 * A pack step such as "summary" or "form" stays screen context.
 */
export const SLOT_ROLE_TOKENS = new Set([
  "cta",
  "button",
  "message",
  "input",
  "row",
  "card",
  "icon",
  "header",
  "field",
  "chip",
  "badge",
  "label",
  "search",
  "avatar",
  "banner",
  "toast",
  "modal",
  "switch",
]);

export const RETIRED_NAME_TOKENS = new Set(["legacy", "old", "deprecated", "retired"]);

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
 * A purpose clause after the component. "snackbar after saving" is a snackbar.
 * "of" and "in" are not here: "price of gold" and "link in bio" are not components.
 */
export const SCENE_TAIL_WORDS = ["for", "after", "across", "showing", "that", "while", "during", "when", "at"] as const;
