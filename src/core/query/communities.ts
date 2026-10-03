import type { EdgeType, GraphNode } from "@/core/model";
import type { GraphIndex } from "./GraphIndex";

/**
 * Community detection over the design graph.
 *
 * Some graph tools use Leiden; this is Louvain with a resolution parameter. Louvain
 * can in rare cases leave a community internally disconnected — Leiden's
 * refinement phase is what fixes that. For a design graph, where communities
 * are almost always anchored by containment, the difference has not shown up,
 * and Louvain is a fraction of the code. If badly-connected communities ever
 * appear, the fix is a refinement pass here, not a change anywhere else.
 *
 * Everything is deterministic: nodes are visited in sorted order and there is
 * no randomness, so the same graph always produces the same partition.
 */

export interface CommunityOptions {
  /** Higher = more, smaller communities. Default 1. */
  resolution?: number;
  /**
   * Drop the highest-degree nodes from the partitioning pass. A "god node"
   * touching everything drags unrelated clusters together; excluded hubs are
   * assigned afterwards to whichever community they lean into most.
   */
  excludeHubs?: boolean;
  /** Degree cutoff for `excludeHubs`, as a percentile. Default 0.98. */
  hubPercentile?: number;
  /** Edge types that count as connective tissue. Defaults to everything real. */
  edgeTypes?: readonly EdgeType[];
  maxPasses?: number;
}

export interface Community {
  id: number;
  /** Name of the highest-degree member — the same convention graph-tool legends use. */
  name: string;
  hubId: string;
  nodeIds: string[];
  size: number;
  color: string;
  /** Edges with both endpoints inside the community. */
  internalEdges: number;
}

export interface CommunityResult {
  communities: Community[];
  byNode: Map<string, number>;
  modularity: number;
  excludedHubs: string[];
}

/** Community swatches. Distinct hues, readable on a dark canvas. */
export const COMMUNITY_PALETTE = [
  "#6b9bd8",
  "#e8934a",
  "#e05c5c",
  "#5cc4b4",
  "#6bbf59",
  "#e8c84a",
  "#c98bc4",
  "#f08ba0",
  "#a3785e",
  "#b9bec7",
  "#7c8fe0",
  "#d9a13b",
  "#8fd15c",
  "#54b1c9",
  "#d76fa8",
];

/** Real relationships only — materialised inverses would double every weight. */
const DEFAULT_EDGE_TYPES: readonly EdgeType[] = [
  "CONTAINS",
  "INSTANCE_OF",
  "VARIANT_OF",
  "NESTS",
  "USES_STYLE",
  "USES_VARIABLE",
  "BELONGS_TO_COLLECTION",
  "SOURCED_FROM_LIBRARY",
  "PROTOTYPES_TO",
  "LINKS_TO",
];

/* ------------------------------------------------------------------ *
 * Weighted undirected graph, indexed by position
 * ------------------------------------------------------------------ */

interface WeightedGraph {
  size: number;
  adjacency: Array<Map<number, number>>;
  selfLoops: number[];
  degrees: number[];
  /** Sum of all edge weights (each undirected edge counted once). */
  totalWeight: number;
}

function emptyGraph(size: number): WeightedGraph {
  return {
    size,
    adjacency: Array.from({ length: size }, () => new Map<number, number>()),
    selfLoops: new Array(size).fill(0),
    degrees: new Array(size).fill(0),
    totalWeight: 0,
  };
}

function addEdge(graph: WeightedGraph, a: number, b: number, weight: number): void {
  if (a === b) {
    graph.selfLoops[a] += weight;
    graph.degrees[a] += 2 * weight;
    graph.totalWeight += weight;
    return;
  }
  graph.adjacency[a].set(b, (graph.adjacency[a].get(b) ?? 0) + weight);
  graph.adjacency[b].set(a, (graph.adjacency[b].get(a) ?? 0) + weight);
  graph.degrees[a] += weight;
  graph.degrees[b] += weight;
  graph.totalWeight += weight;
}

/* ------------------------------------------------------------------ *
 * Louvain
 * ------------------------------------------------------------------ */

/** One pass of local moving. Returns the community assignment per node. */
function localMoving(graph: WeightedGraph, resolution: number): number[] {
  const community = Array.from({ length: graph.size }, (_, i) => i);
  const communityTotal = [...graph.degrees];
  const m2 = 2 * graph.totalWeight;
  if (m2 === 0) return community;

  let improved = true;
  let guard = 0;

  while (improved && guard < 50) {
    improved = false;
    guard += 1;

    for (let node = 0; node < graph.size; node += 1) {
      const current = community[node];
      const degree = graph.degrees[node];

      // Weight from this node into each neighbouring community.
      const weightTo = new Map<number, number>();
      weightTo.set(current, 0);
      for (const [neighbor, weight] of graph.adjacency[node]) {
        const target = community[neighbor];
        weightTo.set(target, (weightTo.get(target) ?? 0) + weight);
      }

      // Remove the node from its community before scoring alternatives.
      communityTotal[current] -= degree;

      let best = current;
      let bestGain = (weightTo.get(current) ?? 0) - (resolution * communityTotal[current] * degree) / m2;

      // Sorted for determinism: ties always resolve the same way.
      for (const target of [...weightTo.keys()].sort((a, b) => a - b)) {
        if (target === current) continue;
        const gain =
          (weightTo.get(target) ?? 0) - (resolution * communityTotal[target] * degree) / m2;
        if (gain > bestGain + 1e-12) {
          bestGain = gain;
          best = target;
        }
      }

      communityTotal[best] += degree;
      if (best !== current) {
        community[node] = best;
        improved = true;
      }
    }
  }

  return community;
}

/** Collapse each community into a single node for the next Louvain level. */
function aggregate(
  graph: WeightedGraph,
  community: number[],
): { graph: WeightedGraph; mapping: number[] } {
  const labels = [...new Set(community)].sort((a, b) => a - b);
  const index = new Map(labels.map((label, i) => [label, i]));
  const mapping = community.map((label) => index.get(label)!);

  const next = emptyGraph(labels.length);
  const seen = new Set<string>();

  for (let node = 0; node < graph.size; node += 1) {
    const a = mapping[node];
    if (graph.selfLoops[node]) addEdge(next, a, a, graph.selfLoops[node]);
    for (const [neighbor, weight] of graph.adjacency[node]) {
      const b = mapping[neighbor];
      if (a === b) {
        // Each internal edge is walked from both ends; count it once.
        if (node < neighbor) addEdge(next, a, a, weight);
        continue;
      }
      const key = node < neighbor ? `${node}|${neighbor}` : `${neighbor}|${node}`;
      if (seen.has(key)) continue;
      seen.add(key);
      addEdge(next, a, b, weight);
    }
  }

  return { graph: next, mapping };
}

export function modularityOf(
  graph: WeightedGraph,
  community: number[],
  resolution: number,
): number {
  const m2 = 2 * graph.totalWeight;
  if (m2 === 0) return 0;

  const internal = new Map<number, number>();
  const total = new Map<number, number>();

  for (let node = 0; node < graph.size; node += 1) {
    const c = community[node];
    total.set(c, (total.get(c) ?? 0) + graph.degrees[node]);
    internal.set(c, (internal.get(c) ?? 0) + graph.selfLoops[node]);
    for (const [neighbor, weight] of graph.adjacency[node]) {
      if (community[neighbor] === c && node < neighbor) {
        internal.set(c, (internal.get(c) ?? 0) + weight);
      }
    }
  }

  let q = 0;
  for (const [c, tot] of total) {
    q += (internal.get(c) ?? 0) / graph.totalWeight - resolution * (tot / m2) ** 2;
  }
  return q;
}

export function louvain(
  graph: WeightedGraph,
  resolution = 1,
  maxPasses = 10,
): { assignment: number[]; modularity: number } {
  let working = graph;
  let assignment = Array.from({ length: graph.size }, (_, i) => i);

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const local = localMoving(working, resolution);
    const distinct = new Set(local).size;
    const { graph: next, mapping } = aggregate(working, local);

    assignment = assignment.map((current) => mapping[current]);
    working = next;

    // No further merging possible.
    if (distinct === local.length) break;
    if (distinct <= 1) break;
  }

  return { assignment, modularity: modularityOf(graph, assignment, resolution) };
}

/* ------------------------------------------------------------------ *
 * Design-graph entry point
 * ------------------------------------------------------------------ */

export interface CommunityInput {
  nodes: readonly GraphNode[];
  edges: ReadonlyArray<{ source: string; target: string; type: EdgeType }>;
}

export function detectCommunities(
  input: CommunityInput,
  options: CommunityOptions = {},
): CommunityResult {
  const {
    resolution = 1,
    excludeHubs = false,
    hubPercentile = 0.98,
    edgeTypes = DEFAULT_EDGE_TYPES,
    maxPasses = 10,
  } = options;

  const allowed = new Set<EdgeType>(edgeTypes);
  const relevant = input.edges.filter((edge) => allowed.has(edge.type));

  const degree = new Map<string, number>();
  for (const node of input.nodes) degree.set(node.id, 0);
  for (const edge of relevant) {
    if (!degree.has(edge.source) || !degree.has(edge.target)) continue;
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  let excluded = new Set<string>();
  if (excludeHubs && input.nodes.length > 20) {
    const sorted = [...degree.values()].sort((a, b) => a - b);
    const cutoff = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * hubPercentile))];
    excluded = new Set(
      input.nodes.filter((node) => (degree.get(node.id) ?? 0) > cutoff).map((node) => node.id),
    );
  }

  const partitioned = input.nodes.filter((node) => !excluded.has(node.id));
  const position = new Map(partitioned.map((node, i) => [node.id, i]));

  const graph = emptyGraph(partitioned.length);
  for (const edge of relevant) {
    const a = position.get(edge.source);
    const b = position.get(edge.target);
    if (a === undefined || b === undefined) continue;
    addEdge(graph, a, b, 1);
  }

  const { assignment, modularity } = louvain(graph, resolution, maxPasses);

  const byNode = new Map<string, number>();
  partitioned.forEach((node, i) => byNode.set(node.id, assignment[i]));

  // Excluded hubs join whichever community they lean into hardest.
  for (const hubId of excluded) {
    const tally = new Map<number, number>();
    for (const edge of relevant) {
      const other =
        edge.source === hubId ? edge.target : edge.target === hubId ? edge.source : undefined;
      if (!other) continue;
      const community = byNode.get(other);
      if (community === undefined) continue;
      tally.set(community, (tally.get(community) ?? 0) + 1);
    }
    const best = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
    byNode.set(hubId, best ? best[0] : -1);
  }

  const members = new Map<number, GraphNode[]>();
  for (const node of input.nodes) {
    const community = byNode.get(node.id) ?? -1;
    const bucket = members.get(community);
    if (bucket) bucket.push(node);
    else members.set(community, [node]);
  }

  const internalEdgeCount = new Map<number, number>();
  for (const edge of relevant) {
    const a = byNode.get(edge.source);
    const b = byNode.get(edge.target);
    if (a !== undefined && a === b) internalEdgeCount.set(a, (internalEdgeCount.get(a) ?? 0) + 1);
  }

  const communities: Community[] = [...members.entries()]
    .map(([rawId, nodes]) => {
      const hub = [...nodes].sort(
        (a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.name.localeCompare(b.name),
      )[0]!;
      return {
        rawId,
        hub,
        nodes,
      };
    })
    .sort((a, b) => b.nodes.length - a.nodes.length || a.hub.name.localeCompare(b.hub.name))
    .map((entry, i) => ({
      id: i,
      name: entry.hub.name,
      hubId: entry.hub.id,
      nodeIds: entry.nodes.map((node) => node.id),
      size: entry.nodes.length,
      color: COMMUNITY_PALETTE[i % COMMUNITY_PALETTE.length],
      internalEdges: internalEdgeCount.get(entry.rawId) ?? 0,
    }));

  // Re-key byNode onto the sorted, user-facing community ids.
  const finalByNode = new Map<string, number>();
  for (const community of communities) {
    for (const nodeId of community.nodeIds) finalByNode.set(nodeId, community.id);
  }

  return {
    communities,
    byNode: finalByNode,
    modularity,
    excludedHubs: [...excluded],
  };
}

/** Convenience wrapper over a whole index. */
export function detectCommunitiesForIndex(
  index: GraphIndex,
  options: CommunityOptions = {},
): CommunityResult {
  return detectCommunities({ nodes: index.allNodes, edges: index.allEdges }, options);
}
