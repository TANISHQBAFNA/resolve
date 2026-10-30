import { codeValueWarnings } from "@/core/query/codeValueGaps";
import { byCode, type CatalogEntry, type CodeCatalog } from "./scan.ts";
import { nameWords, RELATED, stem, tokens } from "./words.ts";

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

function score(entry: CatalogEntry, terms: Map<string, number>, rarity: (word: string) => number) {
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
  return { total, matched };
}

/** Fixed order: score (to 6 places, so float noise cannot reorder), then block before recipe, then name. */
export const rankOrder = (a: { total: number; entry: CatalogEntry }, b: { total: number; entry: CatalogEntry }) =>
  Math.round(b.total * 1e6) - Math.round(a.total * 1e6) || (a.entry.kind === b.entry.kind ? 0 : a.entry.kind === "block" ? -1 : 1) || byCode(a.entry.name, b.entry.name);

export function pickComponents(catalog: CodeCatalog, query: string, limit = 5) {
  const terms = new Map<string, number>();
  for (const word of tokens(query)) {
    terms.set(word, 1);
    for (const [other, weight] of RELATED.get(word) ?? []) if ((terms.get(other) ?? 0) < weight) terms.set(other, weight);
  }
  // A word found in most components says little; a rare one says more.
  const have = (f: Features, w: string) => f.name.has(w) || f.alias.has(w) || f.variants.has(w) || f.classes.has(w) || f.text.has(w) || f.doc.has(w);
  const rarity = (word: string) => 1 - 0.5 * (catalog.components.filter((e) => have(features(e), word)).length / Math.max(1, catalog.components.length));
  const ranked = catalog.components
    .map((entry) => ({ entry, ...score(entry, terms, rarity) }))
    .filter((r) => r.total > 0)
    .sort(rankOrder)
    .slice(0, Math.max(1, Math.min(limit, 12)));
  const components = ranked.map(({ entry, total, matched }) => {
    const code = entry.code;
    const primary = code?.primary ?? "";
    return {
      name: entry.name,
      kind: entry.kind,
      score: Math.round(total * 10) / 10,
      matched: [...new Set(matched)],
      description: entry.description,
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
  return {
    query,
    components,
    ...(components.length
      ? { guidance: "Use only the classes listed here. Match variants by name. If a modifier you need is not listed, say so instead of inventing it." }
      : { message: "No component matches. Say so; do not invent a class. Try other words or list components with resolve code scan." }),
  };
}
