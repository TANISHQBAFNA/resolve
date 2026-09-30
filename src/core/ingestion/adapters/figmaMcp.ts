import type {
  SourceComponentMeta,
  SourceDocument,
  SourceKind,
  SourceNode,
  SourceStyle,
  SourceVariable,
  SourceVariableCollection,
} from "../types";

/**
 * Figma MCP (Dev Mode server) -> SourceDocument.
 *
 * `get_metadata` returns a compact XML tree — ids, layer types, names,
 * positions, sizes — and nothing else. That is exactly the trade this product
 * exists to exploit: it is one or two orders of magnitude cheaper than reading
 * a design payload, and it is enough to build a traversable graph.
 *
 * What MCP metadata does NOT give us, and how each gap is handled:
 *
 * 1. **No `componentId` on instances in typical `get_metadata`.** The layer
 *    name is only a label. When the XML carries a `componentId`, `componentKey`,
 *    or `data-component-id`, that value is a claim, not a master. It is trusted
 *    only after it resolves to a real library/`<symbol>` master already in the
 *    graph. An id that matches nothing stays a name-only guess — we do not mint
 *    a master named after the raw id. Otherwise instances are grouped by layer
 *    name, tagged `identity: "inferred-from-name"`, and never treated as a
 *    confirmed master. Re-ingest via REST, the plugin, or pass
 *    `get_design_context` so exact ids replace the guess.
 * 2. **No per-node variable bindings.** `get_variable_defs` returns the tokens
 *    used somewhere in the queried subtree, keyed by name, with no ids, no
 *    collection and no consumer. They are attached to the queried root node
 *    with subtree scope rather than being dropped.
 * 3. **No file/page context.** MCP answers about a node subtree, so the graph
 *    is rooted at the queried node. Page and section context arrives when the
 *    same file is ingested through REST or a plugin.
 * 4. **No prototype data.** `PROTOTYPES_TO` needs REST or the plugin API.
 * 5. **No instance overrides / detaches.** `get_metadata` XML has names, types,
 *    and geometry only — no `overrides`, `componentProperties`, or Plugin
 *    `detachedInfo`. SOCI variant proposals that need those signals only fire
 *    after a REST ingest (or when extra nested instances are visible in the
 *    tree). Detach-from-master is skipped; that field is Plugin-API only.
 */

/**
 * One `get_metadata` + `get_variable_defs` pair, for one queried node.
 *
 * MCP answers about a node subtree, so a file is captured one frame at a time.
 * Several captures combine into a single graph: shared components and shared
 * tokens dedupe across them, which is what turns "two screens" into "these two
 * screens both use Input Field".
 */
export interface FigmaMcpCapture {
  /** The node id passed to `get_metadata`. Recorded for provenance only. */
  nodeId?: string;
  metadataXml: string;
  /** Raw tool output — values are stringified on the way in. */
  variableDefs?: Record<string, unknown>;
}

export interface FigmaMcpAdapterInput {
  fileKey: string;
  fileName: string;
  /** Single-capture shorthand. */
  metadataXml?: string;
  /** Single-capture shorthand. */
  variableDefs?: Record<string, unknown>;
  /** Multi-capture form. Takes precedence when present. */
  captures?: FigmaMcpCapture[];
  kind?: SourceKind;
  ingestedAt?: string;
}

/* ------------------------------------------------------------------ *
 * A tiny XML reader
 *
 * The payload is machine-generated, shallow in syntax (no namespaces, no CDATA,
 * no entities beyond the basics) and wrapped in prose the tool adds around it.
 * A dependency-free scanner is both smaller and more predictable here than
 * pulling in a full parser.
 * ------------------------------------------------------------------ */

interface XmlElement {
  tag: string;
  attrs: Record<string, string>;
  children: XmlElement[];
}

const TAG_PATTERN = /<(\/?)([A-Za-z][\w-]*)((?:\s+[\w-]+="[^"]*")*)\s*(\/?)>/g;
const ATTR_PATTERN = /([\w-]+)="([^"]*)"/g;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
};

function decodeEntities(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#39);/g, (match) => ENTITIES[match] ?? match);
}

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_PATTERN.lastIndex = 0;
  let match = ATTR_PATTERN.exec(raw);
  while (match) {
    attrs[match[1]] = decodeEntities(match[2] ?? "");
    match = ATTR_PATTERN.exec(raw);
  }
  return attrs;
}

export function parseMetadataXml(xml: string): XmlElement[] {
  const roots: XmlElement[] = [];
  const stack: XmlElement[] = [];

  TAG_PATTERN.lastIndex = 0;
  let match = TAG_PATTERN.exec(xml);
  while (match) {
    const [, closing, tag, rawAttrs = "", selfClosing] = match;

    if (closing) {
      stack.pop();
    } else {
      const element: XmlElement = { tag: tag!, attrs: parseAttributes(rawAttrs), children: [] };
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(element);
      else roots.push(element);
      if (!selfClosing) stack.push(element);
    }

    match = TAG_PATTERN.exec(xml);
  }

  return roots;
}

/* ------------------------------------------------------------------ *
 * Element name -> raw Figma node type
 * ------------------------------------------------------------------ */

const ELEMENT_TO_FIGMA_TYPE: Record<string, string> = {
  frame: "FRAME",
  instance: "INSTANCE",
  component: "COMPONENT",
  symbol: "COMPONENT",
  "component-set": "COMPONENT_SET",
  component_set: "COMPONENT_SET",
  componentset: "COMPONENT_SET",
  slot: "SLOT",
  group: "GROUP",
  text: "TEXT",
  section: "SECTION",
  page: "CANVAS",
  canvas: "CANVAS",
  document: "DOCUMENT",
  image: "IMAGE",
  video: "VIDEO",
  rectangle: "RECTANGLE",
  "rounded-rectangle": "RECTANGLE",
  ellipse: "ELLIPSE",
  polygon: "POLYGON",
  star: "STAR",
  line: "LINE",
  vector: "VECTOR",
  "boolean-operation": "BOOLEAN_OPERATION",
};

export function figmaTypeForElement(tag: string): string {
  const normalised = tag.toLowerCase();
  return ELEMENT_TO_FIGMA_TYPE[normalised] ?? normalised.toUpperCase().replace(/-/g, "_");
}

/** Figma variant layer name: `Type=Primary` or `Type=Primary, Size=Large`. */
export function isVariantStyleName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed.includes("=")) return false;
  return trimmed.split(",").every((part) => {
    const eq = part.indexOf("=");
    if (eq <= 0) return false;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    return key.length > 0 && value.length > 0;
  });
}

export interface MetadataElement {
  tag: string;
  attrs: Record<string, string>;
  children: MetadataElement[];
}

/**
 * Official Figma MCP `get_metadata` writes sets as `<component-set>`,
 * `<component_set>`, or a `<frame>` whose direct children are all
 * variant-named `<symbol>` / `<component>` nodes.
 */
export function isMetadataComponentSet(element: MetadataElement): boolean {
  const tag = element.tag.toLowerCase();
  if (tag === "component-set" || tag === "component_set" || tag === "componentset") return true;
  if (tag !== "frame") return false;
  if (!element.children.length) return false;
  return element.children.every((child) => {
    const childTag = child.tag.toLowerCase();
    if (childTag !== "symbol" && childTag !== "component") return false;
    return isVariantStyleName(child.attrs["name"] ?? "");
  });
}

/** Synthetic component id for a name-inferred main component. */
export const inferredComponentId = (name: string): string => `mcp-name:${name}`;

/** Real ids we already accept from REST / design-context. Do not invent names. */
export function realComponentIdFromAttrs(attrs: Record<string, string>): string | undefined {
  const lower = new Map(Object.entries(attrs).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of ["componentid", "componentkey", "data-component-id", "component-id"]) {
    const value = lower.get(key)?.trim();
    if (value) return value;
  }
  return undefined;
}

function rememberComponent(
  components: Record<string, SourceComponentMeta>,
  id: string,
  name: string,
  identity: SourceComponentMeta["identity"],
): void {
  const prev = components[id];
  if (!prev) {
    components[id] = { id, name, identity };
    return;
  }
  if (prev.identity === "inferred-from-name" && identity === "id") {
    components[id] = { ...prev, id, name: name === id ? prev.name : name, identity: "id" };
    return;
  }
  if (prev.name === prev.id && name !== id) prev.name = name;
}

function toSourceNode(
  element: XmlElement,
  components: Record<string, SourceComponentMeta>,
  fallbackId: string,
): SourceNode {
  const type = isMetadataComponentSet(element) ? "COMPONENT_SET" : figmaTypeForElement(element.tag);
  const name = element.attrs["name"] ?? "(unnamed)";
  const id = element.attrs["id"]?.trim() || fallbackId;
  const node: SourceNode = {
    id,
    name,
    type,
  };

  const x = Number(element.attrs["x"]);
  const y = Number(element.attrs["y"]);
  const width = Number(element.attrs["width"]);
  const height = Number(element.attrs["height"]);
  if ([x, y, width, height].every((value) => Number.isFinite(value))) {
    node.bounds = { x, y, width, height };
  }

  if (element.attrs["hidden"] === "true") node.visible = false;

  const characters = element.attrs["characters"];
  if (characters) node.characters = characters;
  const sizingVertical = element.attrs["layoutSizingVertical"];
  if (sizingVertical) node.layoutSizingVertical = sizingVertical;
  const sizingHorizontal = element.attrs["layoutSizingHorizontal"];
  if (sizingHorizontal) node.layoutSizingHorizontal = sizingHorizontal;
  const primaryAxis = element.attrs["primaryAxisSizingMode"];
  if (primaryAxis) node.primaryAxisSizingMode = primaryAxis;
  const counterAxis = element.attrs["counterAxisSizingMode"];
  if (counterAxis) node.counterAxisSizingMode = counterAxis;
  const minHeight = Number(element.attrs["minHeight"]);
  if (Number.isFinite(minHeight) && element.attrs["minHeight"]) node.minHeight = minHeight;
  const minWidth = Number(element.attrs["minWidth"]);
  if (Number.isFinite(minWidth) && element.attrs["minWidth"]) node.minWidth = minWidth;

  if (type === "COMPONENT") {
    rememberComponent(components, id, name, "id");
  }

  if (type === "INSTANCE") {
    const realId = realComponentIdFromAttrs(element.attrs);
    if (realId) {
      node.componentId = realId;
      // Claim only. A master node is created when this payload already defines
      // that COMPONENT/SYMBOL, or later when a library master matches the id.
    } else {
      const componentId = inferredComponentId(name);
      node.componentId = componentId;
      if (!components[componentId]) {
        components[componentId] = {
          id: componentId,
          name,
          identity: "inferred-from-name",
        };
      }
    }
  }

  if (element.children.length) {
    node.children = element.children.map((child, index) =>
      toSourceNode(child, components, `${id}/${index}`),
    );
  }

  return node;
}

/* ------------------------------------------------------------------ *
 * Variable definitions
 *
 * `get_variable_defs` flattens variables AND styles into one name -> value map.
 * The value's shape is the only signal for which is which.
 * ------------------------------------------------------------------ */

const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;
const NUMERIC = /^-?\d+(\.\d+)?$/;

export type TokenKind =
  | { kind: "style"; styleType: string }
  | { kind: "variable"; resolvedType: string };

export function classifyTokenValue(value: string): TokenKind {
  if (value.startsWith("Effect(")) return { kind: "style", styleType: "EFFECT" };
  if (value.startsWith("Font(")) return { kind: "style", styleType: "TEXT" };
  // Paint styles have no scalar representation, so MCP sends an empty string.
  if (value === "") return { kind: "style", styleType: "FILL" };
  if (HEX_COLOR.test(value)) return { kind: "variable", resolvedType: "COLOR" };
  if (NUMERIC.test(value)) return { kind: "variable", resolvedType: "FLOAT" };
  if (value === "true" || value === "false") return { kind: "variable", resolvedType: "BOOLEAN" };
  return { kind: "variable", resolvedType: "STRING" };
}

export const MCP_COLLECTION_ID = "mcp:variables";

/** Slot key that survives `styleKindFromSlot` with a readable label. */
function styleSlotKey(styleType: string, name: string): string {
  return `${styleType.toLowerCase()}:${name}`;
}

export function adaptFigmaMcpMetadata(input: FigmaMcpAdapterInput): SourceDocument {
  const captures: FigmaMcpCapture[] =
    input.captures?.length
      ? input.captures
      : [{ metadataXml: input.metadataXml ?? "", variableDefs: input.variableDefs }];

  const components: Record<string, SourceComponentMeta> = {};
  const styles: Record<string, SourceStyle> = {};
  const variables: Record<string, SourceVariable> = {};
  const variableCollections: Record<string, SourceVariableCollection> = {};
  const children: SourceNode[] = [];

  for (const capture of captures) {
    const roots = parseMetadataXml(capture.metadataXml);
    if (!roots.length) continue;

    const captureRoots = roots.map((root, index) =>
      toSourceNode(root, components, `mcp:root:${capture.nodeId ?? index}`),
    );
    children.push(...captureRoots);

    // Tokens are reported per capture, for that capture's subtree.
    const styleIds: Record<string, string> = {};
    const variableIds: Record<string, string> = {};

    for (const [name, rawValue] of Object.entries(capture.variableDefs ?? {})) {
      const value = typeof rawValue === "string" ? rawValue : String(rawValue);
      const token = classifyTokenValue(value);
      const id = `mcp:${name}`;

      if (token.kind === "style") {
        styles[id] = {
          id,
          name,
          styleType: token.styleType,
          description: value || undefined,
        };
        styleIds[styleSlotKey(token.styleType, name)] = id;
        continue;
      }

      if (!variableCollections[MCP_COLLECTION_ID]) {
        variableCollections[MCP_COLLECTION_ID] = {
          id: MCP_COLLECTION_ID,
          name: "Variables (via MCP)",
          modes: [],
        };
      }
      variables[id] = {
        id,
        name,
        collectionId: MCP_COLLECTION_ID,
        resolvedType: token.resolvedType,
        description: value,
      };
      variableIds[name] = id;
    }

    // MCP reports tokens for the whole subtree without saying which node uses
    // which, so they attach to that capture's queried root rather than being
    // invented onto arbitrary children.
    const queriedRoot = captureRoots[0];
    if (queriedRoot) {
      if (Object.keys(styleIds).length) queriedRoot.styleIds = styleIds;
      if (Object.keys(variableIds).length) queriedRoot.variableIds = variableIds;
    }
  }

  if (!children.length) {
    throw new Error("Figma MCP metadata contained no elements. Was `get_metadata` output passed?");
  }

  const root: SourceNode = {
    id: `${input.fileKey}:mcp-root`,
    name: input.fileName,
    type: "DOCUMENT",
    children,
  };

  return {
    fileKey: input.fileKey,
    fileName: input.fileName,
    root,
    components,
    componentSets: {},
    styles,
    variables,
    variableCollections,
    libraries: {},
    source: {
      kind: input.kind ?? "figma-mcp",
      ingestedAt: input.ingestedAt ?? new Date().toISOString(),
    },
  };
}
