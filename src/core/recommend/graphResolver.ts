import { parseDsId } from "@/core/rules/dsId";
import { jobOfName } from "../chooseConfigure/screenJobs";
import { screenPatternFor } from "../codeKnowledge/dsck";
import type { GraphIndex } from "../read/GraphIndex";
import { prepareAsk } from "../read/meaning/parse";
import type { ParsedAttribute } from "../read/meaning/types";
import { meaningDictionary } from "../read/meaning/buildDictionary";
import { tokensOf } from "../read/queryTokens";
import { inflectionStems } from "../read/screenInventory";
import type { RecommendContext } from "./recommendSupport";
import { elementJob, jobWordSet, jobsForWord } from "./elementJobs";
import {
  buildComponentGraph,
  type ComponentGraph,
  type ComponentLink,
  type ComponentNode,
  type GraphBuildInput,
  type RecipeBinding,
} from "./componentGraph";

/**
 * Shadow resolver. It explains a lead from the component graph.
 * Callers that serve designers keep returning the word scorer.
 */

export interface GraphLead {
  lead: string;
  weak: boolean;
  empty: boolean;
  jobs: string[];
  evidence: string[];
  next?: string;
}

const NUMBER_WORD = new Set(["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "dozen"]);
const PLACEMENT = new Set(["under", "inside", "below", "within"]);

export interface GraphResolveInput extends GraphBuildInput {
  context?: RecommendContext;
}

function singular(token: string, known: ReadonlySet<string>): string {
  if (known.has(token)) return token;
  return inflectionStems(token).find((stem) => known.has(stem)) ?? token;
}

function placementHost(ask: string): string | undefined {
  const words = ask.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const at = words.findIndex((word) => PLACEMENT.has(word));
  if (at < 0) return undefined;
  return words.slice(at + 1).find((word) => word !== "a" && word !== "an" && word !== "the");
}

function hasPhrase(text: string, alias: string): boolean {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(text);
}

function bindingInScope(binding: RecipeBinding, ask: string, context?: RecommendContext): boolean {
  if (binding.packId && context?.id && binding.packId === context.id) return true;
  const fields = [ask, context?.screenType, context?.domain, context?.journey?.screenJob, context?.journey?.step]
    .flatMap((value) => (value ? [value] : []));
  return binding.aliases.some((alias) => fields.some((field) => hasPhrase(field, alias)));
}

function holds(node: ComponentNode, jobIds: readonly string[]): boolean {
  return node.jobs.some((job) => job.review === "confirmed" && jobIds.includes(job.jobId));
}

function libraryText(node: ComponentNode, jobIds: readonly string[]): boolean {
  if (holds(node, jobIds)) return false;
  const hay = new Set(node.purpose.flatMap((line) => tokensOf(line)));
  return jobIds.some((id) => elementJob(id)?.words.some((word) => hay.has(word)));
}

function overlap(node: ComponentNode, tokens: readonly string[]): number {
  const names = new Set(tokensOf(node.name));
  const synonyms = new Set(node.synonyms.flatMap((term) => tokensOf(term)));
  let score = 0;
  for (const token of tokens) {
    if (synonyms.has(token)) score += 2;
    else if (names.has(token)) score += 1;
  }
  return score;
}

function matchesAttribute(node: ComponentNode, attribute: ParsedAttribute): boolean {
  if (node.attributes.some((row) => row.kind === attribute.kind && row.values.includes(attribute.value))) return true;
  return node.variants.some((variant) => Object.values(variant.properties).some((value) => value.toLowerCase() === attribute.value));
}

function variantNote(node: ComponentNode, attributes: readonly ParsedAttribute[]): string | undefined {
  if (!attributes.length) return undefined;
  const variant = node.variants.find((row) =>
    attributes.every((attribute) => Object.values(row.properties).some((value) => value.toLowerCase() === attribute.value)),
  );
  return variant ? `variant ${variant.name}` : "attribute is not a variant value";
}

function linksFrom(graph: ComponentGraph, ids: ReadonlySet<string>): ComponentLink[] {
  return graph.links.filter(
    (link) =>
      link.review === "confirmed" &&
      (link.kind === "contains" || link.kind === "used-with" || link.kind === "stands-in-for") &&
      (ids.has(link.from) || ids.has(link.to)),
  );
}

function replacement(graph: ComponentGraph, node: ComponentNode): ComponentNode | undefined {
  const link = graph.links.find((row) => row.kind === "replaces" && row.review === "confirmed" && row.from === node.id);
  const next = link ? graph.byId.get(link.to) : undefined;
  if (!next || next.retired || graph.deniedIds.has(next.id)) return undefined;
  return next;
}

function emptyLead(jobs: string[]): GraphLead {
  return { lead: "", weak: false, empty: true, jobs, evidence: [], next: "No component holds this job." };
}

/** Resolve one ask through the component graph. The word scorer is not called. */
export function resolveByGraph(index: GraphIndex, ask: string, input: GraphResolveInput = {}): GraphLead {
  const graph = buildComponentGraph(index, input);
  const dictionary = meaningDictionary(index);
  const decision = prepareAsk(ask, dictionary);
  const known = new Set<string>([
    ...jobWordSet(),
    ...graph.proposedJobs.flatMap((job) => (job.review === "confirmed" ? job.words : [])),
    ...graph.nodes.flatMap((node) => [...tokensOf(node.name), ...node.synonyms.flatMap((term) => tokensOf(term))]),
  ]);
  const attributes = [...decision.attributes];
  const wordsFor = (word: string): readonly string[] => {
    const ids = [...jobsForWord(word)];
    for (const job of graph.proposedJobs) {
      if (job.review === "confirmed" && job.words.includes(word) && !ids.includes(job.id)) ids.push(job.id);
    }
    return ids;
  };
  const tokens: string[] = [];
  const take = (word: string) => {
    if (!word || NUMBER_WORD.has(word) || /^\d+$/.test(word)) return;
    if (attributes.some((attribute) => attribute.value === word)) return;
    if (graph.propertyValues.has(word) && wordsFor(word).length === 0) {
      if (!attributes.some((attribute) => attribute.value === word)) attributes.push({ kind: "state", value: word });
      return;
    }
    if (!tokens.includes(word)) tokens.push(word);
  };
  const stripped = ask
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word && !NUMBER_WORD.has(word) && !/^\d+$/.test(word))
    .map((word) => singular(word, known));
  for (const token of tokensOf(stripped.join(" "))) take(token);
  for (const token of decision.purposeTokens) take(singular(token, known));
  const jobIds = [...new Set(tokens.flatMap((token) => [...wordsFor(token)]))];
  const host = placementHost(ask);
  const denied = graph.deniedIds;
  const usable = (node: ComponentNode | undefined): ComponentNode | undefined => {
    if (!node || denied.has(node.id)) return undefined;
    if (!node.retired) return node;
    return replacement(graph, node);
  };
  const text = ask.trim().toLowerCase();
  const identified = graph.mapping.find(
    (row) => row.status === "confirmed" && (row.figma.toLowerCase() === text || row.aliases.includes(text)),
  );
  const byDs = parseDsId(ask);
  const identity = usable(
    (byDs ? graph.nodes.find((node) => node.dsId === byDs.id) : undefined) ??
      (identified ? graph.byId.get(identified.nodeId) : undefined),
  );
  if (identity) {
    const note = variantNote(identity, attributes);
    return {
      lead: identity.name,
      weak: false,
      empty: false,
      jobs: jobIds,
      evidence: ["identity", ...(note ? [note] : [])],
    };
  }
  const scope = new Set<string>();
  for (const binding of graph.bindings) {
    if (!bindingInScope(binding, ask, input.context)) continue;
    const node = usable(graph.byId.get(binding.nodeId));
    if (node) scope.add(node.id);
  }
  const screenJob =
    jobOfName(input.context?.journey?.screenJob) ?? jobOfName(input.context?.screenType) ?? jobOfName(input.context?.domain);
  if (screenJob && input.dsck) {
    for (const master of screenPatternFor(input.dsck, screenJob).masters) {
      const node = usable(
        graph.nodes.find((row) => row.id === master.masterId || row.name.toLowerCase() === master.name.toLowerCase()),
      );
      if (node) scope.add(node.id);
    }
  }
  const reached = new Set<string>();
  for (const link of linksFrom(graph, scope)) {
    const from = usable(graph.byId.get(link.from));
    const to = usable(graph.byId.get(link.to));
    if (from && scope.has(from.id) && to) reached.add(to.id);
    if (to && scope.has(to.id) && from) reached.add(from.id);
  }
  const bound = new Set(
    graph.bindings
      .filter((binding) => binding.bound && bindingInScope(binding, ask, input.context))
      .map((binding) => binding.nodeId),
  );
  const candidates = new Map<string, { node: ComponentNode; score: number; evidence: string[] }>();
  const consider = (node: ComponentNode | undefined) => {
    if (!node || denied.has(node.id)) return;
    const live = node.retired ? replacement(graph, node) : node;
    if (!live || denied.has(live.id)) return;
    const evidence: string[] = [];
    let score = 0;
    const jobHit = holds(node, jobIds) || holds(live, jobIds);
    if (bound.has(live.id) || bound.has(node.id)) {
      score += 100;
      evidence.push("bound slot");
    }
    if (jobHit) {
      score += 80;
      evidence.push(node.retired ? "replaces" : "confirmed job");
    } else if (libraryText(live, jobIds) || libraryText(node, jobIds)) {
      score += 30;
      evidence.push("library text");
    }
    if (jobHit || reached.has(live.id) || bound.has(live.id)) {
      if (live.screens >= 3) {
        score += 60;
        evidence.push("verified screens");
      } else if (live.screens > 0) {
        score += 20;
        evidence.push("few screens");
      }
    }
    if ((reached.has(live.id) || reached.has(node.id)) && !bound.has(live.id)) {
      score += 40;
      evidence.push("scope edge");
    }
    if (!score) return;
    const prior = candidates.get(live.id);
    if (prior && prior.score >= score) return;
    candidates.set(live.id, { node: live, score, evidence });
  };
  for (const node of graph.nodes) {
    if (holds(node, jobIds) || libraryText(node, jobIds) || reached.has(node.id) || bound.has(node.id)) consider(node);
  }
  let pool = [...candidates.values()];
  if (host && pool.length) {
    const hostIds = new Set(
      pool.filter((row) => tokensOf(row.node.name).includes(host) || row.node.synonyms.some((term) => tokensOf(term).includes(host))).map((row) => row.node.id),
    );
    const related = pool.filter((row) =>
      graph.links.some(
        (link) =>
          link.review === "confirmed" &&
          (link.kind === "contains" || link.kind === "used-with") &&
          ((hostIds.has(link.from) && link.to === row.node.id) || (hostIds.has(link.to) && link.from === row.node.id)),
      ),
    );
    const messages = pool.filter((row) => holds(row.node, ["field-message"]));
    if (related.length) pool = related;
    else if (messages.length && hostIds.size) pool = messages;
  }
  if (!pool.length) {
    const weak = graph.nodes
      .flatMap((node) => {
        const live = usable(node);
        if (!live) return [];
        const ties = overlap(live, tokens);
        return ties > 0 ? [{ node: live, ties }] : [];
      })
      .sort((a, b) => b.ties - a.ties || a.node.synonyms.length - b.node.synonyms.length || a.node.name.localeCompare(b.node.name));
    const lead = weak[0];
    if (!lead) return emptyLead(jobIds);
    return { lead: lead.node.name, weak: true, empty: false, jobs: jobIds, evidence: ["tie-break"] };
  }
  const best = Math.max(...pool.map((row) => row.score));
  let band = pool.filter((row) => row.score === best);
  if (attributes.length) {
    const matched = band.filter((row) => attributes.every((attribute) => matchesAttribute(row.node, attribute)));
    if (matched.length) band = matched;
  }
  band.sort((a, b) => overlap(b.node, tokens) - overlap(a.node, tokens) || a.node.synonyms.length - b.node.synonyms.length || a.node.name.localeCompare(b.node.name));
  const winner = band[0];
  if (!winner) return emptyLead(jobIds);
  const note = variantNote(winner.node, attributes);
  return {
    lead: winner.node.name,
    weak: false,
    empty: false,
    jobs: jobIds,
    evidence: [...winner.evidence, ...(note ? [note] : [])],
  };
}
