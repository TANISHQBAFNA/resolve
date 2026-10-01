import { z } from "zod";
import { NodeTypeSchema, type NodeType } from "./nodeTypes";
import { EdgeTypeSchema, type EdgeType } from "./edgeTypes";

export const BoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
export type Bounds = z.infer<typeof BoundsSchema>;

export const GraphNodeSchema = z.object({
  /** Internal, namespaced id — unique across node ids, style ids, variable ids. */
  id: z.string().min(1),
  /** Raw Figma id (`1:23`, style key, variable id) when the entity came from Figma. */
  figmaNodeId: z.string().optional(),
  /** Figma file key. Required on cards once more than one file is in the workspace — node ids collide across files. */
  fileKey: z.string().optional(),
  type: NodeTypeSchema,
  name: z.string(),
  description: z.string().optional(),

  parentId: z.string().optional(),
  pageId: z.string().optional(),
  sectionId: z.string().optional(),

  isMainComponent: z.boolean().optional(),
  isInstance: z.boolean().optional(),
  /** True when the entity lives in another (library) file. */
  isRemote: z.boolean().optional(),
  /** Set on instances. Points at a MAIN_COMPONENT/VARIANT node id when resolved. */
  mainComponentId: z.string().optional(),
  componentSetId: z.string().optional(),
  variantProperties: z.record(z.string()).optional(),

  styleIds: z.array(z.string()).optional(),
  variableIds: z.array(z.string()).optional(),
  libraryId: z.string().optional(),

  bounds: BoundsSchema.optional(),
  thumbnailUrl: z.string().optional(),
  figmaUrl: z.string().optional(),

  /** Design-system lifecycle. Absent = unknown, not "approved". */
  status: z.enum(["draft", "approved", "deprecated", "experimental"]).optional(),
  owner: z.string().optional(),
  platforms: z.array(z.string()).optional(),

  metadata: z.record(z.unknown()).optional(),
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GraphEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  type: EdgeTypeSchema,
  label: z.string().optional(),
  /** Omit = EXTRACTED. INFERRED only when the transform could not read the link from the source. */
  confidence: z.enum(["EXTRACTED", "INFERRED", "AMBIGUOUS"]).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

export const GraphWarningSchema = z.object({
  code: z.enum([
    "UNRESOLVED_MAIN_COMPONENT",
    "UNRESOLVED_STYLE",
    "UNRESOLVED_VARIABLE",
    "UNRESOLVED_PROTOTYPE_TARGET",
    "UNRESOLVED_LINK_TARGET",
    "INFERRED_COMPONENT_IDENTITY",
    "DUPLICATE_NODE_ID",
    "SOURCE_TRUNCATED",
  ]),
  message: z.string(),
  nodeId: z.string().optional(),
  detail: z.record(z.unknown()).optional(),
});
export type GraphWarning = z.infer<typeof GraphWarningSchema>;

export const DesignGraphSchema = z.object({
  fileKey: z.string(),
  fileName: z.string(),
  /** ISO timestamp of when the graph was built. */
  builtAt: z.string(),
  source: z.object({
    kind: z.enum(["figma-rest", "figma-plugin", "figma-mcp", "json", "mock"]),
    ingestedAt: z.string(),
    version: z.string().optional(),
    lastModified: z.string().optional(),
    /** Remote-stub source lookup. `failed` = 403/404/network; matching by the other file may not work. */
    remoteSourceLookup: z.enum(["ok", "failed", "skipped"]).optional(),
  }),
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
  warnings: z.array(GraphWarningSchema),
});
export type DesignGraph = z.infer<typeof DesignGraphSchema>;

/* ------------------------------------------------------------------ *
 * Id namespacing
 *
 * A Figma node id (`1:23`), a style id (`S:1234,5`) and a variable id
 * (`VariableID:1:2`) live in different id spaces and can collide. Every graph
 * node therefore gets a namespaced internal id, and `figmaNodeId` keeps the
 * original value for deep links and round-tripping.
 * ------------------------------------------------------------------ */

export const ID_NAMESPACES = {
  file: "file",
  node: "node",
  style: "style",
  variable: "var",
  collection: "varset",
  library: "lib",
  annotation: "note",
  interaction: "proto",
} as const;

export type IdNamespace = (typeof ID_NAMESPACES)[keyof typeof ID_NAMESPACES];

export function makeId(namespace: IdNamespace, rawId: string): string {
  return `${namespace}:${rawId}`;
}

export function nodeId(rawFigmaNodeId: string): string {
  return makeId(ID_NAMESPACES.node, rawFigmaNodeId);
}
export function styleId(rawStyleId: string): string {
  return makeId(ID_NAMESPACES.style, rawStyleId);
}
export function variableId(rawVariableId: string): string {
  return makeId(ID_NAMESPACES.variable, rawVariableId);
}
export function collectionId(rawCollectionId: string): string {
  return makeId(ID_NAMESPACES.collection, rawCollectionId);
}
export function libraryId(rawLibraryId: string): string {
  return makeId(ID_NAMESPACES.library, rawLibraryId);
}
export function fileId(rawFileKey: string): string {
  return makeId(ID_NAMESPACES.file, rawFileKey);
}

export function edgeId(type: EdgeType, source: string, target: string): string {
  return `${type}|${source}|${target}`;
}

export function isNodeType(node: GraphNode, ...types: NodeType[]): boolean {
  return types.includes(node.type);
}

export const emptyGraph = (fileKey = "", fileName = ""): DesignGraph => ({
  fileKey,
  fileName,
  builtAt: new Date(0).toISOString(),
  source: { kind: "json", ingestedAt: new Date(0).toISOString() },
  nodes: [],
  edges: [],
  warnings: [],
});
