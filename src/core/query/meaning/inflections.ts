import { GENERIC_NAME_TOKENS, tokensOf } from "../queryTokens";
import { synonymIn } from "../recommendLexicon";
import { inflectionStems } from "../screenInventory";
import type { MeaningDictionary, ParsedAttribute } from "./types";

/** A shared noun ("item") kept an -ed/-ing word only as a guess. */
export interface SharedGuess {
  word: string;
  part: string[];
}

export interface MeaningTokens {
  tokens: string[];
  shared: SharedGuess[];
  attributes: ParsedAttribute[];
}

function nameSetsOf(dictionary: MeaningDictionary): Set<string>[] {
  return dictionary.entries.filter((entry) => !entry.retired).map((entry) => new Set(entry.nameTokens));
}

/**
 * Read -ed and -ing words against the dictionary.
 * A word that only describes the next noun is left out ("selected tab" is a tab).
 * A word whose stem, with that noun or the noun's synonym, is a component is read as the stem
 * ("dated picker" is a date picker, "saving button" is the save button).
 * "dated" after a card is a date attribute on the card, not the date picker.
 */
export function interpretInflections(tokens: readonly string[], dictionary: MeaningDictionary): MeaningTokens {
  const nameSets = nameSetsOf(dictionary);
  const attributes: ParsedAttribute[] = [];
  const directPartWordIn = (names: Set<string>, token: string) =>
    names.has(token) || [...names].some((name) => [`${name}s`, `${name}es`].includes(token) || [`${token}s`, `${token}es`].includes(name));
  const partWordIn = (names: Set<string>, token: string) => directPartWordIn(names, token) || synonymIn(token, names, false);
  const partWord = (token: string) => nameSets.some((names) => partWordIn(names, token));
  const wholePart = (token: string) => nameSets.some((names) => names.size === 1 && partWordIn(names, token));
  const stemFor = (token: string, later: readonly string[]): { stem: string; shared?: SharedGuess } | undefined => {
    let guess: { stem: string; shared?: SharedGuess } | undefined;
    for (const names of nameSets) {
      const stem = inflectionStems(token).find((form) => names.has(form));
      if (!stem) continue;
      if (later.some((word) => word !== token && directPartWordIn(names, word))) return { stem };
      // "saving button": save is on Save CTA, and button is the synonym of cta.
      if (later.some((word) => word !== token && synonymIn(word, names, false))) return { stem };
      const shared = later.find((word) => word !== token && names.size > 1 && GENERIC_NAME_TOKENS.has(word) && !wholePart(word));
      if (shared && !guess) guess = { stem, shared: { word: shared, part: [...names] } };
    }
    return guess;
  };
  const shared: SharedGuess[] = [];
  const read = tokens.flatMap((token, index) => {
    const later = tokens.slice(index + 1);
    if (!/(?:ed|ing)$/.test(token) || partWord(token) || !later.some(partWord)) return [token];
    const found = stemFor(token, later);
    if (found?.shared) shared.push(found.shared);
    if (!found) {
      const stem = inflectionStems(token).find((form) => form === "date" || form === "time");
      const whole = later.find((word) => wholePart(word));
      if (stem && whole) attributes.push({ kind: "date", value: stem });
      return token === "warning" ? [token] : [];
    }
    return [found.stem];
  });
  // "a card that is dated": the date word comes after the noun, so the before-noun rule never sees it.
  const next = read.filter((token, index) => {
    if (!/(?:ed|ing)$/.test(token) || partWord(token)) return true;
    const stem = inflectionStems(token).find((form) => form === "date" || form === "time");
    if (!stem) return true;
    const others = read.filter((_, at) => at !== index);
    const namesBoth = nameSets.some((names) => names.has(stem) && others.some((word) => partWordIn(names, word)));
    if (namesBoth) return true;
    const host = others.some((word) => nameSets.some((names) => partWordIn(names, word) && !names.has(stem)));
    if (!host) return true;
    attributes.push({ kind: "date", value: stem });
    return false;
  });
  const seen = new Set<string>();
  const unique = attributes.filter((row) => {
    const key = `${row.kind}:${row.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { tokens: next, shared, attributes: unique };
}

/** "dated picked": only -ed/-ing words, and none of them is a component word as written. */
export function onlyInflectedAsk(text: string, dictionary: MeaningDictionary): boolean {
  const raw = tokensOf(text);
  if (raw.length < 2) return false;
  const asWritten = (token: string) =>
    dictionary.entries.some((entry) => !entry.retired && entry.nameTokens.includes(token)) ||
    dictionary.synonymGroups.some((group) => group.includes(token));
  return raw.every((token) => /(?:ed|ing)$/.test(token) && !asWritten(token));
}
