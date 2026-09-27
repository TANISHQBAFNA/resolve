import type { DesignGraph } from "@/core/model";
import {
  applyPublishedCatalog,
  extractLearnUnits,
  graphFromMetadataXml,
  hashLearnPayload,
  learnGaps,
  learnProgressLine,
  markRemovedByAbsence,
  mastersFromGraph,
  mergeDesignGraphs,
  remainingLearnUnits,
  uniqueLearnUnits,
  type LearnCheckpoint,
  type LearnInput,
  type LearnResult,
  type LearnUnit,
  type LearnUnitMaster,
} from "@/core/ingestion/learnLibrary";
import { applyFreshness, emptySock, type RemovedMaster } from "@/core/query/sock";
import {
  loadFileGraph,
  loadLearnCheckpoint,
  loadSock,
  saveIngestedFile,
  saveLearnCheckpoint,
  saveSock,
  storeInfo,
} from "./store";

function checkpointVersionMismatch(checkpoint: LearnCheckpoint | undefined, input: LearnInput): boolean {
  if (!checkpoint) return false;
  if (input.version && checkpoint.version && input.version !== checkpoint.version) return true;
  if (input.lastModified && checkpoint.lastModified && input.lastModified !== checkpoint.lastModified) {
    return true;
  }
  return false;
}

function normalizeCheckpoint(raw: LearnCheckpoint | undefined, fileKey: string): LearnCheckpoint | undefined {
  if (!raw) return undefined;
  return {
    ...raw,
    fileKey,
    completedHashes: raw.completedHashes ?? [],
    completedUnits: raw.completedUnits ?? [],
    outline: raw.outline ?? [],
    mastersByUnit: raw.mastersByUnit ?? {},
  };
}

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

  const checkpoint = normalizeCheckpoint(loadLearnCheckpoint(fileKey), fileKey);
  const versionMismatch = checkpointVersionMismatch(checkpoint, input);
  const hash = xml ? hashLearnPayload(xml) : undefined;
  const resumed = Boolean(input.resume && checkpoint && !versionMismatch);
  const skippedDuplicate = Boolean(
    hash && !versionMismatch && checkpoint?.completedHashes.includes(hash),
  );

  const extracted = xml ? extractLearnUnits(xml) : [];
  const priorCompleted = versionMismatch ? [] : (checkpoint?.completedUnits ?? []);
  const outline = uniqueLearnUnits([
    ...(input.outline ?? []),
    ...(checkpoint?.outline ?? []),
    ...extracted,
  ]);

  let graph: DesignGraph | undefined;
  let added = 0;
  let incomingMasters: LearnUnitMaster[] = [];
  if (xml && !skippedDuplicate) {
    const incoming = graphFromMetadataXml({
      fileKey,
      fileName: input.fileName ?? input.label,
      metadataXml: xml,
      lastModified: input.lastModified,
      version: input.version,
    });
    incomingMasters = mastersFromGraph(incoming, fileKey);
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

  const removed: RemovedMaster[] = [];
  if (xml && !skippedDuplicate && extracted.length) {
    const priorMastersByUnit = checkpoint?.mastersByUnit ?? {};
    for (const unit of extracted) {
      const previous = priorMastersByUnit[unit.id];
      if (!previous?.length) continue;
      const missing = previous.filter(
        (prev) =>
          !incomingMasters.some(
            (row) =>
              row.id === prev.id || (prev.figmaNodeId && row.figmaNodeId === prev.figmaNodeId),
          ),
      );
      for (const node of markRemovedByAbsence(graph, missing)) {
        if (removed.some((row) => row.id === node.id)) continue;
        removed.push({
          id: node.id,
          name: node.name,
          figmaNodeId: node.figmaNodeId,
          reason: "deprecated-by-absence",
        });
      }
    }
  }

  saveIngestedFile(graph, {
    role: input.role,
    label: input.label ?? input.fileName,
  });

  const completedUnits = uniqueLearnUnits([
    ...priorCompleted,
    ...extracted,
  ]);
  const remaining = remainingLearnUnits(outline, completedUnits);
  const learnedCount = completedUnits.length;
  const totalCount = Math.max(outline.length, learnedCount);
  const next = remaining[0];
  const hasFullOutline = Boolean(input.outline?.length) || Boolean(checkpoint?.hasFullOutline && !versionMismatch);
  const completeKnown = hasFullOutline && remaining.length === 0;
  const progress = learnProgressLine(learnedCount, totalCount, next, completeKnown);

  const mastersByUnit: Record<string, LearnUnitMaster[]> = {
    ...(versionMismatch ? {} : (checkpoint?.mastersByUnit ?? {})),
  };
  if (xml && !skippedDuplicate) {
    for (const unit of extracted) {
      mastersByUnit[unit.id] = incomingMasters;
    }
  }

  const nextCheckpoint: LearnCheckpoint = {
    fileKey,
    role: input.role,
    completedHashes: hash
      ? [...new Set([...(versionMismatch ? [] : (checkpoint?.completedHashes ?? [])), hash])]
      : versionMismatch
        ? []
        : (checkpoint?.completedHashes ?? []),
    completedUnits,
    outline,
    mastersByUnit,
    hasFullOutline,
    version: input.version ?? (versionMismatch ? undefined : checkpoint?.version),
    lastModified: input.lastModified ?? (versionMismatch ? undefined : checkpoint?.lastModified),
    lastAt: new Date().toISOString(),
  };
  saveLearnCheckpoint(nextCheckpoint);

  const sock = applyFreshness(loadSock() ?? emptySock(), [
    {
      fileKey,
      lastModified: input.lastModified,
      version: input.version,
      outline: outline.map((unit: LearnUnit) => ({ id: unit.id, name: unit.name, kind: unit.kind })),
      stale: false,
      removed: removed.length
        ? [...(loadSock()?.freshness[fileKey]?.removed ?? []), ...removed]
        : undefined,
    },
  ]);
  const row = sock.freshness[fileKey];
  if (row) {
    sock.freshness[fileKey] = {
      ...row,
      stale: false,
      delta: remaining.map((unit) => ({
        id: unit.id,
        name: unit.name,
        kind: unit.kind,
        action: "refetch" as const,
      })),
      removed: removed.length ? [...(row.removed ?? []), ...removed] : row.removed,
    };
  }
  saveSock(sock);

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
    learnedCount,
    totalCount,
    remaining,
    next,
    progress,
    hint: gaps[0]?.hint ?? `${progress}. SOCK updated (${graph.nodes.length} nodes). Next: recipe or recommend. Do not Read graph.json. Store ${storeInfo().path}`,
  };
}
