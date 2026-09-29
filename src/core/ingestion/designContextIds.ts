import {
  COMPONENT_DEFINITION_TYPES,
  edgeId,
  nodeId,
  type DesignGraph,
  type GraphEdge,
  type GraphNode,
} from "@/core/model";
import { inferredComponentId } from "./adapters/figmaMcp";

/**
 * Real component ids from Figma `get_design_context` (HTML attrs or JSON keys).
 * Layer names are not ids. Comments, script, style, CDATA, and other attribute
 * text do not count.
 */

const ELEMENT_TAG = /<[^>]*>/g;
const IDENTITY_ATTRS = ["componentid", "componentkey", "data-component-id", "component-id"];
const JSON_IDENTITY_KEYS = ["componentId", "componentKey", "data-component-id", "component-id"];
const JSON_NODE_KEYS = ["data-node-id", "nodeId", "node-id"];

export interface ElementBindings {
  ids: Map<string, string>;
  conflicted: Set<string>;
}

function contextText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw == null) return "";
  try {
    return JSON.stringify(raw);
  } catch {
    return "";
  }
}

function elementNameAt(lower: string, lt: number): string {
  let i = lt + 1;
  if (lower[i] === "/") i += 1;
  const start = i;
  while (i < lower.length && /[a-z0-9]/.test(lower[i] ?? "")) i += 1;
  return lower.slice(start, i);
}

function closeTagEnd(lower: string, from: number, name: string): number {
  const needle = `</${name}`;
  let i = from;
  while (i < lower.length) {
    const at = lower.indexOf(needle, i);
    if (at === -1) return -1;
    const after = at + needle.length;
    const next = lower[after];
    if (next === undefined || /[\s>/]/.test(next)) {
      const gt = lower.indexOf(">", after);
      return gt === -1 ? -1 : gt + 1;
    }
    i = after;
  }
  return -1;
}

/**
 * Drop comments, script, style, and CDATA before tags are read.
 * One indexOf walk. An opener with no closer drops the rest of the text.
 */
function stripSkippedRegions(text: string): string {
  const lower = text.toLowerCase();
  const kept: string[] = [];
  let i = 0;
  while (i < text.length) {
    const lt = lower.indexOf("<", i);
    if (lt === -1) {
      kept.push(text.slice(i));
      break;
    }
    kept.push(text.slice(i, lt));
    if (lower.startsWith("<!--", lt)) {
      const end = lower.indexOf("-->", lt + 4);
      i = end === -1 ? text.length : end + 3;
      continue;
    }
    if (lower.startsWith("<![cdata[", lt)) {
      const end = lower.indexOf("]]>", lt + 9);
      i = end === -1 ? text.length : end + 3;
      continue;
    }
    const name = elementNameAt(lower, lt);
    if (name === "script" || name === "style") {
      const openEnd = lower.indexOf(">", lt + 1);
      if (openEnd === -1) {
        i = text.length;
        continue;
      }
      const close = closeTagEnd(lower, openEnd + 1, name);
      i = close === -1 ? text.length : close;
      continue;
    }
    const gt = lower.indexOf(">", lt + 1);
    if (gt === -1) {
      kept.push(text.slice(lt));
      break;
    }
    kept.push(text.slice(lt, gt + 1));
    i = gt + 1;
  }
  return kept.join("");
}

/** Attribute name to value. Quoted text is never scanned for other attributes. */
function parseTagAttributes(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  let i = tag.startsWith("<") ? 1 : 0;
  if (tag[i] === "/") i += 1;
  while (i < tag.length && !/\s/.test(tag[i] ?? "") && tag[i] !== ">" && tag[i] !== "/") i += 1;
  while (i < tag.length) {
    while (i < tag.length && /\s/.test(tag[i] ?? "")) i += 1;
    if (i >= tag.length || tag[i] === ">" || tag[i] === "/") break;
    const nameStart = i;
    while (i < tag.length && /[^\s=/>]/.test(tag[i] ?? "")) i += 1;
    const name = tag.slice(nameStart, i).toLowerCase();
    if (!name) break;
    while (i < tag.length && /\s/.test(tag[i] ?? "")) i += 1;
    if (tag[i] !== "=") {
      attrs.set(name, "");
      continue;
    }
    i += 1;
    while (i < tag.length && /\s/.test(tag[i] ?? "")) i += 1;
    const quote = tag[i];
    let value = "";
    if (quote === '"' || quote === "'") {
      i += 1;
      const end = tag.indexOf(quote, i);
      if (end === -1) {
        value = tag.slice(i);
        i = tag.length;
      } else {
        value = tag.slice(i, end);
        i = end + 1;
      }
    } else {
      const start = i;
      while (i < tag.length && !/[\s/>]/.test(tag[i] ?? "")) i += 1;
      value = tag.slice(start, i);
    }
    attrs.set(name, value);
  }
  return attrs;
}

function identityAttr(attrs: Map<string, string>): string | undefined {
  for (const name of IDENTITY_ATTRS) {
    const value = attrs.get(name);
    if (value) return value;
  }
  return undefined;
}

function jsonString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  const lower = new Map<string, unknown>();
  for (const [key, value] of Object.entries(record)) lower.set(key.toLowerCase(), value);
  for (const key of keys) {
    const value = lower.get(key.toLowerCase());
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let quote: string | undefined;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function bindRecord(
  record: Record<string, unknown>,
  ids: Map<string, string>,
  seen: Map<string, number>,
): void {
  const nodeId = jsonString(record, JSON_NODE_KEYS);
  const componentId = jsonString(record, JSON_IDENTITY_KEYS);
  if (!nodeId) return;
  seen.set(nodeId, (seen.get(nodeId) ?? 0) + 1);
  if (componentId && !ids.has(nodeId)) ids.set(nodeId, componentId);
}

function walkJson(
  value: unknown,
  ids: Map<string, string>,
  seen: Map<string, number>,
  depth: number,
): void {
  if (depth > 8 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) walkJson(item, ids, seen, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  bindRecord(record, ids, seen);
  for (const child of Object.values(record)) walkJson(child, ids, seen, depth + 1);
}

function jsonBindings(text: string): { ids: Map<string, string>; seen: Map<string, number> } {
  const ids = new Map<string, string>();
  const seen = new Map<string, number>();
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      walkJson(JSON.parse(trimmed) as unknown, ids, seen, 0);
      return { ids, seen };
    } catch {
      // Mixed markup plus objects.
    }
  }
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf("{", i);
    if (start === -1) break;
    const end = matchingBrace(text, start);
    if (end === -1) break;
    try {
      walkJson(JSON.parse(text.slice(start, end + 1)) as unknown, ids, seen, 0);
    } catch {
      // Not a JSON object.
    }
    i = end + 1;
  }
  return { ids, seen };
}

/** Design context names a real component id or key, not only a layer name. */
export function contextCarriesMasterIds(raw: unknown): boolean {
  return /componentId|componentKey|mainComponent|data-component-id|component-id/i.test(contextText(raw));
}

/**
 * Component id that sits on the same element (or JSON object) as this node.
 * A neighbour's id, a quoted attribute value, a comment, script, style, or CDATA block do not count.
 * The same node id on two tags is a conflict and binds nothing.
 */
export function elementComponentIds(raw: unknown): ElementBindings {
  const text = stripSkippedRegions(contextText(raw));
  const seen = new Map<string, number>();
  const ids = new Map<string, string>();
  const htmlSeen = new Set<string>();
  for (const tag of text.match(ELEMENT_TAG) ?? []) {
    const attrs = parseTagAttributes(tag);
    const nodeId = attrs.get("data-node-id");
    if (!nodeId) continue;
    htmlSeen.add(nodeId);
    seen.set(nodeId, (seen.get(nodeId) ?? 0) + 1);
    const componentId = identityAttr(attrs);
    if (componentId && !ids.has(nodeId)) ids.set(nodeId, componentId);
  }
  const leftover = text.replace(ELEMENT_TAG, " ");
  const json = jsonBindings(leftover);
  for (const [nodeId, count] of json.seen) {
    if (htmlSeen.has(nodeId)) {
      if (!ids.has(nodeId) && json.ids.has(nodeId)) ids.set(nodeId, json.ids.get(nodeId)!);
      continue;
    }
    seen.set(nodeId, (seen.get(nodeId) ?? 0) + count);
    const componentId = json.ids.get(nodeId);
    if (componentId && !ids.has(nodeId)) ids.set(nodeId, componentId);
  }
  const conflicted = new Set<string>();
  for (const [nodeId, count] of seen) {
    if (count < 2) continue;
    conflicted.add(nodeId);
    ids.delete(nodeId);
  }
  return { ids, conflicted };
}

export function contextIdentityFor(bindings: ElementBindings, nodeId: string | undefined): string | undefined {
  if (!nodeId || bindings.conflicted.has(nodeId)) return undefined;
  return bindings.ids.get(nodeId);
}

function idVariants(value: string): string[] {
  return [...new Set([value, value.replace(/-/g, ":"), value.replace(/:/g, "-")])];
}

function isInferredMaster(node: GraphNode): boolean {
  if (node.metadata?.["identity"] === "inferred-from-name") return true;
  return `${node.id} ${node.figmaNodeId ?? ""}`.includes("mcp-name:");
}

/**
 * Bind a claimed componentId/componentKey only to a master's node id or
 * published key. Never to a name, lowercase name, or variant label.
 */
export function masterByIdOrKey(graph: DesignGraph, boundId: string): GraphNode | undefined {
  const claimed = boundId.trim();
  if (!claimed) return undefined;
  const needles = new Set(idVariants(claimed));
  for (const node of graph.nodes) {
    if (!COMPONENT_DEFINITION_TYPES.includes(node.type)) continue;
    if (isInferredMaster(node)) continue;
    if (isUnbackedStub(node)) continue;
    if (needles.has(node.id) || (node.figmaNodeId && needles.has(node.figmaNodeId))) return node;
    const key = typeof node.metadata?.["key"] === "string" ? node.metadata["key"].trim() : "";
    if (key && key === claimed) return node;
  }
  return undefined;
}

function isUnbackedStub(node: GraphNode): boolean {
  if (!COMPONENT_DEFINITION_TYPES.includes(node.type)) return false;
  if (isInferredMaster(node)) return false;
  if (!node.isRemote) return false;
  const fig = node.figmaNodeId ?? "";
  return Boolean(fig) && node.name === fig;
}

function claimedIdOf(instance: GraphNode, byId: Map<string, GraphNode>): string | undefined {
  const unresolved = instance.metadata?.["unresolvedMainComponentId"];
  if (typeof unresolved === "string" && unresolved.trim()) return unresolved.trim();
  const main = instance.mainComponentId ? byId.get(instance.mainComponentId) : undefined;
  if (main && isUnbackedStub(main) && main.figmaNodeId) return main.figmaNodeId;
  return undefined;
}

function guessGraphId(instance: GraphNode): string {
  const raw = inferredComponentId(instance.name);
  const fileKey = instance.fileKey?.trim();
  if (fileKey && instance.id.startsWith("node:") && instance.id.slice(5).startsWith(`${fileKey}:`)) {
    return `node:${fileKey}:${raw}`;
  }
  return nodeId(raw);
}

function ensureGuessMaster(graph: DesignGraph, instance: GraphNode, byId: Map<string, GraphNode>): GraphNode {
  const current = instance.mainComponentId ? byId.get(instance.mainComponentId) : undefined;
  if (current && isInferredMaster(current)) return current;
  const fileKey = instance.fileKey;
  const existing = graph.nodes.find(
    (node) =>
      isInferredMaster(node) &&
      node.name === instance.name &&
      (!fileKey || !node.fileKey || node.fileKey === fileKey),
  );
  if (existing) return existing;
  const node: GraphNode = {
    id: guessGraphId(instance),
    figmaNodeId: inferredComponentId(instance.name),
    type: "MAIN_COMPONENT",
    name: instance.name,
    isMainComponent: true,
    isRemote: false,
    ...(fileKey ? { fileKey } : {}),
    metadata: { identity: "inferred-from-name" },
  };
  const prior = byId.get(node.id);
  if (prior) return prior;
  graph.nodes.push(node);
  byId.set(node.id, node);
  return node;
}

function rewriteInstanceEdges(
  graph: DesignGraph,
  instanceId: string,
  fromId: string | undefined,
  toId: string,
  inferred: boolean,
): void {
  if (fromId === toId) return;
  let hasInstanceOf = false;
  const next: GraphEdge[] = [];
  for (const edge of graph.edges) {
    if (edge.type === "INSTANCE_OF" && edge.source === instanceId) {
      hasInstanceOf = true;
      const rewritten: GraphEdge = {
        id: edgeId("INSTANCE_OF", instanceId, toId),
        source: instanceId,
        target: toId,
        type: "INSTANCE_OF",
        label: edge.label ?? "instance of",
      };
      if (inferred) rewritten.confidence = "INFERRED";
      next.push(rewritten);
      continue;
    }
    if (edge.type === "USED_IN" && edge.target === instanceId && (!fromId || edge.source === fromId)) {
      next.push({
        ...edge,
        id: edgeId("USED_IN", toId, instanceId),
        source: toId,
        target: instanceId,
      });
      continue;
    }
    next.push(edge);
  }
  if (!hasInstanceOf) {
    const instanceOf: GraphEdge = {
      id: edgeId("INSTANCE_OF", instanceId, toId),
      source: instanceId,
      target: toId,
      type: "INSTANCE_OF",
      label: "instance of",
    };
    if (inferred) instanceOf.confidence = "INFERRED";
    next.push(instanceOf);
    next.push({
      id: edgeId("USED_IN", toId, instanceId),
      source: toId,
      target: instanceId,
      type: "USED_IN",
      label: "used in",
    });
  }
  graph.edges = next;
}

function dropUnusedMasters(graph: DesignGraph): void {
  const used = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.type === "INSTANCE_OF") used.add(edge.target);
    if (edge.type === "USED_IN") used.add(edge.source);
  }
  const drop = new Set(
    graph.nodes
      .filter((node) => (isInferredMaster(node) || isUnbackedStub(node)) && !used.has(node.id))
      .map((node) => node.id),
  );
  if (!drop.size) return;
  graph.nodes = graph.nodes.filter((node) => !drop.has(node.id));
  graph.edges = graph.edges.filter((edge) => !drop.has(edge.source) && !drop.has(edge.target));
}

/**
 * Bind claimed instance ids to real library/`<symbol>` masters. An id that
 * matches nothing stays a name-only guess and does not mint a master.
 */
export function settleInstanceBindings(graph: DesignGraph): DesignGraph {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const instance of graph.nodes) {
    if (instance.type !== "COMPONENT_INSTANCE") continue;
    const claimed = claimedIdOf(instance, byId);
    if (!claimed) continue;
    const master = masterByIdOrKey(graph, claimed);
    if (master) {
      const previous = instance.mainComponentId;
      instance.mainComponentId = master.id;
      if (master.componentSetId) instance.componentSetId = master.componentSetId;
      if (instance.metadata && "unresolvedMainComponentId" in instance.metadata) {
        const next = { ...instance.metadata };
        delete next["unresolvedMainComponentId"];
        instance.metadata = next;
      }
      rewriteInstanceEdges(graph, instance.id, previous, master.id, false);
      continue;
    }
    const current = instance.mainComponentId ? byId.get(instance.mainComponentId) : undefined;
    const mcpGuess =
      graph.source.kind === "figma-mcp" ||
      (current != null && (isInferredMaster(current) || isUnbackedStub(current)));
    if (!mcpGuess) continue;
    const guess = ensureGuessMaster(graph, instance, byId);
    const previous = instance.mainComponentId;
    instance.mainComponentId = guess.id;
    instance.metadata = { ...instance.metadata, unresolvedMainComponentId: claimed };
    rewriteInstanceEdges(graph, instance.id, previous, guess.id, true);
  }
  dropUnusedMasters(graph);
  return graph;
}

/** Stamp real component ids from design context onto name-guessed instances. */
export function applyLearnedIdentity(graph: DesignGraph, raw: unknown): number {
  const bindings = elementComponentIds(raw);
  if (!bindings.ids.size) {
    settleInstanceBindings(graph);
    return 0;
  }
  let updated = 0;
  for (const node of graph.nodes) {
    if (node.type !== "COMPONENT_INSTANCE") continue;
    const boundId = contextIdentityFor(bindings, node.figmaNodeId);
    if (!boundId) continue;
    const master = masterByIdOrKey(graph, boundId);
    if (!master) {
      node.metadata = { ...node.metadata, unresolvedMainComponentId: boundId };
      continue;
    }
    if (node.mainComponentId === master.id) {
      if (node.metadata && "unresolvedMainComponentId" in node.metadata) {
        const next = { ...node.metadata };
        delete next["unresolvedMainComponentId"];
        node.metadata = next;
      }
      continue;
    }
    const previous = node.mainComponentId;
    node.mainComponentId = master.id;
    if (master.componentSetId) node.componentSetId = master.componentSetId;
    if (node.metadata && "unresolvedMainComponentId" in node.metadata) {
      const next = { ...node.metadata };
      delete next["unresolvedMainComponentId"];
      node.metadata = next;
    }
    rewriteInstanceEdges(graph, node.id, previous, master.id, false);
    updated += 1;
  }
  settleInstanceBindings(graph);
  return updated;
}
