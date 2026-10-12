import type { GraphNode } from "@/core/model/graph";

/** Letters and digits only, lowercased. Scoreboard and recommend share this fold. */
export function collapseName(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Recommend still calls the fold by this name. */
export const collapsedName = collapseName;

/** Library names compared with surrounding space collapsed. */
export function foldLibName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Leading "." or "_" hides a master. A variant after " / " can hide the same way. */
export function isPrivateMasterName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.startsWith(".") || trimmed.startsWith("_")) return true;
  const variant = trimmed.split(" / ").at(-1)?.trim() ?? "";
  return variant !== trimmed && (variant.startsWith(".") || variant.startsWith("_"));
}

/** Instance layer names guessed by MCP (`mcp-name:`) are not library masters. */
export function isNameInferredMaster(node: GraphNode): boolean {
  if (node.metadata?.["identity"] === "inferred-from-name") return true;
  const id = `${node.id} ${node.figmaNodeId ?? ""}`;
  return id.includes("mcp-name:");
}

/**
 * Tokens longer than one character, with no stopword list.
 * Ranking tokenizers that drop stopwords stay next to the ranker.
 */
export function nameTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 1);
}
