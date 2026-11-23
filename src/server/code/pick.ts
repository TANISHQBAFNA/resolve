import { codeValueWarnings } from "@/core/codeMap/codeValueGaps";
import { byCode, type CatalogEntry, type CatalogProperty, type CodeCatalog } from "./scan.ts";
import { nameWords, RELATED, stem, STOP, tokens } from "./words.ts";

export { stem };


interface Features {
  name: Set<string>;
  alias: Set<string>;
  variants: Set<string>;
  classes: Set<string>;
  text: Set<string>;
  doc: Set<string>;
}
const cache = new WeakMap<CatalogEntry, Features>();
function features(entry: CatalogEntry): Features {
  let f = cache.get(entry);
  if (!f) {
    f = {
      name: new Set(tokens(entry.name.replace(/-/g, " "))),
      alias: new Set([...(entry.aliases ?? []), ...(entry.figma ? [entry.figma.name, ...(entry.figma.aliases ?? [])] : []), ...(entry.figmaAlso ?? [])].flatMap((a) => tokens(nameWords(a)))),
      variants: new Set(entry.variants.flatMap((v) => tokens(v.replace(/-/g, " ")))),
      classes: new Set((entry.code ? [...entry.code.roots, ...entry.code.elements] : []).flatMap((c) => tokens(c.replace(/[-_]+/g, " ")))),
      text: new Set(tokens(`${entry.description} ${entry.rules.join(" ")}`)),
      doc: new Set(tokens(entry.doc ?? "")),
    };
    cache.set(entry, f);
  }
  return f;
}

function score(entry: CatalogEntry, terms: Map<string, number>, rarity: (word: string) => number, head?: string) {
  const f = features(entry);
  const flat = stem(entry.name.replace(/-/g, ""));
  const matched: string[] = [];
  let total = 0;
  for (const [word, weight] of terms) {
    const hit: [number, string] | undefined =
      flat === word ? [10, "name"] : f.name.has(word) ? [6, "name"] : f.alias.has(word) ? [5, "alias"] : f.variants.has(word) ? [3, "variant"] : f.classes.has(word) ? [2, "class"] : f.text.has(word) ? [1.5, "text"] : f.doc.has(word) ? [1, "doc"] : undefined;
    if (!hit) continue;
    total += hit[0] * weight * rarity(word);
    matched.push(`${hit[1]}:${word}`);
  }
  if (head && (f.name.has(head) || f.alias.has(head) || flat === head)) total += 12;
  return { total, matched };
}

const CONTAINER = new Set(["list", "menu", "screen", "dialog", "page", "group"]);
const LINK = new Set(["to", "for", "with", "when", "while"]);

/** The head noun is the component. A container after it is context. A dropdown is a select. */
function askShape(query: string): { head?: string; direct: Set<string> } {
  const raw: string[] = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const direct = new Set(tokens(query));
  if (raw.includes("dropdown") || (raw.includes("drop") && raw.includes("down"))) {
    const head = stem("select");
    direct.add(head);
    return { head, direct };
  }
  const link = raw.findIndex((word, index) => index > 0 && LINK.has(word));
  const clause = link > 0 ? raw.slice(0, link) : raw;
  const prep = clause.findIndex((word) => word === "in" || word === "inside" || word === "within");
  const content = (prep > 0 ? clause.slice(0, prep) : clause).filter((word) => !STOP.has(word));
  let headWord = content[content.length - 1];
  if (content.length >= 2 && CONTAINER.has(stem(content[content.length - 1]!))) {
    headWord = [...content.slice(0, -1)].reverse().find((word) => !CONTAINER.has(stem(word))) ?? headWord;
  }
  return { ...(headWord ? { head: stem(headWord) } : {}), direct };
}

function grounded(entry: CatalogEntry, direct: Set<string>): boolean {
  const f = features(entry);
  for (const word of direct) if (f.name.has(word) || f.alias.has(word) || f.variants.has(word)) return true;
  for (const property of entry.spec?.properties ?? []) {
    for (const option of property.options ?? []) if (tokens(option.value).some((word) => direct.has(word))) return true;
  }
  for (const line of entry.spec?.a11y ?? []) if (tokens(line).some((word) => direct.has(word))) return true;
  return false;
}

const STATE_WORD = new Set(["view", "readonly", "read", "error", "empty", "loading", "disabled", "default", "base", "filled", "hover", "pressed", "focus"]);

function behaviourState(ask: string, options: { value: string }[]): string | undefined {
  const value = (stems: string[]) => options.find((option) => tokens(option.value).some((word) => stems.includes(word)))?.value;
  const showsSaved = /\b(?:show|shows|showing|saved|existing|already)\b/i.test(ask) && /\b(?:value|values|saved|existing|filled|current)\b/i.test(ask);
  if (showsSaved || /\bread-?only\b/i.test(ask)) return value(["view", "readonly", "read"]);
  if (/\breview\b/i.test(ask) && !/\bedit\b/i.test(ask)) return value(["view", "readonly"]);
  if (/\bempty\b|\bnothing\b|\bno results\b/i.test(ask)) return value(["empty"]);
  if (/\bloading\b|\bwaiting\b|\bfetching\b/i.test(ask)) return value(["loading"]);
  if (/\berror\b|\binvalid\b/i.test(ask)) return value(["error"]);
  return undefined;
}

function chooseOption(property: CatalogProperty, words: string[], skip: Set<string>): string | undefined {
  const options = property.options ?? [];
  const ranked = options
    .map((option) => {
      const described = tokens(`${option.value} ${option.use ?? ""}`);
      const valueWords = new Set(tokens(option.value));
      let total = 0;
      for (const word of words) {
        if (word.length < 4 || skip.has(word) || !described.includes(word)) continue;
        total += valueWords.has(word) ? 3 : 1;
      }
      return { option, total };
    })
    .sort((a, b) => b.total - a.total);
  const best = ranked[0];
  if (best && best.total > (ranked[1]?.total ?? 0)) return best.option.value;
  return undefined;
}

/** Decided values only. A real option or a boolean default stays in defaults. Sample text is left out. */
export function settingsForEntry(entry: CatalogEntry, ask: string): { settings: Record<string, string>; defaults: Record<string, string>; states: string[] } {
  const spec = entry.spec;
  if (!spec) return { settings: {}, defaults: {}, states: [] };
  const words = tokens(ask.split(/\b(?:next to|beside|rather than|instead of)\b/)[0] ?? ask);
  const seenOn = new Map<string, number>();
  for (const property of spec.properties) {
    const bag = new Set<string>();
    for (const option of property.options ?? []) for (const word of tokens(`${option.value} ${option.use ?? ""}`)) bag.add(word);
    for (const word of bag) seenOn.set(word, (seenOn.get(word) ?? 0) + 1);
  }
  const skip = new Set([...seenOn].filter(([, count]) => count > 1).map(([word]) => word));
  const settings: Record<string, string> = {};
  const defaults: Record<string, string> = {};
  const states: string[] = [];
  for (const property of spec.properties) {
    const options = property.options ?? [];
    const state = property.name.toLowerCase() === "state" || (options.length > 0 && options.every((option) => tokens(option.value).every((word) => STATE_WORD.has(word))));
    const chosen = state ? behaviourState(ask, options) : options.length ? chooseOption(property, words, skip) : undefined;
    if (chosen) {
      settings[property.name] = chosen;
      if (state) states.push(chosen);
      continue;
    }
    const fallback = property.default;
    const real = fallback === "true" || fallback === "false" || options.some((option) => option.value.toLowerCase() === fallback?.toLowerCase());
    if (fallback && real) defaults[property.name] = fallback;
  }
  return { settings, defaults, states };
}

/** Fixed order: score (to 6 places, so float noise cannot reorder), then block before recipe, then name. */
export const rankOrder = (a: { total: number; entry: CatalogEntry }, b: { total: number; entry: CatalogEntry }) =>
  Math.round(b.total * 1e6) - Math.round(a.total * 1e6) || (a.entry.kind === b.entry.kind ? 0 : a.entry.kind === "block" ? -1 : 1) || byCode(a.entry.name, b.entry.name);

export function pickComponents(catalog: CodeCatalog, query: string, limit = 5) {
  const shape = askShape(query);
  const terms = new Map<string, number>();
  for (const word of shape.direct) {
    terms.set(word, 1);
    for (const [other, weight] of RELATED.get(word) ?? []) if ((terms.get(other) ?? 0) < weight) terms.set(other, weight);
  }
  // A word found in most components says little; a rare one says more.
  const have = (f: Features, w: string) => f.name.has(w) || f.alias.has(w) || f.variants.has(w) || f.classes.has(w) || f.text.has(w) || f.doc.has(w);
  const rarity = (word: string) => 1 - 0.5 * (catalog.components.filter((e) => have(features(e), word)).length / Math.max(1, catalog.components.length));
  // A related word or a comment does not fill the list. Nothing grounded is empty.
  const ranked = catalog.components
    .map((entry) => ({ entry, ...score(entry, terms, rarity, shape.head) }))
    .filter((row) => row.total > 0 && grounded(row.entry, shape.direct))
    .sort(rankOrder)
    .slice(0, Math.max(1, Math.min(limit, 12)));
  const components = ranked.map(({ entry, total, matched }) => {
    const code = entry.code;
    const primary = code?.primary ?? "";
    const chosen = settingsForEntry(entry, query);
    return {
      name: entry.name,
      kind: entry.kind,
      score: Math.round(total * 10) / 10,
      matched: [...new Set(matched)],
      description: entry.description,
      settings: chosen.settings,
      defaults: chosen.defaults,
      states: chosen.states,
      ...(entry.status ? { status: entry.status } : {}),
      variants: entry.variants.slice(0, 16),
      ...(code
        ? {
            classes: code.roots,
            markup: code.markup,
            css: code.cssFile,
            modifiers: [...(code.modifiers[primary] ?? []), ...Object.entries(code.modifiers).filter(([root]) => root !== primary).flatMap(([, list]) => list)].slice(0, 20),
            ...(code.deprecated.length ? { avoid: code.deprecated.map((c) => `.${c}`) } : {}),
            elements: code.elements.slice(0, 12),
            states: code.states.slice(0, 6),
          }
        : {}),
      rules: entry.rules,
      ...(entry.aliases ? { aliases: entry.aliases } : {}),
      ...(entry.figma ? { figma: entry.figma, matchedBy: entry.matchedBy, matched: entry.matched, ...(entry.figmaAlso ? { figmaAlso: entry.figmaAlso } : {}), ...codeValueWarnings(entry.figma.properties, code?.modifiers) } : {}),
    };
  });
  const shortlist = components.slice(0, 3).map((card) => ({
    name: card.name,
    settings: card.settings,
    defaults: card.defaults,
    states: card.states,
  }));
  return {
    query,
    shortlist,
    components,
    ...(components.length
      ? { guidance: "Pick one row, or say nothing fits. Copy only settings: those are the values this request decides. Leave defaults as the component already defines them. Do not invent a component or a setting value." }
      : { message: "No component matches. Say so; do not invent a class. Try other words or list components with resolve code scan." }),
  };
}
