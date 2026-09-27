import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync, appendFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { IngestCheckpointStore, ScreensCheckpoint } from "@/core/ingestion/adapters/figmaRestSource";
import { DesignGraphSchema, type DesignGraph } from "@/core/model";
import {
  assertIngestRoleChange,
  defaultIngestRole,
  emptyBindRules,
  emptySock,
  indexGraph,
  mergeRecipes,
  mergeWorkspaceGraphs,
  loadBindRulesLenient,
  parseContextPackFile,
  parseLibraryRules,
  parseRecipeFile,
  parseWorkspaceFile,
  serializeBindRulesFile,
  serializeRecipeFile,
  stampFileKey,
  starterRecipes,
  SOCI_CORRECTION_CAP,
  upsertWorkspaceFile,
  type BindRulesFile,
  type AuditLine,
  type ContextBind,
  type ContextPackFile,
  type GraphIndex,
  type LibraryRules,
  type Recipe,
  type SockState,
  type SociDecision,
  type WorkspaceFile,
  type WorkspaceFileRole,
  type WorkspaceManifest,
} from "@/core/query";
import type { LearnCheckpoint } from "@/core/ingestion/learnLibrary";

/**
 * Durable graph store. One file:
 *
 *   .graphify/graph.json
 *
 * Optional designer files next to it: library-rules.json, bind-rules.json, recipes.json,
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

export interface StoreInfo {
  path: string;
  graph: string;
  workspace: string;
  graphifyHome?: string;
  builtAt?: string;
}

/**
 * GRAPHIFY_HOME / RESOLVE_HOME win. Else walk up from cwd (then INIT_CWD)
 * looking for `.graphify/graph.json` or `workspace.json`. Last resort: one
 * global store at `~/.resolve/<workspace>` so CLI and MCP share a folder
 * across projects without a clone-local `.graphify`.
 */
/** Folder name under `~/.resolve/`. Rejects `.`, `..`, and separators. */
export function resolveWorkspaceName(raw: string | undefined): string {
  const value = raw?.trim() || "default";
  if (value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
    throw new Error(
      `RESOLVE_WORKSPACE "${value}" is not allowed. The store must stay under ~/.resolve/.`,
    );
  }
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_");
  if (!cleaned || cleaned === "." || cleaned === "..") {
    throw new Error(
      `RESOLVE_WORKSPACE "${value}" is not allowed. The store must stay under ~/.resolve/.`,
    );
  }
  return cleaned;
}

export function defaultGlobalStore(
  env: { HOME?: string; USERPROFILE?: string; RESOLVE_WORKSPACE?: string } = {},
): string {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  return join(home, ".resolve", resolveWorkspaceName(env.RESOLVE_WORKSPACE));
}

export function discoverStoreRoot(
  cwd: string,
  env: {
    GRAPHIFY_HOME?: string;
    RESOLVE_HOME?: string;
    INIT_CWD?: string;
    HOME?: string;
    USERPROFILE?: string;
    RESOLVE_WORKSPACE?: string;
  } = {},
): string {
  const explicit = env.GRAPHIFY_HOME?.trim() || env.RESOLVE_HOME?.trim();
  if (explicit) return resolve(explicit);
  const starts = [cwd, env.INIT_CWD].filter((value): value is string => Boolean(value?.trim()));
  const seen = new Set<string>();
  for (const start of starts) {
    let dir = resolve(start);
    while (!seen.has(dir)) {
      seen.add(dir);
      const candidate = join(dir, ".graphify");
      if (existsSync(join(candidate, "graph.json")) || existsSync(join(candidate, "workspace.json"))) {
        return candidate;
      }
      const parent = resolve(dir, "..");
      if (parent === dir) break;
      dir = parent;
    }
  }
  return defaultGlobalStore(env);
}

export function storeRoot(): string {
  return discoverStoreRoot(process.cwd(), process.env);
}

export function storeInfo(): StoreInfo {
  const home = process.env["GRAPHIFY_HOME"]?.trim();
  let builtAt: string | undefined;
  const path = graphPath();
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { builtAt?: unknown };
      if (typeof raw.builtAt === "string" && raw.builtAt) builtAt = raw.builtAt;
    } catch {
      builtAt = undefined;
    }
  }
  return {
    path: storeRoot(),
    graph: path,
    workspace: workspacePath(),
    ...(home ? { graphifyHome: home } : {}),
    ...(builtAt ? { builtAt } : {}),
  };
}

export function missingGraphMessage(): string {
  const info = storeInfo();
  const homeLine = info.graphifyHome
    ? `GRAPHIFY_HOME=${info.graphifyHome}`
    : "Default store is ~/.resolve/default (or RESOLVE_WORKSPACE). Set GRAPHIFY_HOME to pin a folder.";
  return (
    `No library in SOCK. Looked in ${info.graph} (store ${info.path}). ${homeLine} ` +
    "One step: call learn_library with Figma MCP get_metadata XML + fileKey + role=library. Then recipe / recommend. Do not Read graph.json."
  );
}

function storeFingerprint(): string {
  const parts: string[] = [];
  const add = (path: string) => {
    try {
      const stat = statSync(path);
      parts.push(`${path}:${stat.mtimeMs}:${stat.size}`);
    } catch {
      parts.push(`${path}:missing`);
    }
  };
  add(graphPath());
  add(workspacePath());
  add(sockPath());
  add(bindRulesPath());
  add(libraryRulesPath());
  const filesDir = workspaceFilesDir();
  if (existsSync(filesDir)) {
    for (const name of readdirSync(filesDir).sort()) {
      add(join(filesDir, name));
    }
  }
  return parts.join("|");
}

export function graphPath(): string {
  return join(storeRoot(), "graph.json");
}

/** Optional allow/deny list next to graph.json. Missing file = graph status rules. */
export function libraryRulesPath(): string {
  return join(storeRoot(), "library-rules.json");
}

/** Human-authored bind rules. Missing file = no extra require/forbid/prefer. */
export function bindRulesPath(): string {
  return join(storeRoot(), "bind-rules.json");
}

export function bindAuditPath(): string {
  return join(storeRoot(), "bind-rules.audit.jsonl");
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

export function sockPath(): string {
  return join(storeRoot(), "sock.json");
}

export function learnCheckpointPath(fileKey: string): string {
  return join(storeRoot(), "learn", `${safeFileKey(fileKey)}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeProposals(raw: unknown, warnings: string[]): SockState["proposals"] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    warnings.push("sock.json proposals was not an array; ignored");
    return [];
  }
  const kept: SockState["proposals"] = [];
  let dropped = 0;
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry["id"] !== "string" || typeof entry["status"] !== "string") {
      dropped += 1;
      continue;
    }
    kept.push(entry as unknown as SockState["proposals"][number]);
  }
  if (dropped) {
    warnings.push(
      `sock.json dropped ${dropped} proposal ${dropped === 1 ? "entry" : "entries"} without a string id and status`,
    );
  }
  return kept;
}

function sanitizeCorrections(raw: unknown, warnings: string[]): SockState["corrections"] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    warnings.push("sock.json corrections was not an array; ignored");
    return [];
  }
  const kept: NonNullable<SockState["corrections"]> = [];
  let dropped = 0;
  for (const entry of raw) {
    if (
      !isRecord(entry) ||
      typeof entry["fromId"] !== "string" ||
      typeof entry["toId"] !== "string" ||
      typeof entry["screenId"] !== "string"
    ) {
      dropped += 1;
      continue;
    }
    kept.push(entry as unknown as NonNullable<SockState["corrections"]>[number]);
  }
  if (dropped) {
    warnings.push(
      `sock.json dropped ${dropped} correction ${dropped === 1 ? "entry" : "entries"} without string fromId, toId, and screenId`,
    );
  }
  if (kept.length > SOCI_CORRECTION_CAP) {
    warnings.push(`sock.json corrections trimmed to the latest ${SOCI_CORRECTION_CAP}`);
    return kept.slice(-SOCI_CORRECTION_CAP);
  }
  return kept;
}

function clampThreshold(raw: unknown, warnings: string[]): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 3;
  const floored = Math.floor(raw);
  if (floored < 3) {
    warnings.push(`sock.json threshold ${raw} clamped to 3`);
    return 3;
  }
  return floored;
}

function clampProposalCap(raw: unknown, warnings: string[]): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  const floored = Math.floor(raw);
  if (floored > 12) {
    warnings.push(`sock.json proposalCap ${raw} clamped to 12`);
    return 12;
  }
  if (floored < 1) {
    warnings.push(`sock.json proposalCap ${raw} clamped to 1`);
    return 1;
  }
  return floored;
}

export function loadSock(): SockState | undefined {
  const path = sockPath();
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (raw?.["version"] !== 1 || !Array.isArray(raw["facts"])) return undefined;
    const warnings: string[] = [];
    const proposalCap = clampProposalCap(raw["proposalCap"], warnings);
    return {
      version: 1,
      threshold: clampThreshold(raw["threshold"], warnings),
      facts: raw["facts"] as SockState["facts"],
      freshness: (raw["freshness"] as SockState["freshness"]) ?? {},
      proposals: sanitizeProposals(raw["proposals"], warnings),
      corrections: sanitizeCorrections(raw["corrections"], warnings),
      ...(proposalCap !== undefined ? { proposalCap } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  } catch {
    return undefined;
  }
}

export function saveSock(state: SockState): void {
  mkdirSync(storeRoot(), { recursive: true });
  const persist: SockState = { ...state };
  delete persist.warnings;
  writeFileAtomic(sockPath(), `${JSON.stringify(persist, null, 2)}\n`);
}

export function readSock(): SockState {
  return loadSock() ?? emptySock();
}

export function loadLearnCheckpoint(fileKey: string): LearnCheckpoint | undefined {
  const path = learnCheckpointPath(fileKey);
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as LearnCheckpoint;
    if (raw?.fileKey !== fileKey || !Array.isArray(raw.completedHashes)) return undefined;
    return {
      ...raw,
      completedUnits: raw.completedUnits ?? [],
      outline: raw.outline ?? [],
      mastersByUnit: raw.mastersByUnit ?? {},
    };
  } catch {
    return undefined;
  }
}

export function saveLearnCheckpoint(checkpoint: LearnCheckpoint): void {
  const path = learnCheckpointPath(checkpoint.fileKey);
  mkdirSync(join(storeRoot(), "learn"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(checkpoint, null, 2)}\n`);
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

export function writeFileAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}

export function readBindRules(explicitPath?: string): BindRulesFile {
  const path = explicitPath ?? (existsSync(bindRulesPath()) ? bindRulesPath() : undefined);
  if (!path) return emptyBindRules();
  if (!existsSync(path)) {
    return {
      version: 1,
      rules: [],
      warnings: [{ rule: path, reason: "Bind rules file not found." }],
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      version: 1,
      rules: [],
      warnings: [
        {
          rule: path,
          reason: `not valid JSON (${error instanceof Error ? error.message : String(error)})`,
        },
      ],
    };
  }
  const loaded = loadGraph();
  return loadBindRulesLenient(raw, {
    index: loaded?.index,
    workspace: readWorkspace(),
    sock: readSock(),
  });
}

export function writeBindRules(file: BindRulesFile): void {
  mkdirSync(storeRoot(), { recursive: true });
  writeFileAtomic(bindRulesPath(), `${JSON.stringify(serializeBindRulesFile(file), null, 2)}\n`);
}

export function writeRecipeOverlay(recipes: Recipe[]): void {
  writeFileAtomic(recipesPath(), `${JSON.stringify(serializeRecipeFile(recipes), null, 2)}\n`);
}

export function appendBindAudit(line: AuditLine): void {
  mkdirSync(storeRoot(), { recursive: true });
  appendFileSync(bindAuditPath(), `${JSON.stringify(line)}\n`);
}

/**
 * Bind-rules / recipe overlay first, then proposal status, then audit.
 * Variant and deprecation approvals skip file writes besides sock + audit.
 */
export function commitProposalDecision(
  decided: {
    sock: SockState;
    rules: BindRulesFile;
    audit: AuditLine;
    recipeOverlay?: Recipe[];
    writesRules?: boolean;
    writesRecipes?: boolean;
  } & Partial<SociDecision>,
): void {
  if (decided.writesRules !== false) writeBindRules(decided.rules);
  if (decided.writesRecipes && decided.recipeOverlay) writeRecipeOverlay(decided.recipeOverlay);
  saveSock(decided.sock);
  appendBindAudit(decided.audit);
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

const cache = new Map<string, { graph: DesignGraph; index: GraphIndex; fingerprint: string }>();

export function loadGraph(_graphId?: string): { graph: DesignGraph; index: GraphIndex } | undefined {
  const fingerprint = storeFingerprint();
  const cached = cache.get("graph");
  if (cached && cached.fingerprint === fingerprint) return cached;
  if (cached) cache.clear();

  const workspace = existsSync(workspacePath()) ? readWorkspace() : { version: 1 as const, files: [] };
  const merged = workspace.files.length ? mergeStoredWorkspace(workspace) : undefined;
  if (merged) {
    const entry = { graph: merged, index: indexGraph(merged), fingerprint };
    cache.set("graph", entry);
    return entry;
  }

  const path = graphPath();
  if (!existsSync(path)) return undefined;

  const graph = stampFileKey(DesignGraphSchema.parse(JSON.parse(readFileSync(path, "utf8"))));
  const entry = { graph, index: indexGraph(graph), fingerprint };
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
