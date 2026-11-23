import type { GraphNode } from "@/core/model";
import { dsIdOf } from "@/core/rules/dsId";
import { setOf } from "@/core/rules/family";
import { isRetired } from "@/core/rules/retired";
import { asEvidenceList } from "../codeKnowledge/dsci";
import {
  patternsOf,
  type DsciProposal,
  type DsckState,
  type UsageFact,
} from "../codeKnowledge/dsck";
import { type Recipe, starterRecipes } from "../chooseConfigure/recipes";
import type { GraphIndex } from "../read/GraphIndex";
import { meaningDictionary } from "../read/meaning/buildDictionary";
import type { MeaningAttribute } from "../read/meaning/types";
import { realMastersNamed } from "../read/masterNames";
import { tokensOf } from "../read/queryTokens";
import type { ScreenMapDocument } from "../screenMap/types";
import { mappingRecords, type MappingRecord } from "../read/mappingAliases";
import { replacedByName } from "./recommendLexicon";
import { slotsForComponent } from "./recommendSupport";
import { elementJob, jobsForWord } from "./elementJobs";

/**
 * Read-only component graph. Built from the learned graph, DSCK, recipes,
 * confirmed mapping, and reviewed proposals. AI proposals rank only when
 * their review state is confirmed. Confirmation is Tanishk's.
 */

export type ReviewState = "proposed" | "confirmed" | "denied";
export type JobSource = "library-text" | "mapping" | "dsci";
export type LinkKind = "contains" | "used-with" | "stands-in-for" | "replaces";

export interface HeldJob {
  jobId: string;
  source: JobSource;
  review: ReviewState;
  evidence: string[];
}

export interface ComponentLink {
  kind: LinkKind;
  from: string;
  to: string;
  count: number;
  sources: string[];
  review: ReviewState;
  evidence: string[];
}

export interface ComponentVariant {
  id: string;
  name: string;
  properties: Record<string, string>;
}

export interface ComponentNode {
  id: string;
  name: string;
  dsId?: string;
  fileKey?: string;
  retired: boolean;
  jobs: HeldJob[];
  variants: ComponentVariant[];
  slots: string[];
  synonyms: string[];
  purpose: string[];
  attributes: MeaningAttribute[];
  screens: number;
}

export interface RecipeBinding {
  recipeId: string;
  packId?: string;
  aliases: string[];
  nodeId: string;
  bound: boolean;
}

export interface ProposedElementJob {
  id: string;
  meaning: string;
  words: string[];
  review: ReviewState;
  evidence: string[];
}

export interface MappingLink {
  nodeId: string;
  figma: string;
  aliases: string[];
  status: MappingRecord["status"];
}

export interface ComponentGraph {
  nodes: ComponentNode[];
  byId: Map<string, ComponentNode>;
  links: ComponentLink[];
  bindings: RecipeBinding[];
  mapping: MappingLink[];
  proposedJobs: ProposedElementJob[];
  propertyValues: ReadonlySet<string>;
  deniedIds: ReadonlySet<string>;
}

export interface GraphBuildInput {
  dsck?: DsckState;
  recipes?: Recipe[];
  screenMapEnabled?: boolean;
  screenMaps?: readonly ScreenMapDocument[];
}

const cache = new WeakMap<GraphIndex, { key: string; graph: ComponentGraph }>();

function reviewRank(review: ReviewState): number {
  if (review === "confirmed") return 2;
  if (review === "proposed") return 1;
  return 0;
}

function addJob(node: ComponentNode, job: HeldJob): void {
  const existing = node.jobs.find((row) => row.jobId === job.jobId);
  if (!existing) {
    node.jobs.push(job);
    return;
  }
  if (job.review === "denied" || existing.review === "denied") existing.review = "denied";
  else if (reviewRank(job.review) > reviewRank(existing.review)) existing.review = job.review;
  for (const item of job.evidence) if (!existing.evidence.includes(item)) existing.evidence.push(item);
}

function addLink(into: Map<string, ComponentLink>, link: ComponentLink): void {
  const key = `${link.kind}|${link.from}|${link.to}`;
  const existing = into.get(key);
  if (!existing) {
    into.set(key, { ...link, sources: [...link.sources], evidence: [...link.evidence] });
    return;
  }
  existing.count += link.count;
  for (const source of link.sources) if (!existing.sources.includes(source)) existing.sources.push(source);
  for (const item of link.evidence) if (!existing.evidence.includes(item)) existing.evidence.push(item);
  if (link.review === "denied" || existing.review === "denied") existing.review = "denied";
  else if (reviewRank(link.review) > reviewRank(existing.review)) existing.review = link.review;
}

function familyOf(index: GraphIndex, node: GraphNode): GraphNode {
  return setOf(index, node) ?? node;
}

function nodeByName(index: GraphIndex, name: string): GraphNode | undefined {
  const hits = realMastersNamed(index, name);
  return hits.find((hit) => hit.type === "COMPONENT_SET") ?? hits[0];
}

function nodeByRef(index: GraphIndex, ref: string): GraphNode | undefined {
  const direct = index.getNode(ref);
  if (direct) return familyOf(index, direct);
  const byFigma = index.allNodes.find((node) => node.figmaNodeId === ref);
  if (byFigma) return familyOf(index, byFigma);
  const named = nodeByName(index, ref);
  return named ? familyOf(index, named) : undefined;
}

function jobsFromTokens(tokens: readonly string[], source: JobSource, review: ReviewState, evidence: string): HeldJob[] {
  const ids = new Set<string>();
  for (const token of tokens) for (const id of jobsForWord(token)) ids.add(id);
  return [...ids].map((jobId) => ({ jobId, source, review, evidence: [evidence] }));
}

function reviewOf(proposal: DsciProposal): ReviewState | undefined {
  const named = (proposal as { review?: unknown }).review;
  if (named === "proposed" || named === "confirmed" || named === "denied") return named;
  if (proposal.status === "approved") return "confirmed";
  if (proposal.status === "rejected") return "denied";
  if (proposal.status === "pending") return "proposed";
  return undefined;
}

function evidenceLines(proposal: DsciProposal): string[] {
  return asEvidenceList(proposal.evidence).flatMap((item) => {
    const bits = [item.note, item.frameId, item.screenId, item.screenName].filter((bit): bit is string => Boolean(bit && bit.trim()));
    return bits.length ? [bits.join(" ")] : [];
  });
}

function namedReplacement(index: GraphIndex, node: GraphNode): GraphNode | undefined {
  const seen = new Set<string>();
  let at = node;
  for (let hop = 0; hop < 3; hop += 1) {
    if (seen.has(at.id)) return undefined;
    seen.add(at.id);
    const name = replacedByName(at);
    if (!name) return undefined;
    const next = nodeByRef(index, name);
    if (!next || next.id === at.id) return undefined;
    if (!isRetired(index, next)) return next;
    at = next;
  }
  return undefined;
}

function screenPairs(facts: readonly UsageFact[]): Array<[string, string, string]> {
  const byFrame = new Map<string, UsageFact[]>();
  for (const fact of facts) {
    if (!fact.frameId || fact.countsTowardThreshold === false || fact.nested || fact.private || fact.deprecated) continue;
    const list = byFrame.get(fact.frameId);
    if (list) list.push(fact);
    else byFrame.set(fact.frameId, [fact]);
  }
  const pairs: Array<[string, string, string]> = [];
  for (const [frameId, group] of byFrame) {
    const ids = [...new Set(group.map((fact) => fact.masterId))];
    for (let left = 0; left < ids.length; left += 1) {
      for (let right = left + 1; right < ids.length; right += 1) {
        const a = ids[left];
        const b = ids[right];
        if (a && b) pairs.push([a, b, frameId]);
      }
    }
  }
  return pairs;
}

function screenMapLinks(index: GraphIndex, docs: readonly ScreenMapDocument[], enabled: boolean, into: Map<string, ComponentLink>): void {
  if (!enabled) return;
  for (const doc of docs) {
    const bodies = [doc.nodes, ...Object.values(doc.masters ?? {}).map((master) => master.nodes)];
    for (const nodes of bodies) {
      const extracted = Object.values(nodes).filter((node) => node.identity === "extracted" && node.ds?.masterId);
      for (const node of extracted) {
        const parent = node.parentId ? nodes[node.parentId] : undefined;
        const child = nodeByRef(index, node.ds?.masterId ?? "");
        if (!child) continue;
        if (parent?.identity === "extracted" && parent.ds?.masterId) {
          const host = nodeByRef(index, parent.ds.masterId);
          if (host && host.id !== child.id) {
            addLink(into, {
              kind: "contains",
              from: host.id,
              to: child.id,
              count: 1,
              sources: ["screen-map"],
              review: "confirmed",
              evidence: [doc.fileKey],
            });
          }
        }
      }
      const siblings = new Map<string, string[]>();
      for (const node of extracted) {
        if (!node.parentId || !node.ds?.masterId) continue;
        const parent = nodes[node.parentId];
        if (parent?.identity !== "extracted") continue;
        const target = nodeByRef(index, node.ds.masterId);
        if (!target) continue;
        const list = siblings.get(node.parentId);
        if (list) list.push(target.id);
        else siblings.set(node.parentId, [target.id]);
      }
      for (const ids of siblings.values()) {
        const unique = [...new Set(ids)];
        for (let left = 0; left < unique.length; left += 1) {
          for (let right = left + 1; right < unique.length; right += 1) {
            const from = unique[left];
            const to = unique[right];
            if (!from || !to) continue;
            addLink(into, {
              kind: "used-with",
              from,
              to,
              count: 1,
              sources: ["screen-map"],
              review: "confirmed",
              evidence: [doc.fileKey],
            });
          }
        }
      }
    }
  }
}

function applyProposals(
  index: GraphIndex,
  proposals: readonly DsciProposal[],
  nodes: Map<string, ComponentNode>,
  links: Map<string, ComponentLink>,
  extraJobs: Array<{ id: string; words: string[] }>,
): ProposedElementJob[] {
  const proposed: ProposedElementJob[] = [];
  const ordered = [...proposals.filter((proposal) => proposal.type === "job"), ...proposals.filter((proposal) => proposal.type !== "job")];
  for (const proposal of ordered) {
    const review = reviewOf(proposal);
    const evidence = evidenceLines(proposal);
    if (!review || !evidence.length) continue;
    if (proposal.type === "job" && proposal.suggestedJob) {
      const job = proposal.suggestedJob;
      if (!job.id.trim() || !job.words.length) continue;
      const row: ProposedElementJob = {
        id: job.id.trim(),
        meaning: job.meaning,
        words: job.words.map((word) => word.toLowerCase()),
        review,
        evidence,
      };
      proposed.push(row);
      if (review === "confirmed") extraJobs.push({ id: row.id, words: row.words });
      continue;
    }
    if (proposal.type === "component-job" && proposal.suggestedComponentJob) {
      const target = nodeByRef(index, proposal.suggestedComponentJob.masterId);
      const node = target ? nodes.get(target.id) : undefined;
      const jobId = proposal.suggestedComponentJob.jobId;
      if (!node || !jobId || (!elementJob(jobId) && !extraJobs.some((job) => job.id === jobId))) continue;
      addJob(node, { jobId, source: "dsci", review, evidence });
      continue;
    }
    if (proposal.type === "edge" && proposal.suggestedEdge) {
      const edge = proposal.suggestedEdge;
      const from = nodeByRef(index, edge.fromId);
      const to = nodeByRef(index, edge.toId);
      if (!from || !to || from.id === to.id) continue;
      if (edge.kind !== "contains" && edge.kind !== "used-with" && edge.kind !== "stands-in-for" && edge.kind !== "replaces") continue;
      addLink(links, {
        kind: edge.kind,
        from: from.id,
        to: to.id,
        count: 1,
        sources: ["dsci"],
        review,
        evidence,
      });
    }
  }
  return proposed;
}

function fingerprint(input: GraphBuildInput): string {
  const facts = input.dsck?.facts ?? [];
  let hash = facts.length;
  for (const fact of facts) hash = (hash + fact.masterId.length + (fact.frameId?.length ?? 0)) % 10000019;
  for (const proposal of input.dsck?.proposals ?? []) hash = (hash + proposal.id.length) % 10000019;
  const maps = input.screenMaps ?? [];
  return `${hash}:${input.screenMapEnabled ? 1 : 0}:${maps.map((doc) => doc.fileKey).join(",")}:${input.recipes?.length ?? "starter"}`;
}

/** The component graph for this library. Cached per index and input. */
export function buildComponentGraph(index: GraphIndex, input: GraphBuildInput = {}): ComponentGraph {
  const key = fingerprint(input);
  const hit = cache.get(index);
  if (hit?.key === key) return hit.graph;
  const dictionary = meaningDictionary(index);
  const nodes = new Map<string, ComponentNode>();
  const propertyValues = new Set<string>();
  for (const entry of dictionary.entries) {
    const found = nodeByName(index, entry.name);
    if (!found) continue;
    const host = familyOf(index, found);
    if (nodes.has(host.id)) continue;
    const variants = index.getVariantsOf(host.id).map((variant) => {
      const properties = Object.fromEntries(Object.entries(variant.variantProperties ?? {}).map(([name, value]) => [name, String(value)]));
      for (const value of Object.values(properties)) propertyValues.add(value.toLowerCase());
      return { id: variant.id, name: variant.name, properties };
    });
    for (const prop of host.propertyDefinitions ?? []) {
      for (const option of prop.options ?? []) propertyValues.add(option.toLowerCase());
    }
    for (const attribute of entry.attributes) for (const value of attribute.values) propertyValues.add(value.toLowerCase());
    const dsId = dsIdOf(host.description, host.name)?.id;
    const node: ComponentNode = {
      id: host.id,
      name: entry.name,
      ...(dsId ? { dsId } : {}),
      ...(host.fileKey ? { fileKey: host.fileKey } : {}),
      retired: Boolean(entry.retired) || isRetired(index, host),
      jobs: [],
      variants,
      slots: slotsForComponent(index, host),
      synonyms: [...entry.synonyms],
      purpose: [...entry.purpose],
      attributes: entry.attributes.map((attribute) => ({ ...attribute, values: [...attribute.values] })),
      screens: 0,
    };
    const nameTokens = new Set([...tokensOf(entry.name), ...entry.synonyms.flatMap((term) => tokensOf(term))]);
    for (const job of jobsFromTokens([...nameTokens], "library-text", "confirmed", entry.name)) addJob(node, job);
    nodes.set(node.id, node);
  }
  for (const pattern of input.dsck ? patternsOf(input.dsck) : []) {
    const target = nodeByRef(index, pattern.masterId) ?? nodeByName(index, pattern.name);
    const node = target ? nodes.get(familyOf(index, target).id) : undefined;
    if (node) node.screens = pattern.screens.length;
  }
  const links = new Map<string, ComponentLink>();
  for (const node of nodes.values()) {
    for (const instance of index.getNestedInstances(node.id)) {
      const edge = index.getEdges(node.id, { direction: "out", edgeTypes: ["NESTS"] }).find((row) => row.target === instance.id);
      if (edge?.confidence === "INFERRED") continue;
      const main = index.getMainComponent(instance.id);
      if (!main) continue;
      const target = nodes.get(familyOf(index, main).id);
      if (!target || target.id === node.id) continue;
      addLink(links, {
        kind: "contains",
        from: node.id,
        to: target.id,
        count: 1,
        sources: ["nests"],
        review: "confirmed",
        evidence: [node.name],
      });
    }
    if (!node.retired) continue;
    const host = index.getNode(node.id);
    const next = host ? namedReplacement(index, host) : undefined;
    const replacement = next ? nodes.get(familyOf(index, next).id) : undefined;
    if (!replacement || replacement.id === node.id) continue;
    addLink(links, {
      kind: "replaces",
      from: node.id,
      to: replacement.id,
      count: 1,
      sources: ["replaced-by"],
      review: "confirmed",
      evidence: [node.name],
    });
  }
  for (const [left, right, frameId] of screenPairs(input.dsck?.facts ?? [])) {
    const a = nodeByRef(index, left);
    const b = nodeByRef(index, right);
    if (!a || !b || a.id === b.id || !nodes.has(a.id) || !nodes.has(b.id)) continue;
    addLink(links, {
      kind: "used-with",
      from: a.id,
      to: b.id,
      count: 1,
      sources: ["dsck"],
      review: "confirmed",
      evidence: [frameId],
    });
  }
  const recipes = input.recipes ?? starterRecipes();
  const bindings: RecipeBinding[] = [];
  for (const recipe of recipes) {
    const resolved: string[] = [];
    for (const slot of recipe.slots) {
      if (!slot.defaultMasterId) continue;
      const target = nodeByRef(index, slot.defaultMasterId);
      if (!target || !nodes.has(target.id)) continue;
      resolved.push(target.id);
      bindings.push({
        recipeId: recipe.id,
        ...(recipe.contextPackId ? { packId: recipe.contextPackId } : {}),
        aliases: recipe.intentAliases.map((alias) => alias.toLowerCase()),
        nodeId: target.id,
        bound: true,
      });
    }
    const unique = [...new Set(resolved)];
    for (let left = 0; left < unique.length; left += 1) {
      for (let right = left + 1; right < unique.length; right += 1) {
        const from = unique[left];
        const to = unique[right];
        if (!from || !to) continue;
        addLink(links, {
          kind: "used-with",
          from,
          to,
          count: 1,
          sources: ["recipe"],
          review: "confirmed",
          evidence: [recipe.id],
        });
      }
    }
  }
  screenMapLinks(index, input.screenMaps ?? [], input.screenMapEnabled === true, links);
  const mapping: MappingLink[] = [];
  const deniedIds = new Set<string>();
  for (const row of mappingRecords()) {
    const target = nodeByName(index, row.figma);
    if (!target) continue;
    const node = nodes.get(familyOf(index, target).id);
    if (!node) continue;
    mapping.push({ nodeId: node.id, figma: row.figma, aliases: row.aliases, status: row.status });
    if (row.status === "denied") {
      deniedIds.add(node.id);
      continue;
    }
    if (row.status !== "confirmed") continue;
    for (const alias of row.aliases) if (!node.synonyms.includes(alias)) node.synonyms.push(alias);
    for (const job of jobsFromTokens(row.aliases.flatMap((alias) => tokensOf(alias)), "mapping", "confirmed", row.figma)) addJob(node, job);
  }
  const extraJobs: Array<{ id: string; words: string[] }> = [];
  const proposedJobs = applyProposals(index, input.dsck?.proposals ?? [], nodes, links, extraJobs);
  for (const job of extraJobs) {
    for (const word of job.words) {
      for (const node of nodes.values()) {
        const tokens = new Set([...tokensOf(node.name), ...node.synonyms.flatMap((term) => tokensOf(term))]);
        if (!tokens.has(word)) continue;
        addJob(node, { jobId: job.id, source: "dsci", review: "confirmed", evidence: [`job ${job.id}`] });
      }
    }
  }
  const graph: ComponentGraph = {
    nodes: [...nodes.values()],
    byId: nodes,
    links: [...links.values()],
    bindings,
    mapping,
    proposedJobs,
    propertyValues,
    deniedIds,
  };
  cache.set(index, { key, graph });
  return graph;
}
