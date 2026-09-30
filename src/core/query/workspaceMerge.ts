import {
  COMPONENT_DEFINITION_TYPES,
  edgeId,
  type DesignGraph,
  type GraphEdge,
  type GraphNode,
} from "@/core/model";
import { UNKNOWN_LIBRARY_ID } from "@/core/ingestion";
import { settleInstanceBindings } from "@/core/ingestion/designContextIds";
import { libraryFiles, type WorkspaceFileRole, type WorkspaceManifest } from "./workspace";

const MASTER_TYPES = new Set<string>(COMPONENT_DEFINITION_TYPES);

export function nodeFileKey(node: GraphNode, fallback?: string): string | undefined {
  if (node.fileKey) return node.fileKey;
  const meta = node.metadata?.["fileKey"];
  if (typeof meta === "string" && meta.trim()) return meta.trim();
  return fallback;
}

export function stampFileKey(graph: DesignGraph): DesignGraph {
  const nodes = graph.nodes.map((node) =>
    node.fileKey ? node : { ...node, fileKey: graph.fileKey },
  );
  return { ...graph, nodes };
}

function rewriteId(id: string, fileKey: string): string {
  if (id.startsWith("file:")) return id;
  const colon = id.indexOf(":");
  if (colon < 0) return `${fileKey}:${id}`;
  const ns = id.slice(0, colon);
  const rest = id.slice(colon + 1);
  if (rest === fileKey || rest.startsWith(`${fileKey}:`)) return id;
  return `${ns}:${fileKey}:${rest}`;
}

function rewriteNode(node: GraphNode, fileKey: string): GraphNode {
  const next: GraphNode = {
    ...node,
    id: node.type === "FILE" ? node.id : rewriteId(node.id, fileKey),
    fileKey: node.fileKey ?? fileKey,
  };
  if (node.parentId) next.parentId = rewriteId(node.parentId, fileKey);
  if (node.pageId) next.pageId = rewriteId(node.pageId, fileKey);
  if (node.sectionId) next.sectionId = rewriteId(node.sectionId, fileKey);
  if (node.mainComponentId) next.mainComponentId = rewriteId(node.mainComponentId, fileKey);
  if (node.componentSetId) next.componentSetId = rewriteId(node.componentSetId, fileKey);
  if (node.libraryId) next.libraryId = rewriteId(node.libraryId, fileKey);
  if (node.styleIds?.length) next.styleIds = node.styleIds.map((id) => rewriteId(id, fileKey));
  if (node.variableIds?.length) next.variableIds = node.variableIds.map((id) => rewriteId(id, fileKey));
  return next;
}

function rewriteEdge(edge: GraphEdge, fileKey: string): GraphEdge {
  const source = rewriteId(edge.source, fileKey);
  const target = rewriteId(edge.target, fileKey);
  return {
    ...edge,
    id: edgeId(edge.type, source, target),
    source,
    target,
  };
}

export function namespaceGraph(graph: DesignGraph): DesignGraph {
  const fileKey = graph.fileKey;
  return {
    ...graph,
    nodes: graph.nodes.map((node) => rewriteNode(node, fileKey)),
    edges: graph.edges.map((edge) => rewriteEdge(edge, fileKey)),
    warnings: graph.warnings.map((warning) =>
      warning.nodeId
        ? { ...warning, nodeId: warning.nodeId.startsWith("file:") ? warning.nodeId : rewriteId(warning.nodeId, fileKey) }
        : warning,
    ),
  };
}

function componentKeyOf(node: GraphNode): string | undefined {
  const key = node.metadata?.["key"];
  return typeof key === "string" && key.trim() ? key.trim() : undefined;
}

function uniqueBy<K>(entries: Array<{ key: K; node: GraphNode }>): Map<K, GraphNode> {
  const counts = new Map<K, number>();
  for (const entry of entries) counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1);
  const out = new Map<K, GraphNode>();
  for (const entry of entries) {
    if ((counts.get(entry.key) ?? 0) !== 1) continue;
    out.set(entry.key, entry.node);
  }
  return out;
}

function libraryFileNode(nodes: GraphNode[], key: string): GraphNode | undefined {
  const needle = key.toLowerCase();
  return nodes.find(
    (node) =>
      node.type === "FILE" &&
      (node.fileKey?.toLowerCase() === needle || node.id.toLowerCase() === `file:${needle}`),
  );
}

/**
 * Point remote stubs at an ingested library FILE (and at the real master
 * when figmaNodeId or component key matches exactly). Refuse-over-guess:
 * no fuzzy master merge.
 */
export function relinkRemoteLibraries(graph: DesignGraph, workspace: WorkspaceManifest): DesignGraph {
  const libraries = libraryFiles(workspace);
  if (!libraries.length) return graph;

  const nodes = graph.nodes.map((node) => ({ ...node }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const libraryKeys = new Set(libraries.map((file) => file.key.toLowerCase()));

  const libraryMasters = nodes.filter(
    (node) =>
      MASTER_TYPES.has(node.type) &&
      node.fileKey &&
      libraryKeys.has(node.fileKey.toLowerCase()) &&
      !node.isRemote,
  );
  const byFigma = uniqueBy(
    libraryMasters
      .filter((node) => node.figmaNodeId)
      .map((node) => ({ key: node.figmaNodeId!, node })),
  );
  const byKey = uniqueBy(
    libraryMasters
      .filter((node) => componentKeyOf(node))
      .map((node) => ({ key: componentKeyOf(node)!, node })),
  );

  const soleLibrary = libraries.length === 1 ? libraryFileNode(nodes, libraries[0]!.key) : undefined;

  const rewriteMain = new Map<string, string>();
  const extraEdges: GraphEdge[] = [];
  const dropLibraryIds = new Set<string>();

  for (const stub of nodes) {
    if (!MASTER_TYPES.has(stub.type) || !stub.isRemote) continue;
    if (stub.fileKey && libraryKeys.has(stub.fileKey.toLowerCase())) continue;

    const exact =
      (stub.figmaNodeId ? byFigma.get(stub.figmaNodeId) : undefined) ??
      (componentKeyOf(stub) ? byKey.get(componentKeyOf(stub)!) : undefined);

    const libMeta = typeof stub.metadata?.["fileKey"] === "string" ? stub.metadata["fileKey"] : undefined;
    const pointed = stub.libraryId ? byId.get(stub.libraryId) : undefined;
    const pointedKey =
      (typeof pointed?.metadata?.["fileKey"] === "string" ? pointed.metadata["fileKey"] : undefined) ??
      pointed?.fileKey;
    const fileMatch = [...libraries].find((file) => {
      const key = file.key.toLowerCase();
      return (
        (typeof libMeta === "string" && libMeta.toLowerCase() === key) ||
        (typeof pointedKey === "string" && pointedKey.toLowerCase() === key)
      );
    });
    const libraryNode = exact
      ? libraryFileNode(nodes, exact.fileKey ?? "")
      : fileMatch
        ? libraryFileNode(nodes, fileMatch.key)
        : soleLibrary;

    if (exact) {
      rewriteMain.set(stub.id, exact.id);
    }

    if (libraryNode) {
      if (stub.libraryId && stub.libraryId !== libraryNode.id) dropLibraryIds.add(stub.libraryId);
      stub.libraryId = libraryNode.id;
      extraEdges.push({
        id: edgeId("SOURCED_FROM_LIBRARY", stub.id, libraryNode.id),
        source: stub.id,
        target: libraryNode.id,
        type: "SOURCED_FROM_LIBRARY",
        label: "from library",
      });
    }
  }

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const pushEdge = (edge: GraphEdge) => {
    if (seen.has(edge.id)) return;
    seen.add(edge.id);
    edges.push(edge);
  };

  for (const edge of graph.edges) {
    if (edge.type === "SOURCED_FROM_LIBRARY" && dropLibraryIds.has(edge.target)) continue;
    if ((edge.type === "INSTANCE_OF" || edge.type === "USED_IN") && rewriteMain.size) {
      const mappedSource = rewriteMain.get(edge.source);
      const mappedTarget = rewriteMain.get(edge.target);
      if (edge.type === "INSTANCE_OF" && mappedTarget) {
        const next = { ...edge, target: mappedTarget, id: edgeId(edge.type, edge.source, mappedTarget) };
        pushEdge(next);
        continue;
      }
      if (edge.type === "USED_IN" && mappedSource) {
        const next = { ...edge, source: mappedSource, id: edgeId(edge.type, mappedSource, edge.target) };
        pushEdge(next);
        continue;
      }
    }
    pushEdge(edge);
  }
  for (const edge of extraEdges) pushEdge(edge);

  for (const node of nodes) {
    if (node.mainComponentId && rewriteMain.has(node.mainComponentId)) {
      node.mainComponentId = rewriteMain.get(node.mainComponentId);
    }
  }

  const usedLibrary = new Set(
    edges.filter((edge) => edge.type === "SOURCED_FROM_LIBRARY").map((edge) => edge.target),
  );
  const kept = nodes.filter((node) => {
    if (node.type !== "EXTERNAL_LIBRARY") return true;
    if (usedLibrary.has(node.id)) return true;
    const unknown =
      node.id.endsWith(`:${UNKNOWN_LIBRARY_ID}`) ||
      node.id === `lib:${UNKNOWN_LIBRARY_ID}` ||
      node.name.toLowerCase().includes("source unknown");
    return !unknown;
  });

  return settleInstanceBindings({ ...graph, nodes: kept, edges });
}

export interface WorkspaceGraphInput {
  graph: DesignGraph;
  role: WorkspaceFileRole;
}

/**
 * Combine ingested files into one queryable workspace graph.
 * Node ids are namespaced by file key when more than one file is present.
 */
export function mergeWorkspaceGraphs(
  inputs: WorkspaceGraphInput[],
  workspace: WorkspaceManifest,
): DesignGraph {
  const stamped = inputs.map((input) => ({
    ...input,
    graph: stampFileKey(input.graph),
  }));
  if (stamped.length === 0) {
    return {
      fileKey: "",
      fileName: "Resolve workspace",
      builtAt: new Date(0).toISOString(),
      source: { kind: "json", ingestedAt: new Date(0).toISOString() },
      nodes: [],
      edges: [],
      warnings: [],
    };
  }
  if (stamped.length === 1) {
    return relinkRemoteLibraries(stamped[0]!.graph, workspace);
  }

  const namespaced = stamped.map((input) => namespaceGraph(input.graph));
  const library = namespaced.find((graph) =>
    libraryFiles(workspace).some((file) => file.key === graph.fileKey),
  );
  const primary = library ?? namespaced[0]!;
  const merged: DesignGraph = {
    fileKey: primary.fileKey,
    fileName: workspace.files.length
      ? `Resolve workspace (${workspace.files.map((file) => file.label || file.key).join(", ")})`
      : primary.fileName,
    builtAt: namespaced.map((graph) => graph.builtAt).sort().at(-1) ?? primary.builtAt,
    source: primary.source,
    nodes: namespaced.flatMap((graph) => graph.nodes),
    edges: namespaced.flatMap((graph) => graph.edges),
    warnings: namespaced.flatMap((graph) => graph.warnings),
  };

  const seenNodes = new Set<string>();
  merged.nodes = merged.nodes.filter((node) => {
    if (seenNodes.has(node.id)) return false;
    seenNodes.add(node.id);
    return true;
  });
  const seenEdges = new Set<string>();
  merged.edges = merged.edges.filter((edge) => {
    if (seenEdges.has(edge.id)) return false;
    seenEdges.add(edge.id);
    return true;
  });

  return relinkRemoteLibraries(merged, workspace);
}
