import { prepareAsk } from "./parse";
import type { MeaningDictionary, MeaningHit, MeaningRank, ParsedAsk } from "./types";

/** Match an ask to dictionary entries. The parse decides the head, attributes, and empty. */
export function rankMeaning(raw: string, dictionary: MeaningDictionary): MeaningRank {
  const decision = prepareAsk(raw, dictionary);
  const hits: MeaningHit[] = !decision.empty && decision.leadName
    ? [{
        name: decision.leadName,
        id: decision.leadName.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        score: 1,
        reasons: decision.reasons.length ? decision.reasons : [`${decision.leadName} is the head.`],
        weak: decision.weakWords.length > 0,
        uncovered: decision.weakWords,
      }]
    : [];
  const intent: ParsedAsk = {
    raw,
    text: decision.text,
    head: decision.head,
    modifiers: decision.tokens.filter((token) => token !== decision.head),
    attributes: decision.attributes,
    purpose: decision.purpose,
    purposeTokens: decision.purposeTokens,
    context: decision.context,
    tokens: decision.tokens,
    uncovered: decision.weakWords,
    empty: decision.empty,
  };
  return { intent, hits, empty: decision.empty || hits.length === 0 };
}
