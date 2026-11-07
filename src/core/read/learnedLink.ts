import { parseFigmaTarget } from "@/core/ingestion/figmaFileKey";
import type { GraphIndex } from "./GraphIndex";
import { nodeFileKey } from "./workspaceMerge";

/** Same sentence as the slash-command bad-link failure. */
export const BAD_FIGMA_LINK =
  "That does not look like a Figma link. Copy the link from the browser address bar. It contains figma.com/design/. A screen link also contains node-id.";

export function learnedFileKeys(index: GraphIndex): Set<string> {
  const keys = new Set<string>();
  const add = (key?: string) => {
    const trimmed = key?.trim().toLowerCase();
    if (trimmed) keys.add(trimmed);
  };
  add(index.graph.fileKey);
  for (const node of index.allNodes) add(nodeFileKey(node, index.graph.fileKey));
  return keys;
}

export type ReadFigmaLink =
  | { ok: true; fileKey: string; nodeIds: string[] }
  | { ok: false; kind: "bad-link" | "not-learned"; message: string };

/**
 * A pasted Figma link. Undefined when the text is not a link.
 * A file key is learned only when this store already has that file.
 */
export function readFigmaLink(index: GraphIndex, input: string): ReadFigmaLink | undefined {
  const trimmed = input.trim();
  if (!/figma\.com\//i.test(trimmed)) return undefined;
  let target;
  try {
    target = parseFigmaTarget(trimmed);
  } catch {
    return { ok: false, kind: "bad-link", message: BAD_FIGMA_LINK };
  }
  if (!target.nodeIds.length) return { ok: false, kind: "bad-link", message: BAD_FIGMA_LINK };
  if (!learnedFileKeys(index).has(target.fileKey.toLowerCase())) {
    return {
      ok: false,
      kind: "not-learned",
      message: `This Figma file is not learned (${target.fileKey}). Run /design-system and paste the link to that file.`,
    };
  }
  return { ok: true, fileKey: target.fileKey, nodeIds: target.nodeIds };
}

export function missingNodeSentence(fileKey: string, nodeId: string): string {
  return `No frame with node-id ${nodeId} in the learned file ${fileKey}.`;
}
