import type { IngestionSource, SourceDocument } from "../types";
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
 * Retry-After; completed sections checkpoint so a re-run resumes.
 *
 * Token never lives in the bundle. Browser sends it per-request through the
 * Vite `/api/figma` proxy (CORS). Node/CLI reads `FIGMA_ACCESS_TOKEN`.
 */

export const FIGMA_API_ORIGIN = "https://api.figma.com";
export const DEFAULT_MAX_RETRY_AFTER_MS = 30_000;

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
  completedIds: string[];
  pages: Record<string, { id: string; name: string; type: "CANVAS"; children: unknown[] }>;
  components: Record<string, unknown>;
  componentSets: Record<string, unknown>;
  styles: Record<string, unknown>;
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
}

async function getJson(
  origin: string,
  path: string,
  token: string,
  fileKey: string,
  signal?: AbortSignal,
  retry?: RetryPolicy,
): Promise<unknown> {
  for (;;) {
    let res: Response;
    try {
      res = await figmaGet(origin, path, token, signal);
    } catch (cause) {
      throw wrapNetworkError(fileKey, cause);
    }
    if (res.status === 429) {
      const detail = await figmaError(res);
      const waitMs = parseRetryAfterMs(res.headers.get("Retry-After"));
      const maxWait = retry?.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
      if (waitMs === undefined) {
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
    if (!res.ok) {
      throw new Error(`${httpFailureKind(res.status)} for ${fileKey}: ${await figmaError(res)}`);
    }
    try {
      return await res.json();
    } catch {
      throw new Error(`Figma file ${fileKey}: malformed JSON response.`);
    }
  }
}

async function fetchVariables(
  origin: string,
  fileKey: string,
  token: string,
  signal?: AbortSignal,
): Promise<unknown> {
  try {
    const varRes = await figmaGet(origin, `/v1/files/${fileKey}/variables/local`, token, signal);
    if (varRes.ok) return await varRes.json();
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

async function fetchFullFile(
  origin: string,
  fileKey: string,
  token: string,
  signal: AbortSignal | undefined,
  variables: unknown,
  retry?: RetryPolicy,
): Promise<SourceDocument> {
  const file = await getJson(origin, `/v1/files/${fileKey}`, token, fileKey, signal, retry);
  return adaptFile(fileKey, file, variables);
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
  const variablesPromise = fetchVariables(origin, fileKey, token, options.signal);

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
    return adaptFile(fileKey, file, variables);
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

  const saved = options.checkpoint?.load(fileKey);
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
  return adaptFile(
    fileKey,
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
