/** Figma path prefixes. The component is the next segment. `base` is a sub-part, not a pair. */
export const DEFAULT_FIGMA_NAMESPACES = [
  "ingredients", "ingredient",
  "base", "bases",
  "recipes", "recipe",
  "components", "component",
  "patterns", "pattern",
  "blocks", "primitives",
  "compositions", "composition",
] as const;

const RECIPE = new Set(["recipes", "recipe", "patterns", "pattern", "compositions", "composition"]);
const PART = new Set(["base", "bases"]);

export function namespaceSet(extra?: readonly string[]): Set<string> {
  const list = extra?.length ? extra : DEFAULT_FIGMA_NAMESPACES;
  return new Set(list.map((item) => item.toLowerCase().replace(/\/+$/g, "").trim()).filter(Boolean));
}

export function namespaceHead(name: string, namespaces: ReadonlySet<string> = namespaceSet()): string | undefined {
  const parts = name.split("/").map((part) => part.trim()).filter(Boolean);
  const head = (parts[0] ?? "").toLowerCase();
  return parts.length > 1 && namespaces.has(head) ? head : undefined;
}

export type FigmaFolderKind = "block" | "recipe" | "part";

export function figmaFolderKind(name: string, namespaces: ReadonlySet<string> = namespaceSet()): FigmaFolderKind | undefined {
  const head = namespaceHead(name, namespaces);
  if (!head) return undefined;
  if (PART.has(head)) return "part";
  if (RECIPE.has(head)) return "recipe";
  return "block";
}

/** Full Figma path, case-folded. The mapping key. A prefix alone is not this key. */
export function figmaIdentity(name: string): string {
  return name.split("/").map((part) => part.trim().toLowerCase().replace(/\s+/g, " ")).filter(Boolean).join("/");
}

/** Segment used for matching. A known prefix is removed; `Button/Primary` stays Button. */
export function figmaMatchLabel(name: string, namespaces: ReadonlySet<string> = namespaceSet()): string {
  const parts = name.split("/").map((part) => part.trim()).filter(Boolean);
  const head = (parts[0] ?? "").toLowerCase();
  const body = namespaces.has(head) && parts.length > 1 ? parts.slice(1) : parts;
  return body[0] ?? "";
}
