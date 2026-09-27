import type { GraphNode } from "@/core/model";
import { nodeFileKey } from "./workspaceMerge";

export type PublishState = "published" | "local-only";

/** Fields Figma MCP `use_figma` / `importComponentByKeyAsync` need to place a master. */
export interface PlaceReady {
  nodeId?: string;
  figmaNodeId?: string;
  fileKey?: string;
  componentKey?: string;
  published: boolean;
  publishState: PublishState;
}

export function componentKeyOf(node: GraphNode): string | undefined {
  const key = node.metadata?.["key"];
  return typeof key === "string" && key.trim() ? key.trim() : undefined;
}

export function placeReady(node: GraphNode, graphFileKey?: string): PlaceReady {
  const fileKey = nodeFileKey(node, graphFileKey);
  const nodeId = node.figmaNodeId;
  const componentKey = componentKeyOf(node);
  const published = Boolean(componentKey);
  return {
    ...(nodeId ? { nodeId, figmaNodeId: nodeId } : {}),
    ...(fileKey ? { fileKey } : {}),
    ...(componentKey ? { componentKey } : {}),
    published,
    publishState: published ? "published" : "local-only",
  };
}
