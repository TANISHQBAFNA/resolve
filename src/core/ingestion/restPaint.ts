import type { SourcePaint } from "./types";

/**
 * Copy the colour, effect, spacing, and radius fields a proper-use check needs.
 * A missing binding field is not the same as an unbound value — callers that
 * never see `boundVariables` or a style id must say unknown.
 */

type Rec = Record<string, unknown>;

const rec = (value: unknown): Rec =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : {};
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const PADDING = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"] as const;
const BINDING_KEYS = ["boundVariables", "styles", "fillStyleId", "strokeStyleId", "effectStyleId", "textStyleId", "backgroundStyleId"] as const;

export function hexFromColor(color: unknown): string | undefined {
  const row = rec(color);
  const red = num(row["r"]);
  const green = num(row["g"]);
  const blue = num(row["b"]);
  if (red === undefined || green === undefined || blue === undefined) return undefined;
  const channel = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value * 255)))
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

function boundSlot(raw: Rec, variableKeys: string[], styleKeys: string[], idKeys: string[]): boolean {
  const bound = rec(raw["boundVariables"]);
  if (variableKeys.some((key) => bound[key] !== undefined)) return true;
  const styles = rec(raw["styles"]);
  if (styleKeys.some((key) => styles[key] !== undefined && styles[key] !== "")) return true;
  return idKeys.some((key) => Boolean(str(raw[key])));
}

function solids(raw: Rec, key: "fills" | "strokes", wholeBound: boolean): NonNullable<SourcePaint["fills"]> {
  const out: NonNullable<SourcePaint["fills"]> = [];
  for (const entry of list(raw[key])) {
    const fill = rec(entry);
    if (fill["visible"] === false) continue;
    if (str(fill["type"]) !== "SOLID") continue;
    const hex = hexFromColor(fill["color"]);
    if (!hex) continue;
    const opacity = num(fill["opacity"]) ?? num(rec(fill["color"])["a"]) ?? 1;
    if (opacity <= 0) continue;
    const own = Object.keys(rec(fill["boundVariables"])).length > 0;
    out.push({ hex, bound: wholeBound || own, ...(opacity < 1 ? { opacity } : {}) });
  }
  return out;
}

/** REST node in, compact paint out. Undefined when the node has nothing to judge. */
export function captureRestPaint(raw: unknown): SourcePaint | undefined {
  const node = rec(raw);
  if (!Object.keys(node).length) return undefined;
  const fills = solids(
    node,
    "fills",
    boundSlot(node, ["fills", "fill"], ["fill", "fills"], ["fillStyleId", "backgroundStyleId"]),
  );
  const strokes = solids(
    node,
    "strokes",
    boundSlot(node, ["strokes", "stroke"], ["stroke", "strokes"], ["strokeStyleId"]),
  );
  const effects = list(node["effects"]).filter((entry) => {
    const effect = rec(entry);
    return effect["visible"] !== false && Boolean(str(effect["type"]));
  });
  const effectUnbound =
    effects.length > 0 && !boundSlot(node, ["effects", "effect"], ["effect", "effects"], ["effectStyleId"]);
  const style = rec(node["style"]);
  const fontName = rec(node["fontName"]);
  const fontSize = num(node["fontSize"]) ?? num(style["fontSize"]);
  const fontWeight = num(node["fontWeight"]) ?? num(style["fontWeight"]);
  const fontStyle = str(fontName["style"]) ?? "";
  const weight = fontWeight ?? (/\b(bold|black|heavy|semibold)\b/i.test(fontStyle) ? 700 : undefined);
  const textNode = str(node["type"]) === "TEXT";
  const textBound =
    boundSlot(node, ["fills", "fill"], ["text", "fill", "fills"], ["textStyleId", "fillStyleId"]) ||
    fills.every((fill) => fill.bound);
  const padding = PADDING.map((key) => num(node[key]));
  const paddingBound = PADDING.map((key) => boundSlot(node, [key], [], []));
  const gap = num(node["itemSpacing"]);
  const radius = num(node["cornerRadius"]);
  const radiusBound = boundSlot(
    node,
    ["cornerRadius", "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius", "rectangleCornerRadii"],
    [],
    [],
  );
  const paint: SourcePaint = {};
  if (fills.length) paint.fills = fills;
  if (strokes.length) paint.strokes = strokes;
  if (effectUnbound) paint.effectUnbound = true;
  if (textNode && fills[0]?.hex) {
    paint.textHex = fills[0].hex;
    paint.textBound = textBound;
  }
  if (fontSize !== undefined) paint.fontSize = fontSize;
  if (weight !== undefined) paint.fontWeight = weight;
  if (padding.some((value) => value !== undefined && value !== 0)) {
    paint.padding = padding.map((value) => value ?? 0);
    paint.paddingBound = paddingBound;
  }
  if (gap !== undefined && gap !== 0) {
    paint.gap = gap;
    paint.gapBound = boundSlot(node, ["itemSpacing"], [], []);
  }
  if (radius !== undefined && radius !== 0) {
    paint.radius = radius;
    paint.radiusBound = radiusBound;
  }
  return Object.keys(paint).length ? paint : undefined;
}

function nodeCarriesBindings(node: Rec): boolean {
  return BINDING_KEYS.some((key) => node[key] !== undefined);
}

/** Walk a design-context payload. True only when a binding field is actually present. */
export function payloadHasBindings(raw: unknown): boolean {
  const seen = { yes: false };
  walk(raw, seen, 0);
  return seen.yes;
}

function walk(raw: unknown, seen: { yes: boolean }, depth: number): void {
  if (seen.yes || depth > 40 || raw == null) return;
  if (typeof raw === "string") {
    if (/boundVariables|fillStyleId|strokeStyleId|effectStyleId|textStyleId|backgroundStyleId/.test(raw)) seen.yes = true;
    return;
  }
  if (Array.isArray(raw)) {
    for (const item of raw) walk(item, seen, depth + 1);
    return;
  }
  const node = rec(raw);
  if (!Object.keys(node).length) return;
  if (nodeCarriesBindings(node)) {
    seen.yes = true;
    return;
  }
  for (const value of Object.values(node)) walk(value, seen, depth + 1);
}

/** Node id → paint, only when the payload itself carries binding fields. */
export function paintsByNodeId(raw: unknown): Map<string, SourcePaint> {
  const out = new Map<string, SourcePaint>();
  if (!payloadHasBindings(raw)) return out;
  collect(raw, out, 0);
  return out;
}

function collect(raw: unknown, out: Map<string, SourcePaint>, depth: number): void {
  if (depth > 40 || raw == null) return;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return;
    try {
      collect(JSON.parse(trimmed) as unknown, out, depth + 1);
    } catch {
      return;
    }
    return;
  }
  if (Array.isArray(raw)) {
    for (const item of raw) collect(item, out, depth + 1);
    return;
  }
  const node = rec(raw);
  const id = str(node["id"]);
  if (id) {
    const paint = captureRestPaint(node);
    if (paint) out.set(id, paint);
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") collect(value, out, depth + 1);
  }
}
