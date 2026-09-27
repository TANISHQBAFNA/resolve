import { createHash } from "node:crypto";
import { buildGraph } from "@/core/transform";
import { DesignGraphSchema, type DesignGraph, type GraphNode } from "@/core/model";
import { adaptFigmaMcpMetadata } from "./adapters/figmaMcp";
import type { WorkspaceFileRole } from "@/core/query/workspace";

export interface LearnCatalogItem {
  name?: string;
  key?: string;
  nodeId?: string;
  figmaNodeId?: string;
  fileKey?: string;
  description?: string;
}

export interface LearnCheckpoint {
  fileKey: string;
  role?: WorkspaceFileRole;
  completedHashes: string[];
  lastAt: string;
}

export interface LearnInput {
  fileKey: string;
  role?: WorkspaceFileRole;
  fileName?: string;
  label?: string;
  metadataXml?: string;
  libraries?: unknown;
  designContext?: unknown;
  lastModified?: string;
  version?: string;
  resume?: boolean;
}

export interface LearnGap {
  missing: string;
  hint: string;
}

export interface LearnResult {
  learned: boolean;
  fileKey: string;
  nodes: number;
  added: number;
  resumed: boolean;
  skippedDuplicate: boolean;
  checkpoint?: LearnCheckpoint;
  gaps: LearnGap[];
  hint: string;
}

export function hashLearnPayload(xml: string): string {
  return createHash("sha256").update(xml).digest("hex").slice(0, 16);
}

export function flattenCatalog(raw: unknown): LearnCatalogItem[] {
  if (!raw) return [];
  const out: LearnCatalogItem[] = [];
  const visit = (value: unknown) => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record["key"] === "string" || typeof record["name"] === "string") {
      out.push({
        name: typeof record["name"] === "string" ? record["name"] : undefined,
        key: typeof record["key"] === "string" ? record["key"] : undefined,
        nodeId:
          typeof record["nodeId"] === "string"
            ? record["nodeId"]
            : typeof record["figmaNodeId"] === "string"
              ? record["figmaNodeId"]
              : undefined,
        figmaNodeId: typeof record["figmaNodeId"] === "string" ? record["figmaNodeId"] : undefined,
        fileKey: typeof record["fileKey"] === "string" ? record["fileKey"] : undefined,
        description: typeof record["description"] === "string" ? record["description"] : undefined,
      });
    }
    for (const nested of [
      record["components"],
      record["results"],
      record["libraries"],
      record["items"],
    ]) {
      visit(nested);
    }
  };
  visit(raw);
  return out;
}

export function applyPublishedCatalog(graph: DesignGraph, raw: unknown): { applied: number } {
  const catalog = flattenCatalog(raw);
  let applied = 0;
  for (const item of catalog) {
    if (!item.key) continue;
    const node = graph.nodes.find((candidate) => {
      if (item.nodeId && (candidate.figmaNodeId === item.nodeId || candidate.id.endsWith(item.nodeId))) {
        return true;
      }
      if (item.figmaNodeId && candidate.figmaNodeId === item.figmaNodeId) return true;
      if (item.name && candidate.name === item.name) return true;
      return false;
    });
    if (!node) continue;
    node.metadata = { ...node.metadata, key: item.key };
    applied += 1;
  }
  return { applied };
}

function nodeMergeKey(node: GraphNode): string {
  return node.figmaNodeId ? `${node.type}:${node.figmaNodeId}` : node.id;
}

export function mergeDesignGraphs(base: DesignGraph, incoming: DesignGraph): DesignGraph {
  const nodes = new Map<string, GraphNode>();
  for (const node of base.nodes) nodes.set(nodeMergeKey(node), node);
  for (const node of incoming.nodes) {
    const key = nodeMergeKey(node);
    const prev = nodes.get(key);
    nodes.set(key, prev ? { ...prev, ...node, metadata: { ...prev.metadata, ...node.metadata } } : node);
  }
  const edges = new Map<string, DesignGraph["edges"][number]>();
  for (const edge of [...base.edges, ...incoming.edges]) {
    edges.set(edge.id || `${edge.type}|${edge.source}|${edge.target}`, edge);
  }
  const warnings = [...base.warnings];
  for (const warning of incoming.warnings) {
    if (!warnings.some((row) => row.code === warning.code && row.message === warning.message)) {
      warnings.push(warning);
    }
  }
  return DesignGraphSchema.parse({
    fileKey: incoming.fileKey || base.fileKey,
    fileName: incoming.fileName || base.fileName,
    builtAt: incoming.builtAt || new Date().toISOString(),
    source: {
      kind: incoming.source.kind,
      ingestedAt: incoming.source.ingestedAt,
      version: incoming.source.version ?? base.source.version,
      lastModified: incoming.source.lastModified ?? base.source.lastModified,
    },
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    warnings,
  });
}

export function graphFromMetadataXml(input: {
  fileKey: string;
  fileName?: string;
  metadataXml: string;
  lastModified?: string;
  version?: string;
}): DesignGraph {
  const graph = buildGraph(
    adaptFigmaMcpMetadata({
      fileKey: input.fileKey,
      fileName: input.fileName ?? "Untitled",
      metadataXml: input.metadataXml,
    }),
  );
  return {
    ...graph,
    source: {
      ...graph.source,
      version: input.version ?? graph.source.version,
      lastModified: input.lastModified ?? graph.source.lastModified,
    },
  };
}

export function learnGaps(graph: DesignGraph, hadCatalog: boolean): LearnGap[] {
  const masters = graph.nodes.filter(
    (node) => node.type === "MAIN_COMPONENT" || node.type === "COMPONENT_SET" || node.type === "VARIANT",
  );
  const withKey = masters.filter((node) => typeof node.metadata?.["key"] === "string");
  if (withKey.length === masters.length) return [];
  if (hadCatalog && withKey.length > 0) return [];
  if (hadCatalog) {
    return [
      {
        missing: "componentKey",
        hint: "Some masters still have no published key. Call Figma MCP search_design_system or get_libraries and pass the result as libraries.",
      },
    ];
  }
  return [
    {
      missing: "componentKey",
      hint: "get_metadata has no published component key. Call Figma MCP search_design_system or get_libraries and pass that payload as libraries so use_figma can importComponentByKeyAsync. Until then the master is local-only.",
    },
  ];
}

export const LEARN_EMPTY_HINT =
  "No library in SOCK. Call learn_library with Figma MCP get_metadata XML + fileKey + role=library.";
