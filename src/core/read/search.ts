import { NODE_TYPES, type GraphNode, type NodeType } from "@/core/model";
import type { GraphIndex } from "./GraphIndex";
import { computeAnalytics, type GraphAnalytics } from "./analytics";

/**
 * A tiny, predictable query language.
 *
 *   Button                       free text, matches names
 *   type:instance Button         node type + free text
 *   type:component used-in:Checkout
 *   page:Payments
 *   instance-of:Button
 *   variable:color
 *   is:remote
 *   unused-components            macro
 *
 * All terms are AND-ed. Unknown keys are treated as free text rather than
 * failing, so a half-typed query still returns something useful.
 */

export const SEARCH_KEYS = [
  "type",
  "name",
  "page",
  "section",
  "frame",
  "instance-of",
  "used-in",
  "style",
  "variable",
  "library",
  "is",
] as const;
export type SearchKey = (typeof SEARCH_KEYS)[number];

export const SEARCH_MACROS = [
  "unused-components",
  "orphaned-frames",
  "unresolved-instances",
  "frames-without-components",
  "unused-styles",
  "unused-variables",
  "deprecated-components",
] as const;
export type SearchMacro = (typeof SEARCH_MACROS)[number];

export interface SearchTerm {
  key: SearchKey;
  value: string;
  negated: boolean;
}

export interface ParsedQuery {
  raw: string;
  text: string[];
  terms: SearchTerm[];
  macros: SearchMacro[];
}

export interface SearchResult {
  node: GraphNode;
  score: number;
  matchedOn: string[];
}

/** Human shorthand -> concrete node types. */
const TYPE_ALIASES: Record<string, NodeType[]> = {
  file: ["FILE"],
  page: ["PAGE"],
  section: ["SECTION"],
  frame: ["FRAME"],
  screen: ["FRAME"],
  autolayout: ["AUTO_LAYOUT_CONTAINER"],
  "auto-layout": ["AUTO_LAYOUT_CONTAINER"],
  group: ["GROUP"],
  layer: ["LAYER"],
  text: ["TEXT_LAYER"],
  media: ["MEDIA_LAYER"],
  image: ["MEDIA_LAYER"],
  instance: ["COMPONENT_INSTANCE"],
  component: ["MAIN_COMPONENT", "VARIANT", "COMPONENT_SET"],
  main: ["MAIN_COMPONENT"],
  variant: ["VARIANT"],
  set: ["COMPONENT_SET"],
  "component-set": ["COMPONENT_SET"],
  style: ["STYLE"],
  variable: ["VARIABLE"],
  collection: ["VARIABLE_COLLECTION"],
  library: ["EXTERNAL_LIBRARY"],
  annotation: ["ANNOTATION"],
};

export function resolveTypeAlias(value: string): NodeType[] {
  const normalised = value.trim().toLowerCase();
  const upper = normalised.toUpperCase().replace(/-/g, "_") as NodeType;
  if ((NODE_TYPES as readonly string[]).includes(upper)) return [upper];
  return TYPE_ALIASES[normalised] ?? [];
}

const TOKEN_PATTERN = /"[^"]*"|\S+/g;

export function parseSearchQuery(raw: string): ParsedQuery {
  const parsed: ParsedQuery = { raw, text: [], terms: [], macros: [] };
  const tokens = raw.match(TOKEN_PATTERN) ?? [];

  for (const token of tokens) {
    const bare = token.replace(/^"|"$/g, "");
    const negated = bare.startsWith("-");
    const body = negated ? bare.slice(1) : bare;
    if (!body) continue;

    if ((SEARCH_MACROS as readonly string[]).includes(body.toLowerCase())) {
      parsed.macros.push(body.toLowerCase() as SearchMacro);
      continue;
    }

    const separator = body.indexOf(":");
    if (separator > 0) {
      const key = body.slice(0, separator).toLowerCase();
      const value = body.slice(separator + 1).replace(/^"|"$/g, "");
      if ((SEARCH_KEYS as readonly string[]).includes(key) && value) {
        parsed.terms.push({ key: key as SearchKey, value, negated });
        continue;
      }
    }
    parsed.text.push(body);
  }

  return parsed;
}

const contains = (haystack: string | undefined, needle: string): boolean =>
  Boolean(haystack && haystack.toLowerCase().includes(needle.toLowerCase()));

/** Does any node on this node's hierarchy path match `value`? */
function locationMatches(index: GraphIndex, node: GraphNode, value: string): boolean {
  return index.getHierarchyPath(node.id).some((ancestor) => contains(ancestor.name, value));
}

function matchesTerm(
  index: GraphIndex,
  node: GraphNode,
  term: SearchTerm,
  analytics: GraphAnalytics,
): boolean {
  const { key, value } = term;

  switch (key) {
    case "type":
      return resolveTypeAlias(value).includes(node.type);

    case "name":
      return contains(node.name, value);

    case "page": {
      const page = node.pageId ? index.getNode(node.pageId) : undefined;
      return contains(page?.name, value);
    }

    case "section": {
      const section = node.sectionId ? index.getNode(node.sectionId) : undefined;
      return contains(section?.name, value);
    }

    case "frame": {
      const frame = index.getContainingFrame(node.id);
      return contains(frame?.name, value);
    }

    case "instance-of": {
      if (!node.isInstance) return false;
      const main = index.getMainComponent(node.id);
      if (!main) return false;
      if (contains(main.name, value)) return true;
      const set = main.componentSetId ? index.getNode(main.componentSetId) : undefined;
      return contains(set?.name, value);
    }

    case "used-in": {
      // For a component definition: is it used anywhere inside a matching
      // container? For anything else: does it live inside one?
      const definitions: NodeType[] = ["MAIN_COMPONENT", "VARIANT", "COMPONENT_SET"];
      if (definitions.includes(node.type)) {
        return index
          .getAllInstancesOf(node.id)
          .some((instance) => locationMatches(index, instance, value));
      }
      return locationMatches(index, node, value);
    }

    case "style": {
      if (node.type === "STYLE") return contains(node.name, value);
      return (node.styleIds ?? []).some((id) => contains(index.getNode(id)?.name, value));
    }

    case "variable": {
      if (node.type === "VARIABLE") {
        return (
          contains(node.name, value) ||
          contains(String(node.metadata?.["resolvedType"] ?? ""), value)
        );
      }
      if (node.type === "VARIABLE_COLLECTION") return contains(node.name, value);
      return (node.variableIds ?? []).some((id) => {
        const variable = index.getNode(id);
        return (
          contains(variable?.name, value) ||
          contains(String(variable?.metadata?.["resolvedType"] ?? ""), value)
        );
      });
    }

    case "library": {
      if (node.type === "EXTERNAL_LIBRARY") return contains(node.name, value);
      const library = node.libraryId ? index.getNode(node.libraryId) : undefined;
      return contains(library?.name, value);
    }

    case "is": {
      switch (value.toLowerCase()) {
        case "main":
        case "component":
          return Boolean(node.isMainComponent);
        case "instance":
          return Boolean(node.isInstance);
        case "remote":
        case "external":
          return Boolean(node.isRemote);
        case "local":
          return !node.isRemote;
        case "unused":
          return analytics.unusedComponents.some((candidate) => candidate.id === node.id);
        case "orphan":
        case "orphaned":
          return analytics.orphanedFrames.some((candidate) => candidate.id === node.id);
        case "unresolved":
          return analytics.unresolvedInstances.some((candidate) => candidate.id === node.id);
        case "prototyped":
          return index.getEdges(node.id, { edgeTypes: ["PROTOTYPES_TO"] }).length > 0;
        case "deprecated":
          return node.status === "deprecated";
        case "draft":
          return node.status === "draft";
        case "approved":
          return node.status === "approved";
        case "experimental":
          return node.status === "experimental";
        default:
          return false;
      }
    }

    default:
      return false;
  }
}

function macroNodes(macro: SearchMacro, analytics: GraphAnalytics, index: GraphIndex): GraphNode[] {
  switch (macro) {
    case "unused-components":
      return analytics.unusedComponents;
    case "orphaned-frames":
      return analytics.orphanedFrames;
    case "unresolved-instances":
      return analytics.unresolvedInstances;
    case "frames-without-components":
      return analytics.framesWithoutComponents;
    case "unused-styles":
      return analytics.unusedStyles;
    case "unused-variables":
      return analytics.unusedVariables;
    case "deprecated-components":
      return index.allNodes.filter(
        (node) =>
          node.status === "deprecated" &&
          (node.type === "COMPONENT_SET" ||
            node.type === "MAIN_COMPONENT" ||
            node.type === "VARIANT"),
      );
    default:
      return [];
  }
}

/** Small nudge so pages and components outrank deep vector layers. */
const TYPE_WEIGHT: Partial<Record<NodeType, number>> = {
  FILE: 6,
  PAGE: 5,
  SECTION: 4,
  FRAME: 4,
  COMPONENT_SET: 4,
  MAIN_COMPONENT: 4,
  VARIANT: 3,
  COMPONENT_INSTANCE: 3,
  STYLE: 2,
  VARIABLE: 2,
  VARIABLE_COLLECTION: 2,
  EXTERNAL_LIBRARY: 2,
};

export interface SearchOptions {
  limit?: number;
  analytics?: GraphAnalytics;
  /** Restrict the candidate set (e.g. to the current filter selection). */
  candidates?: readonly GraphNode[];
}

export function searchNodes(
  index: GraphIndex,
  rawQuery: string,
  options: SearchOptions = {},
): SearchResult[] {
  const parsed = parseSearchQuery(rawQuery);
  const analytics = options.analytics ?? computeAnalytics(index);
  const limit = options.limit ?? 200;

  let candidates: readonly GraphNode[] = options.candidates ?? index.allNodes;

  if (parsed.macros.length) {
    const macroSets = parsed.macros.map((macro) => new Set(macroNodes(macro, analytics, index).map((n) => n.id)));
    candidates = candidates.filter((node) => macroSets.every((set) => set.has(node.id)));
  }

  const results: SearchResult[] = [];

  for (const node of candidates) {
    const matchedOn: string[] = [];
    let ok = true;

    for (const term of parsed.terms) {
      const matched = matchesTerm(index, node, term, analytics);
      if (matched === term.negated) {
        ok = false;
        break;
      }
      if (matched) matchedOn.push(`${term.key}:${term.value}`);
    }
    if (!ok) continue;

    let score = TYPE_WEIGHT[node.type] ?? 1;

    for (const text of parsed.text) {
      const needle = text.toLowerCase();
      const name = node.name.toLowerCase();
      if (name === needle) {
        score += 40;
        matchedOn.push("name");
      } else if (name.startsWith(needle)) {
        score += 20;
        matchedOn.push("name");
      } else if (name.includes(needle)) {
        score += 10;
        matchedOn.push("name");
      } else if (contains(node.description, needle)) {
        score += 4;
        matchedOn.push("description");
      } else if (node.figmaNodeId?.toLowerCase() === needle) {
        score += 30;
        matchedOn.push("figmaNodeId");
      } else if (node.type.toLowerCase().includes(needle)) {
        score += 3;
        matchedOn.push("type");
      } else {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    score += parsed.terms.length * 2 + parsed.macros.length * 5;
    results.push({ node, score, matchedOn: [...new Set(matchedOn)] });
  }

  return results
    .sort((a, b) => b.score - a.score || a.node.name.localeCompare(b.node.name))
    .slice(0, limit);
}

export function isEmptyQuery(rawQuery: string): boolean {
  const parsed = parseSearchQuery(rawQuery);
  return !parsed.text.length && !parsed.terms.length && !parsed.macros.length;
}
