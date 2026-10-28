import type { MeaningPack, PickCheck, PickRequest, PickResult, PickTier, SockComponent, ThinEntry } from "./sock";

const PICK_TIERS = ["place", "ask", "no-fit"] as const;
const RETIRED_TEXT = /\bdeprecated\b|\bretired\b|replaced by/i;

function isPickTier(value: string): value is PickTier {
  return (PICK_TIERS as readonly string[]).includes(value);
}

function normQuote(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function wordCount(quote: string): number {
  return quote.split(" ").filter(Boolean).length;
}

function staleLine(libraryBuiltAt: string | undefined, sockBuiltAt: string): string | undefined {
  if (!libraryBuiltAt || !sockBuiltAt) return undefined;
  if (libraryBuiltAt > sockBuiltAt) return `Meaning files are older than the library (${sockBuiltAt} < ${libraryBuiltAt}). Rebuild them.`;
  return undefined;
}

function textRetired(component: SockComponent): boolean {
  if (component.retired) return true;
  return RETIRED_TEXT.test(`${component.description}\n${component.job}`);
}

const STOP = new Set(["a", "an", "the", "and", "or", "of", "to", "for", "with", "in", "on", "by", "from", "is", "are", "was", "be", "as", "at", "it", "its", "this", "that", "when", "used", "displayed", "into", "over", "than", "then", "not"]);

function bare(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function contentWord(quote: string): boolean {
  return quote.split(" ").some((word) => {
    const token = word.replace(/[^a-z0-9]/g, "");
    return token.length > 0 && !STOP.has(token);
  });
}

function textLines(component: SockComponent): string[] {
  const lines = component.quoteLines?.length ? component.quoteLines : [component.description, component.job].filter(Boolean);
  return lines.flatMap((line) => line.split(/\r?\n/)).map((line) => line.trim()).filter(Boolean);
}

function hasRealDescription(component: SockComponent): boolean {
  const name = bare(component.name);
  return textLines(component).some((line) => bare(line) !== name);
}

function hasProperties(component: SockComponent): boolean {
  return Object.keys(component.propOptions).length > 0;
}

function aliasHit(component: SockComponent, quote: string): boolean {
  const key = bare(quote);
  return component.aliases.some((name) => bare(name) === key);
}

function hasLink(text: string): boolean {
  return /https?:|www\.|\]\(/.test(text);
}

function visible(text: string): string {
  return text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/gi, " ").replace(/\bwww\.\S+/gi, " ");
}

function quoteCheck(component: SockComponent, reason: string | undefined): { fail?: "quote" | "alias-quote"; nameOnly?: boolean } {
  if (!reason || /[\r\n]/.test(reason) || hasLink(reason)) return { fail: "quote" };
  const quote = normQuote(reason);
  if (!quote) return { fail: "quote" };
  const name = normQuote(component.name);
  if (quote === name && !hasRealDescription(component) && !hasProperties(component)) return { nameOnly: true };
  if (aliasHit(component, quote)) return { fail: "alias-quote" };
  const nameTokens = component.name.trim().split(/\s+/);
  const tokens = reason.trim().split(/\s+/);
  if (tokens.length === nameTokens.length + 2 && normQuote(tokens.slice(0, nameTokens.length).join(" ")) === name) {
    const prop = tokens[nameTokens.length] ?? "";
    const value = tokens[nameTokens.length + 1] ?? "";
    const values = component.propOptions[prop.toLowerCase()];
    if (values?.some((item) => item.toLowerCase() === value.toLowerCase())) return {};
  }
  for (const line of textLines(component)) {
    if (!hasLink(line) && normQuote(line) === quote && bare(line) !== bare(component.name) && !aliasHit(component, line) && contentWord(quote)) return {};
    if (wordCount(quote) < 3 || quote.length < 12 || !contentWord(quote)) continue;
    for (const sentence of visible(line).split(/(?<=[.!?])\s+/)) {
      if (normQuote(sentence).includes(quote)) return {};
    }
  }
  return { fail: "quote" };
}

function propsFail(component: SockComponent, props: Record<string, string>): boolean {
  for (const [key, value] of Object.entries(props)) {
    const options = component.propOptions[key.toLowerCase()];
    if (!options || !options.some((option) => option.toLowerCase() === value.toLowerCase())) return true;
  }
  return false;
}

/** Pick first, other ids A–Z. Does not add an id that was not offered. */
export function stableShortlist(pick: string | undefined, list: readonly string[] | undefined): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of list ?? []) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length > 3) ids.length = 3;
  const lead = pick?.trim() ?? "";
  if (!lead || !ids.includes(lead)) return [...ids].sort((a, b) => a.localeCompare(b));
  return [lead, ...ids.filter((id) => id !== lead).sort((a, b) => a.localeCompare(b))];
}

function stem(word: string): string {
  return word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
}

function contentTokens(text: string): Set<string> {
  return new Set(bare(text).split(" ").map(stem).filter((word) => word.length > 1 && !STOP.has(word)));
}

function componentTokens(component: SockComponent): Set<string> {
  return contentTokens([component.name, ...component.aliases, ...textLines(component)].join(" "));
}

/**
 * Extra score for an id the model also offered. Calibration knob, measured on the Oct 26 stored runs (50 asks with the same lead):
 * 0 gives identical lists in 49/50 but keeps 15/67 of the alternates both model runs offered; 1 gives 39/50 and 26/67; 3 gives 26/50 and 40/67.
 * Re-tune after a fresh blind run.
 */
const OFFERED_BONUS = 1;

/**
 * Slots 2 and 3 come from the pack, not from the model, so the same ask and lead always give the same list.
 * Score = 2 x words shared with the ask + words shared with the lead's own text + OFFERED_BONUS if the model offered it; ties by name, then id.
 * Fewer than two scored neighbours: fill from the ids the model offered, A–Z.
 * ponytail: word overlap only, long descriptions score high; swap in a real similarity if a blind run says top-3 fell.
 */
export function engineShortlist(pack: MeaningPack, lead: SockComponent, ask: string, offered: readonly string[]): string[] {
  const askWords = contentTokens(ask);
  const leadWords = componentTokens(lead);
  const shared = (words: Set<string>, other: Set<string>) => [...words].filter((word) => other.has(word)).length;
  const offeredSet = new Set(offered);
  const live = pack.components.filter((component) => component.id !== lead.id && !textRetired(component));
  const scored = live
    .map((component) => {
      const words = componentTokens(component);
      return { component, score: 2 * shared(askWords, words) + shared(leadWords, words) + (offeredSet.has(component.id) ? OFFERED_BONUS : 0) };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.component.name.localeCompare(b.component.name) || a.component.id.localeCompare(b.component.id))
    .map((entry) => entry.component.id);
  const liveIds = new Set(live.map((component) => component.id));
  const fill = [...new Set(offered)].filter((id) => liveIds.has(id) && !scored.includes(id)).sort((a, b) => a.localeCompare(b));
  return [lead.id, ...scored, ...fill].slice(0, 3);
}

function shortlistFail(pack: MeaningPack, req: PickRequest, id: string): boolean {
  const list = req.shortlist;
  if (!list || list.length === 0 || list.length > 3 || new Set(list).size !== list.length) return true;
  const ids = new Set(pack.components.map((component) => component.id));
  if (!list.every((item) => ids.has(item))) return true;
  return !list.includes(id);
}

function thinEntries(pack: MeaningPack): ThinEntry[] {
  return pack.components.filter((component) => component.thin.length > 0).map((component) => ({ id: component.id, missing: component.thin }));
}

function pickResult(tier: PickTier, failed: PickCheck[], thin: ThinEntry[], stale: string | undefined, shown?: { id: string; name: string; reason?: string; nameOnly?: boolean; shortlist?: string[] }): PickResult {
  return {
    tier,
    failed,
    thin,
    ...(stale ? { stale } : {}),
    ...(shown?.nameOnly ? { nameOnly: true } : {}),
    ...(shown ? { id: shown.id, name: shown.name, ...(shown.reason ? { reason: shown.reason } : {}) } : {}),
    ...(shown?.shortlist ? { shortlist: shown.shortlist } : {}),
  };
}

export function validateAiPick(pack: MeaningPack, req: PickRequest, libraryBuiltAt?: string): PickResult {
  const thin = thinEntries(pack);
  const stale = staleLine(libraryBuiltAt, pack.builtAt);
  const tier = isPickTier(req.tier) ? req.tier : undefined;
  if (!tier) return pickResult("no-fit", ["tier"], thin, stale);
  if (tier === "no-fit") return pickResult("no-fit", [], thin, stale);
  const id = req.pick?.trim() ?? "";
  const component = id ? pack.components.find((item) => item.id === id) : undefined;
  if (!component) return pickResult("no-fit", ["exists"], thin, stale);
  if (shortlistFail(pack, req, id)) return pickResult("no-fit", ["shortlist"], thin, stale);
  if (textRetired(component)) return pickResult("no-fit", ["retired"], thin, stale);
  const failed: PickCheck[] = [];
  if (req.invalidProps || propsFail(component, req.props ?? {})) failed.push("props");
  const quote = quoteCheck(component, req.reason);
  if (quote.fail) failed.push(quote.fail);
  if (failed.length) return pickResult("no-fit", failed, thin, stale);
  const shown = {
    id: component.id,
    name: component.name,
    shortlist: engineShortlist(pack, component, req.ask, req.shortlist),
    ...(req.reason ? { reason: req.reason } : {}),
    ...(quote.nameOnly ? { nameOnly: true } : {}),
  };
  if (quote.nameOnly) {
    const marked = thin.map((entry) => (entry.id === component.id ? { ...entry, nameOnly: true } : entry));
    return pickResult("ask", tier === "place" ? ["thin-cap"] : [], marked, stale, shown);
  }
  if (component.thin.length > 0 && tier === "place") return pickResult("ask", ["thin-cap"], thin, stale, shown);
  return pickResult(tier, [], thin, stale, shown);
}

function proseLines(markdown: string): string[] {
  return markdown.split("\n").map((line) => line.trim()).filter((line) => {
    if (!line || line.startsWith("# ") || line.startsWith("Aliases") || line.startsWith("Properties:") || line.startsWith("Thin:")) return false;
    if (line.startsWith("© ") || line.startsWith("Source:") || /^https?:\/\//.test(line)) return false;
    if (line === "status: deprecated" || /^\[[^\]]+\]\(index\.md\)$/.test(line)) return false;
    return true;
  });
}

export function componentFromMarkdown(id: string, markdown: string): SockComponent {
  const lines = markdown.split("\n");
  const title = lines.find((line) => line.startsWith("# ")) ?? "";
  const name = title.includes(" / ") ? title.slice(title.lastIndexOf(" / ") + 3).trim() : id;
  const aliasLine = lines.find((line) => line.startsWith("Aliases")) ?? "";
  const aliases = aliasLine.slice(aliasLine.indexOf(":") + 1).split(",").map((item) => item.trim()).filter(Boolean);
  const propLine = lines.find((line) => line.startsWith("Properties:")) ?? "";
  const propOptions: Record<string, string[]> = {};
  const properties: string[] = [];
  const quoteLines: string[] = [];
  if (propLine) {
    const body = propLine.slice("Properties:".length).trim();
    properties.push(body);
    for (const part of body.split(";")) {
      const splitAt = part.indexOf(":");
      if (splitAt < 0) continue;
      const key = part.slice(0, splitAt).trim().toLowerCase();
      const values = part.slice(splitAt + 1).split(",").map((item) => item.trim()).filter(Boolean);
      if (key && values.length) propOptions[key] = values;
    }
  }
  const thinLine = lines.find((line) => line.startsWith("Thin:")) ?? "";
  const missing = /missing\s+(.+)$/.exec(thinLine)?.[1] ?? "";
  const thin = missing.split(",").map((item) => item.trim()).filter(Boolean);
  const prose = proseLines(markdown);
  quoteLines.push(...prose);
  const retired = lines.some((line) => line.trim() === "status: deprecated") || RETIRED_TEXT.test(prose.join("\n"));
  return {
    id,
    name,
    aliases,
    description: prose.join(" "),
    job: prose[0] ?? "",
    properties,
    propOptions,
    retired,
    thin,
    quoteLines,
  };
}

export function packFromFiles(library: string, builtAt: string, files: ReadonlyMap<string, string>): MeaningPack {
  const components = [...files.entries()].map(([id, markdown]) => componentFromMarkdown(id, markdown));
  components.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { library, vocab: "", builtAt, components };
}
