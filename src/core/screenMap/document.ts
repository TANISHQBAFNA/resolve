import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanPropertyName } from "@/core/model/componentProperties";
import type { DesignGraph, GraphNode } from "@/core/model";
import { indexGraph, type GraphIndex } from "@/core/read/GraphIndex";
import { realMastersNamed } from "@/core/read/masterNames";
import { isScreen } from "@/core/read/screenInventory";
import { projectMeta } from "./capture";
import { SCREEN_MAP_VERSION, type MapDs, type MapIdentity, type MapNode, type MasterBody, type ScreenMapDocument } from "./types";

const TREE = new Set(["FILE", "PAGE", "SECTION", "FRAME", "AUTO_LAYOUT_CONTAINER", "GROUP", "LAYER", "TEXT_LAYER", "MEDIA_LAYER", "COMPONENT_SET", "MAIN_COMPONENT", "VARIANT", "COMPONENT_INSTANCE"]);
const REGION = new Set(["FRAME", "AUTO_LAYOUT_CONTAINER", "GROUP", "SECTION"]);
const DETACHED = new Set(["FRAME", "GROUP", "AUTO_LAYOUT_CONTAINER"]);
const LOOKALIKE = new Set(["LAYER", "TEXT_LAYER", "MEDIA_LAYER"]);
const rec = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export function stableStringify(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (!item || typeof item !== "object") return item;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(item).sort()) out[key] = sort((item as Record<string, unknown>)[key]);
    return out;
  };
  return JSON.stringify(sort(value));
}

/** `builtAt` stays out of the compared bytes. */
export function mapIdentityHash(doc: ScreenMapDocument): string {
  const { builtAt, ...rest } = doc;
  return stableStringify(rest);
}

function alias(index: GraphIndex, node: GraphNode): string {
  if (node.type === "FRAME" && isScreen(index, node)) return "screen";
  if (REGION.has(node.type) && index.getAncestors(node.id).some((item) => item.type === "FRAME" && isScreen(index, item))) return "region";
  if (node.type === "COMPONENT_INSTANCE") return "instance";
  if (node.type === "TEXT_LAYER") return "text";
  if (node.type === "LAYER" || node.type === "MEDIA_LAYER") return "atom";
  return node.type;
}

function identityOf(index: GraphIndex, node: GraphNode): MapIdentity | undefined {
  const main = node.mainComponentId ? index.getNode(node.mainComponentId) : undefined;
  const guessed = node.metadata?.["identity"] === "inferred-from-name" || main?.metadata?.["identity"] === "inferred-from-name";
  const component = Boolean(node.isInstance || node.isMainComponent || node.type === "COMPONENT_SET" || node.type === "VARIANT");
  if (!component && !guessed) return undefined;
  if (guessed || index.graph.source.kind === "figma-mcp") return "guessed";
  if (index.graph.source.kind === "figma-rest" || index.graph.source.kind === "figma-plugin") return "extracted";
  return "unknown";
}

function dsOf(index: GraphIndex, node: GraphNode): MapDs | undefined {
  if (!(node.isInstance || node.isMainComponent || node.type === "COMPONENT_SET" || node.propertyDefinitions?.length)) return undefined;
  const main = node.mainComponentId ? index.getNode(node.mainComponentId) : undefined;
  const definitions = (node.propertyDefinitions ?? main?.propertyDefinitions)?.map((row) => ({ name: row.name, type: row.type }));
  const componentProperties: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(rec(node.metadata?.["componentProperties"]))) {
    const raw = rec(item)["value"] ?? item;
    if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean" || raw === null) componentProperties[cleanPropertyName(key).name] = raw;
  }
  const ds: MapDs = {
    ...(node.figmaNodeId ? { componentId: node.figmaNodeId } : {}),
    ...(node.mainComponentId ? { masterId: node.mainComponentId } : {}),
    ...(node.componentSetId ? { setId: node.componentSetId } : {}),
    ...(node.variantProperties ? { variantProperties: node.variantProperties } : {}),
    ...(Object.keys(componentProperties).length ? { componentProperties } : {}),
    ...(definitions?.length ? { propertyDefinitions: definitions } : {}),
  };
  return Object.keys(ds).length ? ds : undefined;
}

function toMapNode(index: GraphIndex, node: GraphNode, childIds: string[], include: Set<string>, lookalikes = false): MapNode {
  const variables: Record<string, string> = {};
  const styles: Record<string, string> = {};
  const names: Record<string, string> = {};
  for (const edge of index.getEdges(node.id, { direction: "out", edgeTypes: ["USES_VARIABLE", "USES_STYLE"] })) {
    const target = index.getNode(edge.target);
    if (target) names[edge.target] = target.name;
    const slot = String((edge.type === "USES_VARIABLE" ? edge.metadata?.["property"] : edge.metadata?.["slot"]) ?? edge.label ?? "");
    if (slot && edge.type === "USES_VARIABLE") variables[slot] = edge.target;
    else if (slot) styles[slot] = edge.target;
  }
  const main = node.mainComponentId ? index.getNode(node.mainComponentId) : undefined;
  const set = (node.componentSetId ?? main?.componentSetId) ? index.getNode(node.componentSetId ?? main?.componentSetId ?? "") : undefined;
  const projected = projectMeta({
    meta: rec(node.metadata),
    sourceKind: index.graph.source.kind,
    variables, styles, names,
    definitions: (set?.propertyDefinitions ?? main?.propertyDefinitions ?? node.propertyDefinitions)?.map((row) => ({ name: row.name, type: row.type })),
    textNode: node.type === "TEXT_LAYER" || node.metadata?.["figmaType"] === "TEXT",
  });
  const insideInstance = index.getAncestors(node.id).some((item) => item.type === "COMPONENT_INSTANCE");
  const named = !insideInstance && !node.isInstance && node.metadata?.["hidden"] !== true && realMastersNamed(index, node.name).length > 0;
  const detached = DETACHED.has(node.type) && named;
  const lookalike = lookalikes && LOOKALIKE.has(node.type) && named;
  const overridden = Array.isArray(node.metadata?.["overrides"]) && (node.metadata["overrides"] as unknown[]).length > 0;
  const flags = { ...projected.flags, ...(node.metadata?.["hidden"] === true ? { hidden: true } : {}), ...(detached ? { detached: true } : {}), ...(lookalike ? { lookalike: true } : {}), ...(overridden ? { overridden: true } : {}) };
  delete projected.flags;
  const parent = index.getParent(node.id);
  const identity = identityOf(index, node);
  const ds = dsOf(index, node);
  return {
    id: node.id,
    ...(node.figmaNodeId ? { figmaNodeId: node.figmaNodeId } : {}),
    type: alias(index, node),
    name: node.name,
    path: index.getHierarchyPath(node.id).map((item) => `${item.name}/${item.id}`).join("/"),
    ...(parent && include.has(parent.id) ? { parentId: parent.id } : {}),
    childIds,
    ...(ds ? { ds } : {}),
    ...projected,
    ...(Object.keys(flags).length ? { flags } : {}),
    ...(identity ? { identity } : {}),
  };
}

function includeSet(index: GraphIndex, frameId?: string): Set<string> {
  const root = index.getFileNode();
  const ids = new Set<string>();
  const walk = (id: string) => {
    const node = index.getNode(id);
    if (!node || ids.has(id) || !TREE.has(node.type)) return;
    ids.add(id);
    for (const child of index.getChildren(id)) walk(child.id);
  };
  if (root) walk(root.id);
  if (!frameId) return ids;
  const focus = [...ids].map((id) => index.getNode(id)).find((node) => node?.id === frameId || node?.figmaNodeId === frameId);
  if (!focus) return ids;
  const screen = index.getHierarchyPath(focus.id).find((node) => isScreen(index, node)) ?? focus;
  const keep = new Set(index.getHierarchyPath(screen.id).map((node) => node.id));
  const seen = new Set<string>();
  const under = (id: string) => {
    if (!ids.has(id) || seen.has(id)) return;
    seen.add(id);
    keep.add(id);
    for (const child of index.getChildren(id)) under(child.id);
    const node = index.getNode(id);
    if (node?.mainComponentId) under(node.mainComponentId);
  };
  under(screen.id);
  return keep;
}

export interface BuildMapOptions { builtAt?: string; frameId?: string; refs?: boolean; lookalikes?: boolean }

export function buildScreenMap(graph: DesignGraph, options: BuildMapOptions = {}): ScreenMapDocument {
  const index = indexGraph(graph);
  const include = includeSet(index, options.frameId);
  const nodes: Record<string, MapNode> = {};
  for (const id of [...include].sort()) {
    const node = index.getNode(id);
    if (!node) continue;
    nodes[id] = toMapNode(index, node, index.getChildren(id).map((child) => child.id).filter((childId) => include.has(childId)), include, options.lookalikes === true);
  }
  const built: ScreenMapDocument = {
    version: SCREEN_MAP_VERSION,
    fileKey: graph.fileKey,
    fileName: graph.fileName,
    fileVersion: graph.source.version ?? "",
    sourceKind: graph.source.kind,
    builtAt: options.builtAt ?? new Date().toISOString(),
    rootId: index.getFileNode()?.id ?? `file:${graph.fileKey}`,
    nodes,
  };
  return options.refs ? applyRefs(built) : built;
}

export function screenMapDir(root: string): string {
  return join(root, ".resolve", "private", "screen-map");
}
export function screenMapFileName(fileKey: string, fileVersion: string): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]+/g, "_") || "unknown";
  return `${safe(fileKey)}@${safe(fileVersion)}.json`;
}

export function writeScreenMap(root: string, doc: ScreenMapDocument): { path: string; rebuilt: boolean } {
  const dir = screenMapDir(root);
  mkdirSync(dir, { recursive: true });
  const name = screenMapFileName(doc.fileKey, doc.fileVersion);
  const path = join(dir, name);
  const rebuilt = existsSync(path);
  const tmp = join(dir, `.${name}.${process.pid}.tmp`);
  writeFileSync(tmp, `${stableStringify(doc)}\n`);
  renameSync(tmp, path);
  writeFileSync(join(dir, "current.json"), `${stableStringify({ fileKey: doc.fileKey, fileVersion: doc.fileVersion, file: name })}\n`);
  return { path, rebuilt };
}

export function readScreenMap(root: string, fileKey?: string): ScreenMapDocument | undefined {
  const dir = screenMapDir(root);
  if (!existsSync(dir)) return undefined;
  let name = "";
  const pointer = join(dir, "current.json");
  if (existsSync(pointer)) {
    try {
      const current = JSON.parse(readFileSync(pointer, "utf8")) as { file?: string; fileKey?: string };
      if (!fileKey || current.fileKey === fileKey) name = current.file ?? "";
    } catch {
      name = "";
    }
  }
  if (!name) {
    const prefix = fileKey ? `${screenMapFileName(fileKey, "x").split("@")[0]}@` : "";
    name = readdirSync(dir).filter((file) => file.endsWith(".json") && file !== "current.json" && (!prefix || file.startsWith(prefix))).sort().at(-1) ?? "";
  }
  if (!name) return undefined;
  try {
    return JSON.parse(readFileSync(join(dir, name), "utf8")) as ScreenMapDocument;
  } catch {
    return undefined;
  }
}

function takeSubtree(nodes: Record<string, MapNode>, id: string, into: Record<string, MapNode>) {
  const node = nodes[id];
  if (!node || into[id]) return;
  into[id] = node;
  for (const child of node.childIds) takeSubtree(nodes, child, into);
}

/** Repeated master internals once. Instances keep `ref`. Definition stays in `nodes`. */
export function applyRefs(doc: ScreenMapDocument): ScreenMapDocument {
  const nodes = structuredClone(doc.nodes);
  const counts = new Map<string, number>();
  for (const node of Object.values(nodes)) {
    const masterId = node.ds?.masterId;
    if (masterId && node.id !== masterId) counts.set(masterId, (counts.get(masterId) ?? 0) + 1);
  }
  const masters: Record<string, MasterBody> = {};
  const drop = new Set<string>();
  for (const masterId of [...counts.keys()].sort()) {
    if ((counts.get(masterId) ?? 0) < 2) continue;
    const master = nodes[masterId];
    if (!master?.childIds.length) continue;
    const body: Record<string, MapNode> = {};
    for (const child of master.childIds) takeSubtree(nodes, child, body);
    masters[masterId] = { id: masterId, name: master.name, childIds: [...master.childIds], nodes: body };
    for (const node of Object.values(nodes)) {
      if (node.ds?.masterId !== masterId || node.id === masterId) continue;
      const mark = (id: string) => {
        const child = nodes[id];
        if (!child || drop.has(id)) return;
        drop.add(id);
        for (const next of child.childIds) mark(next);
      };
      for (const child of node.childIds) mark(child);
      node.childIds = [];
      node.ref = masterId;
    }
  }
  if (!Object.keys(masters).length) return { ...doc, nodes };
  const kept: Record<string, MapNode> = {};
  for (const id of Object.keys(nodes).sort()) if (!drop.has(id)) kept[id] = nodes[id]!;
  return { ...doc, nodes: kept, masters };
}

export function expandRef(doc: ScreenMapDocument, ref: string): MasterBody | undefined {
  return doc.masters?.[ref];
}

/** Graft each ref back under its instance. Logical tree matches a build without refs. */
export function expandAll(doc: ScreenMapDocument): ScreenMapDocument {
  if (!doc.masters) return doc;
  const nodes = structuredClone(doc.nodes);
  for (const node of Object.values(nodes)) {
    const body = node.ref ? doc.masters[node.ref] : undefined;
    if (!body) continue;
    const copyId = (id: string) => `${node.id}~${id}`;
    node.childIds = body.childIds.map(copyId);
    delete node.ref;
    for (const [id, child] of Object.entries(body.nodes)) {
      const parentInBody = Boolean(child.parentId && body.nodes[child.parentId]);
      nodes[copyId(id)] = {
        ...structuredClone(child),
        id: copyId(id),
        parentId: parentInBody ? copyId(child.parentId ?? id) : node.id,
        childIds: child.childIds.map(copyId),
      };
    }
  }
  const next: ScreenMapDocument = { ...doc, nodes };
  delete next.masters;
  return next;
}
