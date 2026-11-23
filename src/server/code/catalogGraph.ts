import type { CatalogEntry, CatalogSpec } from "./scan.ts";
import { expandTerms, tokens } from "./words.ts";

/**
 * Jobs come from the component file's own structure: accessibility roles,
 * part names, and property options with the use line written on each option.
 * A "use X" rule becomes an edge only when X is a real component. Nothing
 * here is copied from a request list, and a proposed edge would not count.
 */

export type Confidence = "high" | "medium" | "low";

export interface Provenance {
  source: "code" | "screen" | "ai";
  file?: string;
  field?: string;
}

export interface CatalogEdge {
  kind: "built-from" | "instead-of";
  from: string;
  to: string;
  provenance: Provenance;
  evidence: string;
  confidence: number;
  review: "extracted" | "proposed";
}

export interface GraphPick {
  name: string;
  /** Values this request decides. The host copies these. */
  settings: Record<string, string>;
  /** The component file's own defaults for everything the request leaves alone. */
  defaults: Record<string, string>;
  states: string[];
  reasons: { job?: string; constraint?: string; context?: string };
  confidence: Confidence;
  edges: CatalogEdge[];
  score: number;
}

interface OptionFact {
  property: string;
  value: string;
  use: string;
}

interface NodeFacts {
  entry: CatalogEntry;
  spec: CatalogSpec;
  roles: { id: string; evidence: string }[];
  options: OptionFact[];
}

const ROLE = /role=["']([a-z]+)["']|\b(radiogroup|tablist|progressbar|listbox|combobox)\b/gi;

function affirmed(sentence: string): boolean {
  return !/\bnot\b|\bnever\b|n't/i.test(sentence);
}

function nodesOf(entries: CatalogEntry[]): NodeFacts[] {
  return entries.flatMap((entry) => {
    const spec = entry.spec;
    if (!spec) return [];
    const roles: NodeFacts["roles"] = [];
    for (const sentence of spec.a11y) {
      if (!affirmed(sentence)) continue;
      ROLE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = ROLE.exec(sentence))) {
        const id = (match[1] || match[2] || "").toLowerCase();
        if (id && !roles.some((role) => role.id === id)) roles.push({ id, evidence: sentence.trim() });
      }
    }
    const options = spec.properties.flatMap((property) =>
      (property.options ?? []).map((option) => ({ property: property.name, value: option.value, use: option.use ?? "" })),
    );
    return [{ entry, spec, roles, options }];
  });
}

function targetNames(raw: string, names: Set<string>, nodes: NodeFacts[]): string[] {
  const phrase = raw.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const hyphen = phrase.replace(/ /g, "-");
  if (names.has(hyphen)) return [hyphen];
  const head = phrase.split(" ")[0] ?? "";
  if (names.has(head)) return [head];
  const named = [...names].find((name) => name === head || name.endsWith(`-${head}`));
  if (named) return [named];
  return nodes
    .filter((node) => node.options.some((option) => option.value.toLowerCase() === head))
    .map((node) => node.entry.name);
}

const USE = /use (?:a |an |the )?(?:recipes\/)?([a-z][a-z0-9-]+(?: [a-z][a-z0-9-]+){0,3})/gi;

function edgesOf(nodes: NodeFacts[]): CatalogEdge[] {
  const names = new Set(nodes.map((node) => node.entry.name));
  const edges: CatalogEdge[] = [];
  for (const node of nodes) {
    const spec = node.spec;
    for (const used of spec.uses) {
      const to = targetNames(used, names, nodes)[0];
      if (!to || to === node.entry.name) continue;
      edges.push({ kind: "built-from", from: node.entry.name, to, provenance: { source: "code", file: spec.file, field: "uses" }, evidence: used, confidence: 1, review: "extracted" });
    }
    for (const rule of [...spec.do, ...spec.dont]) {
      USE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = USE.exec(rule))) {
        for (const to of targetNames(match[1] ?? "", names, nodes)) {
          if (to === node.entry.name) continue;
          edges.push({
            kind: "instead-of",
            from: node.entry.name,
            to,
            provenance: { source: "code", file: spec.file, field: spec.dont.includes(rule) ? "rules.dont" : "rules.do" },
            evidence: rule,
            confidence: 0.9,
            review: "extracted",
          });
        }
      }
    }
  }
  return edges;
}

/** The part of the request that names this control, before "next to" / "beside". */
function subject(ask: string): string {
  return (ask.toLowerCase().split(/\b(?:next to|beside|rather than|instead of)\b/)[0] ?? ask).replace(/\bcentre\b/g, "center");
}

/** A word shared by most options of one property does not choose among them. */
function sharedWords(options: OptionFact[]): Set<string> {
  const counts = new Map<string, number>();
  for (const option of options) {
    for (const word of new Set(tokens(`${option.value} ${option.use}`))) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const shared = new Set<string>();
  for (const [word, count] of counts) if (count >= 2 && count * 2 >= options.length) shared.add(word);
  return shared;
}

function chooseOption(options: OptionFact[], words: string[], skip: Set<string>): string | undefined {
  const shared = sharedWords(options);
  const ranked = options
    .map((option) => {
      const described = tokens(`${option.value} ${option.use}`);
      const valueWords = new Set(tokens(option.value));
      let score = 0;
      for (const word of words) {
        if (word.length < 4 || shared.has(word) || skip.has(word) || !described.includes(word)) continue;
        score += valueWords.has(word) ? 3 : 1;
      }
      return { option, score };
    })
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (best && best.score > (ranked[1]?.score ?? 0)) return best.option.value;
  const has = (stem: string) => options.find((option) => tokens(option.value).includes(stem))?.value;
  if (words.includes("support")) return has("secondary") ?? has("tertiary");
  if (words.includes("destructiv") || words.includes("danger")) return has("negativ") ?? has("destructiv") ?? has("danger");
  if (words.includes("main") || words.includes("primary")) return has("primary");
  return undefined;
}

const STATE_WORD = new Set(["view", "readonly", "read", "error", "empty", "loading", "disabled", "default", "base", "filled", "hover", "pressed", "focus"]);

function isStateProperty(name: string, options: OptionFact[]): boolean {
  if (name.toLowerCase() === "state") return true;
  return options.length > 0 && options.every((option) => tokens(option.value).every((word) => STATE_WORD.has(word)));
}

/** The request describes how the control behaves. Word overlap with an option line does not. */
function behaviourState(ask: string, options: OptionFact[]): string | undefined {
  const text = subject(ask);
  const value = (stems: string[]) => options.find((option) => tokens(option.value).some((word) => stems.includes(word)))?.value;
  const showsSaved = /\b(?:show|shows|showing|saved|existing|already)\b/i.test(text) && /\b(?:value|values|saved|existing|filled|current)\b/i.test(text);
  if (showsSaved || /\bread-?only\b/i.test(text)) return value(["view", "readonly", "read"]);
  if (/\breview\b/i.test(text) && !/\bedit\b/i.test(text)) return value(["view", "readonly"]);
  if (/\bempty\b|\bnothing\b|\bno results\b/i.test(text)) return value(["empty"]);
  if (/\bloading\b|\bwaiting\b|\bfetching\b/i.test(text)) return value(["loading"]);
  if (/\berror\b|\binvalid\b/i.test(text)) return value(["error"]);
  return undefined;
}

function declaredDefault(value: string | undefined, options: OptionFact[]): string | undefined {
  if (!value) return undefined;
  if (value === "true" || value === "false") return value;
  return options.some((option) => option.value.toLowerCase() === value.toLowerCase()) ? value : undefined;
}

/** Decided values only. Everything else is the file's default, and sample text is left out. */
export function settingsForEntry(entry: CatalogEntry, ask: string): { settings: Record<string, string>; defaults: Record<string, string>; states: string[] } {
  const spec = entry.spec;
  if (!spec) return { settings: {}, defaults: {}, states: [] };
  const words = tokens(subject(ask));
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
    const options = (property.options ?? []).map((option) => ({ property: property.name, value: option.value, use: option.use ?? "" }));
    const state = isStateProperty(property.name, options);
    const chosen = state ? behaviourState(ask, options) : options.length ? chooseOption(options, words, skip) : undefined;
    if (chosen) {
      settings[property.name] = chosen;
      if (state) states.push(chosen);
      continue;
    }
    const fallback = declaredDefault(property.default, options);
    if (fallback) defaults[property.name] = fallback;
  }
  return { settings, defaults, states };
}

function settingsFor(node: NodeFacts, ask: string): { settings: Record<string, string>; defaults: Record<string, string>; states: string[] } {
  return settingsForEntry(node.entry, ask);
}

function lexical(node: NodeFacts, terms: Map<string, number>): number {
  const name = tokens(node.entry.name.replace(/-/g, " "));
  const text = new Set(
    tokens(
      [
        node.entry.description,
        node.spec.summary,
        ...node.spec.a11y,
        ...node.spec.do,
        ...node.spec.dont,
        ...node.spec.parts.map((part) => `${part.name} ${part.note ?? ""}`),
        ...node.options.map((option) => `${option.value} ${option.use}`),
        ...(node.entry.aliases ?? []),
        ...node.entry.variants,
      ].join(" "),
    ),
  );
  let total = 0;
  for (const [word, weight] of terms) {
    if (name.some((part) => part === word || (weight === 1 && word.length >= 4 && part.startsWith(word)))) total += 8 * weight;
    else if (text.has(word)) total += 2 * weight;
  }
  return Math.min(total, 24);
}

function namedInAsk(node: NodeFacts, direct: Set<string>): boolean {
  const name = tokens(node.entry.name.replace(/-/g, " "));
  return name.length > 0 && name.every((part) => direct.has(part));
}

function conditionHits(evidence: string, words: string[]): boolean {
  const cut = evidence.toLowerCase().lastIndexOf(" use ");
  const condition = tokens(cut >= 0 ? evidence.slice(0, cut) : evidence).filter((word) => word.length > 3);
  return condition.filter((word) => words.includes(word)).length >= 2;
}

interface Scored {
  node: NodeFacts;
  score: number;
  reasons: GraphPick["reasons"];
  edges: CatalogEdge[];
}

/** At most three. A role or a rule outranks a name. A name still breaks a tie. */
export function pickByCatalog(entries: CatalogEntry[], ask: string): GraphPick[] {
  const nodes = nodesOf(entries);
  if (!nodes.length) return [];
  const edges = edgesOf(nodes);
  const terms = expandTerms(ask);
  const direct = new Set([...terms].filter(([, weight]) => weight === 1).map(([word]) => word));
  const words = [...direct];
  const optionDf = new Map<string, number>();
  const useDf = new Map<string, number>();
  for (const node of nodes) {
    const seenValue = new Set<string>();
    const seenUse = new Set<string>();
    for (const option of node.options) {
      for (const word of tokens(option.value)) {
        if (word.length < 4 || seenValue.has(word)) continue;
        seenValue.add(word);
        optionDf.set(word, (optionDf.get(word) ?? 0) + 1);
      }
      for (const word of tokens(option.use)) {
        if (word.length < 4 || seenUse.has(word)) continue;
        seenUse.add(word);
        useDf.set(word, (useDf.get(word) ?? 0) + 1);
      }
    }
  }
  const roleWords = new Set(nodes.flatMap((node) => node.roles.map((role) => role.id)));
  const askedRoles = new Set(words.filter((word) => roleWords.has(word) || roleWords.has(word.replace(/s$/, ""))));
  const scored: Scored[] = [];
  for (const node of nodes) {
    const reasons: GraphPick["reasons"] = {};
    const used: CatalogEdge[] = [];
    const named = namedInAsk(node, direct);
    let score = lexical(node, terms);
    if (named) {
      score += 36;
      reasons.job = node.entry.name;
    }
    const headWord = tokens(subject(ask)).at(-1);
    const boosted = new Set<string>();
    for (const option of node.options) {
      const valueWords = new Set(tokens(option.value));
      for (const word of [...valueWords, ...tokens(option.use)]) {
        if (boosted.has(word) || !direct.has(word)) continue;
        const rare = (valueWords.has(word) ? optionDf : useDf).get(word) ?? 9;
        // A side word in an option line does not pull the component in. The head noun, or the option value itself, does.
        if (rare > 2 || (word !== headWord && !valueWords.has(word))) continue;
        boosted.add(word);
        score += 18;
      }
    }
    const role = node.roles.find((item) => askedRoles.has(item.id) || askedRoles.has(`${item.id}s`));
    if (role) {
      score += 80;
      reasons.job = role.evidence;
    }
    for (const edge of edges) {
      if (edge.review !== "extracted" || edge.kind !== "instead-of" || !conditionHits(edge.evidence, words)) continue;
      if (edge.from === node.entry.name) {
        if (!named) score -= 60;
        reasons.constraint = edge.evidence;
        used.push(edge);
      } else if (edge.to === node.entry.name) {
        score += 50;
        reasons.constraint = edge.evidence;
        used.push(edge);
      }
    }
    const opening = tokens(node.spec.summary).slice(0, 2);
    if (opening.length === 2 && opening.every((word) => direct.has(word))) {
      score += 16;
      reasons.context = node.spec.summary;
    }
    const signal = named || Boolean(role) || used.some((edge) => edge.to === node.entry.name) || boosted.size > 0;
    if (signal && score > 0) scored.push({ node, score, reasons, edges: used });
  }
  scored.sort((a, b) => b.score - a.score || (a.node.entry.name < b.node.entry.name ? -1 : 1));
  return scored.slice(0, 3).map((row, index, all) => {
    const built = edges.filter((edge) => edge.kind === "built-from" && edge.from === row.node.entry.name);
    const dims = [row.reasons.job, row.reasons.constraint, row.reasons.context].filter(Boolean).length;
    const gap = row.score - (all[index + 1]?.score ?? 0);
    const confidence: Confidence = dims >= 2 && gap >= 20 ? "high" : dims >= 1 && row.score >= 40 ? "medium" : "low";
    const chosen = settingsFor(row.node, ask);
    return {
      name: row.node.entry.name,
      settings: chosen.settings,
      defaults: chosen.defaults,
      states: chosen.states,
      reasons: row.reasons,
      confidence,
      edges: [...row.edges, ...built].slice(0, 8),
      score: Math.round(row.score),
    };
  });
}
