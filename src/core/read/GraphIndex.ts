import {
  COMPONENT_DEFINITION_TYPES,
  type DesignGraph,
  type EdgeType,
  type GraphEdge,
  type GraphNode,
  type NodeType,
} from "@/core/model";

export type Direction = "out" | "in" | "both";

export interface EdgeQuery {
  direction?: Direction;
  edgeTypes?: readonly EdgeType[];
}

export interface TraversalQuery extends EdgeQuery {
  /** Number of hops. Default 1. */
  depth?: number;
  /** Stop after this many nodes. Default unbounded. */
  limit?: number;
  /** Only return nodes of these types (traversal still passes through others). */
  nodeTypes?: readonly NodeType[];
}

export interface PathHop {
  type: EdgeType;
  from: string;
  to: string;
}

export interface PathTrace {
  nodes: GraphNode[];
  hops: PathHop[];
  distance: number;
}

const HUB_TYPES: readonly NodeType[] = ["FILE", "PAGE", "SECTION"];

const isHub = (node: GraphNode | undefined): boolean =>
  !!node && (HUB_TYPES as readonly string[]).includes(node.type);

/** Component relationships cheap; page/file containment dear. */
function pathEdgeWeight(index: GraphIndex, edge: GraphEdge, fromId: string): number {
  const otherId = edge.source === fromId ? edge.target : edge.source;
  switch (edge.type) {
    case "INSTANCE_OF":
    case "USED_IN":
    case "VARIANT_OF":
    case "NESTS":
      return 1;
    case "PROTOTYPES_TO":
    case "LINKS_TO":
      return 2;
    case "GOVERNS":
      return 3;
    case "CONTAINS":
    case "PARENT_OF":
      return isHub(index.getNode(fromId)) || isHub(index.getNode(otherId)) ? 24 : 4;
    case "USES_STYLE":
    case "USES_VARIABLE":
      return 16;
    default:
      return 8;
  }
}

const push = <K, V>(map: Map<K, V[]>, key: K, value: V): void => {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
};

/**
 * Read model for a `DesignGraph`.
 *
 * Built once per graph, then reused by search, filters, subgraph extraction,
 * analytics and AI context assembly. Every index here is a reverse index that
 * would otherwise require a full scan.
 */
export class GraphIndex {
  readonly graph: DesignGraph;

  private readonly nodesById = new Map<string, GraphNode>();
  private readonly outgoing = new Map<string, GraphEdge[]>();
  private readonly incoming = new Map<string, GraphEdge[]>();

  private readonly childrenByParent = new Map<string, string[]>();
  private readonly nodesByType = new Map<NodeType, string[]>();
  private readonly nodesByPage = new Map<string, string[]>();
  private readonly nodesBySection = new Map<string, string[]>();

  private readonly instancesByComponent = new Map<string, string[]>();
  private readonly variantsBySet = new Map<string, string[]>();
  private readonly consumersByStyle = new Map<string, string[]>();
  private readonly consumersByVariable = new Map<string, string[]>();
  private readonly variablesByCollection = new Map<string, string[]>();
  private readonly membersByLibrary = new Map<string, string[]>();
  /** Instances nested anywhere inside a screen frame or component definition. */
  private readonly nestedInstancesByContainer = new Map<string, string[]>();

  constructor(graph: DesignGraph) {
    this.graph = graph;

    for (const node of graph.nodes) {
      this.nodesById.set(node.id, node);
      push(this.nodesByType, node.type, node.id);
      if (node.pageId) push(this.nodesByPage, node.pageId, node.id);
      if (node.sectionId) push(this.nodesBySection, node.sectionId, node.id);
      if (node.libraryId) push(this.membersByLibrary, node.libraryId, node.id);
    }

    for (const edge of graph.edges) {
      push(this.outgoing, edge.source, edge);
      push(this.incoming, edge.target, edge);

      switch (edge.type) {
        case "CONTAINS":
          push(this.childrenByParent, edge.source, edge.target);
          break;
        case "INSTANCE_OF":
          push(this.instancesByComponent, edge.target, edge.source);
          break;
        case "VARIANT_OF":
          push(this.variantsBySet, edge.target, edge.source);
          break;
        case "USES_STYLE":
          push(this.consumersByStyle, edge.target, edge.source);
          break;
        case "USES_VARIABLE":
          push(this.consumersByVariable, edge.target, edge.source);
          break;
        case "BELONGS_TO_COLLECTION":
          push(this.variablesByCollection, edge.target, edge.source);
          break;
        case "SOURCED_FROM_LIBRARY":
          push(this.membersByLibrary, edge.target, edge.source);
          break;
        case "NESTS":
          push(this.nestedInstancesByContainer, edge.source, edge.target);
          break;
        default:
          break;
      }
    }
  }

  /* -------------------------------------------------- basics */

  get nodeCount(): number {
    return this.nodesById.size;
  }
  get edgeCount(): number {
    return this.graph.edges.length;
  }
  get allNodes(): GraphNode[] {
    return this.graph.nodes;
  }
  get allEdges(): GraphEdge[] {
    return this.graph.edges;
  }

  has(id: string): boolean {
    return this.nodesById.has(id);
  }
  getNode(id: string): GraphNode | undefined {
    return this.nodesById.get(id);
  }
  getNodes(ids: Iterable<string>): GraphNode[] {
    const out: GraphNode[] = [];
    for (const id of ids) {
      const node = this.nodesById.get(id);
      if (node) out.push(node);
    }
    return out;
  }
  getNodesByType(...types: NodeType[]): GraphNode[] {
    return this.getNodes(types.flatMap((type) => this.nodesByType.get(type) ?? []));
  }
  getFileNode(): GraphNode | undefined {
    return this.getNodesByType("FILE")[0];
  }
  getPages(): GraphNode[] {
    return this.getNodesByType("PAGE");
  }

  /* -------------------------------------------------- structure */

  getChildren(id: string): GraphNode[] {
    return this.getNodes(this.childrenByParent.get(id) ?? []);
  }
  getChildIds(id: string): readonly string[] {
    return this.childrenByParent.get(id) ?? [];
  }
  getParent(id: string): GraphNode | undefined {
    const parentId = this.nodesById.get(id)?.parentId;
    return parentId ? this.nodesById.get(parentId) : undefined;
  }

  /** File -> ... -> node, inclusive of the node itself. */
  getHierarchyPath(id: string): GraphNode[] {
    const path: GraphNode[] = [];
    const seen = new Set<string>();
    let current = this.nodesById.get(id);
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      path.unshift(current);
      current = current.parentId ? this.nodesById.get(current.parentId) : undefined;
    }
    return path;
  }

  getAncestors(id: string): GraphNode[] {
    return this.getHierarchyPath(id).slice(0, -1);
  }

  getDescendants(
    id: string,
    options: { maxDepth?: number; nodeTypes?: readonly NodeType[]; limit?: number } = {},
  ): GraphNode[] {
    const { maxDepth = Infinity, nodeTypes, limit = Infinity } = options;
    const out: GraphNode[] = [];
    const queue: Array<{ id: string; depth: number }> = [{ id, depth: 0 }];
    const seen = new Set<string>([id]);

    while (queue.length) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth) continue;
      for (const childId of this.childrenByParent.get(current.id) ?? []) {
        if (seen.has(childId)) continue;
        seen.add(childId);
        const child = this.nodesById.get(childId);
        if (!child) continue;
        if (!nodeTypes || nodeTypes.includes(child.type)) {
          out.push(child);
          if (out.length >= limit) return out;
        }
        queue.push({ id: childId, depth: current.depth + 1 });
      }
    }
    return out;
  }

  /* -------------------------------------------------- edges */

  getEdges(id: string, query: EdgeQuery = {}): GraphEdge[] {
    const { direction = "both", edgeTypes } = query;
    const edges: GraphEdge[] = [];
    if (direction === "out" || direction === "both") edges.push(...(this.outgoing.get(id) ?? []));
    if (direction === "in" || direction === "both") edges.push(...(this.incoming.get(id) ?? []));
    return edgeTypes ? edges.filter((edge) => edgeTypes.includes(edge.type)) : edges;
  }

  /** Every edge whose endpoints are both inside `ids`. */
  getInducedEdges(ids: Iterable<string>, edgeTypes?: readonly EdgeType[]): GraphEdge[] {
    const set = ids instanceof Set ? (ids as Set<string>) : new Set(ids);
    const seen = new Set<string>();
    const out: GraphEdge[] = [];
    for (const id of set) {
      for (const edge of this.outgoing.get(id) ?? []) {
        if (!set.has(edge.target)) continue;
        if (edgeTypes && !edgeTypes.includes(edge.type)) continue;
        if (seen.has(edge.id)) continue;
        seen.add(edge.id);
        out.push(edge);
      }
    }
    return out;
  }

  getNeighbors(id: string, query: TraversalQuery = {}): GraphNode[] {
    const { depth = 1, limit = Infinity, nodeTypes } = query;
    const out: GraphNode[] = [];
    const seen = new Set<string>([id]);
    let frontier = [id];

    for (let hop = 0; hop < depth && frontier.length; hop += 1) {
      const next: string[] = [];
      for (const current of frontier) {
        for (const edge of this.getEdges(current, query)) {
          const neighborId = edge.source === current ? edge.target : edge.source;
          if (seen.has(neighborId)) continue;
          seen.add(neighborId);
          const neighbor = this.nodesById.get(neighborId);
          if (!neighbor) continue;
          next.push(neighborId);
          if (nodeTypes && !nodeTypes.includes(neighbor.type)) continue;
          out.push(neighbor);
          if (out.length >= limit) return out;
        }
      }
      frontier = next;
    }
    return out;
  }

  /**
   * Shortest *meaningful* path, not fewest tree hops.
   *
   * Unweighted BFS treats FILE/PAGE/SECTION as 1, so two screens look related
   * because they share a page — the agent never sees the tertiary button they
   * actually share. Component edges (INSTANCE_OF, NESTS, VARIANT_OF) are cheap;
   * containment through a hub is expensive.
   *
   * Foundation edges stay out unless an endpoint is a style/variable.
   * Pass `edgeTypes` to override.
   *
   * ponytail: O(n²) Dijkstra, binary heap if a file regularly exceeds ~20k nodes
   */
  shortestPath(fromId: string, toId: string, edgeTypes?: readonly EdgeType[]): GraphNode[] {
    return this.shortestPathTrace(fromId, toId, edgeTypes).nodes;
  }

  shortestPathTrace(
    fromId: string,
    toId: string,
    edgeTypes?: readonly EdgeType[],
  ): PathTrace {
    const empty: PathTrace = { nodes: [], hops: [], distance: 0 };
    if (!this.has(fromId) || !this.has(toId)) return empty;
    if (fromId === toId) return { nodes: this.getNodes([fromId]), hops: [], distance: 0 };

    const resolvedEdgeTypes = edgeTypes ?? this.defaultPathEdgeTypes(fromId, toId);
    const dist = new Map<string, number>([[fromId, 0]]);
    const prev = new Map<string, { id: string; type: EdgeType }>();
    const done = new Set<string>();

    while (true) {
      let current: string | undefined;
      let best = Infinity;
      for (const [id, cost] of dist) {
        if (done.has(id)) continue;
        if (cost < best) {
          best = cost;
          current = id;
        }
      }
      if (current === undefined) return empty;
      if (current === toId) break;
      done.add(current);

      for (const edge of this.getEdges(current, {
        direction: "both",
        edgeTypes: resolvedEdgeTypes,
      })) {
        const neighborId = edge.source === current ? edge.target : edge.source;
        if (done.has(neighborId)) continue;
        const next = best + pathEdgeWeight(this, edge, current);
        if (next < (dist.get(neighborId) ?? Infinity)) {
          dist.set(neighborId, next);
          prev.set(neighborId, { id: current, type: edge.type });
        }
      }
    }

    const hops: PathHop[] = [];
    const ids = [toId];
    let cursor = toId;
    while (prev.has(cursor)) {
      const step = prev.get(cursor)!;
      hops.unshift({ type: step.type, from: step.id, to: cursor });
      cursor = step.id;
      ids.unshift(cursor);
    }
    return { nodes: this.getNodes(ids), hops, distance: dist.get(toId) ?? 0 };
  }

  private defaultPathEdgeTypes(fromId: string, toId: string): readonly EdgeType[] {
    const foundation: readonly NodeType[] = [
      "STYLE",
      "VARIABLE",
      "VARIABLE_COLLECTION",
      "EXTERNAL_LIBRARY",
    ];
    const touchesFoundation = [fromId, toId].some((id) => {
      const type = this.nodesById.get(id)?.type;
      return type ? foundation.includes(type) : false;
    });

    const structural: EdgeType[] = [
      "CONTAINS",
      "PARENT_OF",
      "INSTANCE_OF",
      "USED_IN",
      "VARIANT_OF",
      "NESTS",
      "PROTOTYPES_TO",
      "LINKS_TO",
      "GOVERNS",
    ];

    return touchesFoundation
      ? [
          ...structural,
          "USES_STYLE",
          "USES_VARIABLE",
          "BELONGS_TO_COLLECTION",
          "SOURCED_FROM_LIBRARY",
        ]
      : structural;
  }

  /* -------------------------------------------------- component system */

  getMainComponent(instanceId: string): GraphNode | undefined {
    const mainId = this.nodesById.get(instanceId)?.mainComponentId;
    return mainId ? this.nodesById.get(mainId) : undefined;
  }

  /** Direct instances of one main component or variant. */
  getInstancesOf(componentId: string): GraphNode[] {
    return this.getNodes(this.instancesByComponent.get(componentId) ?? []);
  }

  getVariantsOf(componentSetId: string): GraphNode[] {
    return this.getNodes(this.variantsBySet.get(componentSetId) ?? []);
  }

  /** Instances of a component, or of every variant when given a component set. */
  getAllInstancesOf(componentId: string): GraphNode[] {
    const node = this.nodesById.get(componentId);
    if (!node) return [];
    if (node.type !== "COMPONENT_SET") return this.getInstancesOf(componentId);
    const seen = new Map<string, GraphNode>();
    for (const variant of this.getVariantsOf(componentId)) {
      for (const instance of this.getInstancesOf(variant.id)) seen.set(instance.id, instance);
    }
    for (const instance of this.getInstancesOf(componentId)) seen.set(instance.id, instance);
    return [...seen.values()];
  }

  /** The component definition a node belongs to, if any. */
  getOwningComponent(id: string): GraphNode | undefined {
    for (const ancestor of this.getHierarchyPath(id).slice().reverse()) {
      if (COMPONENT_DEFINITION_TYPES.includes(ancestor.type)) return ancestor;
    }
    return undefined;
  }

  /** Instances nested anywhere inside a screen frame or component definition. */
  getNestedInstances(containerId: string): GraphNode[] {
    return this.getNodes(this.nestedInstancesByContainer.get(containerId) ?? []);
  }

  /* -------------------------------------------------- foundations */

  getStyleConsumers(styleId: string): GraphNode[] {
    return this.getNodes(this.consumersByStyle.get(styleId) ?? []);
  }
  getVariableConsumers(variableId: string): GraphNode[] {
    return this.getNodes(this.consumersByVariable.get(variableId) ?? []);
  }
  getVariablesInCollection(collectionId: string): GraphNode[] {
    return this.getNodes(this.variablesByCollection.get(collectionId) ?? []);
  }
  getLibraryMembers(libraryId: string): GraphNode[] {
    // Membership arrives twice — from `node.libraryId` and from the
    // SOURCED_FROM_LIBRARY edge — so it is de-duplicated here.
    return this.getNodes(new Set(this.membersByLibrary.get(libraryId) ?? []));
  }

  /* -------------------------------------------------- location */

  getNodesOnPage(pageId: string): GraphNode[] {
    return this.getNodes(this.nodesByPage.get(pageId) ?? []);
  }
  getNodesInSection(sectionId: string): GraphNode[] {
    return this.getNodes(this.nodesBySection.get(sectionId) ?? []);
  }

  /** The screen-level frame a node sits inside, if any. */
  getContainingFrame(id: string): GraphNode | undefined {
    for (const ancestor of this.getHierarchyPath(id).slice(0, -1).reverse()) {
      if (ancestor.type === "FRAME") return ancestor;
    }
    return undefined;
  }

  getPageOf(id: string): GraphNode | undefined {
    const pageId = this.nodesById.get(id)?.pageId;
    return pageId ? this.nodesById.get(pageId) : undefined;
  }
}

export function indexGraph(graph: DesignGraph): GraphIndex {
  return new GraphIndex(graph);
}
