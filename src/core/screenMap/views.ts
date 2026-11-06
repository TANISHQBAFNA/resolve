import type { DesignGraph } from "@/core/model";
import { LAYER_NAME_GUESS } from "@/core/query/cardCopy";
import { indexGraph, type GraphIndex } from "@/core/query/GraphIndex";
import { isScreen } from "@/core/query/screenInventory";
import { buildScreenMap, readScreenMap } from "./document";
import type { MapNode, MapWarning, ScreenMapDocument } from "./types";

const NEXT: Record<string, string> = {
  "W-MAP-NODE": "resolve map outline",
  "W-MAP-NO-PROTO": "re-learn the file with Figma REST or the plugin",
  "W-MAP-GUESSED": "re-learn via REST or plugin for extracted identities",
  "W-MAP-DETACHED": "restore instances or note in drift",
  "W-MAP-STALE": "resolve map build",
  "W-TEXT-LINES-UNKNOWN": "optional; structure is still valid",
  "W-MAP-UNKNOWN-BIND": "re-check with a REST payload that includes boundVariables",
  "W-MAP-CAP": "raise --depth / --page or omit caps for the full view",
  "W-MAP-LOOKALIKE": "replace with a DS instance or ignore",
  "W-MAP-OFF": "set screenMap.enabled true in .resolve/config.json",
  "W-MAP-REBUILT": "resolve map screen <id>",
  "E-MAP-GRAPH": "resolve learn",
  "E-MAP-READ": "resolve map build",
};
export const mapWarning = (code: string, message: string): MapWarning => ({ code, message, next: NEXT[code] ?? "resolve map outline" });
const warn = mapWarning;

export function orderedNodes(doc: ScreenMapDocument): MapNode[] {
  const out: MapNode[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    const node = doc.nodes[id];
    if (!node || seen.has(id)) return;
    seen.add(id);
    out.push(node);
    for (const child of node.childIds) walk(child);
  };
  walk(doc.rootId);
  for (const id of Object.keys(doc.nodes).sort()) walk(id);
  return out;
}

export function subtree(doc: ScreenMapDocument, id: string, depth?: number): { nodes: MapNode[]; capped: boolean } {
  const nodes: MapNode[] = [];
  let capped = false;
  const walk = (current: string, level: number) => {
    const node = doc.nodes[current];
    if (!node) return;
    if (depth !== undefined && level > depth) {
      capped = true;
      return;
    }
    nodes.push(node);
    if (depth !== undefined && level === depth && node.childIds.length) capped = true;
    if (depth === undefined || level < depth) for (const child of node.childIds) walk(child, level + 1);
  };
  walk(id, 0);
  return { nodes, capped };
}

function pack<T extends Record<string, unknown>>(view: string, extra: T, warnings: MapWarning[], capped = false) {
  if (capped) warnings.unshift(warn("W-MAP-CAP", "This view stopped at the opt-in depth or page."));
  const lookalike = warnings.find((item) => item.code === "W-MAP-LOOKALIKE");
  const ordered = lookalike ? [lookalike, ...warnings.filter((item) => item !== lookalike)] : warnings;
  return { view, ...extra, warnings: ordered, next: ordered[0]?.next ?? "resolve map screen <id>", ...(capped ? { viewCapped: true as const } : {}), truncated: false as const };
}

export const findMapNode = (doc: ScreenMapDocument, id: string) =>
  doc.nodes[id] ?? Object.values(doc.nodes).find((node) => node.figmaNodeId === id);

function screenOf(index: GraphIndex, doc: ScreenMapDocument, id: string): MapNode | undefined {
  const screen = index.getHierarchyPath(id).find((node) => isScreen(index, node));
  const hit = screen ?? index.getNode(id);
  return hit ? doc.nodes[hit.id] : doc.nodes[id];
}

const guessed = (doc: ScreenMapDocument): MapWarning[] =>
  Object.values(doc.nodes).some((node) => node.identity === "guessed") ? [warn("W-MAP-GUESSED", LAYER_NAME_GUESS)] : [];

export function loadMap(root: string, graph: DesignGraph | undefined, fileKey?: string, builtAt?: string) {
  const saved = readScreenMap(root, fileKey);
  if (saved && (!graph?.source.version || saved.fileVersion === graph.source.version)) return { doc: saved, warnings: [] as MapWarning[] };
  if (!graph) return { doc: undefined, warnings: [warn("E-MAP-GRAPH", "No learned graph.")] };
  const doc = buildScreenMap(graph, builtAt ? { builtAt } : {});
  return { doc, warnings: [warn("W-MAP-STALE", saved ? "The learned file is newer than the private map." : "No private map is on disk yet.")] };
}

export function outlineView(doc: ScreenMapDocument, options: { page?: number; offset?: number } = {}) {
  const items = orderedNodes(doc).filter((node) => node.type === "screen" || node.type === "region").map((node) => ({
    id: node.id, type: node.type, name: node.name, path: node.path, ...(node.parentId ? { parentId: node.parentId } : {}),
  }));
  const offset = options.offset ?? 0;
  const slice = options.page ? items.slice(offset, offset + options.page) : items;
  const capped = Boolean(options.page && offset + options.page < items.length);
  return pack("outline", {
    fileKey: doc.fileKey, fileVersion: doc.fileVersion, items: slice,
    ...(options.page ? { page: { size: options.page, offset, total: items.length } } : {}),
  }, guessed(doc), capped);
}

export function nodeView(doc: ScreenMapDocument, id: string, depth?: number, view: "screen" | "node" = "node") {
  const node = findMapNode(doc, id);
  if (!node) return pack(view, { nodes: [] }, [warn("W-MAP-NODE", `No node ${id}.`)]);
  const tree = subtree(doc, node.id, depth);
  const warnings = [...guessed(doc)];
  if (tree.nodes.some((item) => item.flags?.detached)) warnings.push(warn("W-MAP-DETACHED", "A frame looks like a component but is not an instance."));
  if (tree.nodes.some((item) => item.flags?.lookalike)) warnings.unshift(warn("W-MAP-LOOKALIKE", `looks like ${tree.nodes.find((item) => item.flags?.lookalike)?.name}, but hand-built`));
  if (tree.nodes.some((item) => item.text?.present && item.text.lines === undefined)) warnings.push(warn("W-TEXT-LINES-UNKNOWN", "A text slot has no line count."));
  return pack(view, { fileKey: doc.fileKey, fileVersion: doc.fileVersion, nodes: tree.nodes }, warnings, tree.capped);
}

export function journeyView(doc: ScreenMapDocument, graph: DesignGraph, startId: string) {
  const index = indexGraph(graph);
  const start = findMapNode(doc, startId);
  if (!start) return pack("journey", { steps: [], loops: [] }, [warn("W-MAP-NODE", `No node ${startId}.`)]);
  const origin = screenOf(index, doc, start.id) ?? start;
  const steps: Array<Record<string, unknown>> = [];
  const loops: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const queue: Array<{ id: string; via?: Record<string, string> }> = [{ id: origin.id }];
  let edges = 0;
  while (queue.length) {
    const current = queue.shift();
    if (!current || seen.has(current.id)) continue;
    seen.add(current.id);
    const node = doc.nodes[current.id];
    if (!node) continue;
    steps.push({ id: node.id, name: node.name, ...(current.via ? { enteredBy: current.via } : {}) });
    for (const source of subtree(doc, node.id).nodes) {
      for (const edge of index.getEdges(source.id, { direction: "out", edgeTypes: ["PROTOTYPES_TO", "LINKS_TO"] })) {
        edges += 1;
        const dest = screenOf(index, doc, edge.target);
        if (!dest) continue;
        const via = {
          from: node.id,
          ...(typeof edge.metadata?.["trigger"] === "string" ? { trigger: edge.metadata["trigger"] } : {}),
          ...(typeof edge.metadata?.["action"] === "string" ? { action: edge.metadata["action"] } : {}),
        };
        if (seen.has(dest.id)) loops.push({ ...via, to: dest.id });
        else if (!queue.some((item) => item.id === dest.id)) queue.push({ id: dest.id, via });
      }
    }
  }
  const warnings = edges ? guessed(doc) : [warn("W-MAP-NO-PROTO", "This file has no prototype edges from the start screen.")];
  return pack("journey", { steps: edges ? steps : [], loops, start: { id: origin.id, name: origin.name } }, warnings);
}

export function driftView(doc: ScreenMapDocument, scopeId?: string) {
  if (scopeId && !findMapNode(doc, scopeId)) return pack("drift", { raw: [], detached: [], lookalikes: [] }, [warn("W-MAP-NODE", `No node ${scopeId}.`)]);
  const scope = scopeId ? subtree(doc, findMapNode(doc, scopeId)!.id).nodes : orderedNodes(doc);
  const raw = scope.flatMap((node) => (node.binding ?? []).filter((row) => row.kind === "raw").map((row) => ({ id: node.id, name: node.name, path: node.path, slot: row.slot, raw: row.raw })));
  const detached = scope.filter((node) => node.flags?.detached).map((node) => ({ id: node.id, name: node.name, path: node.path, flag: "detached" as const }));
  const lookalikes = scope.filter((node) => node.flags?.lookalike).map((node) => ({ id: node.id, name: node.name, path: node.path, flag: "lookalike" as const, message: `looks like ${node.name}, but hand-built` }));
  const warnings: MapWarning[] = [];
  if (lookalikes.length) warnings.push(warn("W-MAP-LOOKALIKE", lookalikes.map((row) => row.message).join("; ")));
  if (detached.length) warnings.push(warn("W-MAP-DETACHED", `${detached.length} detached frame${detached.length === 1 ? "" : "s"}.`));
  if (scope.some((node) => node.binding?.some((row) => row.kind === "unknown"))) warnings.push(warn("W-MAP-UNKNOWN-BIND", "Some bindings are unknown."));
  return pack("drift", { raw, detached, lookalikes: lookalikes.length ? lookalikes : undefined }, warnings);
}
