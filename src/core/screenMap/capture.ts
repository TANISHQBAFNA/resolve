import { cleanPropertyName } from "@/core/model/componentProperties";
import type { SourcePaint } from "@/core/ingestion/types";
import type { ControlType, MapBinding, MapControl, MapFlags, MapLayout, MapRaw, MapStyle, MapText } from "./types";

const CONTROL_TYPES: readonly ControlType[] = ["VARIANT", "BOOLEAN", "TEXT", "INSTANCE_SWAP", "SLOT", "UNKNOWN"];
const rec = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

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
  return { property, type: CONTROL_TYPES.find((item) => item === found) ?? "BOOLEAN" };
}

export interface ProjectedFields {
  layout?: MapLayout; style?: MapStyle; binding?: MapBinding[]; text?: MapText; controlledBy?: MapControl; flags?: MapFlags;
}
export interface ProjectInput {
  meta: Record<string, unknown>; sourceKind: string;
  variables?: Record<string, string>; styles?: Record<string, string>; names?: Record<string, string>;
  definitions?: ReadonlyArray<{ name: string; type: string }>; characters?: string; textNode?: boolean;
}

function tuple(value: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(value) || value.length < 4 || !value.every((item) => typeof item === "number")) return undefined;
  return [value[0], value[1], value[2], value[3]];
}

/** Layout, style, bindings, and a text slot. Characters are counted, then dropped. */
export function projectMeta(input: ProjectInput): ProjectedFields {
  const meta = input.meta;
  const paint = rec(meta["paint"]) as SourcePaint;
  const mcp = input.sourceKind === "figma-mcp";
  const layout: MapLayout = {};
  const direction = str(meta["layoutMode"]);
  if (direction === "HORIZONTAL" || direction === "VERTICAL" || direction === "GRID") layout.direction = direction;
  const padding = tuple(paint.padding);
  if (padding) layout.padding = padding;
  if (typeof paint.gap === "number") layout.gap = paint.gap;
  const primary = str(meta["primaryAxisAlignItems"]);
  const counter = str(meta["counterAxisAlignItems"]);
  if (primary || counter) layout.align = { ...(primary ? { primary } : {}), ...(counter ? { counter } : {}) };
  if (str(meta["layoutWrap"])) layout.wrap = str(meta["layoutWrap"]);
  const sizing = {
    ...(str(meta["layoutSizingHorizontal"]) ? { horizontal: str(meta["layoutSizingHorizontal"]) } : {}),
    ...(str(meta["layoutSizingVertical"]) ? { vertical: str(meta["layoutSizingVertical"]) } : {}),
    ...(str(meta["primaryAxisSizingMode"]) ? { primary: str(meta["primaryAxisSizingMode"]) } : {}),
    ...(str(meta["counterAxisSizingMode"]) ? { counter: str(meta["counterAxisSizingMode"]) } : {}),
  };
  if (Object.keys(sizing).length) layout.sizing = sizing;
  const corners = paint.cornerRadii;
  if (corners && new Set([corners.tl, corners.tr, corners.br, corners.bl]).size > 1) layout.radius = { ...corners };
  else if (typeof paint.radius === "number") layout.radius = paint.radius;
  if (!Object.keys(layout).length && mcp) layout.unknown = true;
  const style: MapStyle = {};
  if (paint.fills?.length) style.fills = paint.fills.map((fill) => ({ ...fill }));
  if (paint.strokes?.length) style.strokes = paint.strokes.map((stroke) => ({ ...stroke }));
  if (paint.effects?.length) style.effects = paint.effects.map((effect) => ({ type: effect.type, bound: effect.bound }));
  if (paint.fontSize !== undefined || paint.fontWeight !== undefined) {
    style.textStyle = { ...(paint.fontSize !== undefined ? { fontSize: paint.fontSize } : {}), ...(paint.fontWeight !== undefined ? { fontWeight: paint.fontWeight } : {}) };
  }
  const binding = bindings(input, paint, padding, mcp);
  const rawCharacters = input.characters ?? (typeof meta["text"] === "string" ? meta["text"] : undefined);
  const text: MapText | undefined = input.textNode || rawCharacters !== undefined
    ? rawCharacters === undefined ? { present: true } : { present: true, lines: textLineCount(rawCharacters) }
    : undefined;
  const refs = rec(meta["componentPropertyReferences"]);
  const stringRefs = Object.fromEntries(Object.entries(refs).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const controlledBy = controllingFromReferences(Object.keys(stringRefs).length ? stringRefs : undefined, input.definitions);
  const out: ProjectedFields = {};
  if (Object.keys(layout).length) out.layout = layout;
  if (Object.keys(style).length) out.style = style;
  if (binding.length) out.binding = binding;
  if (text) out.text = text;
  if (controlledBy) out.controlledBy = controlledBy;
  if (meta["hasImageFill"] === true) out.flags = { hasImageFill: true };
  return out;
}

function bindings(input: ProjectInput, paint: SourcePaint, padding: [number, number, number, number] | undefined, mcp: boolean): MapBinding[] {
  const variables = input.variables ?? {};
  const styles = input.styles ?? {};
  const names = input.names ?? {};
  const out: MapBinding[] = [];
  const push = (slot: string, keys: string[], raw: MapRaw | undefined, bound: boolean | undefined) => {
    const varId = keys.map((key) => variables[key]).find(Boolean);
    const styleId = keys.map((key) => styles[key]).find(Boolean);
    if (varId) out.push({ slot, kind: "variable", id: varId, ...(names[varId] ? { name: names[varId] } : {}) });
    else if (styleId) out.push({ slot, kind: "style", id: styleId, ...(names[styleId] ? { name: names[styleId] } : {}) });
    else if (bound === true) out.push({ slot, kind: "unknown" });
    else if (raw !== undefined) out.push({ slot, kind: mcp && bound === undefined ? "unknown" : "raw", raw });
  };
  if (paint.fills?.length) push("fill", ["fills", "fill", "fills[0]"], paint.fills.find((fill) => !fill.bound)?.hex, paint.fills.every((fill) => fill.bound));
  if (paint.strokes?.length) push("stroke", ["strokes", "stroke", "strokes[0]"], paint.strokes.find((stroke) => !stroke.bound)?.hex, paint.strokes.every((stroke) => stroke.bound));
  if (padding) {
    const bounds = paint.paddingBound;
    push("padding", ["paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "padding"], padding, bounds?.every(Boolean) ? true : bounds?.some((item) => !item) ? false : undefined);
  }
  if (typeof paint.gap === "number") push("gap", ["itemSpacing", "gap"], paint.gap, paint.gapBound);
  const radiusRaw = typeof paint.radius === "number" ? paint.radius : paint.cornerRadii ? [paint.cornerRadii.tl, paint.cornerRadii.tr, paint.cornerRadii.br, paint.cornerRadii.bl] : undefined;
  if (radiusRaw !== undefined) push("radius", ["cornerRadius", "rectangleCornerRadii", "radius"], radiusRaw, paint.radiusBound);
  if (paint.effects?.length) push("effect", ["effects", "effect"], undefined, paint.effects.every((effect) => effect.bound));
  if (!out.length && mcp) out.push({ slot: "style", kind: "unknown" });
  return out;
}
