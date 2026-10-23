export { buildMeaningDictionary, meaningDictionary } from "./buildDictionary";
export { interpretInflections, onlyInflectedAsk } from "./inflections";
export type { MeaningTokens, SharedGuess } from "./inflections";
export { rankMeaning } from "./rank";
export {
  buildMeaningPack,
  contextPack,
  estimateTokens,
  meaningCandidates,
  meaningPackFor,
  renderComponent,
  renderIndex,
  slugId,
  staleWarning,
  thinComponents,
  validatePick,
  writeMeaningPack,
} from "./sock";
export type { MeaningCandidate, MeaningPack, MeaningTier, SockComponent } from "./sock";
export type { MeaningDictionary, MeaningEntry, MeaningHit, MeaningRank, ParsedAsk } from "./types";
