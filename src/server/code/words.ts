import { figmaMatchLabel, namespaceSet } from "@/core/rules/figmaNamespaces";

/** Shared word handling for pick and the Figma-to-code mapping: stems, related words, tokens. */
const STOP = new Set([
  "a", "an", "the", "of", "for", "to", "in", "on", "with", "and", "or", "my", "our", "some", "that", "this", "show", "need", "want", "add", "use", "make", "screen", "page", "component",
  "before", "after", "when", "then", "from", "by", "at", "is", "are", "be", "can", "will", "should", "user", "please", "new", "all", "each", "into", "it", "we", "i",
]);
/** Words that name the same kind of thing. Symmetric: any word in a group reaches the others. */
const GROUPS = [
  "modal dialog popup overlay sheet drawer lightbox",
  "alert toast snackbar banner notification callout",
  "button btn cta",
  "badge pill chip tag status",
  "table grid datagrid list",
  "input textbox textfield field textarea",
  "select dropdown picker combobox",
  "switch toggle",
  "tab nav navigation",
  "card tile panel",
  "metric kpi stat",
  "progress spinner loader loading",
  "tooltip hint popover tip menu",
  "accordion collapse expand disclosure",
  "stepper wizard step",
  "pagination pager",
  "avatar profile",
  "breadcrumb trail",
];
/** One-way: what a verb or state in a request usually needs. */
const INTENTS: Record<string, string> = {
  confirm: "dialog modal", delete: "dialog modal confirm", remove: "dialog modal confirm", destroy: "dialog modal confirm", discard: "dialog modal confirm",
  warn: "alert", error: "alert", success: "alert", pending: "badge", choose: "select",
};

/** Light normaliser so "deleting", "deleted", "deletion" and "delete" meet: plural, a derivational suffix, then a final "e". */
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 5 && w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  const suffix = ["ation", "ition", "ment", "ness", "ing", "ed", "ion"].find((x) => w.endsWith(x) && w.length - x.length >= 4);
  if (suffix) w = w.slice(0, -suffix.length);
  return w.length > 3 && w.endsWith("e") ? w.slice(0, -1) : w;
}

export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 1 && !STOP.has(w)).map(stem);
}

export const RELATED = new Map<string, Array<[string, number]>>();
const relate = (word: string, other: string, weight: number) => {
  const key = stem(word);
  const list = RELATED.get(key) ?? [];
  if (stem(other) !== key && !list.some(([w]) => w === stem(other))) list.push([stem(other), weight]);
  RELATED.set(key, list);
};
for (const group of GROUPS) for (const a of group.split(" ")) for (const b of group.split(" ")) relate(a, b, 0.7);
for (const [word, needs] of Object.entries(INTENTS)) for (const need of needs.split(" ")) relate(word, need, 0.6);

/** Plain words for a component name. A known prefix is dropped; `Button/Primary` stays Button. */
export const nameWords = (name: string, namespaces: ReadonlySet<string> = namespaceSet()): string =>
  figmaMatchLabel(name, namespaces).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ");

/** Stems of namespace words. A shared word that is only one of these does not count. */
export function namespaceStems(namespaces: ReadonlySet<string>): Set<string> {
  return new Set([...namespaces].flatMap((word) => [stem(word), stem(word.replace(/s$/, ""))]));
}
