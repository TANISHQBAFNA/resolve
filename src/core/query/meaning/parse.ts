import { tokensOf } from "../queryTokens";
import { interpretInflections, onlyInflectedAsk, type SharedGuess } from "./inflections";
import type { MeaningDictionary, MeaningEntry, MeaningLanguage, ParsedAttribute } from "./types";

/** English function words. They are not a library's vocabulary. */
const GAP_STOP = new Set(["a", "an", "the", "and", "or", "but", "of", "for", "to", "with", "on", "in", "my", "your", "our", "their", "from", "into"]);
const PURPOSE_WORD = new Set(["to", "for", "on", "when"]);
const CHOOSE = new Set(["choose", "pick", "grab", "select"]);
const FILLER_HEAD = new Set(["something", "anything", "stuff", "thing", "things"]);

export interface MeaningDecision {
  text: string;
  tokens: string[];
  shared: SharedGuess[];
  /** Shared nouns that make the lead a guess. */
  weakWords: string[];
  empty: boolean;
  leadName?: string;
  excluded: string[];
  attributes: ParsedAttribute[];
  purposeTokens: string[];
  purpose: string | null;
  head: string | null;
  context: { device?: string; screen?: string };
  reasons: string[];
}

export function languageOf(raw: Partial<MeaningLanguage> | undefined): MeaningLanguage {
  return {
    density: raw?.density ?? {},
    device: raw?.device ?? [],
    describes: raw?.describes ?? {},
    listItems: raw?.listItems ?? [],
  };
}

function wordMap(language: MeaningLanguage): Map<string, string> {
  const map = new Map<string, string>();
  for (const [canonical, words] of Object.entries(language.density)) {
    for (const word of words) map.set(word.toLowerCase(), canonical);
    map.set(canonical.toLowerCase(), canonical);
  }
  return map;
}

function nounStem(word: string): string {
  const lower = word.toLowerCase();
  if (lower.length >= 5 && lower.endsWith("ies")) return `${lower.slice(0, -3)}y`;
  if (lower.length >= 4 && lower.endsWith("es") && /(?:s|x|z|ch|sh)$/.test(lower.slice(0, -2))) return lower.slice(0, -2);
  if (lower.length >= 4 && lower.endsWith("s") && !lower.endsWith("ss")) return lower.slice(0, -1);
  return lower;
}

function describesNoun(language: MeaningLanguage, word: string, noun: string): boolean | "unsure" {
  const stem = nounStem(noun);
  const described = language.describes[word.toLowerCase()] ?? [];
  if (described.includes(stem) || described.includes(noun.toLowerCase())) return true;
  if (language.listItems.includes(stem) || language.listItems.includes(noun.toLowerCase())) return false;
  return "unsure";
}

function deviceSource(device: readonly string[]): string {
  return [...device]
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((word) => {
      const bits = word.split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      const last = bits.length - 1;
      bits[last] = `${bits[last]}(?:e?s)?`;
      return bits.join("\\s+");
    })
    .join("|");
}

/** Rewrite a density word that modifies list or row, using this library's words. */
export function densityText(text: string, language: MeaningLanguage): string {
  const as = (word: string) => wordMap(language).get(word.toLowerCase());
  const known = new Set(wordMap(language).keys());
  const pattern = deviceSource(language.device);
  const clause = pattern
    ? new RegExp(String.raw`^(?:\s*$|\s*,|\s*[.;!]|\s+please\b|\s+(?:for|on|in)\s+(?:(?:the|a|an|my|your|our)\s+)?(?:${pattern})(?=\s*$|\s*[,.;!]|\s+please\b))`, "i")
    : /^(?:\s*$|\s*,|\s*[.;!]|\s+please\b)/i;
  const beforeRow = text.replace(
    /\b([a-z]+)(\s+)(?=(rows?)\b((?:\s+of|\s+containing|\s+full\s+of|\s+with)\s+[a-z])?)/gi,
    (match, word: string, space: string, noun: string, rowPart?: string) => {
      const density = as(word);
      if (rowPart && /^rows?$/i.test(noun)) {
        if (density && word.toLowerCase() === density) return `${density === "compact" ? "dense" : "airy"}${space}`;
        return match;
      }
      return density ? `${density}${space}` : match;
    },
  );
  const words = [...known].sort((a, b) => b.length - a.length).join("|");
  const before = words
    ? beforeRow.replace(new RegExp(String.raw`\b(${words})(\s+(?:[a-z]+\s+){0,2})(?=lists?\b)`, "gi"), (match, word: string, gap: string) => {
        const density = as(word);
        if (!density) return match;
        const between = gap.trim().split(/\s+/).filter(Boolean);
        if (between.some((token) => GAP_STOP.has(token))) return match;
        if (between.length === 0) return `${density}${gap}`;
        if (!known.has(word.toLowerCase())) return match;
        if (between.some((token) => describesNoun(language, word, token) !== false)) {
          if (word.toLowerCase() === "compact" || word.toLowerCase() === "comfortable") return gap;
          return match;
        }
        return `${density}${gap}`;
      })
    : beforeRow;
  return before.replace(
    new RegExp(String.raw`\b(list|lists|row|rows)((?:\s*,\s*|\s+)(?:but\s+|that\s+is\s+|that\s+are\s+|which\s+is\s+|that's\s+)?)([a-z]+)\b(?=${clause.source.slice(1)})`, "gi"),
    (match, noun: string, joint: string, word: string) => {
      const density = as(word);
      return density && /,|but|that|which|that's/i.test(joint) ? `${noun}${joint}${density}` : match;
    },
  );
}

function purposeSplit(ask: string): { purpose: string | null; purposeTokens: string[] } {
  const parts = ask.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const at = parts.findIndex((part) => PURPOSE_WORD.has(part));
  if (at < 0) return { purpose: null, purposeTokens: [] };
  const tail = parts.slice(at + 1);
  return { purpose: tail.join(" ") || null, purposeTokens: tokensOf(tail.join(" ")) };
}

function deviceOf(text: string, device: readonly string[]): string | undefined {
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return [...device]
    .sort((a, b) => b.length - a.length)
    .find((word) => {
      const bits = word.toLowerCase().split(/\s+/);
      return tokens.some((_, index) => bits.every((bit, offset) => {
        const got = tokens[index + offset] ?? "";
        return got === bit || got === `${bit}s` || got === `${bit}es`;
      }));
    });
}

function exclusions(text: string, dictionary: MeaningDictionary): string[] {
  const match = text.match(/\bnot\s+([a-z0-9][a-z0-9\s-]{0,48})$/i);
  if (!match?.[1]) return [];
  const phrase = match[1].trim().toLowerCase();
  const words = tokensOf(phrase);
  const live = dictionary.entries.filter((entry) => !entry.retired);
  if (words.length === 1) {
    const word = words[0]!;
    const exact = live.filter((entry) => entry.name.toLowerCase() === word);
    if (exact.length) return exact.map((entry) => entry.name);
    return live.filter((entry) => entry.name.toLowerCase().split(/[^a-z0-9]+/).includes(word)).map((entry) => entry.name);
  }
  return live.filter((entry) => entry.name.toLowerCase() === phrase || words.every((word) => entry.nameTokens.includes(word))).map((entry) => entry.name);
}

function purposeFits(entry: MeaningEntry, purposeTokens: readonly string[]): boolean {
  const meaningful = purposeTokens.filter((token) => !CHOOSE.has(token) && !FILLER_HEAD.has(token));
  if (!meaningful.length) return false;
  const hay = new Set([...tokensOf(entry.purpose.join(" ")), ...entry.nameTokens, ...entry.synonyms.flatMap((term) => tokensOf(term))]);
  return meaningful.every((token) => hay.has(token));
}

function genericHead(token: string | null): boolean {
  if (!token) return true;
  return FILLER_HEAD.has(token) || token === "picker" || token === "tool" || token === "widget";
}

/**
 * Read an ask against one library's dictionary.
 * The result is the head, the attributes, and whether the answer is empty or weak.
 */
export function prepareAsk(raw: string, dictionary: MeaningDictionary): MeaningDecision {
  const language = languageOf(dictionary.language);
  const text = densityText(raw, language);
  const { purpose, purposeTokens } = purposeSplit(raw);
  const excluded = exclusions(raw, dictionary);
  const beforePurpose = raw.toLowerCase().split(/\b(?:to|for|on|when)\b/)[0] ?? raw;
  const content = tokensOf(beforePurpose);
  const read = interpretInflections(content.length ? content : tokensOf(text), dictionary);
  const attributes = [...read.attributes];
  const lists = /\b(lists?|rows?)\b/i.test(text) && !/\brows?\b(?:\s+of|\s+containing|\s+full\s+of|\s+with)\b/i.test(text);
  const densityValue = lists ? Object.keys(language.density).find((value) => new RegExp(`\\b${value}\\b`, "i").test(text)) : undefined;
  if (densityValue) attributes.push({ kind: "density", value: densityValue });
  const head = read.tokens.find((token) => !wordMap(language).has(token) && !GAP_STOP.has(token)) ?? null;
  const reasons: string[] = [];
  let leadName: string | undefined;
  const live = dictionary.entries.filter((entry) => !entry.retired);
  const density = attributes.find((row) => row.kind === "density");
  if (density) {
    const hits = live.filter((entry) => entry.nameTokens.includes(density.value) && entry.nameTokens.some((token) => token === "list" || token === "row"));
    if (hits.length === 1 && hits[0]) {
      leadName = hits[0].name;
      reasons.push(`${density.kind} ${density.value} selects ${hits[0].name}.`);
    }
  }
  const dated = attributes.find((row) => row.kind === "date");
  if (!leadName && dated && head) {
    const hosts = live.filter((entry) => entry.nameTokens.includes(head) && !entry.nameTokens.includes(dated.value));
    hosts.sort((a, b) => a.nameTokens.length - b.nameTokens.length || a.name.localeCompare(b.name));
    if (hosts[0]) {
      leadName = hosts[0].name;
      reasons.push(`Date is an attribute of ${hosts[0].name}, not a different component.`);
    }
  }
  if (!leadName && genericHead(head) && purpose) {
    const fits = live.filter((entry) => purposeFits(entry, purposeTokens));
    if (fits.length === 1 && fits[0]) {
      leadName = fits[0].name;
      reasons.push(`Purpose "${purpose}" matches ${fits[0].name}.`);
    }
  }
  if (!leadName) {
    const asked = new Set(read.tokens);
    const coversWord = (token: string) =>
      asked.has(token) ||
      dictionary.synonymGroups.some((group) => group.includes(token) && group.some((term) => (term.includes(" ") ? tokensOf(term).every((part) => asked.has(part)) : asked.has(term))));
    const richer = live.filter((entry) => (entry.nameTokens.includes("mini") || entry.nameTokens.includes("extended")) && entry.nameTokens.every((token) => coversWord(token)));
    if (richer.length === 1 && richer[0]) {
      leadName = richer[0].name;
      reasons.push(`${richer[0].name} covers the asked words.`);
    }
  }
  if (!leadName && excluded.length) {
    const before = tokensOf((raw.split(/\bnot\b/i)[0] ?? ""));
    const hits = live.filter((entry) => !excluded.includes(entry.name) && entry.nameTokens.length > 0 && entry.nameTokens.every((token) => before.includes(token)));
    if (hits.length === 1 && hits[0]) {
      leadName = hits[0].name;
      reasons.push(`${hits[0].name} stays. ${excluded.join(", ")} is not it.`);
    }
  }
  const choose = /\bto\s+(?:choose|pick|grab|select)\b/i.test(raw);
  const purposeKnown = live.some((entry) => purposeFits(entry, purposeTokens));
  const empty = onlyInflectedAsk(raw, dictionary) || (choose && genericHead(head) && !leadName && !purposeKnown) || (genericHead(head) && purposeTokens.length > 0 && !purposeKnown && !leadName && head === "picker");
  if (empty) reasons.push("Nothing in this library fits.");
  const lead = leadName ? live.find((entry) => entry.name === leadName) : undefined;
  const weakWords = lead
    ? read.shared.filter((guess) => guess.part.every((word) => lead.nameTokens.includes(word)) && !lead.nameTokens.includes(guess.word)).map((guess) => guess.word)
    : [];
  const device = deviceOf(raw, language.device);
  const screen = tokensOf(raw).find((token) => token === "screen" || token === "page");
  return {
    text,
    tokens: read.tokens,
    shared: read.shared,
    weakWords,
    empty,
    ...(leadName ? { leadName } : {}),
    excluded,
    attributes,
    purposeTokens,
    purpose,
    head,
    context: { ...(device ? { device } : {}), ...(screen ? { screen } : {}) },
    reasons,
  };
}
