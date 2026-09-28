import { z } from "zod";
import type {
  SourceDocument,
  SourceLink,
  SourceNode,
  SourceStyle,
  SourceVariable,
  SourceVariableCollection,
  SourceComponentMeta,
  SourceLibrary,
  SourceKind,
} from "../types";

/**
 * Figma REST -> SourceDocument.
 *
 * Validation is deliberately shallow. The REST payload for a node has dozens
 * of optional fields that change between API versions; validating all of them
 * would make ingestion fail on files it could otherwise read. We assert the
 * handful of fields the graph actually depends on and treat everything else as
 * opaque.
 */

const RawFileSchema = z
  .object({
    name: z.string(),
    lastModified: z.string().optional(),
    version: z.string().optional(),
    thumbnailUrl: z.string().optional(),
    document: z.object({ id: z.string(), type: z.string() }).passthrough(),
    components: z.record(z.unknown()).optional(),
    componentSets: z.record(z.unknown()).optional(),
    styles: z.record(z.unknown()).optional(),
  })
  .passthrough();

/** Shape of `GET /v1/files/:key/variables/local` (Enterprise only). */
const RawVariablesSchema = z
  .object({
    meta: z
      .object({
        variables: z.record(z.unknown()).optional(),
        variableCollections: z.record(z.unknown()).optional(),
      })
      .optional(),
  })
  .passthrough();

export const UNKNOWN_LIBRARY_ID = "external-unknown";
export const UNKNOWN_LIBRARY_NAME = "External libraries (source unknown)";

export interface FigmaRestAdapterInput {
  fileKey: string;
  /** Body of `GET /v1/files/:file_key`. */
  file: unknown;
  /** Body of `GET /v1/files/:file_key/variables/local`, when available. */
  variables?: unknown;
  kind?: SourceKind;
  ingestedAt?: string;
}

type AnyRecord = Record<string, unknown>;

const asRecord = (v: unknown): AnyRecord => (v && typeof v === "object" ? (v as AnyRecord) : {});
const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const asNumber = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const asBool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * Figma serialises variant names as `Prop=Value, Prop2=Value2`. That format is
 * defined by Figma, not by the user's naming conventions, so parsing it is safe
 * for any file.
 */
export function parseVariantName(name: string): Record<string, string> | undefined {
  if (!name.includes("=")) return undefined;
  const props: Record<string, string> = {};
  for (const part of name.split(",")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) props[key] = value;
  }
  return Object.keys(props).length ? props : undefined;
}

/** `boundVariables` values are aliases or arrays of aliases. */
function collectBoundVariables(raw: AnyRecord): Record<string, string> | undefined {
  const bound = asRecord(raw["boundVariables"]);
  const out: Record<string, string> = {};
  for (const [prop, value] of Object.entries(bound)) {
    if (Array.isArray(value)) {
      value.forEach((entry, i) => {
        const id = asString(asRecord(entry)["id"]);
        if (id) out[`${prop}[${i}]`] = id;
      });
      continue;
    }
    const id = asString(asRecord(value)["id"]);
    if (id) out[prop] = id;
  }
  return Object.keys(out).length ? out : undefined;
}

function collectStyleIds(raw: AnyRecord): Record<string, string> | undefined {
  const styles = asRecord(raw["styles"]);
  const out: Record<string, string> = {};
  for (const [slot, value] of Object.entries(styles)) {
    if (Array.isArray(value)) {
      value.forEach((entry, i) => {
        const id = asString(entry);
        if (id) out[`${slot}[${i}]`] = id;
      });
      continue;
    }
    const id = asString(value);
    if (id) out[slot] = id;
  }
  return Object.keys(out).length ? out : undefined;
}

function hasImageFill(raw: AnyRecord): boolean {
  return asArray(raw["fills"]).some((fill) => asString(asRecord(fill)["type"]) === "IMAGE");
}

/** REST exposes a single transition per node; the Plugin API exposes many. */
function collectTransitions(raw: AnyRecord): SourceNode["transitions"] {
  const out: NonNullable<SourceNode["transitions"]> = [];

  const destination = asString(raw["transitionNodeID"]);
  if (destination) {
    out.push({
      destinationId: destination,
      trigger: asString(asRecord(raw["interactionTrigger"])["type"]) ?? "ON_CLICK",
      action: "NAVIGATE",
      // REST reports transition duration in seconds; the graph stores ms.
      durationMs: (() => {
        const seconds = asNumber(raw["transitionDuration"]);
        return seconds === undefined ? undefined : Math.round(seconds * 1000);
      })(),
      easing: asString(raw["transitionEasing"]),
    });
  }

  // Plugin/MCP-shaped `reactions`, when the source provides them.
  for (const reaction of asArray(raw["reactions"])) {
    const r = asRecord(reaction);
    const action = asRecord(r["action"]);
    const destinationId = asString(action["destinationId"]);
    if (!destinationId) continue;
    out.push({
      destinationId,
      trigger: asString(asRecord(r["trigger"])["type"]) ?? "ON_CLICK",
      action: asString(action["navigation"]) ?? asString(action["type"]) ?? "NAVIGATE",
      durationMs: asNumber(asRecord(action["transition"])["duration"]),
      easing: asString(asRecord(asRecord(action["transition"])["easing"])["type"]),
    });
  }

  const deduped = new Map(out.map((t) => [`${t.destinationId}|${t.trigger}`, t]));
  return deduped.size ? [...deduped.values()] : undefined;
}

const FIGMA_NODE_ID_IN_URL = /node-id=([0-9]+[-:][0-9]+)/i;

function normaliseLink(url: string, label?: string): SourceLink {
  const match = FIGMA_NODE_ID_IN_URL.exec(url);
  const link: SourceLink = { url };
  if (label) link.label = label;
  if (match?.[1]) link.targetFigmaNodeId = match[1].replace("-", ":");
  return link;
}

function collectLinks(raw: AnyRecord): SourceLink[] | undefined {
  const links: SourceLink[] = [];

  const nodeHyperlink = asRecord(asRecord(raw["style"])["hyperlink"]);
  const nodeUrl = asString(nodeHyperlink["url"]);
  if (nodeUrl) links.push(normaliseLink(nodeUrl));

  for (const override of Object.values(asRecord(raw["styleOverrideTable"]))) {
    const url = asString(asRecord(asRecord(override)["hyperlink"])["url"]);
    if (url) links.push(normaliseLink(url));
  }

  for (const entry of asArray(raw["documentationLinks"])) {
    const url = asString(asRecord(entry)["uri"]) ?? asString(asRecord(entry)["url"]);
    if (url) links.push(normaliseLink(url, "Documentation"));
  }

  const deduped = new Map(links.map((l) => [l.url, l]));
  return deduped.size ? [...deduped.values()] : undefined;
}

function collectAnnotations(raw: AnyRecord): SourceNode["annotations"] {
  const out: NonNullable<SourceNode["annotations"]> = [];
  for (const entry of asArray(raw["annotations"])) {
    const a = asRecord(entry);
    const label = asString(a["label"]) ?? asString(a["labelMarkdown"]);
    if (!label) continue;
    const annotation: NonNullable<SourceNode["annotations"]>[number] = { label };
    const id = asString(a["id"]);
    if (id) annotation.id = id;
    // REST sends `properties` as `[{ type: "width" }, ...]`; the Plugin API
    // sends a plain object. Both collapse to a name -> value record.
    const props: Record<string, string> = {};
    const rawProps = a["properties"];
    if (Array.isArray(rawProps)) {
      for (const entry of rawProps) {
        const type = asString(asRecord(entry)["type"]);
        if (type) props[type] = asString(asRecord(entry)["value"]) ?? "true";
      }
    } else {
      for (const [k, v] of Object.entries(asRecord(rawProps))) {
        const value = asString(v) ?? asString(asRecord(v)["type"]);
        if (value) props[k] = value;
      }
    }
    if (Object.keys(props).length) annotation.properties = props;
    out.push(annotation);
  }
  return out.length ? out : undefined;
}

interface WalkOptions {
  maxDepth: number;
  onTruncate: () => void;
}

function walkNode(
  raw: AnyRecord,
  parentType: string | undefined,
  depth: number,
  options: WalkOptions,
): SourceNode {
  const type = asString(raw["type"]) ?? "UNKNOWN";
  const name = asString(raw["name"]) ?? "(unnamed)";

  const node: SourceNode = { id: asString(raw["id"]) ?? "", name, type };

  const visible = asBool(raw["visible"]);
  if (visible === false) node.visible = false;

  const description = asString(raw["description"]);
  if (description) node.description = description;

  const componentId = asString(raw["componentId"]);
  if (componentId) node.componentId = componentId;

  const componentSetId = asString(raw["componentSetId"]);
  if (componentSetId) node.componentSetId = componentSetId;

  if (type === "COMPONENT" && parentType === "COMPONENT_SET") {
    const variantProperties = parseVariantName(name);
    if (variantProperties) node.variantProperties = variantProperties;
  }

  const componentProperties = asRecord(raw["componentProperties"]);
  if (Object.keys(componentProperties).length) node.componentProperties = componentProperties;

  const overrides = asArray(raw["overrides"])
    .map((item) => {
      const rec = asRecord(item);
      const id = asString(rec["id"]);
      const overriddenFields = asArray(rec["overriddenFields"]).filter(
        (field): field is string => typeof field === "string" && field.trim().length > 0,
      );
      if (!id && !overriddenFields.length) return undefined;
      return {
        ...(id ? { id } : {}),
        ...(overriddenFields.length ? { overriddenFields } : {}),
      };
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row));
  if (overrides.length) node.overrides = overrides;

  const box = asRecord(raw["absoluteBoundingBox"]);
  const x = asNumber(box["x"]);
  const y = asNumber(box["y"]);
  const width = asNumber(box["width"]);
  const height = asNumber(box["height"]);
  if (x !== undefined && y !== undefined && width !== undefined && height !== undefined) {
    node.bounds = { x, y, width, height };
  }

  const layoutMode = asString(raw["layoutMode"]);
  if (layoutMode && layoutMode !== "NONE") node.layoutMode = layoutMode;
  const characters = asString(raw["characters"]);
  if (characters) node.characters = characters;
  const layoutSizingHorizontal = asString(raw["layoutSizingHorizontal"]);
  if (layoutSizingHorizontal) node.layoutSizingHorizontal = layoutSizingHorizontal;
  const layoutSizingVertical = asString(raw["layoutSizingVertical"]);
  if (layoutSizingVertical) node.layoutSizingVertical = layoutSizingVertical;
  const primaryAxisSizingMode = asString(raw["primaryAxisSizingMode"]);
  if (primaryAxisSizingMode) node.primaryAxisSizingMode = primaryAxisSizingMode;
  const counterAxisSizingMode = asString(raw["counterAxisSizingMode"]);
  if (counterAxisSizingMode) node.counterAxisSizingMode = counterAxisSizingMode;
  const minHeight = asNumber(raw["minHeight"]);
  if (minHeight !== undefined) node.minHeight = minHeight;
  const minWidth = asNumber(raw["minWidth"]);
  if (minWidth !== undefined) node.minWidth = minWidth;
  if (hasImageFill(raw)) node.hasImageFill = true;

  const styleIds = collectStyleIds(raw);
  if (styleIds) node.styleIds = styleIds;

  const variableIds = collectBoundVariables(raw);
  if (variableIds) node.variableIds = variableIds;

  const transitions = collectTransitions(raw);
  if (transitions) node.transitions = transitions;

  const links = collectLinks(raw);
  if (links) node.links = links;

  const annotations = collectAnnotations(raw);
  if (annotations) node.annotations = annotations;

  const rawChildren = asArray(raw["children"]);
  if (rawChildren.length) {
    if (depth >= options.maxDepth) {
      options.onTruncate();
    } else {
      node.children = rawChildren.map((child) =>
        walkNode(asRecord(child), type, depth + 1, options),
      );
    }
  }

  return node;
}

function mapComponentMeta(id: string, raw: unknown): SourceComponentMeta {
  const r = asRecord(raw);
  const meta: SourceComponentMeta = { id, name: asString(r["name"]) ?? "(unnamed component)" };
  const key = asString(r["key"]);
  if (key) meta.key = key;
  const description = asString(r["description"]);
  if (description) meta.description = description;
  const componentSetId = asString(r["componentSetId"]);
  if (componentSetId) meta.componentSetId = componentSetId;
  const remote = asBool(r["remote"]);
  if (remote) meta.remote = true;
  const links = asArray(r["documentationLinks"])
    .map((entry) => asString(asRecord(entry)["uri"]) ?? asString(asRecord(entry)["url"]))
    .filter((url): url is string => Boolean(url))
    .map((url) => normaliseLink(url, "Documentation"));
  if (links.length) meta.documentationLinks = links;
  return meta;
}

function mapStyle(id: string, raw: unknown): SourceStyle {
  const r = asRecord(raw);
  const style: SourceStyle = {
    id,
    name: asString(r["name"]) ?? "(unnamed style)",
    styleType: asString(r["styleType"]) ?? "UNKNOWN",
  };
  const key = asString(r["key"]);
  if (key) style.key = key;
  const description = asString(r["description"]);
  if (description) style.description = description;
  if (asBool(r["remote"])) style.remote = true;
  return style;
}

function mapVariableCollection(id: string, raw: unknown): SourceVariableCollection {
  const r = asRecord(raw);
  const modes = asArray(r["modes"]).map((mode) => {
    const m = asRecord(mode);
    return {
      id: asString(m["modeId"]) ?? asString(m["id"]) ?? "",
      name: asString(m["name"]) ?? "Mode",
    };
  });
  const collection: SourceVariableCollection = {
    id,
    name: asString(r["name"]) ?? "(unnamed collection)",
    modes,
  };
  if (asBool(r["remote"])) collection.remote = true;
  return collection;
}

function mapVariable(id: string, raw: unknown): SourceVariable {
  const r = asRecord(raw);
  const valuesByMode = asRecord(r["valuesByMode"]);
  const aliasOf = Object.values(valuesByMode)
    .map((value) => {
      const v = asRecord(value);
      return asString(v["type"]) === "VARIABLE_ALIAS" ? asString(v["id"]) : undefined;
    })
    .filter((v): v is string => Boolean(v));

  const variable: SourceVariable = {
    id,
    name: asString(r["name"]) ?? "(unnamed variable)",
    collectionId: asString(r["variableCollectionId"]) ?? asString(r["collectionId"]) ?? "",
    resolvedType: asString(r["resolvedType"]) ?? "UNKNOWN",
  };
  const key = asString(r["key"]);
  if (key) variable.key = key;
  const description = asString(r["description"]);
  if (description) variable.description = description;
  if (asBool(r["remote"])) variable.remote = true;
  if (aliasOf.length) variable.aliasOf = [...new Set(aliasOf)];
  if (Object.keys(valuesByMode).length) variable.valuesByMode = valuesByMode;
  return variable;
}

export interface FigmaRestAdapterOptions {
  /** Guard against pathological files. Depth is counted from DOCUMENT. */
  maxDepth?: number;
}

export function adaptFigmaRestFile(
  input: FigmaRestAdapterInput,
  options: FigmaRestAdapterOptions = {},
): SourceDocument {
  const file = RawFileSchema.parse(input.file);
  const maxDepth = options.maxDepth ?? 40;

  let truncated = false;
  const root = walkNode(asRecord(file.document), undefined, 0, {
    maxDepth,
    onTruncate: () => {
      truncated = true;
    },
  });

  const components: Record<string, SourceComponentMeta> = {};
  for (const [id, raw] of Object.entries(file.components ?? {})) {
    components[id] = mapComponentMeta(id, raw);
  }
  const componentSets: Record<string, SourceComponentMeta> = {};
  for (const [id, raw] of Object.entries(file.componentSets ?? {})) {
    componentSets[id] = mapComponentMeta(id, raw);
  }
  const styles: Record<string, SourceStyle> = {};
  for (const [id, raw] of Object.entries(file.styles ?? {})) {
    styles[id] = mapStyle(id, raw);
  }

  const variables: Record<string, SourceVariable> = {};
  const variableCollections: Record<string, SourceVariableCollection> = {};
  if (input.variables !== undefined) {
    const parsed = RawVariablesSchema.parse(input.variables);
    for (const [id, raw] of Object.entries(parsed.meta?.variableCollections ?? {})) {
      variableCollections[id] = mapVariableCollection(id, raw);
    }
    for (const [id, raw] of Object.entries(parsed.meta?.variables ?? {})) {
      variables[id] = mapVariable(id, raw);
    }
  }

  // The file endpoint never says *which* library a remote entity came from, so
  // all remote entities are grouped under one synthetic library node. Sources
  // that do know (Plugin API, MCP) can set `libraryId` and get real grouping.
  const libraries: Record<string, SourceLibrary> = {};
  const remoteEntities = [
    ...Object.values(components),
    ...Object.values(componentSets),
    ...Object.values(styles),
    ...Object.values(variables),
    ...Object.values(variableCollections),
  ].filter((entity) => entity.remote);

  for (const entity of remoteEntities) {
    const id = entity.libraryId ?? UNKNOWN_LIBRARY_ID;
    entity.libraryId = id;
    if (!libraries[id]) {
      libraries[id] = { id, name: id === UNKNOWN_LIBRARY_ID ? UNKNOWN_LIBRARY_NAME : id };
    }
  }

  const source: SourceDocument["source"] = {
    kind: input.kind ?? "figma-rest",
    ingestedAt: input.ingestedAt ?? new Date().toISOString(),
  };
  if (file.version) source.version = file.version;
  if (file.lastModified) source.lastModified = file.lastModified;
  if (truncated) source.truncated = true;

  return {
    fileKey: input.fileKey,
    fileName: file.name,
    root,
    components,
    componentSets,
    styles,
    variables,
    variableCollections,
    libraries,
    source,
  };
}
