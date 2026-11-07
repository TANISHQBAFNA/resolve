import type { EdgeType, GraphEdge, GraphNode, NodeType } from "@/core/model";
import type { GraphIndex } from "./GraphIndex";

/**
 * Whole-file projection.
 *
 * The focused levels answer "what is this one thing made of". The atlas answers
 * "what does this file look like" — and for that, 87 separate `Button` instance
 * nodes are 87 copies of one fact. Collapsing every instance onto its main
 * component turns repetition into edge weight: one node per component, one edge
 * per container that uses it, carrying how many times.
 */

export interface ProjectionOptions {
  /** Fold instances into the component they reference. Default true. */
  collapseInstances?: boolean;
  /** Keep only these node types (applied after collapsing). */
  includeTypes?: readonly NodeType[];
  /** Drop these node types. */
  excludeTypes?: readonly NodeType[];
  /** Drop nodes below this degree once projected. Default 0. */
  minDegree?: number;
  /** Relationship types to keep. Materialised inverses are always dropped. */
  edgeTypes?: readonly EdgeType[];
}

export interface ProjectedEdge extends GraphEdge {
  /** How many source relationships collapsed into this one. */
  weight: number;
}

export interface AtlasProjection {
  nodes: GraphNode[];
  edges: ProjectedEdge[];
  /** instance id -> the node it was folded into. */
  collapsed: Map<string, string>;
  stats: {
    sourceNodes: number;
    sourceEdges: number;
    nodes: number;
    edges: number;
    collapsedInstances: number;
    droppedByDegree: number;
  };
}

const REAL_EDGE_TYPES: readonly EdgeType[] = [
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

/** Containment of a collapsed instance is really "this container uses that component". */
const COLLAPSED_CONTAINMENT: readonly EdgeType[] = ["CONTAINS", "NESTS"];

export function projectAtlas(
  index: GraphIndex,
  options: ProjectionOptions = {},
): AtlasProjection {
  const {
    collapseInstances = true,
    includeTypes,
    excludeTypes,
    minDegree = 0,
    edgeTypes = REAL_EDGE_TYPES,
  } = options;

  const allowedEdges = new Set<EdgeType>(edgeTypes.filter((type) => REAL_EDGE_TYPES.includes(type)));
  const include = includeTypes?.length ? new Set<NodeType>(includeTypes) : undefined;
  const exclude = excludeTypes?.length ? new Set<NodeType>(excludeTypes) : undefined;

  /** Where each source node ends up. */
  const remap = new Map<string, string>();
  const collapsed = new Map<string, string>();

  for (const node of index.allNodes) {
    if (collapseInstances && node.isInstance && node.mainComponentId) {
      remap.set(node.id, node.mainComponentId);
      collapsed.set(node.id, node.mainComponentId);
    } else {
      remap.set(node.id, node.id);
    }
  }

  // An instance nested inside another instance collapses through the chain.
  const resolve = (id: string): string => {
    let current = id;
    for (let hop = 0; hop < 8; hop += 1) {
      const next = remap.get(current);
      if (!next || next === current) break;
      current = next;
    }
    return current;
  };

  const keptIds = new Set<string>();
  for (const node of index.allNodes) {
    if (collapsed.has(node.id)) continue;
    if (include && !include.has(node.type)) continue;
    if (exclude?.has(node.type)) continue;
    keptIds.add(node.id);
  }

  const edges = new Map<string, ProjectedEdge>();

  for (const edge of index.allEdges) {
    if (!allowedEdges.has(edge.type)) continue;

    const sourceCollapsed = collapsed.has(edge.source);
    const targetCollapsed = collapsed.has(edge.target);
    let source = resolve(edge.source);
    let target = resolve(edge.target);
    let type: EdgeType = edge.type;

    if (source === target) continue;
    if (!keptIds.has(source) || !keptIds.has(target)) continue;

    // `frame CONTAINS instance` becomes `component USED_IN frame`, matching the
    // direction the rest of the product uses for usage relationships.
    if (targetCollapsed && COLLAPSED_CONTAINMENT.includes(edge.type)) {
      const container = source;
      source = target;
      target = container;
      type = "USED_IN";
    } else if (sourceCollapsed && edge.type === "INSTANCE_OF") {
      continue;
    }

    const id = `${type}|${source}|${target}`;
    const existing = edges.get(id);
    if (existing) {
      existing.weight += 1;
      continue;
    }
    edges.set(id, {
      id,
      source,
      target,
      type,
      weight: 1,
      label: type === "USED_IN" ? "used in" : edge.label,
      metadata: sourceCollapsed || targetCollapsed ? { projected: true } : edge.metadata,
    });
  }

  // Degree pruning happens last so weights are already accumulated.
  let droppedByDegree = 0;
  if (minDegree > 0) {
    const degree = new Map<string, number>();
    for (const edge of edges.values()) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    }
    for (const id of [...keptIds]) {
      if ((degree.get(id) ?? 0) < minDegree) {
        keptIds.delete(id);
        droppedByDegree += 1;
      }
    }
    for (const [id, edge] of [...edges]) {
      if (!keptIds.has(edge.source) || !keptIds.has(edge.target)) edges.delete(id);
    }
  }

  return {
    nodes: index.getNodes(keptIds),
    edges: [...edges.values()],
    collapsed,
    stats: {
      sourceNodes: index.nodeCount,
      sourceEdges: index.edgeCount,
      nodes: keptIds.size,
      edges: edges.size,
      collapsedInstances: collapsed.size,
      droppedByDegree,
    },
  };
}
