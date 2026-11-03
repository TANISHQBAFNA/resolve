import type {
  KnowledgeAgreement,
  KnowledgeField,
  KnowledgePair,
  KnowledgeSource,
  ParsedClaim,
  ParsedComponent,
  ParsedRecipe,
  ScannedComponent,
  ScannerSnapshot,
} from "./types";
import { readRepoFile } from "./readRepo";

const CLASS_ATTR = /class\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

function byText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function byPair(left: KnowledgePair, right: KnowledgePair): number {
  return byText(left.id, right.id) || byText(left.field, right.field) || byText(left.value, right.value) || byText(left.source, right.source);
}

function partKey(owner: string, raw: string): string {
  const text = raw.trim().toLowerCase();
  const prefix = `${owner.trim().toLowerCase()}__`;
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

function variantKey(raw: string): string {
  const text = raw.trim().toLowerCase();
  const at = text.lastIndexOf("--");
  return at >= 0 ? text.slice(at + 2) : text;
}

function tokenKey(raw: string): string {
  const text = raw.trim();
  return text.startsWith("--") ? text : `--${text}`;
}

function claim(id: string, field: KnowledgeField, value: string, source: KnowledgeSource): KnowledgePair {
  return { id, field, value, source };
}

function fromNames(id: string, field: KnowledgeField, names: string[], source: KnowledgeSource, map: (name: string) => string): KnowledgePair[] {
  return names.filter((name) => name.trim()).map((name) => claim(id, field, map(name), source));
}

function aiLists(component: ParsedComponent, source: KnowledgeSource): KnowledgePair[] {
  const id = component.id;
  const named = (field: KnowledgeField, list: ParsedClaim[], map: (name: string) => string) => fromNames(id, field, list.map((item) => item.name), source, map);
  return [
    claim(id, "id", id, source),
    ...named("props", component.props, (name) => name.toLowerCase()),
    ...named("variants", component.variants, variantKey),
    ...named("parts", component.parts, (name) => partKey(component.name, name)),
    ...named("slots", component.slots, (name) => name.toLowerCase()),
    ...named("tokens", component.tokens, tokenKey),
    ...named("aliases", component.aliases, (name) => name.toLowerCase()),
  ];
}

function scannerLists(component: ScannedComponent): KnowledgePair[] {
  const id = component.dsId ?? component.name;
  return [
    claim(id, "id", id, "scanner"),
    ...fromNames(id, "variants", component.variants, "scanner", variantKey),
    ...fromNames(id, "parts", component.elements, "scanner", (name) => partKey(component.name, name)),
    ...fromNames(id, "tokens", component.tokens, "scanner", tokenKey),
    ...fromNames(id, "aliases", component.aliases, "scanner", (name) => name.toLowerCase()),
  ];
}

function classesOf(html: string): string[] {
  const names: string[] = [];
  for (const match of html.matchAll(CLASS_ATTR)) {
    const body = match[1] ?? match[2] ?? "";
    for (const name of body.split(/\s+/)) if (name) names.push(name);
  }
  return names;
}

function blockOwner(cls: string, components: ScannedComponent[]): ScannedComponent | undefined {
  const base = cls.split("--")[0]?.split("__")[0] ?? cls;
  return components.find((item) => item.kind === "block" && item.name === base);
}

function composedIds(recipe: ScannedComponent, snapshot: ScannerSnapshot, repo: string): string[] {
  const ids = new Set<string>();
  for (const file of snapshot.files) {
    if (!file.endsWith(".html") || !file.split("/").includes(recipe.name)) continue;
    const text = readRepoFile(repo, file);
    if (text === undefined) continue;
    for (const cls of classesOf(text)) {
      const owner = blockOwner(cls, snapshot.components);
      if (!owner) continue;
      ids.add(owner.dsId ?? owner.name);
    }
  }
  return [...ids].sort(byText);
}

function recipeMatch(recipe: ParsedRecipe, components: ScannedComponent[]): ScannedComponent | undefined {
  return components.find((item) => item.kind === "recipe" && (item.name === recipe.id || item.dsId === recipe.id));
}

function diff(ai: KnowledgePair[], scanner: KnowledgePair[]): { pairs: KnowledgePair[]; agreements: KnowledgeAgreement[]; disagreements: KnowledgePair[] } {
  const sources = new Map<string, Set<KnowledgeSource>>();
  const sample = new Map<string, KnowledgePair>();
  for (const item of [...ai, ...scanner]) {
    const key = `${item.id}\0${item.field}\0${item.value}`;
    const have = sources.get(key) ?? new Set<KnowledgeSource>();
    have.add(item.source);
    sources.set(key, have);
    sample.set(key, item);
  }
  const pairs: KnowledgePair[] = [];
  const agreements: KnowledgeAgreement[] = [];
  const disagreements: KnowledgePair[] = [];
  for (const [key, have] of sources) {
    const item = sample.get(key);
    if (!item) continue;
    for (const source of ["ai", "scanner"] as const) if (have.has(source)) pairs.push({ id: item.id, field: item.field, value: item.value, source });
    if (have.has("ai") && have.has("scanner")) agreements.push({ id: item.id, field: item.field, value: item.value });
    else disagreements.push({ id: item.id, field: item.field, value: item.value, source: have.has("ai") ? "ai" : "scanner" });
  }
  pairs.sort(byPair);
  agreements.sort((left, right) => byText(left.id, right.id) || byText(left.field, right.field) || byText(left.value, right.value));
  disagreements.sort(byPair);
  return { pairs, agreements, disagreements };
}

/** AI claims against a fresh scanner snapshot. Each pair is marked source ai or source scanner. */
export function compareKnowledge(
  components: ParsedComponent[],
  recipes: ParsedRecipe[],
  snapshot: ScannerSnapshot,
  repo: string | undefined,
): { pairs: KnowledgePair[]; agreements: KnowledgeAgreement[]; disagreements: KnowledgePair[] } {
  const ai: KnowledgePair[] = [];
  const scanner: KnowledgePair[] = [];
  const matched = new Set<ScannedComponent>();
  for (const component of components) {
    ai.push(...aiLists(component, "ai"));
    const found = snapshot.components.find((item) => item.dsId === component.id) ?? snapshot.components.find((item) => item.name === component.name);
    if (!found) continue;
    matched.add(found);
    scanner.push(...scannerLists(found));
  }
  for (const item of snapshot.components) {
    if (matched.has(item)) continue;
    const id = item.dsId ?? item.name;
    scanner.push(claim(id, "id", id, "scanner"));
  }
  for (const recipe of recipes) {
    for (const id of recipe.components) ai.push(claim(recipe.id, "components", id, "ai"));
    const found = recipeMatch(recipe, snapshot.components);
    if (!found || !repo) continue;
    for (const id of composedIds(found, snapshot, repo)) scanner.push(claim(recipe.id, "components", id, "scanner"));
  }
  return diff(ai, scanner);
}
