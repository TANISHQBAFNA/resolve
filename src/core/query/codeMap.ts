import { existsSync, readFileSync } from "node:fs";
import type { CodeTwin, GraphNode } from "@/core/model";
import type { GraphIndex } from "./GraphIndex";
import { overlayFile } from "./overlayFile";
import { nodeFileKey } from "./workspaceMerge";

export const CODE_MAP_FILE = "code-map.json";
export const NO_CODE_MAP_HINT = "No code map. Add .graphify/code-map.json next to synonyms.json.";

export interface CodeMapEntry {
  fileKey: string;
  id?: string;
  name?: string;
  code: CodeTwin;
}

export interface LoadedCodeMap {
  entries: CodeMapEntry[];
  namingRule?: "same-name";
  codeComponents: string[];
}

export interface StaleMapEntry {
  fileKey: string;
  id?: string;
  name?: string;
}

export interface CodeMapReport {
  configured: boolean;
  mapped: number;
  unmapped: number;
  ambiguous: number;
  stale: number;
  unmappedNames: string[];
  ambiguousNames: string[];
  staleEntries: StaleMapEntry[];
  hint?: string;
}

const CATALOG_TYPES = new Set(["COMPONENT_SET", "MAIN_COMPONENT"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCatalog(node: GraphNode): boolean {
  return CATALOG_TYPES.has(node.type);
}

export function catalogMasters(index: GraphIndex): GraphNode[] {
  return index.graph.nodes.filter(isCatalog);
}

function figmaIdOf(node: GraphNode): string {
  if (node.figmaNodeId?.trim()) return node.figmaNodeId.trim();
  return node.id.startsWith("node:") ? node.id.slice("node:".length) : node.id;
}

function fileOf(node: GraphNode, graphFileKey: string): string {
  return (nodeFileKey(node, graphFileKey) ?? graphFileKey).trim();
}

function idsMatch(node: GraphNode, rawId: string): boolean {
  const want = rawId.trim();
  if (!want) return false;
  if (figmaIdOf(node) === want) return true;
  if (node.id === want || node.id === `node:${want}`) return true;
  return node.id.endsWith(`:${want}`);
}

function parseTwin(raw: unknown): CodeTwin | undefined {
  if (!isRecord(raw)) return undefined;
  const imp = typeof raw["import"] === "string" ? raw["import"].trim() : "";
  const component = typeof raw["component"] === "string" ? raw["component"].trim() : "";
  if (!imp || !component) return undefined;
  const twin: CodeTwin = { import: imp, component };
  const props = parseProps(raw["props"]);
  if (props) twin.props = props;
  if (typeof raw["source"] === "string" && raw["source"].trim()) twin.source = raw["source"].trim();
  return twin;
}

function parseProps(raw: unknown): CodeTwin["props"] {
  if (!isRecord(raw)) return undefined;
  const out: NonNullable<CodeTwin["props"]> = {};
  for (const [prop, mapping] of Object.entries(raw)) {
    if (!isRecord(mapping)) continue;
    const inner: Record<string, string> = {};
    for (const [from, to] of Object.entries(mapping)) {
      if (typeof to === "string") inner[from] = to;
    }
    if (Object.keys(inner).length) out[prop] = inner;
  }
  return Object.keys(out).length ? out : undefined;
}

function parseEntry(raw: unknown): CodeMapEntry | undefined {
  if (!isRecord(raw)) return undefined;
  const code = parseTwin(raw["code"]);
  if (!code) return undefined;
  const fileKey = typeof raw["fileKey"] === "string" ? raw["fileKey"].trim() : "";
  const id = typeof raw["id"] === "string" ? raw["id"].trim() : "";
  const name = typeof raw["name"] === "string" ? raw["name"].trim() : "";
  if (!fileKey && !id && !name) return undefined;
  return {
    fileKey,
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
    code,
  };
}

let lastMalformedPath = "";

function emitMalformed(path: string): void {
  if (lastMalformedPath === path) return;
  lastMalformedPath = path;
  process.stderr.write("code-map.json is malformed; ignored\n");
}

/** Missing / empty / malformed = undefined (no map). Malformed prints one stderr line. */
export function loadCodeMap(): LoadedCodeMap | undefined {
  const path = overlayFile(CODE_MAP_FILE);
  if (!path || !existsSync(path)) {
    lastMalformedPath = "";
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    emitMalformed(path);
    return undefined;
  }
  if (!isRecord(raw)) {
    emitMalformed(path);
    return undefined;
  }
  const entries: CodeMapEntry[] = [];
  if (raw["entries"] != null) {
    if (!Array.isArray(raw["entries"])) {
      emitMalformed(path);
      return undefined;
    }
    for (const item of raw["entries"]) {
      const entry = parseEntry(item);
      if (entry) entries.push(entry);
    }
  }
  lastMalformedPath = "";
  const codeComponents = Array.isArray(raw["codeComponents"])
    ? raw["codeComponents"]
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())
    : [];
  const namingRule = raw["namingRule"] === "same-name" ? ("same-name" as const) : undefined;
  if (!entries.length && !(namingRule && codeComponents.length)) return undefined;
  return {
    entries,
    ...(namingRule ? { namingRule } : {}),
    codeComponents,
  };
}

export function pascalCaseName(name: string): string {
  return name
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

interface ResolvedMap {
  byId: Map<string, CodeTwin>;
  ambiguousIds: Set<string>;
  stale: StaleMapEntry[];
}

function nodeKey(node: GraphNode): string {
  return node.id;
}

function resolveEntries(index: GraphIndex, map: LoadedCodeMap): ResolvedMap {
  const catalog = catalogMasters(index);
  const graphFileKey = index.graph.fileKey;
  const byId = new Map<string, CodeTwin>();
  const ambiguousIds = new Set<string>();
  const stale: StaleMapEntry[] = [];

  const inFile = (node: GraphNode, fileKey: string) =>
    !fileKey || fileOf(node, graphFileKey) === fileKey;

  for (const entry of map.entries) {
    let hits: GraphNode[] = [];
    if (entry.fileKey && entry.id) {
      hits = catalog.filter((node) => inFile(node, entry.fileKey) && idsMatch(node, entry.id!));
    } else if (entry.name) {
      const named = catalog.filter(
        (node) => inFile(node, entry.fileKey) && node.name === entry.name,
      );
      if (named.length === 1) hits = named;
      else if (named.length > 1) {
        for (const node of named) ambiguousIds.add(nodeKey(node));
        continue;
      }
    }
    if (hits.length === 1) {
      const id = nodeKey(hits[0]!);
      if (!byId.has(id) && !ambiguousIds.has(id)) byId.set(id, entry.code);
      continue;
    }
    if (hits.length > 1) {
      for (const node of hits) ambiguousIds.add(nodeKey(node));
      continue;
    }
    stale.push({
      fileKey: entry.fileKey,
      ...(entry.id ? { id: entry.id } : {}),
      ...(entry.name ? { name: entry.name } : {}),
    });
  }

  if (map.namingRule === "same-name" && map.codeComponents.length) {
    const listed = new Set(map.codeComponents);
    const buckets = new Map<string, GraphNode[]>();
    for (const node of catalog) {
      if (byId.has(nodeKey(node)) || ambiguousIds.has(nodeKey(node))) continue;
      const pascal = pascalCaseName(node.name);
      if (!listed.has(pascal)) continue;
      const bucket = buckets.get(pascal);
      if (bucket) bucket.push(node);
      else buckets.set(pascal, [node]);
    }
    for (const [pascal, nodes] of buckets) {
      if (nodes.length === 1) {
        const node = nodes[0]!;
        byId.set(nodeKey(node), {
          import: `import { ${pascal} }`,
          component: pascal,
        });
      } else {
        for (const node of nodes) ambiguousIds.add(nodeKey(node));
      }
    }
  }

  return { byId, ambiguousIds, stale };
}

/** Overlay lookup. Never mutates the graph. Empty when no map or no match. */
export function codeTwinFor(index: GraphIndex, node: GraphNode): CodeTwin | undefined {
  const map = loadCodeMap();
  if (!map) return undefined;
  const resolved = resolveEntries(index, map);
  const direct = resolved.byId.get(node.id);
  if (direct) return direct;
  if (node.componentSetId) return resolved.byId.get(node.componentSetId);
  return undefined;
}

/** Stamp `code` on a copy when the map hits. Original node is untouched. */
export function attachCodeTwin(index: GraphIndex, node: GraphNode): GraphNode {
  const twin = codeTwinFor(index, node);
  return twin ? { ...node, code: twin } : node;
}

export function codeHintLine(twin: CodeTwin): string | undefined {
  const from = twin.import.match(/\bfrom\s+['"]([^'"]+)['"]/);
  if (!from?.[1]) return undefined;
  return `${twin.component} from '${from[1]}'`;
}

export function recommendCodeHint(index: GraphIndex, nodeId: string | undefined): string | undefined {
  if (!nodeId) return undefined;
  const node = index.getNode(nodeId);
  if (!node) return undefined;
  const twin = codeTwinFor(index, node);
  return twin ? codeHintLine(twin) : undefined;
}

export function reportCodeMap(index: GraphIndex, map = loadCodeMap()): CodeMapReport {
  if (!map) {
    return {
      configured: false,
      mapped: 0,
      unmapped: 0,
      ambiguous: 0,
      stale: 0,
      unmappedNames: [],
      ambiguousNames: [],
      staleEntries: [],
      hint: NO_CODE_MAP_HINT,
    };
  }
  const catalog = catalogMasters(index);
  const resolved = resolveEntries(index, map);
  const unmappedNames: string[] = [];
  const ambiguousNames: string[] = [];
  let mapped = 0;
  for (const node of catalog) {
    if (resolved.ambiguousIds.has(node.id)) {
      ambiguousNames.push(node.name);
      continue;
    }
    if (resolved.byId.has(node.id)) {
      mapped += 1;
      continue;
    }
    unmappedNames.push(node.name);
  }
  return {
    configured: true,
    mapped,
    unmapped: unmappedNames.length,
    ambiguous: ambiguousNames.length,
    stale: resolved.stale.length,
    unmappedNames,
    ambiguousNames,
    staleEntries: resolved.stale,
  };
}

export function formatCodeMapReport(report: CodeMapReport, first = 8): string {
  if (!report.configured) return report.hint ?? NO_CODE_MAP_HINT;
  const lines = [
    `Code map: ${report.mapped} mapped, ${report.unmapped} unmapped, ${report.ambiguous} ambiguous, ${report.stale} stale`,
  ];
  if (report.unmappedNames.length) {
    lines.push(`Unmapped: ${report.unmappedNames.slice(0, first).join(", ")}`);
  }
  if (report.ambiguousNames.length) {
    lines.push(`Ambiguous: ${report.ambiguousNames.slice(0, first).join(", ")}`);
  }
  if (report.staleEntries.length) {
    const labels = report.staleEntries
      .slice(0, first)
      .map((entry) => entry.name || entry.id || entry.fileKey);
    lines.push(`Stale: ${labels.join(", ")}`);
  }
  return lines.join("\n");
}
