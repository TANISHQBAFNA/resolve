import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { IngestCheckpointStore, ScreensCheckpoint } from "@/core/ingestion/adapters/figmaRestSource";
import { DesignGraphSchema, type DesignGraph } from "@/core/model";
import {
  assertIngestRoleChange,
  defaultIngestRole,
  indexGraph,
  mergeRecipes,
  mergeWorkspaceGraphs,
  parseContextPackFile,
  parseLibraryRules,
  parseRecipeFile,
  parseWorkspaceFile,
  stampFileKey,
  starterRecipes,
  upsertWorkspaceFile,
  type ContextBind,
  type ContextPackFile,
  type GraphIndex,
  type LibraryRules,
  type Recipe,
  type WorkspaceFile,
  type WorkspaceFileRole,
  type WorkspaceManifest,
} from "@/core/query";

/**
 * Durable graph store. One file:
 *
 *   .graphify/graph.json
 *
 * Optional designer files next to it: library-rules.json, recipes.json,
 * context-packs.json, workspace.json. Per-file graphs live in files/.
 * Agents call recipe / recommend / resolve / cousins — they do not Read the graph file.
 */

export interface StoredGraphSummary {
  graphId: string;
  fileKey: string;
  fileName: string;
  sourceKind: string;
  nodes: number;
  edges: number;
  warnings: number;
  savedAt: string;
  role?: WorkspaceFileRole;
  label?: string;
  /** Roots the agent can start from — pages, or captured frames. */
  entryPoints: Array<{ id: string; name: string; type: string; figmaNodeId?: string; fileKey?: string }>;
}

export interface StoreIndex {
  version: 1;
  graphs: StoredGraphSummary[];
}

export function storeRoot(): string {
  return resolve(process.env["GRAPHIFY_HOME"] ?? join(process.cwd(), ".graphify"));
}

export function graphPath(): string {
  return join(storeRoot(), "graph.json");
}

/** Optional allow/deny list next to graph.json. Missing file = graph status rules. */
export function libraryRulesPath(): string {
  return join(storeRoot(), "library-rules.json");
}

/** Designer-editable recipe overlay next to graph.json. Missing file = starter pack only. */
export function recipesPath(): string {
  return join(storeRoot(), "recipes.json");
}

/** Product + journey context packs. Missing file = no extra ranking context. */
export function contextPacksPath(): string {
  return join(storeRoot(), "context-packs.json");
}

/** Designer-editable multi-file workspace. Missing file = single ingested graph. */
export function workspacePath(): string {
  return join(storeRoot(), "workspace.json");
}

export function workspaceFilesDir(): string {
  return join(storeRoot(), "files");
}

export function safeFileKey(fileKey: string): string {
  return fileKey.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "file";
}

export function fileGraphPath(fileKey: string): string {
  return join(workspaceFilesDir(), `${safeFileKey(fileKey)}.json`);
}

export function ingestCheckpointDir(): string {
  return join(storeRoot(), "ingest");
}

export function fsIngestCheckpointStore(): IngestCheckpointStore {
  const dir = ingestCheckpointDir();
  const pathFor = (fileKey: string) => join(dir, `${safeFileKey(fileKey)}.partial.json`);
  return {
    load(fileKey) {
      const path = pathFor(fileKey);
      if (!existsSync(path)) return undefined;
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as ScreensCheckpoint;
        if (parsed?.fileKey === fileKey && Array.isArray(parsed.completedIds)) return parsed;
      } catch {
        return undefined;
      }
      return undefined;
    },
    save(fileKey, data) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(pathFor(fileKey), `${JSON.stringify(data)}\n`);
    },
    clear(fileKey) {
      const path = pathFor(fileKey);
      if (existsSync(path)) rmSync(path);
    },
  };
}

export function readRecipeOverlay(explicitPath?: string): Recipe[] {
  const path = explicitPath ?? (existsSync(recipesPath()) ? recipesPath() : undefined);
  if (!path) return [];
  if (!existsSync(path)) {
    throw new Error(`Recipes file not found: ${path}`);
  }
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return parseRecipeFile(raw);
}

export function loadRecipes(explicitPath?: string): Recipe[] {
  return mergeRecipes(starterRecipes(), readRecipeOverlay(explicitPath));
}

export function readContextPacks(explicitPath?: string): ContextPackFile {
  const path = explicitPath ?? (existsSync(contextPacksPath()) ? contextPacksPath() : undefined);
  if (!path) return { packs: [] };
  if (!existsSync(path)) {
    throw new Error(`Context packs file not found: ${path}`);
  }
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return parseContextPackFile(raw);
}

export function loadContextBind(
  args: {
    pack?: string;
    product?: string;
    journey?: string;
    domain?: string;
    packsFile?: string;
  } = {},
): ContextBind {
  const file = readContextPacks(args.packsFile);
  const trim = (value?: string) => {
    const next = value?.trim();
    return next ? next : undefined;
  };
  const workspace = readWorkspace();
  return {
    packs: file.packs,
    active: file.active,
    packId: trim(args.pack),
    product: trim(args.product),
    journey: trim(args.journey),
    domain: trim(args.domain),
    ...(workspace.files.length ? { workspace } : {}),
  };
}

export function readWorkspace(explicitPath?: string): WorkspaceManifest {
  const path = explicitPath ?? (existsSync(workspacePath()) ? workspacePath() : undefined);
  if (!path) return { version: 1, files: [] };
  if (!existsSync(path)) {
    throw new Error(`Workspace file not found: ${path}`);
  }
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return parseWorkspaceFile(raw);
}

export function writeWorkspace(manifest: WorkspaceManifest): void {
  mkdirSync(storeRoot(), { recursive: true });
  writeFileSync(workspacePath(), `${JSON.stringify(manifest, null, 2)}\n`);
}

export function loadFileGraph(fileKey: string): DesignGraph | undefined {
  const path = fileGraphPath(fileKey);
  if (!existsSync(path)) return undefined;
  return stampFileKey(DesignGraphSchema.parse(JSON.parse(readFileSync(path, "utf8"))));
}

export function writeFileGraph(graph: DesignGraph): string {
  mkdirSync(workspaceFilesDir(), { recursive: true });
  const stamped = stampFileKey(graph);
  const path = fileGraphPath(stamped.fileKey);
  writeFileSync(path, `${JSON.stringify(stamped, null, 2)}\n`);
  return path;
}

export function readLibraryRules(explicitPath?: string): LibraryRules | undefined {
  const path = explicitPath ?? (existsSync(libraryRulesPath()) ? libraryRulesPath() : undefined);
  if (!path) return undefined;
  if (!existsSync(path)) {
    throw new Error(`Library rules file not found: ${path}`);
  }
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return parseLibraryRules(raw);
}

/** Stable id derived from the file it came from. Display only — the file is always graph.json. */
export function graphIdFor(fileKey: string, fileName: string): string {
  const slug = fileName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  const key = fileKey.replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
  return `${slug || "file"}-${key || "local"}`;
}

function summarise(graphId: string, graph: DesignGraph): StoredGraphSummary {
  const fileNode = graph.nodes.find((node) => node.type === "FILE");
  const entryPoints = graph.nodes
    .filter((node) => node.parentId === fileNode?.id)
    .slice(0, 40)
    .map((node) => ({
      id: node.id,
      name: node.name,
      type: node.type,
        figmaNodeId: node.figmaNodeId,
        fileKey: node.fileKey ?? graph.fileKey,
    }));

  return {
    graphId,
    fileKey: graph.fileKey,
    fileName: graph.fileName,
    sourceKind: graph.source.kind,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    warnings: graph.warnings.length,
    savedAt: new Date().toISOString(),
    entryPoints,
  };
}

function summariseWorkspaceFile(file: WorkspaceFile, graph?: DesignGraph): StoredGraphSummary {
  if (graph) {
    return { ...summarise(graphIdFor(graph.fileKey, file.label || graph.fileName), graph), role: file.role, label: file.label };
  }
  return {
    graphId: graphIdFor(file.key, file.label || file.key),
    fileKey: file.key,
    fileName: file.label || file.key,
    sourceKind: "workspace",
    nodes: 0,
    edges: 0,
    warnings: 0,
    savedAt: new Date(0).toISOString(),
    role: file.role,
    label: file.label,
    entryPoints: [],
  };
}

const LEGACY_FILES = ["GRAPH_REPORT.md", "index.json"] as const;
const LEGACY_DIRS = ["reports", "graphs"] as const;

function removeLegacySidecars(): void {
  for (const name of LEGACY_FILES) {
    const path = join(storeRoot(), name);
    if (existsSync(path)) rmSync(path);
  }
  for (const name of LEGACY_DIRS) {
    const path = join(storeRoot(), name);
    if (existsSync(path)) rmSync(path, { recursive: true });
  }
}

export function saveGraph(graph: DesignGraph, graphId?: string): StoredGraphSummary {
  mkdirSync(storeRoot(), { recursive: true });
  writeFileSync(graphPath(), JSON.stringify(graph, null, 2) + "\n");
  removeLegacySidecars();
  cache.clear();
  const id = graphId ?? graphIdFor(graph.fileKey, graph.fileName);
  return summarise(id, graph);
}

export function deleteGraph(_graphId?: string): boolean {
  const path = graphPath();
  let deleted = false;
  if (existsSync(path)) {
    rmSync(path);
    deleted = true;
  }
  const filesDir = workspaceFilesDir();
  if (existsSync(filesDir)) {
    rmSync(filesDir, { recursive: true });
    deleted = true;
  }
  cache.clear();
  return deleted;
}

export function listGraphs(): StoredGraphSummary[] {
  const workspace = readWorkspace();
  if (workspace.files.length) {
    return workspace.files.map((file) => summariseWorkspaceFile(file, loadFileGraph(file.key)));
  }
  const loaded = loadGraph();
  if (!loaded) return [];
  return [summarise(graphIdFor(loaded.graph.fileKey, loaded.graph.fileName), loaded.graph)];
}

export function mergeStoredWorkspace(workspace = readWorkspace()): DesignGraph | undefined {
  const inputs = workspace.files
    .map((file) => {
      const graph = loadFileGraph(file.key);
      return graph ? { graph, role: file.role } : undefined;
    })
    .filter((entry): entry is { graph: DesignGraph; role: WorkspaceFileRole } => Boolean(entry));
  if (!inputs.length) return undefined;
  return mergeWorkspaceGraphs(inputs, workspace);
}

export function saveIngestedFile(
  graph: DesignGraph,
  options: {
    role?: WorkspaceFileRole;
    url?: string;
    label?: string;
    graphId?: string;
    forceRole?: boolean;
  } = {},
): StoredGraphSummary {
  const stamped = stampFileKey(graph);
  writeFileGraph(stamped);
  const current = readWorkspace();
  const existing = current.files.find((file) => file.key === stamped.fileKey);
  if (options.role && existing) {
    assertIngestRoleChange(current, stamped.fileKey, options.role, { forceRole: options.forceRole });
  }
  const role = options.role ?? existing?.role ?? defaultIngestRole(current);
  const next: WorkspaceFile = {
    role,
    key: stamped.fileKey,
    url: options.url ?? existing?.url,
    label: options.label ?? existing?.label ?? stamped.fileName,
  };
  const workspace = upsertWorkspaceFile(current, next);
  writeWorkspace(workspace);
  const merged = mergeWorkspaceGraphs(
    workspace.files
      .map((file) => {
        const fileGraph = file.key === stamped.fileKey ? stamped : loadFileGraph(file.key);
        return fileGraph ? { graph: fileGraph, role: file.role } : undefined;
      })
      .filter((entry): entry is { graph: DesignGraph; role: WorkspaceFileRole } => Boolean(entry)),
    workspace,
  );
  cache.clear();
  return { ...saveGraph(merged, options.graphId), role, label: next.label };
}

/** No sidecar index. Kept so CLI `reindex` still runs. */
export function rebuildIndex(): StoreIndex {
  return { version: 1, graphs: listGraphs() };
}

const cache = new Map<string, { graph: DesignGraph; index: GraphIndex }>();

export function loadGraph(_graphId?: string): { graph: DesignGraph; index: GraphIndex } | undefined {
  const cached = cache.get("graph");
  if (cached) return cached;

  const workspace = existsSync(workspacePath()) ? readWorkspace() : { version: 1 as const, files: [] };
  const merged = workspace.files.length ? mergeStoredWorkspace(workspace) : undefined;
  if (merged) {
    const entry = { graph: merged, index: indexGraph(merged) };
    cache.set("graph", entry);
    return entry;
  }

  const path = graphPath();
  if (!existsSync(path)) return undefined;

  const graph = stampFileKey(DesignGraphSchema.parse(JSON.parse(readFileSync(path, "utf8"))));
  const entry = { graph, index: indexGraph(graph) };
  cache.set("graph", entry);
  return entry;
}

/** The one stored graph. `graphId` is ignored — there is only graph.json. */
export function resolveGraph(
  graphId?: string,
): { graph: DesignGraph; index: GraphIndex; graphId: string } | undefined {
  const loaded = loadGraph();
  if (!loaded) return undefined;
  const id = graphId ?? graphIdFor(loaded.graph.fileKey, loaded.graph.fileName);
  return { ...loaded, graphId: id };
}

export function clearCache(): void {
  cache.clear();
}
