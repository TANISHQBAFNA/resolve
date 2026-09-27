import type { DesignGraph } from "@/core/model";
import {
  applyPublishedCatalog,
  graphFromMetadataXml,
  hashLearnPayload,
  learnGaps,
  mergeDesignGraphs,
  type LearnCheckpoint,
  type LearnInput,
  type LearnResult,
} from "@/core/ingestion/learnLibrary";
import { applyFreshness, emptySock } from "@/core/query/sock";
import {
  loadFileGraph,
  loadLearnCheckpoint,
  loadSock,
  saveIngestedFile,
  saveLearnCheckpoint,
  saveSock,
  storeInfo,
} from "./store";

export function learnLibrary(input: LearnInput): LearnResult {
  const fileKey = input.fileKey.trim();
  if (!fileKey) throw new Error("learn_library needs fileKey.");
  const xml = input.metadataXml?.trim();
  const catalog = input.libraries ?? input.designContext;
  if (!xml && catalog == null) {
    throw new Error(
      "learn_library needs metadataXml from Figma MCP get_metadata, or libraries from search_design_system / get_libraries.",
    );
  }

  const checkpoint = loadLearnCheckpoint(fileKey);
  const hash = xml ? hashLearnPayload(xml) : undefined;
  const resumed = Boolean(input.resume && checkpoint);
  const skippedDuplicate = Boolean(hash && checkpoint?.completedHashes.includes(hash));

  let graph: DesignGraph | undefined;
  let added = 0;
  if (xml && !skippedDuplicate) {
    const incoming = graphFromMetadataXml({
      fileKey,
      fileName: input.fileName ?? input.label,
      metadataXml: xml,
      lastModified: input.lastModified,
      version: input.version,
    });
    const existing = loadFileGraph(fileKey);
    const before = existing?.nodes.length ?? 0;
    graph = existing ? mergeDesignGraphs(existing, incoming) : incoming;
    added = Math.max(0, graph.nodes.length - before);
  } else {
    graph = loadFileGraph(fileKey);
  }

  if (!graph && catalog != null) {
    throw new Error(
      "No graph yet for this fileKey. Pass get_metadata XML first, then libraries to stamp published keys.",
    );
  }
  if (!graph) {
    throw new Error("Nothing new to learn. Pass metadataXml or libraries.");
  }

  if (catalog != null) applyPublishedCatalog(graph, catalog);

  saveIngestedFile(graph, {
    role: input.role,
    label: input.label ?? input.fileName,
  });

  const nextCheckpoint: LearnCheckpoint = {
    fileKey,
    role: input.role,
    completedHashes: hash
      ? [...new Set([...(checkpoint?.completedHashes ?? []), hash])]
      : (checkpoint?.completedHashes ?? []),
    lastAt: new Date().toISOString(),
  };
  saveLearnCheckpoint(nextCheckpoint);

  if (input.lastModified || input.version) {
    const sock = applyFreshness(loadSock() ?? emptySock(), [
      { fileKey, lastModified: input.lastModified, version: input.version },
    ]);
    if (sock.freshness[fileKey]) sock.freshness[fileKey] = { ...sock.freshness[fileKey]!, stale: false };
    saveSock(sock);
  }

  const gaps = learnGaps(graph, catalog != null);
  return {
    learned: true,
    fileKey,
    nodes: graph.nodes.length,
    added,
    resumed,
    skippedDuplicate,
    checkpoint: nextCheckpoint,
    gaps,
    hint: gaps[0]?.hint
      ?? `SOCK updated (${graph.nodes.length} nodes). Next: recipe or recommend. Do not Read graph.json. Store ${storeInfo().path}`,
  };
}
