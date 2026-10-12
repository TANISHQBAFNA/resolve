import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DesignGraphSchema, type DesignGraph } from "@/core/model";
import { SourceDocumentSchema } from "@/core/ingestion/types";
import { adaptFigmaRestFile } from "@/core/ingestion/adapters/figmaRest";
import { adaptFigmaMcpMetadata } from "@/core/ingestion/adapters/figmaMcp";
import { fetchFigmaRestDocument, figmaAccessToken } from "@/core/ingestion/adapters/figmaRestSource";
import { buildGraph } from "@/core/transform";
import {
  describeRole,
  iconLibraryWarnings,
  indexGraph,
  parseIngestRole,
  WORKSPACE_FILE_ROLES,
  type WorkspaceFileRole,
} from "@/core/query";
import {
  fsIngestCheckpointStore,
  graphPath,
  loadContextBind,
  missingGraphMessage,
  resolveGraph,
  saveIngestedFile,
  storeRoot,
  workspacePath,
} from "./store";

export function readDesignContextFile(path: string): string {
  if (!existsSync(path)) {
    throw new Error(
      `Design context file not found: ${path}. Pass the path to the frame's get_design_context output.`,
    );
  }
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read design context file ${path}. ${detail}`);
  }
}

export function parseTextsFlag(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`--texts must be JSON, for example '{"1:3":"Pay now"}'.`);
  }
}

export function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
}

export function looksLikeMetadataXml(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("{") || trimmed.startsWith("[")) return false;
  return /<(frame|component|component-set|component_set|componentSet|symbol|instance|section|canvas|page)\b/i.test(
    trimmed,
  );
}

export function graphFromMetadataXml(xml: string, args: string[]): DesignGraph {
  return buildGraph(
    adaptFigmaMcpMetadata({
      fileKey: flag(args, "file-key") ?? "local-file",
      fileName: flag(args, "name") ?? flag(args, "file-key") ?? "file",
      metadataXml: xml,
    }),
  );
}

export function toGraph(payload: unknown, args: string[]): DesignGraph {
  const asGraph = DesignGraphSchema.safeParse(payload);
  if (asGraph.success) return asGraph.data;

  const asSource = SourceDocumentSchema.safeParse(payload);
  if (asSource.success) return buildGraph(asSource.data);

  const record = (payload ?? {}) as Record<string, unknown>;
  const fileKey = flag(args, "file-key") ?? (record["fileKey"] as string) ?? "local-file";
  const fileName = flag(args, "name") ?? (record["fileName"] as string) ?? "Untitled";

  if (record["metadataXml"] || record["captures"]) {
    return buildGraph(
      adaptFigmaMcpMetadata({
        fileKey,
        fileName,
        metadataXml: record["metadataXml"] as string | undefined,
        variableDefs: record["variableDefs"] as Record<string, unknown> | undefined,
        captures: record["captures"] as never,
      }),
    );
  }

  if (record["document"]) {
    return buildGraph(
      adaptFigmaRestFile({ fileKey, file: payload, variables: record["variables"] }),
    );
  }

  throw new Error(
    "Unrecognised JSON. Expected a Figma REST file body, an MCP capture, or a graph.",
  );
}

export function ingestRole(args: string[]): WorkspaceFileRole | undefined {
  const at = args.indexOf("--role");
  if (at < 0) return undefined;
  const named = args[at + 1];
  if (!named || named.startsWith("--")) {
    throw new Error(`Unknown --role. Valid roles: ${WORKSPACE_FILE_ROLES.join(", ")}.`);
  }
  return parseIngestRole(named);
}

export function writeStored(graph: DesignGraph, args: string[], target?: string): void {
  const summary = saveIngestedFile(graph, {
    graphId: flag(args, "id"),
    role: ingestRole(args),
    forceRole: args.includes("--force-role"),
    url: target && /^https?:\/\//.test(target) ? target : flag(args, "url"),
    label: flag(args, "label") ?? flag(args, "name"),
  });
  process.stdout.write(
    [
      `Stored ${summary.graphId}`,
      `  file      ${summary.fileName} (${summary.fileKey})`,
      summary.role ? `  role      ${summary.role} — ${describeRole(summary.role)}` : "",
      `  source    ${summary.sourceKind}`,
      `  graph     ${summary.nodes} nodes, ${summary.edges} edges`,
      summary.warnings ? `  warnings  ${summary.warnings}` : "",
      ...iconLibraryWarnings(indexGraph(graph)).map((line) => `  ${line}`),
      `  entry     ${summary.entryPoints.map((entry) => entry.name).join(", ") || "(none)"}`,
      `  workspace ${workspacePath()}`,
      `  graph     ${graphPath()}`,
      "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

function ingestScope(args: string[]): "auto" | "node" | "screens" | "file" {
  const named = flag(args, "scope");
  if (named === "node" || named === "screens" || named === "file" || named === "auto") return named;
  if (args.includes("--whole-file")) return "file";
  return "auto";
}

export async function ingestLive(target: string, args: string[]): Promise<void> {
  const token = figmaAccessToken();
  if (!token) {
    throw new Error("Set FIGMA_ACCESS_TOKEN to ingest a live Figma file.");
  }
  const document = await fetchFigmaRestDocument(target, {
    token,
    scope: ingestScope(args),
    checkpoint: fsIngestCheckpointStore(),
    onProgress: (info) => {
      if (info.phase === "outline") {
        process.stderr.write(`Outlining ${info.name}\n`);
        return;
      }
      if (info.total <= 1 && info.done === 0) return;
      process.stderr.write(`  ${info.done}/${info.total} ${info.name}\n`);
    },
  });
  writeStored(buildGraph(document), args, target);
}

export function requireGraph(args: string[]) {
  const resolved = resolveGraph(flag(args, "id"));
  if (!resolved) {
    throw new Error(missingGraphMessage());
  }
  return resolved;
}

export function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

export function bindFromFlags(args: string[]) {
  return loadContextBind({
    pack: flag(args, "pack"),
    product: flag(args, "product"),
    journey: flag(args, "journey"),
    domain: flag(args, "domain"),
    audience: flag(args, "audience"),
    a11y: flag(args, "a11y"),
    packsFile: flag(args, "packs"),
  });
}

/** Entries of the code map on disk, as written (good or bad). A file that is not a map gives none. */
export function existingEntries(path: string): unknown[] {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "").trim() || "{}") as { entries?: unknown };
    return Array.isArray(raw.entries) ? raw.entries : [];
  } catch {
    return [];
  }
}

let jsonPretty = false;

export function printJson(value: unknown): void {
  const text = jsonPretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  process.stdout.write(`${text}\n`);
}

export function defaultGoldenDir(): string {
  const stored = join(storeRoot(), "scoreboard", "golden");
  if (existsSync(stored)) return stored;
  return resolve("scoreboard/golden");
}

export function setJsonPretty(next: boolean): boolean {
  const previous = jsonPretty;
  jsonPretty = next;
  return previous;
}
