import { z } from "zod";
import { parseLibraryRules, type LibraryRules } from "./agentSurface";
import { parseBindRulesFile, type BindRulesFile } from "./bindRules";
import type { WorkspaceManifest } from "./workspace";

/**
 * Product + journey context packs. Designers edit JSON under .resolve/.
 * Binds a shared library to *this* product and *this* journey step.
 * Never carries invented Figma node ids.
 */

export interface ContextConstraints {
  density?: string;
  a11y?: string;
}

export interface ContextPack {
  id: string;
  product?: { id?: string; name?: string };
  /** When product ≠ client, same pack schema — not a second model. */
  client?: { id?: string; name?: string };
  domain?: string;
  journey?: { step?: string; screenJob?: string };
  audience?: string;
  constraints?: ContextConstraints;
  /** Where each echoed field came from. Not used for ranking. */
  sources?: ContextSources;
  /** Plain warning when a pack id is unknown or fights the document product. */
  warning?: string;
  recipeIds?: string[];
  /** Optional product/client labels from `.resolve/workspace.json`. Not Figma file keys. */
  files?: string[];
  libraryRules?: LibraryRules;
  bindRules?: BindRulesFile;
}

export interface ContextPackFile {
  packs: ContextPack[];
  active?: string;
}

export interface ContextBind {
  packs: ContextPack[];
  active?: string;
  packId?: string;
  product?: string;
  journey?: string;
  domain?: string;
  /** Who the screen is for. Overrides the pack for this call. */
  audience?: string;
  /** Accessibility bar, for example wcag-aa. Overrides the pack. Not an audit. */
  a11y?: string;
  workspace?: WorkspaceManifest;
}

/** `document`, `pack <id>`, or `active pack`. */
export interface ContextSources {
  product?: string;
  client?: string;
  domain?: string;
  journey?: string;
  audience?: string;
  a11y?: string;
}

export interface AppliedContext {
  id?: string;
  product?: string;
  productFrom?: string;
  client?: string;
  clientFrom?: string;
  domain?: string;
  domainFrom?: string;
  journey?: string;
  journeyFrom?: string;
  audience?: string;
  audienceFrom?: string;
  a11y?: string;
  a11yFrom?: string;
  files?: string[];
  warning?: string;
}

export interface ContextQuery {
  packId?: string;
  product?: string;
  journey?: string;
  domain?: string;
  recipeId?: string;
}

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

function productOf(raw: unknown): ContextPack["product"] {
  if (typeof raw === "string") {
    const name = raw.trim();
    if (!name) return undefined;
    return { id: slug(name), name };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const id = typeof record["id"] === "string" ? record["id"].trim() : "";
  const name = typeof record["name"] === "string" ? record["name"].trim() : "";
  if (!id && !name) return undefined;
  return { id: id || slug(name), name: name || id };
}

function journeyOf(raw: unknown): ContextPack["journey"] {
  if (typeof raw === "string") {
    const step = raw.trim();
    if (!step) return undefined;
    return { step, screenJob: step };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const step = typeof record["step"] === "string" ? record["step"].trim() : "";
  const screenJob = typeof record["screenJob"] === "string" ? record["screenJob"].trim() : "";
  if (!step && !screenJob) return undefined;
  return { step: step || undefined, screenJob: screenJob || undefined };
}

function constraintsOf(raw: unknown): ContextConstraints | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const density = typeof record["density"] === "string" ? record["density"].trim() : "";
  const a11yRaw = typeof record["a11y"] === "string" ? record["a11y"].trim() : "";
  const a11y = a11yRaw ? normaliseA11y(a11yRaw) : "";
  if (!density && !a11y) return undefined;
  return { ...(density ? { density } : {}), ...(a11y ? { a11y } : {}) };
}

function stringList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const items = raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

const PackIdSchema = z.string().trim().min(1);

function parseOne(raw: unknown): ContextPack[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const record = raw as Record<string, unknown>;
  const id = PackIdSchema.safeParse(record["id"]);
  if (!id.success) return [];
  const libraryRules = parseLibraryRules(record["libraryRules"] ?? record["library-rules"]);
  const hasRules = Boolean(libraryRules.allow || libraryRules.deny);
  const bindRaw = record["bindRules"] ?? record["bind-rules"];
  const bindRules = bindRaw == null ? undefined : parseBindRulesFile(bindRaw);
  return [
    {
      id: id.data,
      product: productOf(record["product"]),
      client: productOf(record["client"]),
      domain: typeof record["domain"] === "string" ? record["domain"].trim() || undefined : undefined,
      journey: journeyOf(record["journey"]),
      audience: typeof record["audience"] === "string" ? record["audience"].trim() || undefined : undefined,
      constraints: constraintsOf(record["constraints"]),
      recipeIds: stringList(record["recipeIds"] ?? record["recipes"]),
      files: stringList(record["files"]),
      ...(hasRules ? { libraryRules } : {}),
      ...(bindRules?.rules.length ? { bindRules } : {}),
    },
  ];
}

/** Designer JSON in, packs out. Unknown keys and figmaNodeId ignored. Bad files → []. Ranking uses this. `resolve pack validate` is strict. `readContextPacks` skips a bad pack or field and warns once. */
export function parseContextPackFile(raw: unknown): ContextPackFile {
  if (Array.isArray(raw)) return { packs: raw.flatMap(parseOne) };
  if (!raw || typeof raw !== "object") return { packs: [] };
  const record = raw as Record<string, unknown>;
  const lists = record["packs"] ?? record["contextPacks"];
  const packs = Array.isArray(lists) ? lists.flatMap(parseOne) : [];
  const activeRaw = typeof record["active"] === "string" ? record["active"].trim() : "";
  return { packs, ...(activeRaw ? { active: activeRaw } : {}) };
}

/** `AA` and `WCAG AA` become `wcag-aa`. Anything else is returned trimmed. */
export function normaliseA11y(raw: string): string {
  const compact = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (compact === "a" || compact === "wcaga") return "wcag-a";
  if (compact === "aa" || compact === "wcagaa") return "wcag-aa";
  if (compact === "aaa" || compact === "wcagaaa") return "wcag-aaa";
  return raw.trim();
}

const fold = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");

function productMatch(pack: ContextPack, product: string): boolean {
  const want = fold(product);
  if (!want) return false;
  return [pack.product?.id, pack.product?.name].some((name) => Boolean(name) && fold(name!) === want);
}

function journeyMatch(pack: ContextPack, journey: string): boolean {
  const want = fold(journey);
  if (!want) return false;
  return [pack.journey?.step, pack.journey?.screenJob].some((name) => Boolean(name) && fold(name!) === want);
}

function namedPack(packs: ContextPack[], id: string): ContextPack | undefined {
  const needle = id.trim().toLowerCase();
  if (!needle) return undefined;
  return packs.find((pack) => pack.id.toLowerCase() === needle);
}

function sourceFor(pack: ContextPack, key: keyof ContextSources): string | undefined {
  return pack.sources?.[key];
}

export function appliedContext(pack: ContextPack): AppliedContext | undefined {
  const product = pack.product?.name || pack.product?.id;
  const client = pack.client?.name || pack.client?.id;
  const journey = pack.journey?.screenJob || pack.journey?.step;
  const a11y = pack.constraints?.a11y ? normaliseA11y(pack.constraints.a11y) : undefined;
  const from = (key: keyof ContextSources) => sourceFor(pack, key);
  const sourceValues = Object.values(pack.sources ?? {});
  const chosen = sourceValues.length
    ? sourceValues.some((item) => item === "active pack" || item.startsWith("pack "))
    : Boolean(pack.id);
  const echo: AppliedContext = {
    ...(chosen && pack.id ? { id: pack.id } : {}),
    ...(product ? { product, ...(from("product") ? { productFrom: from("product") } : {}) } : {}),
    ...(client ? { client, ...(from("client") ? { clientFrom: from("client") } : {}) } : {}),
    ...(pack.domain ? { domain: pack.domain, ...(from("domain") ? { domainFrom: from("domain") } : {}) } : {}),
    ...(journey ? { journey, ...(from("journey") ? { journeyFrom: from("journey") } : {}) } : {}),
    ...(pack.audience ? { audience: pack.audience, ...(from("audience") ? { audienceFrom: from("audience") } : {}) } : {}),
    ...(a11y ? { a11y, ...(from("a11y") ? { a11yFrom: from("a11y") } : {}) } : {}),
    ...(pack.files?.length ? { files: pack.files } : {}),
    ...(pack.warning ? { warning: pack.warning } : {}),
  };
  if (!product && !client && !pack.domain && !journey && !pack.audience && !a11y && !pack.warning) return undefined;
  return echo;
}

export function contextPhrase(pack: ContextPack): string {
  // Audience, density, and a11y are echo only. They must not enter the recommend text.
  return [pack.product?.name || pack.product?.id, pack.client?.name || pack.client?.id, pack.domain, pack.journey?.screenJob || pack.journey?.step]
    .filter((part): part is string => Boolean(part))
    .join(" ");
}

function exactPacks(packs: ContextPack[], product?: string, journey?: string): ContextPack[] {
  const named = product?.trim();
  if (!named) return [];
  let hits = packs.filter((pack) => productMatch(pack, named));
  const step = journey?.trim();
  if (step) hits = hits.filter((pack) => journeyMatch(pack, step));
  return hits;
}

export function matchContextPack(packs: ContextPack[], query: ContextQuery): ContextPack | undefined {
  if (query.packId?.trim()) return namedPack(packs, query.packId);
  const product = query.product?.trim();
  const recipeId = query.recipeId?.trim();
  if (!product && recipeId) {
    const bound = packs.filter((pack) => pack.recipeIds?.includes(recipeId));
    return bound.length === 1 ? bound[0] : undefined;
  }
  const hits = exactPacks(packs, product, query.journey);
  if (recipeId) {
    const bound = hits.filter((pack) => pack.recipeIds?.includes(recipeId));
    if (bound.length === 1) return bound[0];
  }
  return hits.length === 1 ? hits[0] : undefined;
}

function stated(bind: ContextBind) {
  const product = bind.product?.trim() || undefined;
  const journey = bind.journey?.trim() || undefined;
  const domain = bind.domain?.trim() || undefined;
  const audience = bind.audience?.trim() || undefined;
  const a11y = bind.a11y?.trim() ? normaliseA11y(bind.a11y) : undefined;
  return { product, journey, domain, audience, a11y };
}

/** Fields the document stated, and nothing from a pack. No pack id. */
function documentOnly(bind: ContextBind, warning?: string): ContextPack | undefined {
  const doc = stated(bind);
  const sources: ContextSources = {};
  if (doc.product) sources.product = "document";
  if (doc.journey) sources.journey = "document";
  if (doc.domain) sources.domain = "document";
  if (doc.audience) sources.audience = "document";
  if (doc.a11y) sources.a11y = "document";
  if (!doc.product && !doc.journey && !doc.domain && !doc.audience && !doc.a11y && !warning) return undefined;
  return {
    id: "",
    ...(doc.product ? { product: productOf(doc.product) } : {}),
    ...(doc.domain ? { domain: doc.domain } : {}),
    ...(doc.journey ? { journey: journeyOf(doc.journey) } : {}),
    ...(doc.audience ? { audience: doc.audience } : {}),
    ...(doc.a11y ? { constraints: { a11y: doc.a11y } } : {}),
    sources,
    ...(warning ? { warning } : {}),
  };
}

/** Document fields win. Pack fields fill the gaps and say where they came from. */
function withDocument(pack: ContextPack, bind: ContextBind, source: string, warning?: string): ContextPack {
  const doc = stated(bind);
  const sources: ContextSources = {};
  const packA11y = pack.constraints?.a11y ? normaliseA11y(pack.constraints.a11y) : undefined;
  const a11y = doc.a11y || packA11y;
  if (doc.product) sources.product = "document";
  else if (pack.product) sources.product = source;
  if (doc.journey) sources.journey = "document";
  else if (pack.journey) sources.journey = source;
  if (doc.domain) sources.domain = "document";
  else if (pack.domain) sources.domain = source;
  if (doc.audience) sources.audience = "document";
  else if (pack.audience) sources.audience = source;
  if (doc.a11y) sources.a11y = "document";
  else if (packA11y) sources.a11y = source;
  if (pack.client) sources.client = source;
  return {
    ...pack,
    ...(doc.product ? { product: productOf(doc.product) } : {}),
    ...(doc.journey ? { journey: journeyOf(doc.journey) } : {}),
    ...(doc.domain ? { domain: doc.domain } : {}),
    ...(doc.audience ? { audience: doc.audience } : {}),
    ...(a11y ? { constraints: { ...pack.constraints, a11y } } : {}),
    sources,
    ...(warning ? { warning } : {}),
  };
}

function decidePack(bind: ContextBind, recipe?: { id: string; contextPackId?: string }): ContextPack | undefined {
  const packs = bind.packs;
  const product = bind.product?.trim();
  const journey = bind.journey?.trim();
  const asked = bind.packId?.trim();
  if (asked) {
    const found = namedPack(packs, asked);
    if (!found) return documentOnly(bind, `No context pack "${asked}".`);
    if (product && found.product && !productMatch(found, product)) {
      const name = found.product.name || found.product.id || found.id;
      return documentOnly(bind, `Context pack "${found.id}" is for ${name}, not ${product}.`);
    }
    return withDocument(found, bind, `pack ${found.id}`);
  }
  if (product) {
    const hits = exactPacks(packs, product, journey);
    if (recipe) {
      const bound = hits.filter((pack) => pack.id === recipe.contextPackId || pack.recipeIds?.includes(recipe.id));
      if (bound.length === 1) return withDocument(bound[0]!, bind, `pack ${bound[0]!.id}`);
    }
    if (hits.length === 1) return withDocument(hits[0]!, bind, `pack ${hits[0]!.id}`);
    if (hits.length > 1) {
      return documentOnly(bind, `${hits.length} context packs match ${product}${journey ? ` / ${journey}` : ""}. None was used.`);
    }
    return documentOnly(bind);
  }
  if (recipe?.contextPackId) {
    const named = namedPack(packs, recipe.contextPackId);
    if (named) return withDocument(named, bind, `pack ${named.id}`);
  }
  if (recipe) {
    const bound = packs.filter((pack) => pack.recipeIds?.includes(recipe.id));
    if (bound.length === 1) return withDocument(bound[0]!, bind, `pack ${bound[0]!.id}`);
  }
  if (bind.active) {
    const active = namedPack(packs, bind.active);
    if (active && (!recipe || !active.recipeIds?.length || active.recipeIds.includes(recipe.id))) {
      return withDocument(active, bind, "active pack");
    }
  }
  return documentOnly(bind);
}

export function packForRecipe(
  recipe: { id: string; contextPackId?: string },
  bind: ContextBind = { packs: [] },
): ContextPack | undefined {
  return decidePack(bind, recipe);
}

/** Pack for recommend. Exact product, and exact journey when the document gives one. */
export function packForRecommend(bind: ContextBind = { packs: [] }): ContextPack | undefined {
  return decidePack(bind);
}
