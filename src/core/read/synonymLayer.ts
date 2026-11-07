import type { PropertyHint } from "./componentProperties";

/**
 * Property-hint aliases for ranking.
 * The hint list in componentProperties.ts is the source. This does not copy it.
 * Team hints from a context pack or property-hints.json join the same map per ask.
 * Multi-word hints ("greyed out") stay phrases for the property card.
 */

const fold = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");

let active = new Map<string, readonly string[]>();

/** Single-word says/value pairs that share a value become one alias group. */
export function aliasesFromHints(hints: readonly PropertyHint[]): Map<string, readonly string[]> {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const next = parent.get(id);
    if (!next || next === id) return id;
    const root = find(next);
    parent.set(id, root);
    return root;
  };
  const unite = (left: string, right: string) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent.set(a, b);
  };
  const words = new Set<string>();
  for (const hint of hints) {
    const says = fold(hint.says);
    const value = fold(hint.value);
    if (!says || !value || says.length < 2 || value.length < 2) continue;
    if (hint.says.trim().includes(" ")) continue;
    words.add(says);
    words.add(value);
    if (!parent.has(says)) parent.set(says, says);
    if (!parent.has(value)) parent.set(value, value);
    unite(says, value);
  }
  const groups = new Map<string, string[]>();
  for (const word of words) {
    const root = find(word);
    const list = groups.get(root) ?? [];
    list.push(word);
    groups.set(root, list);
  }
  const out = new Map<string, readonly string[]>();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const frozen = [...new Set(list)];
    for (const word of frozen) out.set(word, frozen);
  }
  return out;
}

/** Call once per recommend, before scoring. */
export function usePropertyHints(hints: readonly PropertyHint[]): void {
  active = aliasesFromHints(hints);
}

export function propertyAliases(token: string): readonly string[] | undefined {
  return active.get(fold(token));
}
