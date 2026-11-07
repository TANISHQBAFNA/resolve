import type { GraphNode } from "@/core/model";
import type { GraphIndex } from "./GraphIndex";

/**
 * Deterministic, definition-first analytics. Every metric below states its
 * rule explicitly so a number in the UI can always be explained.
 */

export interface ComponentUsage {
  component: GraphNode;
  /** Instances of this component (variants aggregated for component sets). */
  instanceCount: number;
  variantCount: number;
  /** Distinct screen frames that contain at least one instance. */
  frameIds: string[];
  /** Distinct pages that contain at least one instance. */
  pageIds: string[];
  /** instances + frames + 2x pages. A blast-radius proxy, not a judgement. */
  riskScore: number;
}

export interface UsageSummary {
  instanceCount?: number;
  directChildrenCount?: number;
  styleCount?: number;
  variableCount?: number;
  dependentFrameCount?: number;
}

export interface GraphAnalytics {
  totals: {
    nodes: number;
    edges: number;
    pages: number;
    frames: number;
    componentDefinitions: number;
    instances: number;
    styles: number;
    variables: number;
  };
  componentUsage: ComponentUsage[];
  /** Component definitions with zero instances anywhere in this file. */
  unusedComponents: GraphNode[];
  /** Instances whose main component could not be resolved from this payload. */
  unresolvedInstances: GraphNode[];
  /** Frames containing no component instance at any depth. */
  framesWithoutComponents: GraphNode[];
  /** Screen frames with no component instances *and* no prototype connections. */
  orphanedFrames: GraphNode[];
  unusedStyles: GraphNode[];
  unusedVariables: GraphNode[];
  /** Highest-degree nodes — "risky to change" candidates. */
  mostConnected: Array<{ node: GraphNode; degree: number }>;
}

const COMPONENT_DEF_TYPES = ["COMPONENT_SET", "MAIN_COMPONENT", "VARIANT"] as const;

export function computeComponentUsage(index: GraphIndex, component: GraphNode): ComponentUsage {
  const instances = index.getAllInstancesOf(component.id);
  const frameIds = new Set<string>();
  const pageIds = new Set<string>();

  for (const instance of instances) {
    const frame = index.getContainingFrame(instance.id);
    if (frame) frameIds.add(frame.id);
    if (instance.pageId) pageIds.add(instance.pageId);
  }

  return {
    component,
    instanceCount: instances.length,
    variantCount: index.getVariantsOf(component.id).length,
    frameIds: [...frameIds],
    pageIds: [...pageIds],
    riskScore: instances.length + frameIds.size + pageIds.size * 2,
  };
}

export function computeAnalytics(index: GraphIndex): GraphAnalytics {
  const definitions = index
    .getNodesByType(...COMPONENT_DEF_TYPES)
    // A variant's usage rolls up into its set; count sets and standalone mains.
    .filter((node) => node.type !== "VARIANT" || !node.componentSetId);

  const componentUsage = definitions
    .map((component) => computeComponentUsage(index, component))
    .sort((a, b) => b.instanceCount - a.instanceCount || a.component.name.localeCompare(b.component.name));

  const unusedComponents = componentUsage
    .filter((usage) => usage.instanceCount === 0)
    .map((usage) => usage.component);

  const instances = index.getNodesByType("COMPONENT_INSTANCE");
  const unresolvedInstances = instances.filter((instance) => !instance.mainComponentId);

  const frames = index.getNodesByType("FRAME");
  const framesWithoutComponents = frames.filter(
    (frame) => index.getDescendants(frame.id, { nodeTypes: ["COMPONENT_INSTANCE"], limit: 1 }).length === 0,
  );

  const orphanedFrames = framesWithoutComponents.filter((frame) => {
    const parent = index.getParent(frame.id);
    const isScreen =
      parent?.type === "PAGE" || parent?.type === "SECTION" || parent?.type === "FILE";
    if (!isScreen) return false;
    return index.getEdges(frame.id, { edgeTypes: ["PROTOTYPES_TO"] }).length === 0;
  });

  const unusedStyles = index
    .getNodesByType("STYLE")
    .filter((style) => index.getStyleConsumers(style.id).length === 0);

  const unusedVariables = index
    .getNodesByType("VARIABLE")
    .filter((variable) => index.getVariableConsumers(variable.id).length === 0);

  const mostConnected = index.allNodes
    .map((node) => ({
      node,
      // Derived inverse edges would double-count, so they are excluded.
      degree: index.getEdges(node.id, {
        edgeTypes: [
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
        ],
      }).length,
    }))
    .sort((a, b) => b.degree - a.degree)
    .slice(0, 20);

  return {
    totals: {
      nodes: index.nodeCount,
      edges: index.edgeCount,
      pages: index.getNodesByType("PAGE").length,
      frames: frames.length,
      componentDefinitions: definitions.length,
      instances: instances.length,
      styles: index.getNodesByType("STYLE").length,
      variables: index.getNodesByType("VARIABLE").length,
    },
    componentUsage,
    unusedComponents,
    unresolvedInstances,
    framesWithoutComponents,
    orphanedFrames,
    unusedStyles,
    unusedVariables,
    mostConnected,
  };
}

/** Compact per-node summary, reused by the inspector and the AI payload. */
export function usageSummaryFor(index: GraphIndex, nodeId: string): UsageSummary {
  const node = index.getNode(nodeId);
  if (!node) return {};

  const summary: UsageSummary = {
    directChildrenCount: index.getChildIds(nodeId).length,
    styleCount: node.styleIds?.length ?? 0,
    variableCount: node.variableIds?.length ?? 0,
  };

  if (node.type === "STYLE") summary.instanceCount = index.getStyleConsumers(nodeId).length;
  else if (node.type === "VARIABLE") summary.instanceCount = index.getVariableConsumers(nodeId).length;
  else if (COMPONENT_DEF_TYPES.includes(node.type as (typeof COMPONENT_DEF_TYPES)[number])) {
    const usage = computeComponentUsage(index, node);
    summary.instanceCount = usage.instanceCount;
    summary.dependentFrameCount = usage.frameIds.length;
  } else {
    const nested = index.getNestedInstances(nodeId);
    if (nested.length) summary.instanceCount = nested.length;
  }

  return summary;
}
