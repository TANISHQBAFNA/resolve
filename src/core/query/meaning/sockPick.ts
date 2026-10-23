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

function noDescription(component: SockComponent): boolean {
  return component.thin.includes("description") || component.description.trim().length < 12;
}

function namePlusProp(component: SockComponent, quote: string): boolean {
  const name = normQuote(component.name);
  if (!name || !quote.includes(name)) return false;
  for (const [key, values] of Object.entries(component.propOptions)) {
    const prop = normQuote(key);
    if (!prop || !quote.includes(prop)) continue;
    if (values.some((value) => quote.includes(normQuote(value)))) return true;
  }
  return false;
}

function sourceLines(component: SockComponent): string[] {
  const lines = component.quoteLines?.length ? [...component.quoteLines] : [component.description, component.job];
  for (const [key, values] of Object.entries(component.propOptions)) {
    for (const value of values) lines.push(`${key} ${value}`);
  }
  return lines.filter(Boolean);
}

function quoteCheck(component: SockComponent, reason: string | undefined): "quote" | "alias-quote" | undefined {
  if (!reason || /[\r\n]/.test(reason)) return "quote";
  const quote = normQuote(reason);
  if (!quote) return "quote";
  if (component.aliases.some((name) => normQuote(name) === quote)) return "alias-quote";
  if (noDescription(component) && namePlusProp(component, quote)) return undefined;
  if (wordCount(quote) < 3 || quote.length < 12) return "quote";
  const owned = sourceLines(component).map((line) => normQuote(line.split(/[\r\n]/)[0] ?? ""));
  if (owned.some((line) => line.includes(quote))) return undefined;
  if (component.aliases.some((name) => normQuote(name).includes(quote))) return "alias-quote";
  return "quote";
}

function propsFail(component: SockComponent, props: Record<string, string>): boolean {
  for (const [key, value] of Object.entries(props)) {
    const options = component.propOptions[key.toLowerCase()];
    if (!options || !options.some((option) => option.toLowerCase() === value.toLowerCase())) return true;
  }
  return false;
}

function shortlistFail(pack: MeaningPack, req: PickRequest, id: string): boolean {
  const list = req.shortlist;
  if (!list || list.length === 0 || list.length > 3) return true;
  const ids = new Set(pack.components.map((component) => component.id));
  if (!list.every((item) => ids.has(item))) return true;
  return !list.includes(id);
}

function thinEntries(pack: MeaningPack): ThinEntry[] {
  return pack.components.filter((component) => component.thin.length > 0).map((component) => ({ id: component.id, missing: component.thin }));
}

function pickResult(tier: PickTier, failed: PickCheck[], thin: ThinEntry[], stale: string | undefined, shown?: { id: string; name: string; reason?: string }): PickResult {
  return {
    tier,
    failed,
    thin,
    ...(stale ? { stale } : {}),
    ...(shown ? { id: shown.id, name: shown.name, ...(shown.reason ? { reason: shown.reason } : {}) } : {}),
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
  if (quote) failed.push(quote);
  if (failed.length) return pickResult("no-fit", failed, thin, stale);
  const shown = { id: component.id, name: component.name, ...(req.reason ? { reason: req.reason } : {}) };
  if ((component.thin.length > 0 || noDescription(component)) && tier === "place") return pickResult("ask", ["thin-cap"], thin, stale, shown);
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
      for (const value of values) quoteLines.push(`${part.slice(0, splitAt).trim()} ${value}`);
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
