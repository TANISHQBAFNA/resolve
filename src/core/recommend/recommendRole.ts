/** Role layer: what the asked part does, read from the task wording, beats a name that only shares a word. */
import { HOLDER } from "../read/meaning/parse";
import { DESCRIBING_WORD, tokensOf } from "../read/queryTokens";
import { PLAIN_NOUN } from "./recommendLexicon";

export interface AskRole {
  kind: "chooser" | "selection" | "two-way" | "number" | "dismissible" | "marker" | "stand-in";
  /** Family name words that do this job. */
  want: ReadonlySet<string>;
  /** Family name words for a part that looks close but does another job. */
  avoid: ReadonlySet<string>;
  /** Variant values that show a family does this job: count 2 and tab style for a two-way choice. */
  values?: ReadonlySet<string>;
  /** Variant values that show a family does another job: Mandatory / Optional is a form-field label. */
  avoidValues?: ReadonlySet<string>;
  /** When no family does the job: the words of a part that can stand in, and the asked part it stands in for. */
  standIn?: { words: ReadonlySet<string>; part: string };
}

/** Parts most libraries lack, and the part that stands in, named: a progress bar for a score, a list for a timeline. */
const STAND_INS: [string, string, string][] = [
  ["score", "progress", "a score"],
  ["timeline", "list", "a timeline"],
];
const DISPLAY_ONLY = new Set(["summary", "badge", "label", "tag", "text", "card", "chip", "avatar", "banner"]);
const CHANGE_VERB = /\b(?:chang(?:e|ed|es|ing)|switch(?:ed|es|ing)? between|swap(?:ped|s)?|edit(?:ed|able)? inline)\b/;
/** "(To do, In progress, Done)", "To do, In progress or Done", "Day/Week". */
const OPTION_SET = /\([^)]*,[^)]*\)|\b\w+(?: \w+)?, \w+(?: \w+)?,? (?:and|or) \w+|\b\w+\/\w+\b/;

export function askRole(ask: string): AskRole | undefined {
  const text = ask.toLowerCase();
  const words = text.split(/[^a-z0-9]+/).filter(Boolean);
  const at = words.findIndex((word, i) => i > 0 && DESCRIBING_WORD.has(word));
  // "big confirm button whose colour changes with the Buy/Sell toggle": the lead names the part, so the tail sets no role.
  if (at > 0 && words.slice(0, at).some((word) => PLAIN_NOUN.has(word))) return undefined;
  // 'a small label that marks a song as "Explicit"': a tag or badge, not a form-field label.
  if (/\bmark(?:s|ed|ing)?\b.+\bas\b/.test(text)) {
    return { kind: "marker", want: new Set(["tag", "badge"]), avoid: new Set(), avoidValues: new Set(["mandatory", "optional", "conditional", "required"]) };
  }
  // "filters that can be removed one by one": a tag or chip with a close action.
  if (/\b(?:removable|dismiss[ai]ble|(?:can be|are|is) (?:removed|dismissed)|removed one by one)\b/.test(text)) {
    return { kind: "dismissible", want: new Set(["tag", "tags", "chip", "chips"]), avoid: new Set(["bar", "panel"]), values: new Set(["close", "dismiss", "remove", "removable"]) };
  }
  // "quantity stepper": a +/- number control, not a progress stepper.
  if (/\b(?:quantity|number|count|amount)\b/.test(text) && /\bstepper\b|\+\s*\/\s*-|plus\/minus/.test(text)) {
    return {
      kind: "number",
      want: new Set(["counter", "quantity", "increment", "incrementer", "numeric", "spinbutton"]),
      avoid: new Set(["stepper", "step", "steps", "progress"]),
      standIn: { words: new Set(["input"]), part: "a +/- number control" },
    };
  }
  // "Buy/Sell toggle", "toggle between Buy and Sell": one of two named sides, not an on/off switch.
  if (/\b\w+\/\w+ toggle\b|\btoggle between \w+ (?:and|or) \w+/.test(text)) {
    return { kind: "two-way", want: new Set(["selector", "segmented"]), avoid: new Set(["toggle", "switch"]), values: new Set(["2", "tab"]) };
  }
  if (CHANGE_VERB.test(text) && OPTION_SET.test(text)) {
    return { kind: "chooser", want: new Set(["menu", "dropdown", "select", "segmented"]), avoid: DISPLAY_ONLY };
  }
  // "ride option row with price, ETA and a selected state": pick one of several.
  // "choose one option from three" and "one of three" are the same job. A dialog is not that control.
  if (
    (/\boptions?\b/.test(text) && /\bselected\b/.test(text)) ||
    /\b(?:one of (?:two|three|four|\d+)|choose one|pick one)\b/.test(text)
  ) {
    return {
      kind: "selection",
      want: new Set(["selector", "selection", "interactive", "tile", "radio", "choice"]),
      avoid: new Set(["badge", "label", "tag", "text", "dialog", "modal"]),
    };
  }
  // "match score", "timeline of match events": a part named so still wins; else the stand-in, named. "score card" is a card.
  const missingPart = STAND_INS.find(([word]) => words.includes(word));
  if (missingPart && !words.some((word) => PLAIN_NOUN.has(word))) {
    const [word, standIn, part] = missingPart;
    return { kind: "stand-in", want: new Set([word]), avoid: new Set(), standIn: { words: new Set([standIn]), part } };
  }
  return undefined;
}

/** The asked part a missing word belongs to: "week view", "swipeable card", "event row". */
export function askedPart(ask: string, word: string): string {
  const words = ask.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const at = words.indexOf(word);
  const next = words[at + 1];
  const previous = words[at - 1];
  if (next && (/(?:able|ible)$/.test(word) || HOLDER.has(next))) return `${word} ${next}`;
  return previous && !["a", "an", "the"].includes(previous) ? `${previous} ${word}` : word;
}

/** Asked states and the variant values that mean them: done is completed, current is in progress, locked is disabled. */
const STATE_ALIAS: [RegExp, string[]][] = [
  [/\b(?:done|completed?|finished)\b/, ["completed", "complete", "done"]],
  [/\b(?:current|in progress)\b/, ["inprogress", "current"]],
  [/\b(?:locked|disabled)\b/, ["disabled", "locked"]],
  [/\b(?:pending|upcoming|not started)\b/, ["pending", "upcoming"]],
];

/** How many asked states a family's variant values name. */
export function statesCovered(ask: string, variantText: string): number {
  const text = ask.toLowerCase();
  const values = new Set(variantText.toLowerCase().replace(/in progress/g, "inprogress").split(/[^a-z0-9]+/));
  return STATE_ALIAS.filter(([asked, names]) => asked.test(text) && names.some((name) => values.has(name))).length;
}

/** Lexical points for a family under the asked role. Positive lets a part with no shared word rank. A stand-in ranks below a real fit. */
export function roleFit(role: AskRole | undefined, familyLabel: string, variantText = ""): { points: number; standIn?: string } {
  if (!role) return { points: 0 };
  const names = tokensOf(familyLabel.replace(/-/g, " "));
  const values = new Set(variantText.toLowerCase().split(/[^a-z0-9]+/));
  if (names.some((token) => role.avoid.has(token)) || [...(role.avoidValues ?? [])].some((value) => values.has(value))) return { points: -200 };
  if (role.standIn && names.some((token) => role.standIn!.words.has(token))) return { points: 300, standIn: role.standIn.part };
  if (!names.some((token) => role.want.has(token))) return { points: 0 };
  return { points: 400 + [...(role.values ?? [])].filter((value) => values.has(value)).length * 60 };
}
