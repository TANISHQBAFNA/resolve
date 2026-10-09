import { z } from "zod";

/**
 * The ingestion contract.
 *
 * Every source (Figma REST, Figma plugin, Figma MCP, an exported JSON blob, a
 * mock fixture) is normalised into a `SourceDocument` *before* the graph
 * transform runs. The transform and everything above it therefore never sees a
 * vendor payload shape.
 *
 * A `SourceDocument` is still a tree — it is "Figma-ish but stable". Turning
 * the tree into nodes + edges is the job of `core/transform`.
 */

export const SourceBoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

export const SourceTransitionSchema = z.object({
  destinationId: z.string(),
  trigger: z.string().optional(),
  action: z.string().optional(),
  durationMs: z.number().optional(),
  easing: z.string().optional(),
  preserveScroll: z.boolean().optional(),
});
export type SourceTransition = z.infer<typeof SourceTransitionSchema>;

export const SourceLinkSchema = z.object({
  /** Raw href. May be an external URL or a figma.com deep link. */
  url: z.string(),
  label: z.string().optional(),
  /** Populated when the link points at a node inside this file. */
  targetFigmaNodeId: z.string().optional(),
  /** File key parsed from a figma.com URL. An internal edge needs this to match the ingested file. */
  targetFileKey: z.string().optional(),
});
export type SourceLink = z.infer<typeof SourceLinkSchema>;

export const SourceAnnotationSchema = z.object({
  id: z.string().optional(),
  label: z.string(),
  properties: z.record(z.string()).optional(),
});
export type SourceAnnotation = z.infer<typeof SourceAnnotationSchema>;

/**
 * The raw Figma node `type` string, kept as a plain string on purpose: Figma
 * adds node types over time and an unknown type must degrade to `LAYER`
 * instead of failing ingestion.
 */
export const SourceNodeSchema: z.ZodType<SourceNode> = z.lazy(() =>
  z.object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    visible: z.boolean().optional(),
    description: z.string().optional(),
    children: z.array(SourceNodeSchema).optional(),

    /** INSTANCE -> main component node id (may live in another file). */
    componentId: z.string().optional(),
    /** COMPONENT -> owning COMPONENT_SET node id. */
    componentSetId: z.string().optional(),
    variantProperties: z.record(z.string()).optional(),
    componentProperties: z.record(z.unknown()).optional(),
    overrides: z
      .array(
        z.object({
          id: z.string().optional(),
          overriddenFields: z.array(z.string()).optional(),
        }),
      )
      .optional(),

    bounds: SourceBoundsSchema.optional(),
    /** "NONE" | "HORIZONTAL" | "VERTICAL" | "GRID" */
    layoutMode: z.string().optional(),
    /** TEXT node characters, when the source sent them. */
    characters: z.string().optional(),
    layoutSizingHorizontal: z.string().optional(),
    layoutSizingVertical: z.string().optional(),
    primaryAxisSizingMode: z.string().optional(),
    counterAxisSizingMode: z.string().optional(),
    minHeight: z.number().optional(),
    minWidth: z.number().optional(),
    hasImageFill: z.boolean().optional(),

    /** style slot ("fill" | "text" | "effect" | "grid" | "stroke") -> style id */
    styleIds: z.record(z.string()).optional(),
    /** property name -> variable id */
    variableIds: z.record(z.string()).optional(),

    transitions: z.array(SourceTransitionSchema).optional(),
    links: z.array(SourceLinkSchema).optional(),
    annotations: z.array(SourceAnnotationSchema).optional(),

    /** Anything a source wants to keep without inventing a first-class field. */
    raw: z.record(z.unknown()).optional(),
  }),
);

export interface SourceNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  description?: string;
  children?: SourceNode[];
  componentId?: string;
  componentSetId?: string;
  variantProperties?: Record<string, string>;
  componentProperties?: Record<string, unknown>;
  overrides?: Array<{ id?: string; overriddenFields?: string[] }>;
  bounds?: z.infer<typeof SourceBoundsSchema>;
  layoutMode?: string;
  characters?: string;
  layoutSizingHorizontal?: string;
  layoutSizingVertical?: string;
  primaryAxisSizingMode?: string;
  counterAxisSizingMode?: string;
  minHeight?: number;
  minWidth?: number;
  hasImageFill?: boolean;
  styleIds?: Record<string, string>;
  variableIds?: Record<string, string>;
  transitions?: SourceTransition[];
  links?: SourceLink[];
  annotations?: SourceAnnotation[];
  raw?: Record<string, unknown>;
}

export const SourceComponentMetaSchema = z.object({
  /** Node id inside this file, or a synthetic id for a remote component. */
  id: z.string(),
  key: z.string().optional(),
  name: z.string(),
  description: z.string().optional(),
  componentSetId: z.string().optional(),
  remote: z.boolean().optional(),
  libraryId: z.string().optional(),
  documentationLinks: z.array(SourceLinkSchema).optional(),
  /**
   * How this component's identity was established. `"id"` (the default) means
   * the source gave us a real `componentId`. `"inferred-from-name"` means only
   * the instance layer name was available — a label, never a confirmed master.
   */
  identity: z.enum(["id", "inferred-from-name"]).optional(),
  /** Published-library file this remote actually lives in (REST lookup). */
  sourceFileKey: z.string().optional(),
  sourceFileName: z.string().optional(),
  sourcePageName: z.string().optional(),
});
export type SourceComponentMeta = z.infer<typeof SourceComponentMetaSchema>;

export const SourceStyleSchema = z.object({
  id: z.string(),
  key: z.string().optional(),
  name: z.string(),
  /** "FILL" | "TEXT" | "EFFECT" | "GRID" | "STROKE" */
  styleType: z.string(),
  description: z.string().optional(),
  remote: z.boolean().optional(),
  libraryId: z.string().optional(),
});
export type SourceStyle = z.infer<typeof SourceStyleSchema>;

export const SourceVariableCollectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  modes: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
  remote: z.boolean().optional(),
  libraryId: z.string().optional(),
});
export type SourceVariableCollection = z.infer<typeof SourceVariableCollectionSchema>;

export const SourceVariableSchema = z.object({
  id: z.string(),
  key: z.string().optional(),
  name: z.string(),
  collectionId: z.string(),
  /** "COLOR" | "FLOAT" | "STRING" | "BOOLEAN" */
  resolvedType: z.string(),
  description: z.string().optional(),
  remote: z.boolean().optional(),
  libraryId: z.string().optional(),
  /** Variable ids this variable aliases (semantic -> primitive). */
  aliasOf: z.array(z.string()).optional(),
  valuesByMode: z.record(z.unknown()).optional(),
});
export type SourceVariable = z.infer<typeof SourceVariableSchema>;

export const SourceLibrarySchema = z.object({
  id: z.string(),
  name: z.string(),
  fileKey: z.string().optional(),
});
export type SourceLibrary = z.infer<typeof SourceLibrarySchema>;

export const SourceKindSchema = z.enum([
  "figma-rest",
  "figma-plugin",
  "figma-mcp",
  "json",
  "mock",
]);
export type SourceKind = z.infer<typeof SourceKindSchema>;

export const SourceDocumentSchema = z.object({
  fileKey: z.string(),
  fileName: z.string(),
  /** DOCUMENT-level root. Its children are pages. */
  root: SourceNodeSchema,
  components: z.record(SourceComponentMetaSchema).default({}),
  componentSets: z.record(SourceComponentMetaSchema).default({}),
  styles: z.record(SourceStyleSchema).default({}),
  variables: z.record(SourceVariableSchema).default({}),
  variableCollections: z.record(SourceVariableCollectionSchema).default({}),
  libraries: z.record(SourceLibrarySchema).default({}),
  source: z.object({
    kind: SourceKindSchema,
    ingestedAt: z.string(),
    version: z.string().optional(),
    lastModified: z.string().optional(),
    /** True when the source deliberately stopped walking (depth/size cap). */
    truncated: z.boolean().optional(),
    /**
     * Remote component source lookup (GET /v1/components/:key).
     * `skipped` = nothing to look up. `failed` = 403/404/network, stubs stay unknown.
     */
    remoteSourceLookup: z.enum(["ok", "failed", "partial", "skipped"]).optional(),
  }),
});
export type SourceDocument = z.infer<typeof SourceDocumentSchema>;

/**
 * Anything that can produce a `SourceDocument`. Phase 3 adds
 * `FigmaRestIngestionSource` and `FigmaMcpIngestionSource` behind this same
 * interface; nothing above the ingestion layer changes.
 */
export interface IngestionSource {
  readonly id: string;
  readonly label: string;
  readonly kind: SourceKind;
  load(signal?: AbortSignal): Promise<SourceDocument>;
}
