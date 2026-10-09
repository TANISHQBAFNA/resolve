import {
  collectionId as makeCollectionId,
  edgeId as makeEdgeId,
  fileId as makeFileId,
  libraryId as makeLibraryId,
  nodeId as makeNodeId,
  styleId as makeStyleId,
  variableId as makeVariableId,
  type DesignGraph,
  type EdgeType,
  type GraphEdge,
  type GraphNode,
  type GraphWarning,
  type NodeType,
  applyGovernance,
  inheritGovernance,
  makeId,
} from "@/core/model";
import type {
  SourceComponentMeta,
  SourceDocument,
  SourceLink,
  SourceNode,
  SourceTransition,
} from "@/core/ingestion/types";
import { classifySourceNode, styleKindFromSlot } from "./classify";
import { figmaFileUrl, figmaNodeUrl } from "./figmaUrl";
import { settleInstanceBindings } from "@/core/ingestion/designContextIds";

export interface BuildGraphOptions {
  /** See `ClassifyOptions.classifyAutoLayout`. */
  classifyAutoLayout?: boolean;
  /** Drop layers Figma reports as hidden. Default: keep them, flagged. */
  skipInvisible?: boolean;
  /** Safety valve for pathological files. Default 50_000. */
  maxNodes?: number;
  /** Injectable for deterministic tests. */
  builtAt?: string;
}

interface WalkContext {
  parentGraphId: string;
  parentGraphType: NodeType;
  parentSourceType: string;
  pageId?: string;
  sectionId?: string;
  /** Nearest enclosing COMPONENT_SET / MAIN_COMPONENT / VARIANT. */
  componentDefId?: string;
  /** Nearest enclosing top-level frame (a "screen"). */
  screenFrameId?: string;
}

interface PendingInstance {
  instanceGraphId: string;
  componentFigmaId: string;
}
interface PendingStyleRef {
  consumerGraphId: string;
  slot: string;
  styleFigmaId: string;
}
interface PendingVariableRef {
  consumerGraphId: string;
  property: string;
  variableFigmaId: string;
}
interface PendingTransition {
  sourceGraphId: string;
  transition: SourceTransition;
}
interface PendingLink {
  sourceGraphId: string;
  link: SourceLink;
}

const COMPONENT_DEF_TYPES: readonly NodeType[] = ["COMPONENT_SET", "MAIN_COMPONENT", "VARIANT"];

function remoteSourceFields(meta: SourceComponentMeta): Record<string, unknown> {
  return {
    ...(meta.sourceFileKey ? { sourceFileKey: meta.sourceFileKey } : {}),
    ...(meta.sourceFileName ? { sourceFileName: meta.sourceFileName } : {}),
    ...(meta.sourcePageName ? { sourcePageName: meta.sourcePageName } : {}),
  };
}

function applyRemoteSource(node: GraphNode, meta: SourceComponentMeta): void {
  const source = remoteSourceFields(meta);
  if (Object.keys(source).length) {
    node.metadata = { ...node.metadata, ...source };
  }
  if (meta.sourceFileKey && (meta.remote || node.isRemote)) {
    node.fileKey = meta.sourceFileKey;
  }
}

class GraphBuilder {
  readonly nodes = new Map<string, GraphNode>();
  readonly edges = new Map<string, GraphEdge>();
  readonly warnings: GraphWarning[] = [];
  private readonly warningKeys = new Set<string>();
  truncated = false;

  constructor(private readonly maxNodes: number) {}

  addNode(node: GraphNode): GraphNode | undefined {
    if (this.nodes.has(node.id)) {
      this.warn({
        code: "DUPLICATE_NODE_ID",
        message: `Two source entities resolved to the same graph id (${node.id}). The first one wins.`,
        nodeId: node.id,
      });
      return this.nodes.get(node.id);
    }
    if (this.nodes.size >= this.maxNodes) {
      if (!this.truncated) {
        this.truncated = true;
        this.warn({
          code: "SOURCE_TRUNCATED",
          message: `Graph hit the ${this.maxNodes} node cap; the rest of the file was skipped.`,
        });
      }
      return undefined;
    }
    this.nodes.set(node.id, node);
    return node;
  }

  addEdge(
    type: EdgeType,
    source: string,
    target: string,
    label?: string,
    metadata?: Record<string, unknown>,
  ): GraphEdge | undefined {
    if (source === target) return undefined;
    if (!this.nodes.has(source) || !this.nodes.has(target)) return undefined;
    const id = makeEdgeId(type, source, target);
    const existing = this.edges.get(id);
    if (existing) return existing;
    const edge: GraphEdge = { id, source, target, type };
    if (label) edge.label = label;
    if (metadata) {
      const { confidence, ...rest } = metadata;
      if (confidence === "EXTRACTED" || confidence === "INFERRED" || confidence === "AMBIGUOUS") {
        edge.confidence = confidence;
      }
      if (Object.keys(rest).length) edge.metadata = rest;
    }
    this.edges.set(id, edge);
    return edge;
  }

  warn(warning: GraphWarning): void {
    const key = `${warning.code}|${warning.nodeId ?? ""}|${warning.message}`;
    if (this.warningKeys.has(key)) return;
    this.warningKeys.add(key);
    this.warnings.push(warning);
  }
}

export function buildGraph(doc: SourceDocument, options: BuildGraphOptions = {}): DesignGraph {
  const { classifyAutoLayout = true, skipInvisible = false, maxNodes = 50_000 } = options;
  const builder = new GraphBuilder(maxNodes);

  const pendingInstances: PendingInstance[] = [];
  const pendingStyles: PendingStyleRef[] = [];
  const pendingVariables: PendingVariableRef[] = [];
  const pendingTransitions: PendingTransition[] = [];
  const pendingLinks: PendingLink[] = [];

  const linkNode = (rawFigmaId: string) => figmaNodeUrl(doc.fileKey, doc.fileName, rawFigmaId);

  const attachRationale = (
    subjectId: string,
    label: string,
    extras: { url?: string; body?: string } = {},
  ): void => {
    const key = extras.url ?? extras.body ?? label;
    const id = makeId("note", `${subjectId}:${key}`.slice(0, 180));
    if (!builder.nodes.has(id)) {
      builder.addNode({
        id,
        type: "ANNOTATION",
        name: label.slice(0, 120),
        description: extras.body,
        metadata: extras.url ? { url: extras.url } : undefined,
      });
    }
    builder.addEdge("GOVERNS", id, subjectId, "governs", { confidence: "EXTRACTED" });
  };

  /* ---------------------------------------------------------------- *
   * 1. File root
   * ---------------------------------------------------------------- */
  const fileGraphId = makeFileId(doc.fileKey);
  builder.addNode({
    id: fileGraphId,
    figmaNodeId: doc.root.id,
    type: "FILE",
    name: doc.fileName,
    figmaUrl: figmaFileUrl(doc.fileKey, doc.fileName),
    metadata: {
      figmaType: doc.root.type,
      fileKey: doc.fileKey,
      sourceKind: doc.source.kind,
      lastModified: doc.source.lastModified,
      version: doc.source.version,
    },
  });

  /* ---------------------------------------------------------------- *
   * 2. Structural walk
   * ---------------------------------------------------------------- */
  const walk = (source: SourceNode, context: WalkContext): void => {
    if (skipInvisible && source.visible === false) return;

    const graphType = classifySourceNode(
      source,
      { parentSourceType: context.parentSourceType, parentGraphType: context.parentGraphType },
      { classifyAutoLayout },
    );

    const id = makeNodeId(source.id);
    const node: GraphNode = {
      id,
      figmaNodeId: source.id,
      type: graphType,
      name: source.name,
      parentId: context.parentGraphId,
      figmaUrl: linkNode(source.id),
    };

    if (source.description) node.description = source.description;

    const pageId = graphType === "PAGE" ? id : context.pageId;
    const sectionId = graphType === "SECTION" ? id : context.sectionId;
    if (pageId) node.pageId = pageId;
    if (sectionId) node.sectionId = sectionId;

    if (source.bounds) node.bounds = source.bounds;

    if (graphType === "COMPONENT_INSTANCE") {
      node.isInstance = true;
      if (source.componentId) {
        pendingInstances.push({ instanceGraphId: id, componentFigmaId: source.componentId });
      } else {
        builder.warn({
          code: "UNRESOLVED_MAIN_COMPONENT",
          message: `Instance "${source.name}" does not reference a main component.`,
          nodeId: id,
        });
      }
    }

    if (graphType === "MAIN_COMPONENT" || graphType === "VARIANT") {
      node.isMainComponent = true;
    }

    if (graphType === "VARIANT") {
      const setId = source.componentSetId ?? doc.components[source.id]?.componentSetId;
      node.componentSetId = setId ? makeNodeId(setId) : context.parentGraphId;
      if (source.variantProperties) node.variantProperties = source.variantProperties;
    }

    const metadata: Record<string, unknown> = { figmaType: source.type };
    if (source.layoutMode) metadata["layoutMode"] = source.layoutMode;
    if (source.characters) metadata["text"] = source.characters;
    if (source.layoutSizingHorizontal) metadata["layoutSizingHorizontal"] = source.layoutSizingHorizontal;
    if (source.layoutSizingVertical) metadata["layoutSizingVertical"] = source.layoutSizingVertical;
    if (source.primaryAxisSizingMode) metadata["primaryAxisSizingMode"] = source.primaryAxisSizingMode;
    if (source.counterAxisSizingMode) metadata["counterAxisSizingMode"] = source.counterAxisSizingMode;
    if (source.minHeight !== undefined) metadata["minHeight"] = source.minHeight;
    if (source.minWidth !== undefined) metadata["minWidth"] = source.minWidth;
    if (source.visible === false) metadata["hidden"] = true;
    if (source.children?.length) metadata["sourceChildCount"] = source.children.length;
    if (source.componentProperties) metadata["componentProperties"] = source.componentProperties;
    if (source.overrides?.length) metadata["overrides"] = source.overrides;
    if (source.annotations?.length) metadata["annotations"] = source.annotations;
    node.metadata = metadata;

    const added = builder.addNode(node);
    if (!added) return;

    builder.addEdge("CONTAINS", context.parentGraphId, id);

    for (const annotation of source.annotations ?? []) {
      attachRationale(id, annotation.label, { body: annotation.label });
    }

    if (graphType === "VARIANT" && context.parentGraphType === "COMPONENT_SET") {
      builder.addEdge("VARIANT_OF", id, context.parentGraphId, "variant of");
    }

    if (graphType === "COMPONENT_INSTANCE") {
      if (context.componentDefId) {
        builder.addEdge("NESTS", context.componentDefId, id, "nests");
      }
      if (context.screenFrameId) {
        builder.addEdge("NESTS", context.screenFrameId, id, "nests");
      }
    }

    for (const [slot, styleFigmaId] of Object.entries(source.styleIds ?? {})) {
      pendingStyles.push({ consumerGraphId: id, slot, styleFigmaId });
    }
    for (const [property, variableFigmaId] of Object.entries(source.variableIds ?? {})) {
      pendingVariables.push({ consumerGraphId: id, property, variableFigmaId });
    }
    for (const transition of source.transitions ?? []) {
      pendingTransitions.push({ sourceGraphId: id, transition });
    }
    for (const link of source.links ?? []) {
      pendingLinks.push({ sourceGraphId: id, link });
    }

    // Anchors the `NESTS` edges that answer "what is on this screen". Must
    // include `FILE`, or a page-less subtree source produces no NESTS at all.
    const isScreenFrame =
      graphType === "FRAME" &&
      (context.parentGraphType === "PAGE" ||
        context.parentGraphType === "SECTION" ||
        context.parentGraphType === "FILE");

    const childContext: WalkContext = {
      parentGraphId: id,
      parentGraphType: graphType,
      parentSourceType: source.type,
    };
    if (pageId) childContext.pageId = pageId;
    if (sectionId) childContext.sectionId = sectionId;
    const componentDefId = COMPONENT_DEF_TYPES.includes(graphType) ? id : context.componentDefId;
    if (componentDefId) childContext.componentDefId = componentDefId;
    const screenFrameId = isScreenFrame ? id : context.screenFrameId;
    if (screenFrameId) childContext.screenFrameId = screenFrameId;

    for (const child of source.children ?? []) {
      walk(child, childContext);
    }
  };

  for (const page of doc.root.children ?? []) {
    walk(page, {
      parentGraphId: fileGraphId,
      parentGraphType: "FILE",
      parentSourceType: doc.root.type,
    });
  }

  /* ---------------------------------------------------------------- *
   * 3. Foundations: libraries, styles, collections, variables
   * ---------------------------------------------------------------- */
  for (const library of Object.values(doc.libraries)) {
    builder.addNode({
      id: makeLibraryId(library.id),
      type: "EXTERNAL_LIBRARY",
      name: library.name,
      isRemote: true,
      metadata: { fileKey: library.fileKey },
    });
  }

  const linkToLibrary = (graphId: string, rawLibraryId?: string): string | undefined => {
    if (!rawLibraryId) return undefined;
    const libGraphId = makeLibraryId(rawLibraryId);
    if (!builder.nodes.has(libGraphId)) return undefined;
    builder.addEdge("SOURCED_FROM_LIBRARY", graphId, libGraphId, "from library");
    return libGraphId;
  };

  for (const style of Object.values(doc.styles)) {
    const id = makeStyleId(style.id);
    const node: GraphNode = {
      id,
      figmaNodeId: style.id,
      type: "STYLE",
      name: style.name,
      metadata: { styleType: style.styleType, key: style.key },
    };
    if (style.description) node.description = style.description;
    if (style.remote) node.isRemote = true;
    builder.addNode(node);
    const libGraphId = linkToLibrary(id, style.libraryId);
    if (libGraphId) node.libraryId = libGraphId;
  }

  for (const collection of Object.values(doc.variableCollections)) {
    const id = makeCollectionId(collection.id);
    const node: GraphNode = {
      id,
      figmaNodeId: collection.id,
      type: "VARIABLE_COLLECTION",
      name: collection.name,
      metadata: { modes: collection.modes },
    };
    if (collection.remote) node.isRemote = true;
    builder.addNode(node);
    const libGraphId = linkToLibrary(id, collection.libraryId);
    if (libGraphId) node.libraryId = libGraphId;
  }

  for (const variable of Object.values(doc.variables)) {
    const id = makeVariableId(variable.id);
    const collectionGraphId = makeCollectionId(variable.collectionId);
    const node: GraphNode = {
      id,
      figmaNodeId: variable.id,
      type: "VARIABLE",
      name: variable.name,
      metadata: {
        resolvedType: variable.resolvedType,
        key: variable.key,
        valuesByMode: variable.valuesByMode,
      },
    };
    if (variable.description) node.description = variable.description;
    if (variable.remote) node.isRemote = true;
    if (builder.nodes.has(collectionGraphId)) node.parentId = collectionGraphId;
    builder.addNode(node);
    builder.addEdge("BELONGS_TO_COLLECTION", id, collectionGraphId, "in collection");
    const libGraphId = linkToLibrary(id, variable.libraryId);
    if (libGraphId) node.libraryId = libGraphId;
  }

  // Semantic -> primitive aliases are variable-to-variable dependencies.
  for (const variable of Object.values(doc.variables)) {
    for (const aliasTarget of variable.aliasOf ?? []) {
      builder.addEdge(
        "USES_VARIABLE",
        makeVariableId(variable.id),
        makeVariableId(aliasTarget),
        "aliases",
        { alias: true },
      );
    }
  }

  /* ---------------------------------------------------------------- *
   * 4. Component metadata enrichment + remote component materialisation
   * ---------------------------------------------------------------- */
  const ensureComponentNode = (componentFigmaId: string): GraphNode | undefined => {
    const graphId = makeNodeId(componentFigmaId);
    const existing = builder.nodes.get(graphId);
    // A claimed id that lands on a rectangle, text, instance, or frame is not a master.
    if (existing) return COMPONENT_DEF_TYPES.includes(existing.type) ? existing : undefined;

    const meta = doc.components[componentFigmaId];
    if (!meta) return undefined;

    // The component lives in a library file, so its internals are not in this
    // payload. We still know its identity, so it becomes a remote stub node.
    const inferred = meta.identity === "inferred-from-name";
    const node: GraphNode = {
      id: graphId,
      figmaNodeId: componentFigmaId,
      type: "MAIN_COMPONENT",
      name: meta.name,
      isMainComponent: true,
      // A component we cannot see the internals of is "remote" in the sense
      // that matters here: its definition lives outside this payload.
      isRemote: !inferred,
      metadata: {
        key: meta.key,
        remote: !inferred,
        identity: meta.identity ?? "id",
        ...remoteSourceFields(meta),
      },
    };
    if (meta.description) node.description = meta.description;
    builder.addNode(node);
    applyRemoteSource(node, meta);
    const libGraphId = linkToLibrary(graphId, meta.libraryId);
    if (libGraphId) node.libraryId = libGraphId;

    if (meta.componentSetId) {
      const setMeta = doc.componentSets[meta.componentSetId];
      const setGraphId = makeNodeId(meta.componentSetId);
      if (!builder.nodes.has(setGraphId) && setMeta) {
        const setNode: GraphNode = {
          id: setGraphId,
          figmaNodeId: meta.componentSetId,
          type: "COMPONENT_SET",
          name: setMeta.name,
          isRemote: true,
          metadata: { key: setMeta.key, remote: true, ...remoteSourceFields(setMeta) },
        };
        builder.addNode(setNode);
        applyRemoteSource(setNode, setMeta);
        const setLibGraphId = linkToLibrary(setGraphId, setMeta.libraryId);
        if (setLibGraphId) setNode.libraryId = setLibGraphId;
      }
      if (builder.nodes.has(setGraphId)) {
        node.componentSetId = setGraphId;
        node.type = "VARIANT";
        builder.addEdge("VARIANT_OF", graphId, setGraphId, "variant of");
      }
    }
    return node;
  };

  for (const meta of [...Object.values(doc.components), ...Object.values(doc.componentSets)]) {
    const node = builder.nodes.get(makeNodeId(meta.id));
    if (!node) continue;
    if (!node.description && meta.description) node.description = meta.description;
    if (meta.remote) node.isRemote = true;
    node.metadata = { ...node.metadata, key: meta.key, ...remoteSourceFields(meta) };
    applyRemoteSource(node, meta);
    const libGraphId = linkToLibrary(node.id, meta.libraryId);
    if (libGraphId) node.libraryId = libGraphId;
    for (const link of meta.documentationLinks ?? []) {
      pendingLinks.push({ sourceGraphId: node.id, link });
    }
  }

  /* ---------------------------------------------------------------- *
   * 5. Instance -> main component
   * ---------------------------------------------------------------- */
  for (const pending of pendingInstances) {
    const instance = builder.nodes.get(pending.instanceGraphId);
    if (!instance) continue;

    const main = ensureComponentNode(pending.componentFigmaId);
    if (!main) {
      instance.metadata = {
        ...instance.metadata,
        unresolvedMainComponentId: pending.componentFigmaId,
      };
      builder.warn({
        code: "UNRESOLVED_MAIN_COMPONENT",
        message: `Instance "${instance.name}" references component ${pending.componentFigmaId}, which is not in this payload.`,
        nodeId: instance.id,
        detail: { componentFigmaId: pending.componentFigmaId },
      });
      continue;
    }

    instance.mainComponentId = main.id;
    if (main.componentSetId) instance.componentSetId = main.componentSetId;
    if (main.variantProperties) instance.variantProperties = main.variantProperties;
    if (main.isRemote) instance.isRemote = true;

    const inferred = main.metadata?.["identity"] === "inferred-from-name";
    builder.addEdge(
      "INSTANCE_OF",
      instance.id,
      main.id,
      "instance of",
      inferred ? { confidence: "INFERRED" } : undefined,
    );
    builder.addEdge("USED_IN", main.id, instance.id, "used in");
  }

  const inferredComponents = [...builder.nodes.values()].filter(
    (node) => node.metadata?.["identity"] === "inferred-from-name",
  );
  if (inferredComponents.length) {
    builder.warn({
      code: "INFERRED_COMPONENT_IDENTITY",
      message: `${inferredComponents.length} component identities were inferred from instance layer names because this source does not expose componentId. Layer names are labels, not masters. Re-ingest via REST, the plugin, or pass get_design_context for exact links.`,
      detail: { count: inferredComponents.length, sourceKind: doc.source.kind },
    });
  }

  /* ---------------------------------------------------------------- *
   * 6. Style + variable consumption
   * ---------------------------------------------------------------- */
  for (const pending of pendingStyles) {
    const consumer = builder.nodes.get(pending.consumerGraphId);
    if (!consumer) continue;
    const styleGraphId = makeStyleId(pending.styleFigmaId);
    if (!builder.nodes.has(styleGraphId)) {
      builder.warn({
        code: "UNRESOLVED_STYLE",
        message: `Style ${pending.styleFigmaId} is referenced but not published in this payload.`,
        nodeId: consumer.id,
      });
      continue;
    }
    consumer.styleIds = [...new Set([...(consumer.styleIds ?? []), styleGraphId])];
    builder.addEdge("USES_STYLE", consumer.id, styleGraphId, styleKindFromSlot(pending.slot), {
      slot: pending.slot,
    });
  }

  for (const pending of pendingVariables) {
    const consumer = builder.nodes.get(pending.consumerGraphId);
    if (!consumer) continue;
    const variableGraphId = makeVariableId(pending.variableFigmaId);
    if (!builder.nodes.has(variableGraphId)) {
      // Variables need a separate, Enterprise-gated endpoint. Rather than
      // dropping the binding we keep a placeholder so "this node is
      // token-bound" stays visible even without variable access.
      builder.addNode({
        id: variableGraphId,
        figmaNodeId: pending.variableFigmaId,
        type: "VARIABLE",
        name: `Unresolved variable (${pending.variableFigmaId})`,
        metadata: { unresolved: true },
      });
      builder.warn({
        code: "UNRESOLVED_VARIABLE",
        message: `Variable ${pending.variableFigmaId} is bound but its definition was not provided.`,
        detail: { variableFigmaId: pending.variableFigmaId },
      });
    }
    consumer.variableIds = [...new Set([...(consumer.variableIds ?? []), variableGraphId])];
    builder.addEdge("USES_VARIABLE", consumer.id, variableGraphId, pending.property, {
      property: pending.property,
    });
  }

  /* ---------------------------------------------------------------- *
   * 7. Prototype flow + links
   * ---------------------------------------------------------------- */
  for (const { sourceGraphId, transition } of pendingTransitions) {
    const targetGraphId = makeNodeId(transition.destinationId);
    if (!builder.nodes.has(targetGraphId)) {
      builder.warn({
        code: "UNRESOLVED_PROTOTYPE_TARGET",
        message: `Prototype target ${transition.destinationId} is not in this payload.`,
        nodeId: sourceGraphId,
      });
      continue;
    }
    builder.addEdge(
      "PROTOTYPES_TO",
      sourceGraphId,
      targetGraphId,
      transition.trigger ?? "navigate",
      {
        trigger: transition.trigger,
        action: transition.action,
        durationMs: transition.durationMs,
        easing: transition.easing,
      },
    );
  }

  for (const { sourceGraphId, link } of pendingLinks) {
    const node = builder.nodes.get(sourceGraphId);
    if (!node) continue;
    const otherFile = Boolean(link.targetFileKey && link.targetFileKey !== doc.fileKey);
    const targetGraphId =
      !otherFile && link.targetFigmaNodeId ? makeNodeId(link.targetFigmaNodeId) : undefined;
    if (targetGraphId && builder.nodes.has(targetGraphId)) {
      builder.addEdge("LINKS_TO", sourceGraphId, targetGraphId, link.label ?? "links to", {
        url: link.url,
      });
      continue;
    }
    attachRationale(node.id, link.label ?? "Documentation", { url: link.url });
    const existing = Array.isArray(node.metadata?.["externalLinks"])
      ? (node.metadata!["externalLinks"] as SourceLink[])
      : [];
    node.metadata = { ...node.metadata, externalLinks: [...existing, link] };
    if (link.targetFigmaNodeId && !otherFile) {
      builder.warn({
        code: "UNRESOLVED_LINK_TARGET",
        message: `Link from "${node.name}" points at ${link.targetFigmaNodeId}, which is not in this payload.`,
        nodeId: node.id,
      });
    }
  }

  for (const node of builder.nodes.values()) applyGovernance(node);
  for (const node of builder.nodes.values()) {
    if (node.componentSetId) {
      const set = builder.nodes.get(node.componentSetId);
      if (set) inheritGovernance(node, set);
    }
    if (!node.mainComponentId) continue;
    const main = builder.nodes.get(node.mainComponentId);
    if (main) inheritGovernance(node, main);
  }

  /* ---------------------------------------------------------------- *
   * 8. Materialised inverse edges
   *
   * `PARENT_OF` is the inverse of `CONTAINS` (source = child, target =
   * parent — read it as "has parent"). `USED_IN` is already emitted next to
   * `INSTANCE_OF` above. Both are hidden on the canvas by default.
   * ---------------------------------------------------------------- */
  for (const edge of [...builder.edges.values()]) {
    if (edge.type !== "CONTAINS") continue;
    builder.addEdge("PARENT_OF", edge.target, edge.source, "has parent", { derived: true });
  }

  for (const node of builder.nodes.values()) {
    if (!node.fileKey) node.fileKey = doc.fileKey;
  }

  return settleInstanceBindings({
    fileKey: doc.fileKey,
    fileName: doc.fileName,
    builtAt: options.builtAt ?? new Date().toISOString(),
    source: {
      kind: doc.source.kind,
      ingestedAt: doc.source.ingestedAt,
      version: doc.source.version,
      lastModified: doc.source.lastModified,
      ...(doc.source.remoteSourceLookup ? { remoteSourceLookup: doc.source.remoteSourceLookup } : {}),
    },
    nodes: [...builder.nodes.values()],
    edges: [...builder.edges.values()],
    warnings: builder.warnings,
  });
}
