import { tokensOf } from "../queryTokens";
import { interpretInflections, onlyInflectedAsk, type SharedGuess } from "./inflections";
import type { MeaningDictionary, MeaningEntry, MeaningLanguage, ParsedAttribute } from "./types";

/** English function words. They are not a library's vocabulary. */
const GAP_STOP = new Set(["a", "an", "the", "and", "or", "but", "of", "for", "to", "with", "on", "in", "my", "your", "our", "their", "from", "into"]);
const PURPOSE_WORD = new Set(["to", "for", "on", "when"]);
const CHOOSE = new Set(["choose", "pick", "grab", "select"]);
const FILLER_HEAD = new Set(["something", "anything", "stuff", "thing", "things", "widget", "control", "way"]);
const CONTRAST = /\b(?:rather\s+than|instead\s+of|not)\b/i;

export interface MeaningDecision {
  text: string;
  tokens: string[];
  shared: SharedGuess[];
  /** Shared nouns that make the lead a guess. */
  weakWords: string[];
  empty: boolean;
  leadName?: string;
  /** When a density list leads, the named part in the ask. */
  secondName?: string;
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
    senses: raw?.senses ?? {},
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

const ARTICLE = new Set(["a", "an", "the"]);

function nounDescribed(language: MeaningLanguage, word: string, noun: string): boolean {
  const stem = nounStem(noun);
  const lower = noun.toLowerCase();
  const canonical = wordMap(language).get(word.toLowerCase());
  const keys = [word.toLowerCase(), ...(canonical ? [canonical] : [])];
  for (const key of keys) {
    const described = language.describes[key] ?? [];
    if (described.includes(stem) || described.includes(lower)) return true;
  }
  return Object.values(language.senses).some((words) => words.includes(stem) || words.includes(lower));
}

/**
 * Rewrite a density word that modifies list or row.
 * Any noun before list counts, and so does list of a plural once that plural is singular.
 * A density word that plainly describes the noun (a material, fabric, paper, document, or clothing sense) does not.
 * A row of a part is not a density list.
 */
export function densityText(text: string, language: MeaningLanguage): string {
  const as = (word: string) => wordMap(language).get(word.toLowerCase());
  const known = new Set(wordMap(language).keys());
  const pattern = deviceSource(language.device);
  const clause = pattern
    ? new RegExp(String.raw`^(?:\s*$|\s*,|\s*[.;!]|\s+please\b|\s+(?:for|on|in)\s+(?:(?:the|a|an|my|your|our)\s+)?(?:${pattern})(?=\s*$|\s*[,.;!]|\s+please\b))`, "i")
    : /^(?:\s*$|\s*,|\s*[.;!]|\s+please\b)/i;
  const beforeRow = text.replace(
    /\b([a-z]+)(\s+)(?=(rows?)\b((?:\s*,?\s*(?:of|containing|full\s+of|with)\s+)[a-z])?)/gi,
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
    ? beforeRow.replace(new RegExp(String.raw`\b(${words})(\s+(?:[a-z]+\s+){0,2})(lists?)(?:\s+of\s+([a-z]+))?`, "gi"), (match, word: string, gap: string, listWord: string, ofNoun?: string) => {
        const density = as(word);
        if (!density) return match;
        const between = gap.trim().split(/\s+/).filter((token) => token && !ARTICLE.has(token));
        if (between.some((token) => GAP_STOP.has(token))) return match;
        const noun = ofNoun ? nounStem(ofNoun) : between.length ? nounStem(between[between.length - 1] ?? "") : "";
        const ok = !noun || !nounDescribed(language, word, noun);
        const ofTail = ofNoun ? ` of ${ofNoun}` : "";
        if (!ok) {
          if (word.toLowerCase() === density) return `${gap}${listWord}${ofTail}`.replace(/^\s+/, (lead) => lead);
          return match;
        }
        return `${density}${gap}${listWord}${ofTail}`;
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

function withoutContrast(text: string): string {
  const match = CONTRAST.exec(text);
  return match?.index === undefined ? text : text.slice(0, match.index).trim();
}

function exclusions(text: string, dictionary: MeaningDictionary): string[] {
  const match = text.match(/\b(?:rather\s+than|instead\s+of|not)\s+([a-z0-9][\s\S]{0,80})$/i);
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

const PURPOSE_COMMON = new Set(["message", "list", "button", "card", "text", "item", "row", "header", "page", "show", "open", "control", "action", "screen", "bottom", "top", "small", "brief", "little", "icon", "bar", "field", "menu", "part", "value", "name", "type", "form", "input", "label", "title", "view", "panel", "sheet", "data", "user"]);

function purposeWordsHit(token: string, word: string): boolean {
  const stem = nounStem(token);
  const other = nounStem(word);
  if (token === word || stem === other) return true;
  const short = stem.length <= other.length ? stem : other;
  const long = stem.length <= other.length ? other : stem;
  return short.length >= 4 && long.startsWith(short);
}

/**
 * Purpose text is a fallback for an ask that matched no part.
 * Two content words, or one rare word, must match. One common word does not.
 */
export function purposeFallback(askTokens: readonly string[], live: readonly MeaningEntry[]): MeaningEntry | undefined {
  const namesAPart = live.some((entry) => entry.nameTokens.some((token) => token.length > 2 && (askTokens.includes(token) || askTokens.includes(`${token}s`)) && (entry.nameTokens.length === 1 || entry.name.toLowerCase() === token)));
  if (namesAPart) return undefined;
  const styleValue = new Set(live.flatMap((entry) => entry.attributes.flatMap((row) => row.values.map((value) => value.toLowerCase()))));
  const content = askTokens.filter((token) => token.length > 2 && !GAP_STOP.has(token) && !FILLER_HEAD.has(token) && !CHOOSE.has(token) && !styleValue.has(token));
  if (!content.length) return undefined;
  if (content.length === 1 && /(?:ed|ing)$/.test(content[0] ?? "")) {
    const token = content[0]!;
    const leads = live.filter((entry) => entry.purpose.some((line) => tokensOf(line)[0] === token));
    return leads.length === 1 ? leads[0] : undefined;
  }
  const hayOf = (entry: MeaningEntry) => tokensOf(entry.purpose.join(" "));
  const hitsWord = (token: string, entry: MeaningEntry) => hayOf(entry).some((word) => purposeWordsHit(token, word));
  const owners = (token: string) => live.filter((entry) => hitsWord(token, entry)).length;
  const scored = live
    .map((entry) => {
      const matched = content.filter((token) => hitsWord(token, entry));
      const rare = matched.filter((token) => !PURPOSE_COMMON.has(nounStem(token)) && owners(token) === 1);
      return { entry, score: matched.length, rare: rare.length };
    })
    .filter((row) => row.score >= 2 || row.rare >= 1)
    .sort((a, b) => b.score - a.score || b.rare - a.rare || a.entry.name.localeCompare(b.entry.name));
  const best = scored[0];
  if (!best || (scored[1] && scored[1].score === best.score && scored[1].rare === best.rare)) return undefined;
  return best.entry;
}

const HELD_RECORD = new Set(["list", "row", "item", "entry", "result", "record", "line", "card", "name"]);

function densityWordSet(language: MeaningLanguage): Set<string> {
  return new Set(Object.values(language.density).flat().map((word) => word.toLowerCase()));
}

function senseStems(language: MeaningLanguage): Set<string> {
  const stems = new Set<string>();
  for (const words of Object.values(language.senses)) for (const word of words) stems.add(nounStem(word));
  return stems;
}

/** Words a density word sits on: the words before list, or list-of, each singular. */
function governedSpan(text: string, language: MeaningLanguage): string[] {
  const density = densityWordSet(language);
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (let index = 0; index < tokens.length; index += 1) {
    if (!density.has(tokens[index] ?? "")) continue;
    const ahead = tokens.slice(index + 1, index + 6);
    const listAt = ahead.findIndex((token) => /^lists?$/.test(token));
    if (listAt < 0) continue;
    const between = ahead.slice(0, listAt).filter((token) => !ARTICLE.has(token) && !GAP_STOP.has(token));
    const listIndex = index + 1 + listAt;
    if (tokens[listIndex + 1] === "of") {
      const object = tokens.slice(listIndex + 2, listIndex + 5).filter((token) => !ARTICLE.has(token) && !GAP_STOP.has(token));
      if (object.length) return object.map(nounStem);
    }
    if (between.length) return between.map(nounStem);
  }
  return [];
}

function senseCompounds(language: MeaningLanguage): string[][] {
  const compounds: string[][] = [];
  for (const words of Object.values(language.senses)) {
    for (const word of words) {
      const parts = word.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(nounStem);
      if (parts.length > 1) compounds.push(parts);
    }
  }
  return compounds;
}

function partsNamed(stem: string, entries: readonly MeaningEntry[]): MeaningEntry[] {
  if (!stem || HELD_RECORD.has(stem)) return [];
  return entries.filter((entry) => !entry.retired && entry.nameTokens.includes(stem));
}

function isSenseSpan(span: readonly string[], language: MeaningLanguage, entries: readonly MeaningEntry[]): boolean {
  if (!span.length || span.some((stem) => partsNamed(stem, entries).length > 0)) return false;
  const stems = senseStems(language);
  const compound = senseCompounds(language).some((parts) => parts.length === span.length && parts.every((part, index) => part === span[index]));
  if (compound) return true;
  return span.every((stem) => stems.has(stem) && !HELD_RECORD.has(stem));
}

/** A part named before the density word, such as "form" in "a form for a compact chip". */
function partBeforeDensity(text: string, language: MeaningLanguage, entries: readonly MeaningEntry[]): MeaningEntry | undefined {
  const density = densityWordSet(language);
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const at = tokens.findIndex((token) => density.has(token));
  if (at <= 0) return undefined;
  const before = new Set(tokens.slice(0, at).filter((token) => !ARTICLE.has(token) && !GAP_STOP.has(token)));
  const hits = entries.filter((entry) => !entry.retired && entry.nameTokens.some((token) => before.has(token)));
  hits.sort((a, b) => Number(!a.nameTokens.includes("form")) - Number(!b.nameTokens.includes("form")) || a.nameTokens.length - b.nameTokens.length || a.name.localeCompare(b.name));
  return hits[0];
}

function partFromSpan(span: readonly string[], entries: readonly MeaningEntry[]): MeaningEntry | undefined {
  for (const stem of [...span].reverse()) {
    const parts = partsNamed(stem, entries).sort((a, b) => a.nameTokens.length - b.nameTokens.length || a.name.localeCompare(b.name));
    const exact = parts.find((entry) => entry.name.toLowerCase() === stem);
    const part = exact ?? parts[0];
    if (part) return part;
  }
  return undefined;
}

function stripDensity(text: string, language: MeaningLanguage): string {
  const density = densityWordSet(language);
  return text.replace(/\b[a-z]+\b/gi, (word) => (density.has(word.toLowerCase()) ? "" : word)).replace(/\s+/g, " ").trim();
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
  const kept = withoutContrast(raw);
  const { purpose, purposeTokens } = purposeSplit(kept);
  const fillerLead = /^(?:a|an|the\s+)?(?:widget|control|way|tool)\b/i.test(kept);
  const span = governedSpan(kept, language);
  const senseNoun = isSenseSpan(span, language, dictionary.entries);
  const namedPart = senseNoun ? undefined : partFromSpan(span, dictionary.entries);
  const source = senseNoun ? stripDensity(fillerLead && purpose ? purpose : kept, language) : fillerLead && purpose ? purpose : kept;
  const text = densityText(source, language);
  const excluded = exclusions(raw, dictionary);
  const beforePurpose = kept.toLowerCase().split(/\b(?:to|for|on|when)\b/)[0] ?? kept;
  const content = tokensOf(beforePurpose);
  const read = interpretInflections(content.length ? content : tokensOf(text), dictionary);
  const attributes = [...read.attributes];
  const lists = /\b(lists?|rows?)\b/i.test(text) && !/\brows?\b(?:\s*,?\s*(?:of|containing|full\s+of|with)\b)/i.test(text);
  const besideList = (value: string) => new RegExp(String.raw`\b${value}\s+(?:[a-z]+\s+){0,2}(?:lists?|rows?)\b|\b(?:lists?|rows?)\b(?:\s*,\s*|\s+)(?:but\s+|that\s+(?:is|are)\s+|which\s+is\s+|that's\s+)?${value}\b`, "i").test(text);
  const densityValue = lists ? Object.keys(language.density).find((value) => besideList(value)) : undefined;
  if (densityValue) attributes.push({ kind: "density", value: densityValue });
  const head = read.tokens.find((token) => !wordMap(language).has(token) && !GAP_STOP.has(token)) ?? null;
  const reasons: string[] = [];
  let leadName: string | undefined;
  const live = dictionary.entries.filter((entry) => !entry.retired);
  const density = attributes.find((row) => row.kind === "density");
  let densityLead = false;
  if (density) {
    const hits = live.filter((entry) => entry.nameTokens.includes(density.value) && entry.nameTokens.some((token) => token === "list" || token === "row"));
    if (hits.length === 1 && hits[0]) {
      leadName = hits[0].name;
      densityLead = true;
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
    const before = tokensOf(withoutContrast(raw));
    const hits = live.filter((entry) => !excluded.includes(entry.name) && entry.nameTokens.length > 0 && entry.nameTokens.every((token) => before.includes(token)));
    if (hits.length === 1 && hits[0]) {
      leadName = hits[0].name;
      reasons.push(`${hits[0].name} stays. ${excluded.join(", ")} is not it.`);
    }
  }
  const askTokens = tokensOf(kept);
  if (density && !leadName) {
    const densityWords = new Set(Object.values(language.density).flat().map((word) => word.toLowerCase()));
    const beforeList = new RegExp(String.raw`\b(?:${[...densityWords].join("|")})\s+(?:[a-z]+\s+){0,2}(?:lists?|rows?)\b`, "i").test(kept);
    const butRow = /\brows?\b(?:\s*,\s*|\s+)but\b/i.test(kept);
    if (!beforeList && !butRow) {
      // density said after the list stays unanswered when this library has no such variant
    } else {
    const covers = (token: string) => {
      const plural = token.endsWith("y") ? `${token.slice(0, -1)}ies` : `${token}s`;
      return askTokens.includes(token) || askTokens.includes(plural) || askTokens.includes(`${token}es`);
    };
    const named = live
      .filter((entry) => {
        const own = entry.nameTokens.filter((token) => !densityWords.has(token));
        return own.length > 0 && own.every((token) => covers(token));
      })
      .sort((a, b) => b.nameTokens.length - a.nameTokens.length || a.name.localeCompare(b.name));
    const plain = live.find((entry) => entry.nameTokens.length === 1 && entry.nameTokens[0] === "list");
    const specific = named.filter((entry) => !(entry.nameTokens.length === 1 && (entry.nameTokens[0] === "list" || entry.nameTokens[0] === "row")));
    const fallback = specific[0] ?? namedPart ?? plain;
    if (fallback) {
      leadName = fallback.name;
      reasons.push("No density variant. The plain part stays.");
    } else {
      reasons.push("No density variant.");
    }
    }
  }
  const earlier = namedPart ? partBeforeDensity(kept, language, live) : undefined;
  if (earlier && earlier.name !== namedPart?.name && (leadName === namedPart?.name || densityLead || !leadName)) {
    leadName = earlier.name;
    densityLead = false;
    reasons.push(`The named part ${earlier.name} is said before the density word.`);
  }
  let secondName: string | undefined;
  if (densityLead && namedPart && leadName !== namedPart.name) {
    secondName = namedPart.name;
    reasons.push(`${namedPart.name} stays second. The density list leads.`);
  }
  if (!leadName && namedPart) {
    leadName = namedPart.name;
    reasons.push("The noun names a part, so the list density does not.");
  }
  const rowsThatAre = /\brows?\s+that\s+are\s+[a-z]+\b/i.test(kept);
  if (!leadName && rowsThatAre && density) {
    const plain = live.find((entry) => entry.nameTokens.length === 1 && entry.nameTokens[0] === "list");
    if (plain) {
      leadName = plain.name;
      reasons.push("No density variant. The plain part stays.");
    } else {
      reasons.push("No density variant.");
    }
  }
  const dateUnits = new Set(["date", "day", "week", "month", "year"]);
  const timeUnits = new Set(["time", "hour", "minute"]);
  const unitWords = askTokens.filter((token) => dateUnits.has(token) || timeUnits.has(token));
  if (!leadName && unitWords.length) {
    const wantsTime = unitWords.some((token) => timeUnits.has(token));
    const picker = wantsTime
      ? live.find((entry) => entry.nameTokens.includes("time") && entry.nameTokens.includes("picker"))
      : live.find((entry) => entry.nameTokens.includes("date") && (entry.nameTokens.includes("picker") || entry.synonyms.includes("datepicker")));
    const otherPart = live.some((entry) => entry.nameTokens.some((token) => token.length > 3 && !dateUnits.has(token) && !timeUnits.has(token) && token !== "picker" && askTokens.includes(token)));
    if (picker && !otherPart) {
      leadName = picker.name;
      reasons.push(wantsTime ? "A time unit uses the time picker." : "A date unit uses the date picker.");
    }
  }
  const choose = /\bto\s+(?:choose|pick|grab|select)\b/i.test(raw);
  const purposeKnown = live.some((entry) => purposeFits(entry, purposeTokens));
  const noVariant = reasons.some((reason) => reason === "No density variant.");
  const empty = senseNoun || noVariant || onlyInflectedAsk(raw, dictionary) || (choose && genericHead(head) && !leadName && !purposeKnown) || (genericHead(head) && purposeTokens.length > 0 && !purposeKnown && !leadName && head === "picker");
  if (empty) reasons.push("Nothing in this library fits.");
  const lead = leadName ? live.find((entry) => entry.name === leadName) : undefined;
  const weakWords = lead
    ? read.shared.filter((guess) => guess.part.every((word) => lead.nameTokens.includes(word)) && !lead.nameTokens.includes(guess.word)).map((guess) => guess.word)
    : [];
  const device = deviceOf(raw, language.device);
  if (!leadName && device && read.tokens.some((token) => token === "nav" || token === "navigation")) {
    const navs = live.filter((entry) => entry.nameTokens.includes("nav") || entry.nameTokens.includes("navigation"));
    const direct = navs.filter((entry) => entry.nameTokens.includes(device));
    const handheld = new Set(["phone", "mobile", "handset", "iphone", "ios", "android", "ipad", "tablet", "watch"]);
    const desk = new Set(["desktop", "web", "laptop", "tv"]);
    const picked = direct.length === 1 ? direct[0] : handheld.has(device) ? navs.find((entry) => entry.nameTokens.includes("mobile")) : desk.has(device) ? navs.find((entry) => entry.nameTokens.includes("desktop")) : undefined;
    if (picked) {
      leadName = picked.name;
      reasons.push(`${device} selects ${picked.name}.`);
    }
  }
  const screen = tokensOf(raw).find((token) => token === "screen" || token === "page");
  return {
    text,
    tokens: read.tokens,
    shared: read.shared,
    weakWords,
    empty,
    ...(leadName ? { leadName } : {}),
    ...(secondName ? { secondName } : {}),
    excluded,
    attributes,
    purposeTokens,
    purpose,
    head,
    context: { ...(device ? { device } : {}), ...(screen ? { screen } : {}) },
    reasons,
  };
}
