/** One component, in the words a designer actually uses. */
export interface MeaningAttribute {
  kind: "density" | "size" | "state" | "style" | "date";
  name: string;
  values: string[];
}

export interface MeaningEntry {
  id: string;
  name: string;
  /** Other words for this component, including one-word synonyms. */
  synonyms: string[];
  /** Multi-word names a designer may say instead. */
  altNames: string[];
  /** Plurals and verb forms of the name. */
  wordForms: string[];
  /** Short lines from the component description: what it is for. */
  purpose: string[];
  /** Variant knobs that pick a version of this component. */
  attributes: MeaningAttribute[];
  /** Different components that share a word. Not this one. */
  not: string[];
  retired?: boolean;
  nameTokens: string[];
}

export interface MeaningLanguage {
  /** Canonical density value → words this library uses for it. */
  density: Record<string, string[]>;
  /** Devices this library treats as context, not as a component. */
  device: string[];
  /** Nouns a density word describes on its own, keyed by the word that was said. */
  describes: Record<string, string[]>;
  /** Nouns that are a material, fabric, paper, document, or clothing. Density does not apply to them. */
  senses: Record<string, string[]>;
}

export interface MeaningDictionary {
  version: 1;
  library: string;
  language: MeaningLanguage;
  /** Synonym groups this dictionary was built with, lowercased. */
  synonymGroups: string[][];
  entries: MeaningEntry[];
}

export interface ParsedAttribute {
  kind: MeaningAttribute["kind"];
  value: string;
}

export interface ParsedAsk {
  raw: string;
  /** Density words rewritten to the canonical value. The words live on the dictionary. */
  text: string;
  head: string | null;
  modifiers: string[];
  attributes: ParsedAttribute[];
  purpose: string | null;
  purposeTokens: string[];
  context: { device?: string; screen?: string };
  tokens: string[];
  uncovered: string[];
  empty: boolean;
}

export interface MeaningHit {
  name: string;
  id: string;
  score: number;
  reasons: string[];
  weak: boolean;
  uncovered: string[];
}

export interface MeaningRank {
  intent: ParsedAsk;
  hits: MeaningHit[];
  empty: boolean;
}
