import { z } from "zod";
import { parseLibraryRules, type LibraryRules } from "./agentSurface";
import { parseBindRulesFile, type BindRulesFile } from "./bindRules";
import type { WorkspaceManifest } from "./workspace";

/**
 * Product + journey context packs. Designers edit JSON under .graphify/.
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
  recipeIds?: string[];
  /** Optional product/client file keys or labels from `.graphify/workspace.json`. */
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
  workspace?: WorkspaceManifest;
}

export interface AppliedContext {
  id: string;
  product?: string;
  client?: string;
  domain?: string;
  journey?: string;
  files?: string[];
}

export interface ContextQuery {
  packId?: string;
  product?: string;
  journey?: string;
  domain?: string;
  recipeId?: string;
}

const STOPWORDS = new Set(["a", "an", "the", "and", "or", "for", "to", "of", "with"]);

const tokensOf = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 1 && !STOPWORDS.has(part));

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
  const a11y = typeof record["a11y"] === "string" ? record["a11y"].trim() : "";
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

/** Designer JSON in, packs out. Unknown keys and figmaNodeId ignored. Bad files → []. */
export function parseContextPackFile(raw: unknown): ContextPackFile {
  if (Array.isArray(raw)) return { packs: raw.flatMap(parseOne) };
  if (!raw || typeof raw !== "object") return { packs: [] };
  const record = raw as Record<string, unknown>;
  const lists = record["packs"] ?? record["contextPacks"];
  const packs = Array.isArray(lists) ? lists.flatMap(parseOne) : [];
  const activeRaw = typeof record["active"] === "string" ? record["active"].trim() : "";
  return { packs, ...(activeRaw ? { active: activeRaw } : {}) };
}

export function appliedContext(pack: ContextPack): AppliedContext {
  const product = pack.product?.name || pack.product?.id;
  const client = pack.client?.name || pack.client?.id;
  const journey = pack.journey?.screenJob || pack.journey?.step;
  return {
    id: pack.id,
    ...(product ? { product } : {}),
    ...(client ? { client } : {}),
    ...(pack.domain ? { domain: pack.domain } : {}),
    ...(journey ? { journey } : {}),
    ...(pack.files?.length ? { files: pack.files } : {}),
  };
}

export function contextPhrase(pack: ContextPack): string {
  return [
    pack.product?.name || pack.product?.id,
    pack.client?.name || pack.client?.id,
    pack.domain,
    pack.journey?.screenJob || pack.journey?.step,
    pack.audience,
    pack.constraints?.density,
    pack.constraints?.a11y,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");
}

function packHaystack(pack: ContextPack): Set<string> {
  return new Set(
    tokensOf(
      [
        pack.id,
        pack.product?.id,
        pack.product?.name,
        pack.domain,
        pack.journey?.step,
        pack.journey?.screenJob,
        ...(pack.recipeIds ?? []),
      ]
        .filter(Boolean)
        .join(" "),
    ),
  );
}

function scorePack(pack: ContextPack, tokens: string[]): number {
  if (!tokens.length) return 0;
  const haystack = packHaystack(pack);
  return tokens.reduce((count, token) => count + (haystack.has(token) ? 1 : 0), 0);
}

function bestPack(packs: ContextPack[], tokens: string[]): ContextPack | undefined {
  let best: { pack: ContextPack; score: number } | undefined;
  for (const pack of packs) {
    const score = scorePack(pack, tokens);
    if (score === 0) continue;
    if (!best || score > best.score || (score === best.score && pack.id < best.pack.id)) {
      best = { pack, score };
    }
  }
  return best?.pack;
}

export function matchContextPack(packs: ContextPack[], query: ContextQuery): ContextPack | undefined {
  const packId = query.packId?.trim();
  if (packId) {
    const needle = packId.toLowerCase();
    return packs.find((pack) => pack.id.toLowerCase() === needle);
  }

  const tokens = tokensOf([query.product, query.journey, query.domain].filter(Boolean).join(" "));
  const recipeId = query.recipeId?.trim();
  const bound = recipeId ? packs.filter((pack) => pack.recipeIds?.includes(recipeId)) : [];
  if (bound.length === 1) return bound[0];
  if (bound.length > 1) return (tokens.length ? bestPack(bound, tokens) : undefined) ?? [...bound].sort((a, b) => a.id.localeCompare(b.id))[0];
  if (tokens.length) return bestPack(packs, tokens);
  return undefined;
}

export function packForRecipe(
  recipe: { id: string; contextPackId?: string },
  bind: ContextBind = { packs: [] },
): ContextPack | undefined {
  const packs = bind.packs;
  if (bind.packId?.trim()) return matchContextPack(packs, { packId: bind.packId });
  if (recipe.contextPackId) {
    const named = matchContextPack(packs, { packId: recipe.contextPackId });
    if (named) return named;
  }
  const bound = matchContextPack(packs, {
    recipeId: recipe.id,
    product: bind.product,
    journey: bind.journey,
    domain: bind.domain,
  });
  if (bound) return bound;
  const flagged = matchContextPack(packs, {
    product: bind.product,
    journey: bind.journey,
    domain: bind.domain,
  });
  if (flagged) return flagged;
  if (!bind.active) return undefined;
  const active = matchContextPack(packs, { packId: bind.active });
  if (!active) return undefined;
  if (active.recipeIds?.length && !active.recipeIds.includes(recipe.id)) return undefined;
  return active;
}

function inlinePack(bind: ContextBind): ContextPack | undefined {
  if (!bind.product && !bind.journey && !bind.domain) return undefined;
  return {
    id: "inline",
    product: productOf(bind.product),
    domain: bind.domain?.trim() || undefined,
    journey: journeyOf(bind.journey),
  };
}

/** Active / flagged pack for recommend when no recipe is in play. */
export function packForRecommend(bind: ContextBind = { packs: [] }): ContextPack | undefined {
  if (bind.packId?.trim()) return matchContextPack(bind.packs, { packId: bind.packId });
  const flagged = matchContextPack(bind.packs, {
    product: bind.product,
    journey: bind.journey,
    domain: bind.domain,
  });
  if (flagged) return flagged;
  if (bind.product || bind.journey || bind.domain) return inlinePack(bind);
  if (bind.active) return matchContextPack(bind.packs, { packId: bind.active });
  return undefined;
}
