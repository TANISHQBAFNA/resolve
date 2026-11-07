/** Short strings and node stamps shared by inventory, verify, and recommend cards. */
import type { GraphNode } from "@/core/model";

export const briefNode = (node: GraphNode) => ({
  id: node.id,
  name: node.name,
  type: node.type,
  figmaNodeId: node.figmaNodeId,
  status: node.status,
  owner: node.owner,
});
/** Explicit card marker. Guessed identity is never a confirmed component. */
export const LAYER_NAME_GUESS = "guess from layer name, not confirmed";
export const EXACT_COMPONENT_HINT =
  "Add a Figma access token (or use the design-context read) to get exact components";
