import type { GraphEdge, GraphNode } from "@/core/model";
import type { GraphIndex } from "@/core/query/GraphIndex";
import { usageSummaryFor, type UsageSummary } from "@/core/query/analytics";
import { extractSubgraph, levelForNode, type ViewMode } from "@/core/query/subgraph";

/**
 * AI never receives the file. It receives a bounded subgraph around what the
 * user selected, projected down to the fields a model can actually use.
 */

export interface AiGraphContext {
  selectedNodeIds: string[];
  focusNode: GraphNode;
  neighbors: GraphNode[];
  edges: GraphEdge[];
  hierarchyPath: GraphNode[];
  usageSummary: UsageSummary;
  meta: {
    fileKey: string;
    fileName: string;
    generatedAt: string;
    /** Node budget that produced this payload. */
    nodeBudget: number;
    truncated: boolean;
    /** Selected ids that did not fit in the node budget. */
    omittedSelectionIds?: string[];
    sourceKind: string;
  };
}

export interface BuildAiContextOptions {
  /** Extra selected nodes beyond the focus node. */
  selectedNodeIds?: readonly string[];
  viewMode?: ViewMode;
  /** Maximum neighbour nodes in the payload. Default 60. */
  nodeBudget?: number;
  /** Keep the raw `metadata` bag. Default false — it is large and noisy. */
  includeMetadata?: boolean;
  generatedAt?: string;
}

/** Drops the heavy fields so payloads stay small and diff-able. */
export function compactNode(node: GraphNode, includeMetadata = false): GraphNode {
  const compact: GraphNode = { id: node.id, type: node.type, name: node.name };
  if (node.figmaNodeId) compact.figmaNodeId = node.figmaNodeId;
  if (node.fileKey) compact.fileKey = node.fileKey;
  if (node.description) compact.description = node.description;
  if (node.parentId) compact.parentId = node.parentId;
  if (node.pageId) compact.pageId = node.pageId;
  if (node.sectionId) compact.sectionId = node.sectionId;
  if (node.isMainComponent) compact.isMainComponent = true;
  if (node.isInstance) compact.isInstance = true;
  if (node.isRemote) compact.isRemote = true;
  if (node.mainComponentId) compact.mainComponentId = node.mainComponentId;
  if (node.componentSetId) compact.componentSetId = node.componentSetId;
  if (node.variantProperties) compact.variantProperties = node.variantProperties;
  if (node.styleIds?.length) compact.styleIds = node.styleIds;
  if (node.variableIds?.length) compact.variableIds = node.variableIds;
  if (node.libraryId) compact.libraryId = node.libraryId;
  if (node.figmaUrl) compact.figmaUrl = node.figmaUrl;
  if (node.status) compact.status = node.status;
  if (node.owner) compact.owner = node.owner;
  if (node.platforms?.length) compact.platforms = node.platforms;
  if (includeMetadata && node.metadata) compact.metadata = node.metadata;
  return compact;
}

export function buildAiGraphContext(
  index: GraphIndex,
  focusId: string,
  options: BuildAiContextOptions = {},
): AiGraphContext | undefined {
  const focus = index.getNode(focusId);
  if (!focus) return undefined;

  const nodeBudget = options.nodeBudget ?? 60;
  const includeMetadata = options.includeMetadata ?? false;
  const selectedNodeIds = [...new Set([focusId, ...(options.selectedNodeIds ?? [])])];

  const subgraph = extractSubgraph(index, {
    focusId,
    level: levelForNode(focus),
    viewMode: options.viewMode ?? "hierarchy",
    maxNodes: nodeBudget,
    includeAncestors: true,
  });

  const nodeIds = new Set(subgraph.nodes.map((node) => node.id));
  const omittedSelectionIds: string[] = [];
  for (const id of selectedNodeIds) {
    if (nodeIds.has(id)) continue;
    if (nodeIds.size >= nodeBudget || !index.getNode(id)) {
      omittedSelectionIds.push(id);
      continue;
    }
    nodeIds.add(id);
  }

  const neighbors = index
    .getNodes(nodeIds)
    .filter((node) => node.id !== focusId)
    .map((node) => compactNode(node, includeMetadata));

  const edges = index.getInducedEdges(nodeIds).filter((edge) => edge.type !== "PARENT_OF");

  return {
    selectedNodeIds: selectedNodeIds.filter((id) => nodeIds.has(id)),
    focusNode: compactNode(focus, includeMetadata),
    neighbors,
    edges,
    hierarchyPath: index.getHierarchyPath(focusId).map((node) => compactNode(node, false)),
    usageSummary: usageSummaryFor(index, focusId),
    meta: {
      fileKey: index.graph.fileKey,
      fileName: index.graph.fileName,
      generatedAt: options.generatedAt ?? new Date().toISOString(),
      nodeBudget,
      truncated: subgraph.truncated || omittedSelectionIds.length > 0,
      ...(omittedSelectionIds.length ? { omittedSelectionIds } : {}),
      sourceKind: index.graph.source.kind,
    },
  };
}
