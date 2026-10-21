import { GENERIC_NAME_TOKENS, tokensOf } from "../queryTokens";
import { interpretInflections, onlyInflectedAsk } from "./inflections";
import { normalizeDensity, MEANING_LANGUAGE } from "./language";
import { purposePhrase, purposeTailTokens } from "./purpose";
import type { MeaningDictionary, MeaningEntry, MeaningHit, MeaningRank, ParsedAsk, ParsedAttribute } from "./types";

function deviceOf(text: string): string | undefined {
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return MEANING_LANGUAGE.device.find((word) => tokens.includes(word) || tokens.includes(`${word}s`) || tokens.includes(`${word}es`));
}

function screenOf(tokens: readonly string[]): string | undefined {
  return tokens.find((token) => token === "screen" || token === "page");
}

function groupOf(token: string, groups: readonly string[][]): readonly string[] | undefined {
  return groups.find((group) => group.includes(token));
}

function covers(entry: MeaningEntry, token: string, groups: readonly string[][]): boolean {
  if (entry.nameTokens.includes(token) || entry.wordForms.includes(token) || entry.synonyms.includes(token)) return true;
  if (entry.synonyms.some((term) => term.includes(" ") && tokensOf(term).includes(token))) return true;
  const group = groupOf(token, groups);
  return Boolean(group?.some((term) => !term.includes(" ") && (entry.nameTokens.includes(term) || entry.synonyms.includes(term))));
}

function headOf(tokens: readonly string[], dictionary: MeaningDictionary): string | null {
  const groups = dictionary.synonymGroups;
  const isPart = (token: string) => dictionary.entries.some((entry) => !entry.retired && covers(entry, token, groups));
  const list = tokens[tokens.length - 1];
  const prev = tokens[tokens.length - 2];
  if (list && prev && (list === "list" || list === "lists" || list === "group" || list === "set") && isPart(prev) && !GENERIC_NAME_TOKENS.has(prev)) {
    return prev;
  }
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const token = tokens[i];
    if (token && isPart(token) && token !== "compact" && token !== "comfortable") return token;
  }
  return tokens[tokens.length - 1] ?? null;
}

function densityAttribute(normalized: string): ParsedAttribute | undefined {
  const before = /\b(compact|comfortable)\s+(lists?|rows?)\b/i.exec(normalized);
  const beforeValue = before?.[1]?.toLowerCase();
  if (beforeValue === "compact" || beforeValue === "comfortable") return { kind: "density", value: beforeValue };
  const after = /\b(lists?|rows?)\b(?:\s*,\s*|\s+(?:but\s+|that\s+is\s+|that\s+are\s+|which\s+is\s+|that's\s+))(compact|comfortable)\b/i.exec(normalized);
  const afterValue = after?.[2]?.toLowerCase();
  if (afterValue === "compact" || afterValue === "comfortable") return { kind: "density", value: afterValue };
  return undefined;
}

function scoreEntry(
  entry: MeaningEntry,
  tokens: readonly string[],
  ask: ParsedAsk,
  dictionary: MeaningDictionary,
): MeaningHit | undefined {
  if (entry.retired) return undefined;
  const groups = dictionary.synonymGroups;
  const purpose = new Set(ask.purposeTokens);
  const device = new Set(ask.context.device ? [ask.context.device, `${ask.context.device}s`] : []);
  const content = tokens.filter((token) => !purpose.has(token) && !device.has(token));
  const coveredContent = content.filter((token) => covers(entry, token, groups));
  if (!coveredContent.length) return undefined;
  const reasons: string[] = [];
  let score = coveredContent.length * 40;
  const nameCovered = entry.nameTokens.filter((token) => content.some((asked) => covers(entry, asked, groups) && (asked === token || groupOf(asked, groups)?.includes(token) || entry.synonyms.includes(asked))));
  if (entry.nameTokens.length > 0 && entry.nameTokens.every((token) => content.includes(token) || content.some((asked) => groupOf(asked, groups)?.includes(token)))) {
    score += 80;
    reasons.push(`Name ${entry.name} is covered by the ask.`);
  } else if (nameCovered.length) {
    reasons.push(`The word ${nameCovered.join(", ")} is ${entry.name}.`);
  }
  const synonym = entry.synonyms.find((term) => content.includes(term) || (term.includes(" ") && tokensOf(term).every((part) => content.includes(part))));
  if (synonym) {
    score += 60;
    reasons.push(`"${synonym}" is another name for ${entry.name}.`);
  }
  if (ask.head && (entry.nameTokens.includes(ask.head) || entry.synonyms.includes(ask.head))) {
    score += 25;
    reasons.push(`Head word ${ask.head}.`);
  }
  for (const attribute of ask.attributes) {
    const selected = entry.nameTokens.includes(attribute.value) || entry.attributes.some((row) => row.kind === attribute.kind && row.values.includes(attribute.value));
    const headIsThis = ask.head !== null && (entry.nameTokens.includes(ask.head) || entry.name.toLowerCase() === ask.head);
    if (attribute.kind === "date" && headIsThis && !entry.nameTokens.includes(attribute.value)) {
      reasons.push(`Date is an attribute of ${entry.name}, not a different component.`);
      continue;
    }
    if (!selected) continue;
    score += 45;
    reasons.push(`${attribute.kind} ${attribute.value} selects ${entry.name}.`);
  }
  if (!ask.attributes.some((row) => row.kind === "density") && entry.nameTokens.some((token) => token === "compact" || token === "comfortable")) {
    score -= 50;
  }
  const uncovered = content.filter((token) => !covers(entry, token, groups) && token !== "compact" && token !== "comfortable");
  const missedPart = uncovered.filter((token) =>
    dictionary.entries.some((other) => other.id !== entry.id && !other.retired && other.nameTokens.includes(token)),
  );
  const weak = missedPart.length > 0;
  if (!reasons.length) reasons.push(`${entry.name} shares a word with the ask.`);
  return { name: entry.name, id: entry.id, score, reasons, weak, uncovered: missedPart };
}

function nothingFits(ask: ParsedAsk, dictionary: MeaningDictionary, tokens: readonly string[]): boolean {
  if (onlyInflectedAsk(ask.raw, dictionary)) return true;
  const purpose = new Set(ask.purposeTokens);
  if (!purpose.size) return false;
  const content = tokens.filter((token) => !purpose.has(token));
  if (!content.length || !content.every((token) => GENERIC_NAME_TOKENS.has(token))) return false;
  const known = (token: string) =>
    dictionary.entries.some((entry) => !entry.retired && (entry.nameTokens.includes(token) || entry.synonyms.includes(token) || entry.purpose.some((line) => line.toLowerCase().includes(token))));
  if ([...purpose].some((token) => known(token))) return false;
  const exact = dictionary.entries.some((entry) => !entry.retired && entry.nameTokens.length > 0 && entry.nameTokens.every((token) => content.includes(token)) && content.every((token) => entry.nameTokens.includes(token) || GENERIC_NAME_TOKENS.has(token)));
  return !exact;
}

/** Turn an ask into intent, then match it to dictionary entries. Never invents a component. */
export function rankMeaning(raw: string, dictionary: MeaningDictionary): MeaningRank {
  const normalized = normalizeDensity(raw);
  const all = tokensOf(normalized);
  const purposeTokens = [...purposeTailTokens(raw)];
  const interpreted = interpretInflections(all, dictionary);
  const density = densityAttribute(normalized);
  const attributes = [...interpreted.attributes, ...(density ? [density] : [])];
  const device = deviceOf(raw);
  const screen = screenOf(all);
  const head = headOf(interpreted.tokens.filter((token) => !purposeTokens.includes(token)), dictionary);
  const intent: ParsedAsk = {
    raw,
    text: normalized,
    head,
    modifiers: interpreted.tokens.filter((token) => token !== head && !purposeTokens.includes(token)),
    attributes,
    purpose: purposePhrase(raw),
    purposeTokens,
    context: { ...(device ? { device } : {}), ...(screen ? { screen } : {}) },
    tokens: interpreted.tokens,
    uncovered: [],
    empty: false,
  };
  if (nothingFits(intent, dictionary, interpreted.tokens)) {
    intent.empty = true;
    return { intent, hits: [], empty: true };
  }
  const hits = dictionary.entries
    .map((entry) => scoreEntry(entry, interpreted.tokens, intent, dictionary))
    .filter((hit): hit is MeaningHit => Boolean(hit && hit.score > 0))
    .sort((a, b) => b.score - a.score || Number(a.weak) - Number(b.weak) || a.name.localeCompare(b.name));
  intent.uncovered = hits[0]?.uncovered ?? [];
  intent.empty = hits.length === 0;
  return { intent, hits, empty: hits.length === 0 };
}

/**
 * A confident dictionary hit that names the lead plus an asked word ("mini" on Mini FAB).
 * Undefined when the lead is already that specific.
 */
export function moreSpecificName(ask: string, leadName: string, dictionary: MeaningDictionary): string | undefined {
  const top = rankMeaning(ask, dictionary).hits[0];
  if (!top || top.weak) return undefined;
  if (top.name.toLowerCase() === leadName.toLowerCase()) return undefined;
  const asked = new Set(tokensOf(ask));
  const lead = tokensOf(leadName);
  const next = tokensOf(top.name);
  const adds = next.filter((token) => !lead.includes(token));
  if (!adds.length || !adds.every((token) => asked.has(token))) return undefined;
  if (!lead.every((token) => next.includes(token))) return undefined;
  return top.name;
}
