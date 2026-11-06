import { cleanPropertyName } from "@/core/model/componentProperties";
import type { SourcePaint } from "@/core/ingestion/types";
import type { BindingKind, ControlType, MapBinding, MapControl, MapLayout, MapRaw, MapStyle, MapText } from "./types";

const CONTROL_TYPES: readonly ControlType[] = ["VARIANT", "BOOLEAN", "TEXT", "INSTANCE_SWAP", "SLOT", "UNKNOWN"];

/** Line count only. The words are not returned. */
export function textLineCount(characters: string): number {
  return characters.length === 0 ? 0 : characters.split(/\r\n|\n|\r/).length;
}

export function controllingFromReferences(
  refs: Record<string, string> | undefined,
  definitions?: ReadonlyArray<{ name: string; type: string }>,
): MapControl | undefined {
  const visible = refs?.["visible"];
  if (!visible) return undefined;
  const property = cleanPropertyName(visible).name;
  const found = definitions?.find((row) => row.name === property)?.type;
  const type = CONTROL_TYPES.find((item) => item === found) ?? "BOOLEAN";
  return { property, type };
}

export interface ProjectedFields {
  layout?: MapLayout;
  style?: MapStyle;
  binding?: MapBinding[];
  text?: MapText;
  controlledBy?: MapControl;
  flags?: { hasImageFill?: true };
}

export interface ProjectInput {
  meta: Record<string, unknown>;
  sourceKind: string;
  variables?: Record<string, string>;
  styles?: Record<string, string>;
  names?: Record<string, string>;
  definitions?: ReadonlyArray<{ name: string; type: string }>;
  /** Counted, then dropped. Never copied onto the result. */
  characters?: string;
  textNode?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
function tuple(value: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(value) || value.length < 4 || !value.every((item) => typeof item === "number")) return undefined;
  return [value[0], value[1], value[2], value[3]];
}

/** Layout, style, bindings, and a text slot. No characters. */
export function projectMeta(input: ProjectInput): ProjectedFields {
  const meta = input.meta;
  const paint = isRecord(meta["paint"]) ? (meta["paint"] as SourcePaint) : undefined;
  const mcp = input.sourceKind === "figma-mcp";
  const layout: MapLayout = {};
  const direction = str(meta["layoutMode"]);
  if (direction === "HORIZONTAL" || direction === "VERTICAL" || direction === "GRID") layout.direction = direction;
  const padding = tuple(paint?.padding);
  if (padding) layout.padding = padding;
  if (typeof paint?.gap === "number") layout.gap = paint.gap;
  const primary = str(meta["primaryAxisAlignItems"]);
  const counter = str(meta["counterAxisAlignItems"]);
  if (primary || counter) layout.align = { ...(primary ? { primary } : {}), ...(counter ? { counter } : {}) };
  const wrap = str(meta["layoutWrap"]);
  if (wrap) layout.wrap = wrap;
  const horizontal = str(meta["layoutSizingHorizontal"]);
  const vertical = str(meta["layoutSizingVertical"]);
  const primarySize = str(meta["primaryAxisSizingMode"]);
  const counterSize = str(meta["counterAxisSizingMode"]);
  if (horizontal || vertical || primarySize || counterSize) {
    layout.sizing = {
      ...(horizontal ? { horizontal } : {}),
      ...(vertical ? { vertical } : {}),
      ...(primarySize ? { primary: primarySize } : {}),
      ...(counterSize ? { counter: counterSize } : {}),
    };
  }
  const corners = paint?.cornerRadii;
  if (corners && new Set([corners.tl, corners.tr, corners.br, corners.bl]).size > 1) layout.radius = { ...corners };
  else if (typeof paint?.radius === "number") layout.radius = paint.radius;
  if (!Object.keys(layout).length && mcp) layout.unknown = true;

  const style: MapStyle = {};
  if (paint?.fills?.length) style.fills = paint.fills.map((fill) => ({ ...fill }));
  if (paint?.strokes?.length) style.strokes = paint.strokes.map((stroke) => ({ ...stroke }));
  if (paint?.effects?.length) style.effects = paint.effects.map((effect) => ({ type: effect.type, bound: effect.bound }));
  if (paint?.fontSize !== undefined || paint?.fontWeight !== undefined) {
    style.textStyle = {
      ...(paint.fontSize !== undefined ? { fontSize: paint.fontSize } : {}),
      ...(paint.fontWeight !== undefined ? { fontWeight: paint.fontWeight } : {}),
    };
  }

  const binding = bindings(input, paint, padding, mcp);
  const rawCharacters = input.characters ?? (typeof meta["text"] === "string" ? meta["text"] : undefined);
  const text = input.textNode || rawCharacters !== undefined
    ? rawCharacters === undefined ? { present: true } : { present: true, lines: textLineCount(rawCharacters) }
    : undefined;
  const refs = isRecord(meta["componentPropertyReferences"])
    ? Object.fromEntries(Object.entries(meta["componentPropertyReferences"]).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : undefined;
  const controlledBy = controllingFromReferences(refs, input.definitions);
  const out: ProjectedFields = {};
  if (Object.keys(layout).length) out.layout = layout;
  if (Object.keys(style).length) out.style = style;
  if (binding.length) out.binding = binding;
  if (text) out.text = text;
  if (controlledBy) out.controlledBy = controlledBy;
  if (meta["hasImageFill"] === true) out.flags = { hasImageFill: true };
  return out;
}

function bindings(input: ProjectInput, paint: SourcePaint | undefined, padding: [number, number, number, number] | undefined, mcp: boolean): MapBinding[] {
  const variables = input.variables ?? {};
  const styles = input.styles ?? {};
  const names = input.names ?? {};
  const out: MapBinding[] = [];
  const push = (slot: string, keys: string[], raw: MapRaw | undefined, bound: boolean | undefined) => {
    const varId = keys.map((key) => variables[key]).find((id) => Boolean(id));
    const styleId = keys.map((key) => styles[key]).find((id) => Boolean(id));
    if (varId) out.push({ slot, kind: "variable", id: varId, ...(names[varId] ? { name: names[varId] } : {}) });
    else if (styleId) out.push({ slot, kind: "style", id: styleId, ...(names[styleId] ? { name: names[styleId] } : {}) });
    else if (bound === true) out.push({ slot, kind: "unknown" });
    else if (raw !== undefined) out.push({ slot, kind: mcp && bound === undefined ? "unknown" : "raw", raw });
  };
  const fillBound = paint?.fills?.every((fill) => fill.bound);
  const strokeBound = paint?.strokes?.every((stroke) => stroke.bound);
  if (paint?.fills?.length) push("fill", ["fills", "fill", "fills[0]"], paint.fills.find((fill) => !fill.bound)?.hex, fillBound);
  if (paint?.strokes?.length) push("stroke", ["strokes", "stroke", "strokes[0]"], paint.strokes.find((stroke) => !stroke.bound)?.hex, strokeBound);
  if (padding) {
    const bounds = paint?.paddingBound;
    const bound = bounds?.every(Boolean) ? true : bounds?.some((item) => item === false) ? false : undefined;
    push("padding", ["paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "padding"], padding, bound);
  }
  if (typeof paint?.gap === "number") push("gap", ["itemSpacing", "gap"], paint.gap, paint.gapBound);
  const radiusRaw: MapRaw | undefined = typeof paint?.radius === "number"
    ? paint.radius
    : paint?.cornerRadii
      ? [paint.cornerRadii.tl, paint.cornerRadii.tr, paint.cornerRadii.br, paint.cornerRadii.bl]
      : undefined;
  if (typeof paint?.radius === "number" || paint?.cornerRadii) push("radius", ["cornerRadius", "rectangleCornerRadii", "radius"], radiusRaw, paint?.radiusBound);
  if (paint?.effects?.length) push("effect", ["effects", "effect"], undefined, paint.effects.every((effect) => effect.bound));
  if (paint?.fontSize !== undefined) push("fontSize", ["fontSize"], paint.fontSize, undefined);
  if (!out.length && mcp) out.push({ slot: "style", kind: "unknown" satisfies BindingKind });
  return out;
}
