import {
  DEPENDENCY_EDGE_TYPES,
  type EdgeType,
  type GraphEdge,
  type GraphNode,
  type NodeType,
} from "@/core/model";
import type { GraphIndex } from "./GraphIndex";

/**
 * Progressive disclosure lives here.
 *
 * The canvas never renders the whole file. It renders a *subgraph* chosen by
 * (focus node, level, view mode, manual expansions), which is what keeps large
 * files legible and keeps AI payloads small.
 */

export const GRAPH_LEVELS = [
  "PRODUCT_MAP",
  "PAGE_MAP",
  "FRAME_COMPOSITION",
  "COMPONENT_DEPENDENCY",
] as const;
export type GraphLevel = (typeof GRAPH_LEVELS)[number];

export const VIEW_MODES = ["hierarchy", "dependency", "usage", "prototype"] as const;
export type ViewMode = (typeof VIEW_MODES)[number];

export const EDGE_TYPES_BY_VIEW: Record<ViewMode, readonly EdgeType[]> = {
  hierarchy: ["CONTAINS", "INSTANCE_OF", "PROTOTYPES_TO"],
  dependency: DEPENDENCY_EDGE_TYPES,
  usage: ["USED_IN", "CONTAINS", "VARIANT_OF", "NESTS"],
  prototype: ["PROTOTYPES_TO", "LINKS_TO"],
};

export interface SubgraphRequest {
  focusId: string;
  level?: GraphLevel;
  viewMode?: ViewMode;
  /** Nodes the user explicitly expanded (double-click). */
  expandedIds?: readonly string[];
  /** Hard cap on rendered nodes. Default 300. */
  maxNodes?: number;
  /** Cap on children pulled in per container before "+N more". Default 24. */
  maxChildrenPerContainer?: number;
  /**
   * Separate, tighter cap for styles and variables. A screen can touch dozens
   * of tokens; drawing all of them buries the structure the level exists to
   * show. The inspector still lists every one.
   */
  maxFoundations?: number;
  /** Include the File -> ... -> focus chain for context. Default true. */
  includeAncestors?: boolean;
  /** Restrict to these node types after collection. */
  nodeTypeFilter?: readonly NodeType[];
}

export interface Subgraph {
  focusId: string;
  level: GraphLevel;
  viewMode: ViewMode;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** True when the node cap or a per-container cap kicked in. */
  truncated: boolean;
  hiddenCount: number;
}

export function levelForNode(node: GraphNode | undefined): GraphLevel {
  switch (node?.type) {
    case "FILE":
    case undefined:
      return "PRODUCT_MAP";
    case "PAGE":
    case "SECTION":
      return "PAGE_MAP";
    case "COMPONENT_SET":
    case "MAIN_COMPONENT":
    case "VARIANT":
      return "COMPONENT_DEPENDENCY";
    default:
      return "FRAME_COMPOSITION";
  }
}

const SCREEN_LIKE: readonly NodeType[] = ["FRAME", "AUTO_LAYOUT_CONTAINER"];
const COMPONENT_DEF: readonly NodeType[] = ["COMPONENT_SET", "MAIN_COMPONENT", "VARIANT"];

class Collector {
  readonly ids = new Set<string>();
  hidden = 0;
  truncated = false;

  constructor(
    private readonly index: GraphIndex,
    private readonly maxNodes: number,
  ) {}

  add(node: GraphNode | undefined | null): boolean {
    if (!node) return false;
    if (this.ids.has(node.id)) return true;
    if (this.ids.size >= this.maxNodes) {
      this.truncated = true;
      this.hidden += 1;
      return false;
    }
    this.ids.add(node.id);
    return true;
  }

  addMany(nodes: readonly GraphNode[], cap = Infinity): void {
    const limited = nodes.slice(0, cap);
    if (nodes.length > limited.length) {
      this.truncated = true;
      this.hidden += nodes.length - limited.length;
    }
    for (const node of limited) this.add(node);
  }

  addPath(id: string): void {
    for (const ancestor of this.index.getHierarchyPath(id)) this.add(ancestor);
  }
}

export function extractSubgraph(index: GraphIndex, request: SubgraphRequest): Subgraph {
  const focus = index.getNode(request.focusId) ?? index.getFileNode();
  const focusId = focus?.id ?? request.focusId;
  const level = request.level ?? levelForNode(focus);
  const viewMode = request.viewMode ?? "hierarchy";
  const maxNodes = request.maxNodes ?? 300;
  const childCap = request.maxChildrenPerContainer ?? 24;
  const foundationCap = request.maxFoundations ?? 8;
  const includeAncestors = request.includeAncestors ?? true;

  const collector = new Collector(index, maxNodes);
  if (focus) collector.add(focus);

  if (level !== "PRODUCT_MAP" && includeAncestors && focus) collector.addPath(focus.id);

  switch (level) {
    case "PRODUCT_MAP":
      collectProductMap(index, collector, childCap);
      break;
    case "PAGE_MAP":
      if (focus) collectPageMap(index, collector, focus, childCap);
      break;
    case "FRAME_COMPOSITION":
      if (focus) collectFrameComposition(index, collector, focus, childCap, foundationCap);
      break;
    case "COMPONENT_DEPENDENCY":
      if (focus) collectComponentDependency(index, collector, focus, childCap, foundationCap);
      break;
    default:
      break;
  }

  // Manual expansions always win over the level defaults.
  for (const expandedId of request.expandedIds ?? []) {
    if (!collector.ids.has(expandedId)) continue;
    collector.addMany(index.getChildren(expandedId), childCap);
  }

  let nodes = index.getNodes(collector.ids);
  if (request.nodeTypeFilter?.length) {
    const allowed = new Set<NodeType>(request.nodeTypeFilter);
    nodes = nodes.filter((node) => node.id === focusId || allowed.has(node.type));
  }

  const edgeTypes = EDGE_TYPES_BY_VIEW[viewMode];
  const nodeIds = new Set(nodes.map((node) => node.id));
  let edges = index.getInducedEdges(nodeIds, edgeTypes);

  if (level === "PAGE_MAP" && viewMode !== "prototype") {
    edges = [...edges, ...rollupComponentUsage(index, nodeIds)];
  }

  // In non-hierarchy views a node with no edge is noise, not information.
  if (viewMode !== "hierarchy") {
    const connected = new Set<string>([focusId]);
    for (const edge of edges) {
      connected.add(edge.source);
      connected.add(edge.target);
    }
    const before = nodes.length;
    nodes = nodes.filter((node) => connected.has(node.id));
    collector.hidden += before - nodes.length;
    const remaining = new Set(nodes.map((node) => node.id));
    edges = edges.filter((edge) => remaining.has(edge.source) && remaining.has(edge.target));
  }

  return {
    focusId,
    level,
    viewMode,
    nodes,
    edges,
    truncated: collector.truncated,
    hiddenCount: collector.hidden,
  };
}

/**
 * Level 2 rollup.
 *
 * A page map shows screens and the components those screens use, but the
 * instances that connect the two are deliberately left out — they would triple
 * the node count for a view meant to stay readable. Without a rollup those
 * component nodes would float unconnected, so the subgraph adds a derived
 * `USED_IN` edge (main component -> screen frame) that summarises the real
 * path `frame -NESTS-> instance -INSTANCE_OF-> main`.
 *
 * These edges exist only in the rendered subgraph, never in the DesignGraph,
 * and are tagged `derived` so nothing downstream mistakes them for source data.
 */
function rollupComponentUsage(index: GraphIndex, nodeIds: Set<string>): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  for (const id of nodeIds) {
    const node = index.getNode(id);
    if (!node || !SCREEN_LIKE.includes(node.type)) continue;

    for (const instance of index.getNestedInstances(id)) {
      const mainId = instance.mainComponentId;
      if (!mainId || !nodeIds.has(mainId)) continue;
      const edgeId = `USED_IN|${mainId}|${id}`;
      if (seen.has(edgeId)) continue;
      seen.add(edgeId);
      edges.push({
        id: edgeId,
        source: mainId,
        target: id,
        type: "USED_IN",
        label: "used in",
        metadata: { derived: true, rollup: "NESTS+INSTANCE_OF" },
      });
    }
  }

  return edges;
}

/* ------------------------------------------------------------------ *
 * Level collectors
 * ------------------------------------------------------------------ */

const TOP_LEVEL_TYPES: readonly NodeType[] = [
  ...SCREEN_LIKE,
  ...COMPONENT_DEF,
  "COMPONENT_INSTANCE",
];

/**
 * Walks the file's own children rather than assuming pages exist.
 *
 * A REST or plugin ingest roots at a document and those children are pages. An
 * MCP ingest roots at whatever node was queried, so the file's children are
 * frames. Both produce a useful top-level map from the same walk.
 */
function collectProductMap(index: GraphIndex, collector: Collector, childCap: number): void {
  const file = index.getFileNode();
  collector.add(file);
  if (!file) return;

  const roots = index.getChildren(file.id);
  collector.addMany(roots, childCap);

  for (const root of roots) {
    const children = index.getChildren(root.id);
    const sections = children.filter((child) => child.type === "SECTION");
    collector.addMany(sections, childCap);
    collector.addMany(
      children.filter((child) => TOP_LEVEL_TYPES.includes(child.type)),
      childCap,
    );

    for (const section of sections) {
      collector.addMany(
        index.getChildren(section.id).filter((child) => TOP_LEVEL_TYPES.includes(child.type)),
        childCap,
      );
    }
  }
}

function collectPageMap(
  index: GraphIndex,
  collector: Collector,
  focus: GraphNode,
  childCap: number,
): void {
  const page = focus.type === "PAGE" ? focus : index.getPageOf(focus.id) ?? focus;
  collector.add(page);

  const children = index.getChildren(page.id);
  collector.addMany(children, childCap);

  const sections = children.filter((child) => child.type === "SECTION");
  for (const section of sections) {
    collector.addMany(index.getChildren(section.id), childCap);
  }

  // Component definitions used by the screens on this page, one hop away.
  const screens = index
    .getNodes(collector.ids)
    .filter((node) => SCREEN_LIKE.includes(node.type) && node.pageId === page.id);

  const mains = new Map<string, GraphNode>();
  for (const screen of screens) {
    for (const instance of index.getNestedInstances(screen.id)) {
      const main = index.getMainComponent(instance.id);
      if (main) mains.set(main.id, main);
    }
  }
  collector.addMany([...mains.values()], childCap);
}

function collectFrameComposition(
  index: GraphIndex,
  collector: Collector,
  focus: GraphNode,
  childCap: number,
  foundationCap: number,
): void {
  collector.addMany(index.getChildren(focus.id), childCap);

  const nested = index.getNestedInstances(focus.id);
  collector.addMany(nested, childCap);

  const instances = [
    ...nested,
    ...index.getChildren(focus.id).filter((child) => child.isInstance),
    ...(focus.isInstance ? [focus] : []),
  ];

  for (const instance of instances) {
    const main = index.getMainComponent(instance.id);
    if (!main) continue;
    collector.add(main);
    if (main.componentSetId) collector.add(index.getNode(main.componentSetId));
  }

  // Foundations touched by this frame and its direct children.
  const foundationOwners = [focus, ...index.getChildren(focus.id)];
  for (const owner of foundationOwners) {
    collector.addMany(index.getNodes(owner.styleIds ?? []), foundationCap);
    collector.addMany(index.getNodes(owner.variableIds ?? []), foundationCap);
  }

  // Prototype destinations keep flow context visible from a screen.
  for (const edge of index.getEdges(focus.id, { edgeTypes: ["PROTOTYPES_TO"] })) {
    collector.add(index.getNode(edge.source === focus.id ? edge.target : edge.source));
  }
}

function collectComponentDependency(
  index: GraphIndex,
  collector: Collector,
  focus: GraphNode,
  childCap: number,
  foundationCap: number,
): void {
  const set =
    focus.type === "COMPONENT_SET"
      ? focus
      : focus.componentSetId
        ? index.getNode(focus.componentSetId)
        : undefined;

  if (set) {
    collector.add(set);
    collector.addMany(index.getVariantsOf(set.id), childCap);
  }

  const definitions = [focus, ...(set ? index.getVariantsOf(set.id) : [])];

  for (const definition of definitions) {
    collector.addMany(index.getNodes(definition.styleIds ?? []), foundationCap);
    collector.addMany(index.getNodes(definition.variableIds ?? []), foundationCap);
    // Components nested inside the definition.
    collector.addMany(index.getNestedInstances(definition.id), childCap);
    if (definition.libraryId) collector.add(index.getNode(definition.libraryId));
  }

  const instances = index.getAllInstancesOf(focus.id);
  collector.addMany(instances, Math.max(childCap, 40));

  // Where each instance lives: its frame and page give the blast radius.
  for (const instance of instances.slice(0, Math.max(childCap, 40))) {
    const frame = index.getContainingFrame(instance.id);
    if (frame) collector.add(frame);
    const page = index.getPageOf(instance.id);
    if (page) collector.add(page);
  }
}
