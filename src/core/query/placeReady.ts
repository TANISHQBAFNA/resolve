import type { GraphNode } from "@/core/model";
import { componentKeyOf, nodeFileKey } from "./workspaceMerge";

export type PublishState = "published" | "local-only";

/** Fields a place-ready card and a recipe master share. */
export interface PlaceFields {
  figmaNodeId?: string;
  nodeId?: string;
  fileKey?: string;
  componentKey?: string;
  published?: boolean;
  publishState?: PublishState;
  variantProperties?: Record<string, string>;
}

/** Fields Figma MCP `use_figma` / `importComponentByKeyAsync` need to place a master. */
export interface PlaceReady {
  nodeId?: string;
  figmaNodeId?: string;
  fileKey?: string;
  componentKey?: string;
  published: boolean;
  publishState: PublishState;
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
