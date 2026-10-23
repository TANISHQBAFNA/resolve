import { meaningCandidates, type MeaningPack } from "./sock";
import type { MeaningDictionary, MeaningHit, MeaningRank, ParsedAsk } from "./types";

/** Match an ask to components using only that dictionary's own text. */
export function rankMeaning(raw: string, dictionary: MeaningDictionary): MeaningRank {
  const pack: MeaningPack = {
    library: dictionary.library,
    vocab: "",
    builtAt: "",
    components: dictionary.entries.filter((entry) => !entry.retired).map((entry) => ({
      id: entry.id,
      name: entry.name,
      aliases: entry.synonyms,
      description: entry.purpose.join(". "),
      job: "",
      properties: entry.attributes.flatMap((row) => row.values),
      propOptions: {},
      retired: false,
      thin: entry.purpose.length ? [] : ["description"],
    })),
  };
  const candidates = meaningCandidates(raw, pack);
  const hits: MeaningHit[] = candidates.map((row) => ({
    name: row.name,
    id: row.id,
    score: row.score,
    reasons: [row.reason],
    weak: row.confidence !== "sure",
    uncovered: [],
  }));
  const intent: ParsedAsk = {
    raw,
    text: raw,
    head: null,
    modifiers: [],
    attributes: [],
    purpose: null,
    purposeTokens: [],
    context: {},
    tokens: [],
    uncovered: [],
    empty: hits.length === 0,
  };
  return { intent, hits, empty: hits.length === 0 || hits.every((hit) => hit.weak) };
}
