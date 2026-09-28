import { createHash } from "node:crypto";
import { buildGraph } from "@/core/transform";
import { DesignGraphSchema, type DesignGraph, type GraphNode } from "@/core/model";
import {
  adaptFigmaMcpMetadata,
  inferredComponentId,
  isMetadataComponentSet,
  parseMetadataXml,
} from "./adapters/figmaMcp";
import type { WorkspaceFileRole } from "@/core/query/workspace";

export interface LearnCatalogItem {
  name?: string;
  key?: string;
  nodeId?: string;
  figmaNodeId?: string;
  fileKey?: string;
  description?: string;
}

export interface LearnUnit {
  id: string;
  name: string;
  kind: "page" | "frame";
}

export interface LearnUnitMaster {
  id: string;
  name: string;
  figmaNodeId?: string;
}

export interface LearnCheckpoint {
  fileKey: string;
  role?: WorkspaceFileRole;
  completedHashes: string[];
  completedUnits: LearnUnit[];
  outline: LearnUnit[];
  mastersByUnit: Record<string, LearnUnitMaster[]>;
  hasFullOutline?: boolean;
  version?: string;
  lastModified?: string;
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
  outline?: LearnUnit[];
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
  learnedCount: number;
  totalCount: number;
  remaining: LearnUnit[];
  next?: LearnUnit;
  progress: string;
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

const CATALOG_MASTER_TYPES = new Set(["MAIN_COMPONENT", "COMPONENT_SET"]);

function isCatalogMaster(node: GraphNode): boolean {
  return CATALOG_MASTER_TYPES.has(node.type);
}

function fileOfNode(node: GraphNode, graph: DesignGraph): string {
  return (node.fileKey ?? graph.fileKey).trim();
}

function catalogNodeId(item: LearnCatalogItem): string | undefined {
  const id = item.nodeId ?? item.figmaNodeId;
  return id?.trim() || undefined;
}

/** Stamp published keys. Exact fileKey + nodeId + master type only. Name fallback if exactly one master in that file has that name. */
export function applyPublishedCatalog(graph: DesignGraph, raw: unknown): { applied: number } {
  const catalog = flattenCatalog(raw);
  let applied = 0;
  for (const item of catalog) {
    if (!item.key) continue;
    const wantFile = (item.fileKey ?? graph.fileKey).trim();
    const wantId = catalogNodeId(item);
    let node: GraphNode | undefined;
    if (wantFile && wantId) {
      node = graph.nodes.find(
        (candidate) =>
          isCatalogMaster(candidate) &&
          fileOfNode(candidate, graph) === wantFile &&
          candidate.figmaNodeId === wantId,
      );
    }
    if (!node && item.name && wantFile) {
      const matches = graph.nodes.filter(
        (candidate) =>
          isCatalogMaster(candidate) &&
          fileOfNode(candidate, graph) === wantFile &&
          candidate.name === item.name,
      );
      if (matches.length === 1) node = matches[0];
    }
    if (!node) continue;
    node.metadata = { ...node.metadata, key: item.key };
    applied += 1;
  }
  return { applied };
}

type XmlLike = { tag: string; attrs: Record<string, string>; children: XmlLike[] };

const LEARN_MASTER_TAGS = new Set([
  "component",
  "symbol",
  "component-set",
  "component_set",
  "componentset",
]);

export const LEARN_ZERO_COMPONENTS =
  "Learned 0 components. Make sure you passed the LIBRARY file's metadata, not a product screen";

export const LEARN_PRODUCT_EMPTY =
  "Learned 0 product screens. Pass the product file's get_metadata, not an empty payload.";

export function realLearnedComponentCount(graph: DesignGraph, fileKey?: string): number {
  const want = fileKey?.trim();
  return graph.nodes.filter((node) => {
    if (node.type !== "MAIN_COMPONENT" && node.type !== "COMPONENT_SET" && node.type !== "VARIANT") {
      return false;
    }
    if (node.metadata?.["identity"] === "inferred-from-name") return false;
    const id = `${node.id} ${node.figmaNodeId ?? ""}`;
    if (id.includes("mcp-name:")) return false;
    if (!want) return true;
    return (node.fileKey ?? graph.fileKey).trim() === want;
  }).length;
}

function learnUnitKind(tag: string): LearnUnit["kind"] | undefined {
  const lower = tag.toLowerCase();
  if (lower === "canvas" || lower === "page") return "page";
  if (lower === "frame" || lower === "section") return "frame";
  return undefined;
}

function collectNestedMasters(element: XmlLike): LearnUnitMaster[] {
  const out: LearnUnitMaster[] = [];
  const seen = new Set<string>();
  const walk = (node: XmlLike) => {
    const id = node.attrs["id"]?.trim();
    const name = node.attrs["name"]?.trim() || id;
    const tag = node.tag.toLowerCase();
    const isMaster = LEARN_MASTER_TAGS.has(tag) || (tag === "frame" && isMetadataComponentSet(node));
    if (id && isMaster && !seen.has(id)) {
      seen.add(id);
      out.push({ id, name: name || id, figmaNodeId: id });
    }
    if (node.tag.toLowerCase() === "instance" && name && !out.some((row) => row.name === name)) {
      const inferred = inferredComponentId(name);
      if (!seen.has(inferred)) {
        seen.add(inferred);
        out.push({ id: inferred, name, figmaNodeId: inferred });
      }
    }
    for (const child of node.children) walk(child);
  };
  walk(element);
  return out;
}

/** Top-level pages/frames plus masters nested inside each unit's own subtree. */
export function extractLearnOutline(xml: string): {
  units: LearnUnit[];
  mastersByUnit: Record<string, LearnUnitMaster[]>;
} {
  const roots = parseMetadataXml(xml);
  const units: LearnUnit[] = [];
  const mastersByUnit: Record<string, LearnUnitMaster[]> = {};
  const seen = new Set<string>();
  const visit = (element: XmlLike) => {
    const id = element.attrs["id"]?.trim();
    const name = element.attrs["name"]?.trim() || id;
    const kind = learnUnitKind(element.tag);
    if (id && name && kind && !seen.has(id)) {
      seen.add(id);
      units.push({ id, name, kind });
      mastersByUnit[id] = collectNestedMasters(element);
      return;
    }
    for (const child of element.children) visit(child);
  };
  for (const root of roots) visit(root);
  return { units, mastersByUnit };
}

export function extractLearnUnits(xml: string): LearnUnit[] {
  return extractLearnOutline(xml).units;
}

export function mastersByUnitFromXml(xml: string): Record<string, LearnUnitMaster[]> {
  return extractLearnOutline(xml).mastersByUnit;
}

export function sameLearnMaster(a: LearnUnitMaster, b: LearnUnitMaster): boolean {
  if (a.id && b.id && a.id === b.id) return true;
  return Boolean(a.figmaNodeId && b.figmaNodeId && a.figmaNodeId === b.figmaNodeId);
}

export function resolveMastersAgainstGraph(masters: LearnUnitMaster[], graph: DesignGraph): LearnUnitMaster[] {
  return masters.map((item) => {
    const node = graph.nodes.find(
      (candidate) =>
        isCatalogMaster(candidate) &&
        (candidate.figmaNodeId === item.figmaNodeId ||
          candidate.figmaNodeId === item.id ||
          candidate.id === item.id),
    );
    return node ? { id: node.id, name: node.name, figmaNodeId: node.figmaNodeId } : item;
  });
}

/** Removed only when every prior home unit was re-sent and none still contains the master. */
export function removedMastersByAbsence(
  priorByUnit: Record<string, LearnUnitMaster[]>,
  resentByUnit: Record<string, LearnUnitMaster[]>,
): LearnUnitMaster[] {
  const resentIds = new Set(Object.keys(resentByUnit));
  const keyOf = (master: LearnUnitMaster) => master.figmaNodeId || master.id;
  const homes = new Map<string, { master: LearnUnitMaster; units: string[] }>();
  for (const [unitId, masters] of Object.entries(priorByUnit)) {
    for (const master of masters) {
      const key = keyOf(master);
      if (!key) continue;
      const row = homes.get(key) ?? { master, units: [] };
      if (!row.units.includes(unitId)) row.units.push(unitId);
      homes.set(key, row);
    }
  }
  const removed: LearnUnitMaster[] = [];
  for (const [key, row] of homes) {
    const resentHomes = row.units.filter((unitId) => resentIds.has(unitId));
    if (!resentHomes.length || resentHomes.length !== row.units.length) continue;
    const stillHere = row.units.some((unitId) =>
      (resentByUnit[unitId] ?? []).some(
        (master) => keyOf(master) === key || sameLearnMaster(master, row.master),
      ),
    );
    if (!stillHere) removed.push(row.master);
  }
  return removed;
}

export function uniqueLearnUnits(units: LearnUnit[]): LearnUnit[] {
  const seen = new Set<string>();
  const out: LearnUnit[] = [];
  for (const unit of units) {
    if (!unit.id || seen.has(unit.id)) continue;
    seen.add(unit.id);
    out.push(unit);
  }
  return out;
}

export function remainingLearnUnits(outline: LearnUnit[], completed: LearnUnit[]): LearnUnit[] {
  const done = new Set(completed.map((unit) => unit.id));
  return outline.filter((unit) => !done.has(unit.id));
}

export function learnProgressLine(
  learned: number,
  total: number,
  next?: LearnUnit,
  role?: WorkspaceFileRole,
): string {
  if (next) return `learned ${learned} of ${total} pages; next: ${next.name}`;
  if (total > 0 && learned >= total) {
    if (role === "product" || role === "client") {
      return `learned ${learned} of ${total} pages; ${role} screens recorded`;
    }
    return `learned ${learned} of ${total} pages; library complete`;
  }
  return `learned ${learned} of ${total} pages; next: pass next get_metadata page/frame`;
}

export function mastersFromGraph(graph: DesignGraph, fileKey?: string): LearnUnitMaster[] {
  const want = fileKey?.trim();
  return graph.nodes
    .filter((node) => {
      if (!isCatalogMaster(node)) return false;
      if (!want) return true;
      return fileOfNode(node, graph) === want;
    })
    .map((node) => ({ id: node.id, name: node.name, figmaNodeId: node.figmaNodeId }));
}

function isInferredMasterId(value: string | undefined): boolean {
  return Boolean(value?.startsWith("mcp-name:") || value?.includes(":mcp-name:"));
}

export function markRemovedByAbsence(graph: DesignGraph, missing: LearnUnitMaster[]): GraphNode[] {
  const marked: GraphNode[] = [];
  const mark = (node: GraphNode) => {
    if (marked.some((row) => row.id === node.id)) return;
    node.status = "deprecated";
    node.metadata = { ...node.metadata, removedByAbsence: true };
    marked.push(node);
  };
  for (const gone of missing) {
    for (const candidate of graph.nodes) {
      if (!isCatalogMaster(candidate)) continue;
      const exact =
        candidate.id === gone.id ||
        (gone.figmaNodeId && candidate.figmaNodeId === gone.figmaNodeId);
      const inferredTwin =
        candidate.name === gone.name &&
        (isInferredMasterId(candidate.id) || isInferredMasterId(candidate.figmaNodeId));
      if (exact || inferredTwin) mark(candidate);
    }
  }
  return marked;
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
