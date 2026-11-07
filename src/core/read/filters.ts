import type { EdgeType, GraphNode, NodeType } from "@/core/model";
import type { GraphIndex } from "./GraphIndex";
import type { GraphAnalytics } from "./analytics";

export interface FilterState {
  /** Empty means "every type". */
  nodeTypes: NodeType[];
  /** Empty means "whatever the current view mode implies". */
  edgeTypes: EdgeType[];
  pageIds: string[];
  sectionIds: string[];
  libraryIds: string[];
  componentScope: "all" | "main" | "instance";
  origin: "all" | "local" | "remote";
  onlyUnusedComponents: boolean;
  onlyUnresolvedInstances: boolean;
  onlyFramesWithoutComponents: boolean;
  onlyPrototypeLinked: boolean;
  /** Nodes that consume at least one style or variable. */
  onlyDesignSystemConsumers: boolean;
  hideHiddenLayers: boolean;
}

export const defaultFilterState = (): FilterState => ({
  nodeTypes: [],
  edgeTypes: [],
  pageIds: [],
  sectionIds: [],
  libraryIds: [],
  componentScope: "all",
  origin: "all",
  onlyUnusedComponents: false,
  onlyUnresolvedInstances: false,
  onlyFramesWithoutComponents: false,
  onlyPrototypeLinked: false,
  onlyDesignSystemConsumers: false,
  hideHiddenLayers: false,
});

export function isFilterActive(filters: FilterState): boolean {
  const base = defaultFilterState();
  return (JSON.stringify(filters) !== JSON.stringify(base));
}

export function matchesFilters(
  index: GraphIndex,
  node: GraphNode,
  filters: FilterState,
  analytics: GraphAnalytics,
): boolean {
  if (filters.nodeTypes.length && !filters.nodeTypes.includes(node.type)) return false;

  if (filters.pageIds.length) {
    const pageId = node.type === "PAGE" ? node.id : node.pageId;
    if (!pageId || !filters.pageIds.includes(pageId)) return false;
  }

  if (filters.sectionIds.length) {
    const sectionId = node.type === "SECTION" ? node.id : node.sectionId;
    if (!sectionId || !filters.sectionIds.includes(sectionId)) return false;
  }

  if (filters.libraryIds.length) {
    const libraryId = node.type === "EXTERNAL_LIBRARY" ? node.id : node.libraryId;
    if (!libraryId || !filters.libraryIds.includes(libraryId)) return false;
  }

  if (filters.componentScope === "main" && !node.isMainComponent) return false;
  if (filters.componentScope === "instance" && !node.isInstance) return false;

  if (filters.origin === "local" && node.isRemote) return false;
  if (filters.origin === "remote" && !node.isRemote) return false;

  if (filters.onlyUnusedComponents && !analytics.unusedComponents.some((n) => n.id === node.id)) {
    return false;
  }
  if (
    filters.onlyUnresolvedInstances &&
    !analytics.unresolvedInstances.some((n) => n.id === node.id)
  ) {
    return false;
  }
  if (
    filters.onlyFramesWithoutComponents &&
    !analytics.framesWithoutComponents.some((n) => n.id === node.id)
  ) {
    return false;
  }
  if (filters.onlyPrototypeLinked && index.getEdges(node.id, { edgeTypes: ["PROTOTYPES_TO"] }).length === 0) {
    return false;
  }
  if (
    filters.onlyDesignSystemConsumers &&
    !(node.styleIds?.length || node.variableIds?.length)
  ) {
    return false;
  }
  if (filters.hideHiddenLayers && node.metadata?.["hidden"] === true) return false;

  return true;
}

export function applyFilters(
  index: GraphIndex,
  nodes: readonly GraphNode[],
  filters: FilterState,
  analytics: GraphAnalytics,
): GraphNode[] {
  return nodes.filter((node) => matchesFilters(index, node, filters, analytics));
}
