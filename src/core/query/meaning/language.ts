import type { MeaningLanguage } from "./types";

/**
 * Density and device words are meaning, stored on each library dictionary.
 * "dense" means the compact density. "roomy" means comfortable.
 */
export const MEANING_LANGUAGE: MeaningLanguage = {
  density: {
    compact: ["compact", "dense", "condensed", "tight"],
    comfortable: ["comfortable", "spacious", "roomy", "airy", "relaxed"],
  },
  device: [
    "mobile",
    "desktop",
    "tablet",
    "phone",
    "web",
    "ios",
    "android",
    "ipad",
    "iphone",
    "pixel",
    "galaxy",
    "laptop",
    "watch",
    "tv",
    "handset",
    "portrait",
    "landscape",
  ],
};

const DENSITY_WORD = new Map<string, string>();
for (const [canonical, words] of Object.entries(MEANING_LANGUAGE.density)) {
  for (const word of words) DENSITY_WORD.set(word, canonical);
}

const DEVICE_WORD = `(?:${MEANING_LANGUAGE.device.join("|")}|(?:small|large|big|wide|narrow)\\s+(?:screen|display))`;
/**
 * A density said after the list ends its clause at the end, at punctuation, at please,
 * or at for/on/in plus a device. "for a phone plan" is a plan, not a device.
 */
const CLAUSE_END = new RegExp(
  String.raw`^(?:\s*$|\s*,|\s*[.;!]|\s+please\b|\s+(?:for|on|in)\s+(?:(?:the|a|an|my|your|our)\s+)?${DEVICE_WORD}(?:e?s)?(?=\s*$|\s*[,.;!]|\s+please\b))`,
  "i",
);

/**
 * A density word that modifies list or row becomes the canonical density.
 * Before the noun ("a dense list") or, after it, only with a comma, but, or that/which is,
 * and only through the end of that clause. A row of another part is left alone.
 */
export function normalizeDensity(text: string): string {
  const as = (word: string) => DENSITY_WORD.get(word.toLowerCase());
  const before = text.replace(
    /\b([a-z]+)(\s+)(?=(list|lists|row|rows)\b((?:\s+of|\s+containing|\s+full\s+of|\s+with)\s+[a-z])?)/gi,
    (match, word: string, space: string, noun: string, rowPart?: string) => {
      const lower = word.toLowerCase();
      const density = as(word);
      if (rowPart && /^rows?$/i.test(noun)) {
        if (density && lower === density) return `${density === "compact" ? "dense" : "airy"}${space}`;
        return match;
      }
      return density ? `${density}${space}` : match;
    },
  );
  return before.replace(
    new RegExp(String.raw`\b(list|lists|row|rows)((?:\s*,\s*|\s+)(?:but\s+|that\s+is\s+|that\s+are\s+|which\s+is\s+|that's\s+)?)([a-z]+)\b(?=${CLAUSE_END.source.slice(1)})`, "gi"),
    (match, noun: string, joint: string, word: string) => {
      const density = as(word);
      return density && /,|but|that|which|that's/i.test(joint) ? `${noun}${joint}${density}` : match;
    },
  );
}

export function densityCanonical(word: string): string | undefined {
  return DENSITY_WORD.get(word.toLowerCase());
}
