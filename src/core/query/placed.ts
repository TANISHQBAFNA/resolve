import type { GraphNode } from "@/core/model";
import type { GraphIndex } from "./GraphIndex";

export function isHiddenLayer(node: GraphNode): boolean {
  return node.metadata?.["hidden"] === true;
}

/** This layer, or an ancestor short of stopId, is hidden. */
export function hiddenUnder(index: GraphIndex, node: GraphNode, stopId?: string): boolean {
  let at: GraphNode | undefined = node;
  while (at && at.id !== stopId) {
    if (isHiddenLayer(at)) return true;
    at = at.parentId ? index.getNode(at.parentId) : undefined;
  }
  return false;
}

export function isFigmaSlot(node: GraphNode): boolean {
  return node.metadata?.["figmaType"] === "SLOT" || node.metadata?.["slot"] === true;
}

/**
 * Instances a designer placed on a screen frame.
 * An instance inside a Figma slot counts: the designer put it there.
 * An instance that belongs to the component, and is not in a slot, does not.
 * Hidden instances are left out.
 * A screen that is itself one instance stays that one instance.
 */
export function designerPlacedInstances(index: GraphIndex, frameId: string): GraphNode[] {
  const self = index.getNode(frameId);
  if (!self) return [];
  if (self.type === "COMPONENT_INSTANCE") return hiddenUnder(index, self) ? [] : [self];
  const out: GraphNode[] = [];
  const walkLayer = (parentId: string) => {
    for (const child of index.getChildren(parentId)) {
      if (hiddenUnder(index, child, parentId)) continue;
      if (child.type === "COMPONENT_INSTANCE") {
        out.push(child);
        walkSlots(child.id);
        continue;
      }
      walkLayer(child.id);
    }
  };
  const walkSlots = (instanceId: string) => {
    for (const child of index.getChildren(instanceId)) {
      if (hiddenUnder(index, child, instanceId)) continue;
      if (isFigmaSlot(child)) {
        walkLayer(child.id);
        continue;
      }
      if (child.type !== "COMPONENT_INSTANCE") walkSlots(child.id);
    }
  };
  walkLayer(frameId);
  return out;
}
