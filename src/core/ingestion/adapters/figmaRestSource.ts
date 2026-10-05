import type { IngestionSource, SourceComponentMeta, SourceDocument } from "../types";
import { parseFigmaTarget } from "../figmaFileKey";
import {
  collectTopLevelScreens,
  fileFromNodesResponse,
  resolveIngestScope,
  type FigmaIngestScope,
  type ScreenRef,
} from "../figmaScope";
import { adaptFigmaRestFile } from "./figmaRest";

/**
 * Live Figma REST ingest. Parsing stays in `adaptFigmaRestFile`; this file
 * only fetches.
 *
 * Default scope is the shared node (`?node-id=`), not the whole file. Whole
 * files walk top-level FRAME/SECTION/COMPONENT/COMPONENT_SET nodes one at a
 * time. `--scope file` is one request (safer on a low API tier). 429s honor
 * Retry-After, or exponential backoff when that header is missing. Completed
 * sections checkpoint (tied to file version/lastModified) so a re-run resumes.
 *
 * Token never lives in the bundle. Browser sends it per-request through the
 * Vite `/api/figma` proxy (CORS). Node/CLI reads `FIGMA_ACCESS_TOKEN`.
 */

export const FIGMA_API_ORIGIN = "https://api.figma.com";
export const DEFAULT_MAX_RETRY_AFTER_MS = 30_000;
export const DEFAULT_BACKOFF_MS = 1_000;
export const DEFAULT_MAX_RATE_LIMIT_RETRIES = 5;
export const DEFAULT_MAX_SERVER_ERROR_RETRIES = 3;
export const DEFAULT_MAX_ATTEMPTS = 4;
export const DEFAULT_SERVER_ERROR_BACKOFF_MS = 2_000;
export const STUB_LOOKUP_RETRYABLE_BUDGET = 6;
export const STUB_LOOKUP_STOPPED =
  "Figma stub lookup stopped after repeated 503/429 responses. Remote sources were not filled in. Re-run ingest to retry.";
export const RETRYABLE_SERVER_STATUSES = new Set([500, 502, 503, 504]);

/** Shared budget for remote-stub lookups. Opens after this many 503/429s in a row. A success resets the streak. */
export function stubLookupCircuit(budget = STUB_LOOKUP_RETRYABLE_BUDGET): {
  note(status: number): boolean;
  succeed(): void;
  open: boolean;
  message: string;
} {
  let streak = 0;
  let open = false;
  return {
    message: STUB_LOOKUP_STOPPED,
    get open() {
      return open;
    },
    succeed() {
      if (!open) streak = 0;
    },
    note(status: number): boolean {
      if (status !== 429 && !RETRYABLE_SERVER_STATUSES.has(status)) return false;
      streak += 1;
      if (streak >= budget) open = true;
      return open;
    },
  };
}

export function exponentialBackoffMs(attempt: number, capMs = DEFAULT_MAX_RETRY_AFTER_MS): number {
  return Math.min(capMs, DEFAULT_BACKOFF_MS * 2 ** Math.max(0, attempt));
}

function serverBackoffMs(attempt: number): number {
  return Math.min(12_000, DEFAULT_SERVER_ERROR_BACKOFF_MS * 2 ** Math.max(0, attempt));
}

export function parseRetryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (!trimmed) return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return undefined;
  return Math.max(0, parsed - now);
}

export interface ScreensCheckpoint {
  fileKey: string;
  version?: string;
  lastModified?: string;
  completedIds: string[];
  pages: Record<string, { id: string; name: string; type: "CANVAS"; children: unknown[] }>;
  components: Record<string, unknown>;
  componentSets: Record<string, unknown>;
  styles: Record<string, unknown>;
}

export function checkpointMatchesFileVersion(
  saved: ScreensCheckpoint | undefined,
  version?: string,
  lastModified?: string,
): saved is ScreensCheckpoint {
  if (!saved) return false;
  if (saved.version && version && saved.version !== version) return false;
  if (saved.lastModified && lastModified && saved.lastModified !== lastModified) return false;
  if ((version || lastModified) && !saved.version && !saved.lastModified) return false;
  return true;
}

export interface IngestCheckpointStore {
  load(fileKey: string): ScreensCheckpoint | undefined;
  save(fileKey: string, data: ScreensCheckpoint): void;
  clear(fileKey: string): void;
}

export function memoryCheckpointStore(): IngestCheckpointStore {
  const bag = new Map<string, ScreensCheckpoint>();
  return {
    load: (fileKey) => bag.get(fileKey),
    save: (fileKey, data) => {
      bag.set(fileKey, structuredClone(data));
    },
    clear: (fileKey) => {
      bag.delete(fileKey);
    },
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function figmaApiOrigin(): string {
  return typeof window === "undefined" ? FIGMA_API_ORIGIN : "/api/figma";
}

export function figmaAccessToken(): string | undefined {
  const env = typeof process === "undefined" ? undefined : process.env;
  const token = env?.["FIGMA_ACCESS_TOKEN"] ?? env?.["FIGMA_TOKEN"];
  return token?.trim() || undefined;
}

export interface IngestProgress {
  phase: "outline" | "screen" | "file";
  done: number;
  total: number;
  name: string;
}

export interface FetchFigmaRestOptions {
  token: string;
  signal?: AbortSignal;
  origin?: string;
  scope?: FigmaIngestScope;
  onProgress?: (info: IngestProgress) => void;
  sleep?: (ms: number) => Promise<void>;
  maxRetryAfterMs?: number;
  checkpoint?: IngestCheckpointStore;
}

function httpFailureKind(status: number): string {
  if (status === 401) return "Figma authentication failed";
  if (status === 403) return "Figma authorization failed";
  if (status === 404) return "Figma file not found";
  if (status === 429) return "Figma rate limited";
  return `Figma request failed (${status})`;
}

async function figmaError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { err?: string; message?: string };
    return body.err ?? body.message ?? `${res.status} ${res.statusText}`;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

function wrapNetworkError(fileKey: string, cause: unknown): Error {
  if (cause instanceof Error && cause.name === "AbortError") {
    return new Error(`Figma file ${fileKey}: request timed out.`);
  }
  return new Error(`Figma file ${fileKey}: network error.`);
}

function unexpectedShape(fileKey: string): Error {
  return new Error(`Figma file ${fileKey}: unexpected response shape.`);
}

async function figmaGet(
  origin: string,
  path: string,
  token: string,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${origin}${path}`, {
    headers: { "X-Figma-Token": token },
    signal,
  });
}

interface RetryPolicy {
  sleep: (ms: number) => Promise<void>;
  maxRetryAfterMs: number;
  maxRateLimitRetries?: number;
  /** True when this 429/5xx must stop the whole stub-lookup pass. */
  noteRetryable?: (status: number) => boolean;
  /** A successful response resets the consecutive-failure streak. */
  noteSuccess?: () => void;
  circuitOpen?: () => boolean;
  circuitMessage?: string;
}

async function getJson(
  origin: string,
  path: string,
  token: string,
  fileKey: string,
  signal?: AbortSignal,
  retry?: RetryPolicy,
): Promise<unknown> {
  let headerlessAttempts = 0;
  let tries = 0;
  for (;;) {
    if (retry?.circuitOpen?.()) {
      throw new Error(retry.circuitMessage ?? STUB_LOOKUP_STOPPED);
    }
    tries += 1;
    let res: Response;
    try {
      res = await figmaGet(origin, path, token, signal);
    } catch (cause) {
      throw wrapNetworkError(fileKey, cause);
    }
    if (res.status === 429) {
      const detail = await figmaError(res);
      if (retry?.noteRetryable?.(429)) {
        throw new Error(retry.circuitMessage ?? `${httpFailureKind(429)} for ${fileKey}: ${detail}`);
      }
      const headerWait = parseRetryAfterMs(res.headers.get("Retry-After"));
      const maxWait = retry?.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
      const maxHeaderless = retry?.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES;
      const waitMs = headerWait ?? exponentialBackoffMs(headerlessAttempts, maxWait);
      if (headerWait === undefined) {
        headerlessAttempts += 1;
        if (headerlessAttempts > maxHeaderless || tries >= DEFAULT_MAX_ATTEMPTS) {
          throw new Error(`${httpFailureKind(429)} for ${fileKey}: ${detail}`);
        }
      } else if (tries >= DEFAULT_MAX_ATTEMPTS) {
        throw new Error(`${httpFailureKind(429)} for ${fileKey}: ${detail}`);
      }
      const secs = Math.round(waitMs / 1000);
      if (waitMs > maxWait) {
        throw new Error(
          `${httpFailureKind(429)} for ${fileKey}: Retry-After ${secs}s (too long to wait). Re-run ingest to resume completed sections. ${detail}`,
        );
      }
      await (retry?.sleep ?? defaultSleep)(waitMs);
      continue;
    }
    if (RETRYABLE_SERVER_STATUSES.has(res.status)) {
      if (retry?.noteRetryable?.(res.status)) {
        throw new Error(
          retry.circuitMessage ?? `${httpFailureKind(res.status)} for ${fileKey}: ${await figmaError(res)}`,
        );
      }
      if (tries < DEFAULT_MAX_ATTEMPTS) {
        const waitMs = serverBackoffMs(tries - 1);
        await (retry?.sleep ?? defaultSleep)(waitMs);
        continue;
      }
    }
    if (!res.ok) {
      throw new Error(`${httpFailureKind(res.status)} for ${fileKey}: ${await figmaError(res)}`);
    }
    retry?.noteSuccess?.();
    try {
      return await res.json();
    } catch {
      throw new Error(`Figma file ${fileKey}: malformed JSON response.`);
    }
  }
}

/** 403/404 (and exhausted 5xx) return undefined. Never throws on those. */
async function getJsonSoft(
  origin: string,
  path: string,
  token: string,
  fileKey: string,
  signal?: AbortSignal,
  retry?: RetryPolicy,
): Promise<unknown> {
  try {
    return await getJson(origin, path, token, fileKey, signal, retry);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (
      /authorization failed|not found|request failed \(40[134]\)/i.test(message) ||
      /request failed \(50[0-4]\)/i.test(message) ||
      /network error|timed out/i.test(message)
    ) {
      return undefined;
    }
    return undefined;
  }
}

async function fetchVariables(
  origin: string,
  fileKey: string,
  token: string,
  signal?: AbortSignal,
  retry?: RetryPolicy,
): Promise<unknown> {
  try {
    return await getJson(origin, `/v1/files/${fileKey}/variables/local`, token, fileKey, signal, retry);
  } catch {
    // Enterprise-gated. 403/404 is expected — the graph still builds.
  }
  return undefined;
}

function adaptFile(fileKey: string, file: unknown, variables: unknown): SourceDocument {
  try {
    return adaptFigmaRestFile({
      fileKey,
      file,
      variables,
      kind: "figma-rest",
    });
  } catch {
    throw unexpectedShape(fileKey);
  }
}

interface RemoteSourceHit {
  fileKey: string;
  fileName?: string;
  pageName?: string;
}

function metaRecord(value: unknown): Record<string, unknown> {
  const rec = asRecord(value);
  const nested = rec["meta"];
  return nested && typeof nested === "object" ? asRecord(nested) : rec;
}

function sourceFromPublished(raw: unknown): RemoteSourceHit | undefined {
  const rec = asRecord(raw);
  const fileKey = asString(rec["file_key"]) ?? asString(rec["fileKey"]);
  if (!fileKey) return undefined;
  const frame = asRecord(rec["containing_frame"] ?? rec["containingFrame"]);
  const pageName =
    asString(frame["pageName"]) ??
    asString(frame["page_name"]) ??
    asString(frame["name"]);
  const fileName = asString(rec["file_name"]) ?? asString(rec["fileName"]);
  return {
    fileKey,
    ...(fileName ? { fileName } : {}),
    ...(pageName ? { pageName } : {}),
  };
}

function publishedKeyOf(raw: unknown): string | undefined {
  return asString(asRecord(raw)["key"]);
}

function stampRemoteMeta(meta: SourceComponentMeta, hit: RemoteSourceHit): void {
  meta.sourceFileKey = hit.fileKey;
  if (hit.fileName) meta.sourceFileName = hit.fileName;
  if (hit.pageName) meta.sourcePageName = hit.pageName;
  meta.libraryId = hit.fileKey;
}

function restampRemoteLibraries(doc: SourceDocument): void {
  const remotes = [...Object.values(doc.components), ...Object.values(doc.componentSets)].filter(
    (meta) => meta.remote,
  );
  for (const meta of remotes) {
    if (!meta.sourceFileKey) continue;
    const id = meta.sourceFileKey;
    meta.libraryId = id;
    const existing = doc.libraries[id];
    doc.libraries[id] = {
      id,
      name: meta.sourceFileName ?? existing?.name ?? id,
      fileKey: id,
    };
  }
}

export async function enrichRemoteComponentSources(
  doc: SourceDocument,
  options: {
    origin: string;
    token: string;
    signal?: AbortSignal;
    retry?: RetryPolicy;
  },
): Promise<SourceDocument> {
  const remotes = [...Object.values(doc.components), ...Object.values(doc.componentSets)].filter(
    (meta) => meta.remote && meta.key,
  );
  if (!remotes.length) {
    doc.source.remoteSourceLookup = "skipped";
    return doc;
  }

  const cache = new Map<string, RemoteSourceHit>();
  const fileNames = new Map<string, string>();
  const batchedFiles = new Set<string>();
  let attempted = false;
  let told = false;
  const circuit = stubLookupCircuit();
  const retry: RetryPolicy = {
    sleep: options.retry?.sleep ?? defaultSleep,
    maxRetryAfterMs: options.retry?.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS,
    ...(options.retry?.maxRateLimitRetries !== undefined
      ? { maxRateLimitRetries: options.retry.maxRateLimitRetries }
      : {}),
    noteRetryable: (status) => circuit.note(status),
    noteSuccess: () => circuit.succeed(),
    circuitOpen: () => circuit.open,
    circuitMessage: circuit.message,
  };
  const stopLookups = (): boolean => {
    if (!circuit.open) return false;
    if (!told) {
      told = true;
      process.stderr.write(`${circuit.message}\n`);
    }
    return true;
  };

  const remember = (key: string | undefined, hit: RemoteSourceHit | undefined) => {
    if (!key || !hit) return;
    const named = fileNames.get(hit.fileKey);
    const next = named && !hit.fileName ? { ...hit, fileName: named } : hit;
    if (next.fileName) fileNames.set(next.fileKey, next.fileName);
    cache.set(key, next);
  };

  const ingestPublishedList = (body: unknown) => {
    const meta = metaRecord(body);
    const list = [
      ...asArray(meta["components"]),
      ...asArray(meta["component_sets"]),
      ...asArray(meta["componentSets"]),
    ];
    for (const row of list) {
      remember(publishedKeyOf(row), sourceFromPublished(row));
    }
    const one = sourceFromPublished(meta);
    if (one) remember(publishedKeyOf(meta) ?? asString(meta["key"]), one);
  };

  const batchFile = async (sourceFileKey: string) => {
    if (stopLookups() || batchedFiles.has(sourceFileKey)) return;
    batchedFiles.add(sourceFileKey);
    attempted = true;
    const comps = await getJsonSoft(
      options.origin,
      `/v1/files/${sourceFileKey}/components`,
      options.token,
      sourceFileKey,
      options.signal,
      retry,
    );
    if (comps) ingestPublishedList(comps);
    const sets = await getJsonSoft(
      options.origin,
      `/v1/files/${sourceFileKey}/component_sets`,
      options.token,
      sourceFileKey,
      options.signal,
      retry,
    );
    if (sets) ingestPublishedList(sets);
    if (stopLookups()) return;
    if (!fileNames.has(sourceFileKey)) {
      const file = await getJsonSoft(
        options.origin,
        `/v1/files/${sourceFileKey}?depth=1`,
        options.token,
        sourceFileKey,
        options.signal,
        retry,
      );
      const name = asString(asRecord(file)["name"]);
      if (name) fileNames.set(sourceFileKey, name);
    }
  };

  for (const remote of remotes) {
    if (stopLookups()) break;
    const key = remote.key!;
    if (cache.has(key)) continue;
    attempted = true;
    const path = doc.componentSets[remote.id] ? `/v1/component_sets/${key}` : `/v1/components/${key}`;
    const body = await getJsonSoft(
      options.origin,
      path,
      options.token,
      key,
      options.signal,
      retry,
    );
    if (!body) continue;
    ingestPublishedList(body);
    const hit = cache.get(key) ?? sourceFromPublished(metaRecord(body));
    if (hit) {
      remember(key, hit);
      await batchFile(hit.fileKey);
    }
  }

  for (const remote of remotes) {
    const hit = remote.key ? cache.get(remote.key) : undefined;
    if (!hit) continue;
    if (!hit.fileName && fileNames.has(hit.fileKey)) hit.fileName = fileNames.get(hit.fileKey);
    stampRemoteMeta(remote, hit);
  }
  restampRemoteLibraries(doc);
  const filled = remotes.filter((remote) => remote.key && cache.has(remote.key)).length;
  const stoppedEarly = circuit.open && filled < remotes.length;
  doc.source.remoteSourceLookup = stoppedEarly
    ? filled > 0
      ? "partial"
      : "failed"
    : filled > 0
      ? "ok"
      : attempted
        ? "failed"
        : "skipped";
  return doc;
}

async function adaptAndEnrich(
  origin: string,
  fileKey: string,
  token: string,
  file: unknown,
  variables: unknown,
  signal: AbortSignal | undefined,
  retry?: RetryPolicy,
): Promise<SourceDocument> {
  const doc = adaptFile(fileKey, file, variables);
  try {
    return await enrichRemoteComponentSources(doc, { origin, token, signal, retry });
  } catch {
    doc.source.remoteSourceLookup = "failed";
    return doc;
  }
}

async function fetchFullFile(
  origin: string,
  fileKey: string,
  token: string,
  signal: AbortSignal | undefined,
  variables: unknown,
  retry?: RetryPolicy,
): Promise<SourceDocument> {
  const file = await getJson(origin, `/v1/files/${fileKey}`, token, fileKey, signal, retry);
  return adaptAndEnrich(origin, fileKey, token, file, variables, signal, retry);
}

async function fetchNodesFile(
  origin: string,
  fileKey: string,
  nodeIds: string[],
  token: string,
  signal: AbortSignal | undefined,
  pages?: ScreenRef[],
  retry?: RetryPolicy,
): Promise<unknown> {
  const ids = encodeURIComponent(nodeIds.join(","));
  const body = await getJson(
    origin,
    `/v1/files/${fileKey}/nodes?ids=${ids}`,
    token,
    fileKey,
    signal,
    retry,
  );
  try {
    return fileFromNodesResponse(body, pages);
  } catch {
    throw unexpectedShape(fileKey);
  }
}

export async function fetchFigmaRestDocument(
  fileInput: string,
  options: FetchFigmaRestOptions,
): Promise<SourceDocument> {
  const token = options.token.trim();
  if (!token) {
    throw new Error("Figma authentication failed: missing access token.");
  }

  const target = parseFigmaTarget(fileInput);
  const fileKey = target.fileKey;
  const origin = (options.origin ?? figmaApiOrigin()).replace(/\/$/, "");
  const scope = resolveIngestScope(target, options.scope ?? "auto");
  const retry: RetryPolicy = {
    sleep: options.sleep ?? defaultSleep,
    maxRetryAfterMs: options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS,
  };
  const variablesPromise = fetchVariables(origin, fileKey, token, options.signal, retry);

  if (scope === "file") {
    options.onProgress?.({ phase: "file", done: 0, total: 1, name: fileKey });
    const variables = await variablesPromise;
    return fetchFullFile(origin, fileKey, token, options.signal, variables, retry);
  }

  if (scope === "node") {
    options.onProgress?.({
      phase: "screen",
      done: 0,
      total: 1,
      name: target.nodeIds.join(", "),
    });
    const [file, variables] = await Promise.all([
      fetchNodesFile(origin, fileKey, target.nodeIds, token, options.signal, undefined, retry),
      variablesPromise,
    ]);
    options.onProgress?.({
      phase: "screen",
      done: 1,
      total: 1,
      name: target.nodeIds.join(", "),
    });
    return adaptAndEnrich(origin, fileKey, token, file, variables, options.signal, retry);
  }

  options.onProgress?.({ phase: "outline", done: 0, total: 1, name: fileKey });
  const outline = asRecord(
    await getJson(origin, `/v1/files/${fileKey}?depth=2`, token, fileKey, options.signal, retry),
  );
  const screens = collectTopLevelScreens(outline["document"]);
  if (!screens.length) {
    const variables = await variablesPromise;
    return fetchFullFile(origin, fileKey, token, options.signal, variables, retry);
  }

  const outlineVersion = asString(outline["version"]);
  const outlineModified = asString(outline["lastModified"]);
  const loaded = options.checkpoint?.load(fileKey);
  const saved = checkpointMatchesFileVersion(loaded, outlineVersion, outlineModified) ? loaded : undefined;
  if (loaded && !saved) options.checkpoint?.clear(fileKey);
  const components: Record<string, unknown> = { ...(saved?.components ?? {}) };
  const componentSets: Record<string, unknown> = { ...(saved?.componentSets ?? {}) };
  const styles: Record<string, unknown> = { ...(saved?.styles ?? {}) };
  const pages = new Map<string, { id: string; name: string; type: "CANVAS"; children: unknown[] }>();
  for (const page of Object.values(saved?.pages ?? {})) {
    pages.set(page.id, {
      id: page.id,
      name: page.name,
      type: "CANVAS",
      children: [...page.children],
    });
  }
  const completed = new Set(saved?.completedIds ?? []);

  const persist = () => {
    options.checkpoint?.save(fileKey, {
      fileKey,
      version: outlineVersion,
      lastModified: outlineModified,
      completedIds: [...completed],
      pages: Object.fromEntries(pages),
      components,
      componentSets,
      styles,
    });
  };

  const mergeWrapped = (wrapped: Record<string, unknown>) => {
    Object.assign(components, asRecord(wrapped["components"]));
    Object.assign(componentSets, asRecord(wrapped["componentSets"]));
    Object.assign(styles, asRecord(wrapped["styles"]));
    const document = asRecord(wrapped["document"]);
    for (const page of asArray(document["children"])) {
      const rec = asRecord(page);
      const pageId = asString(rec["id"]);
      if (!pageId) continue;
      let bucket = pages.get(pageId);
      if (!bucket) {
        bucket = {
          id: pageId,
          name: asString(rec["name"]) ?? pageId,
          type: "CANVAS",
          children: [],
        };
        pages.set(pageId, bucket);
      }
      bucket.children.push(...asArray(rec["children"]));
    }
  };

  for (let i = 0; i < screens.length; i += 1) {
    const screen = screens[i]!;
    options.onProgress?.({
      phase: "screen",
      done: i,
      total: screens.length,
      name: screen.name,
    });
    if (completed.has(screen.id)) continue;
    const wrapped = asRecord(
      await fetchNodesFile(origin, fileKey, [screen.id], token, options.signal, [screen], retry),
    );
    mergeWrapped(wrapped);
    completed.add(screen.id);
    persist();
  }

  options.onProgress?.({
    phase: "screen",
    done: screens.length,
    total: screens.length,
    name: screens[screens.length - 1]?.name ?? fileKey,
  });

  options.checkpoint?.clear(fileKey);
  const variables = await variablesPromise;
  return adaptAndEnrich(
    origin,
    fileKey,
    token,
    {
      name: asString(outline["name"]) ?? "Figma file",
      lastModified: outline["lastModified"],
      version: outline["version"],
      thumbnailUrl: outline["thumbnailUrl"],
      document: {
        id: "0:0",
        name: "Document",
        type: "DOCUMENT",
        children: [...pages.values()],
      },
      components,
      componentSets,
      styles,
    },
    variables,
    options.signal,
    retry,
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export class FigmaRestIngestionSource implements IngestionSource {
  readonly kind = "figma-rest" as const;
  readonly id: string;
  readonly label: string;
  readonly fileKey: string;
  private readonly fileInput: string;

  constructor(
    fileInput: string,
    private readonly token: string,
    private readonly origin?: string,
    private readonly scope?: FigmaIngestScope,
  ) {
    this.fileInput = fileInput;
    const target = parseFigmaTarget(fileInput);
    this.fileKey = target.fileKey;
    this.id = target.nodeIds.length
      ? `figma-rest:${target.fileKey}:${target.nodeIds.join(",")}`
      : `figma-rest:${target.fileKey}`;
    this.label = target.nodeIds.length
      ? `Figma REST — ${target.fileKey} @ ${target.nodeIds.join(", ")}`
      : `Figma REST — ${target.fileKey}`;
  }

  load(signal?: AbortSignal): Promise<SourceDocument> {
    return fetchFigmaRestDocument(this.fileInput, {
      token: this.token,
      signal,
      origin: this.origin,
      scope: this.scope,
    });
  }
}
