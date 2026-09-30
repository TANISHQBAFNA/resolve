/**
 * Layout derivation.
 *
 * A recipe says *what* to place. It has never said *how it is arranged*, so the
 * grid a designer settled on lives only in the file — recoverable by reading
 * bounds, never served by a card. This derives that arrangement from the child
 * bounds of a frame and expresses it in spacing tokens rather than pixels.
 *
 * Two rules, both deliberate:
 *
 * 1. **Decline rather than average.** A marketing page or a mixed-span
 *    dashboard has no single grid. When the evidence is not regular enough the
 *    result is `undefined`, never a blended number.
 * 2. **Snap exactly or not at all.** A measured gap is reported as a token only
 *    when it equals one. A near miss is reported as `raw` with the nearest
 *    token named, which is what makes this double as a spacing-scale linter:
 *    a 56px margin that matches an unused `spacing/56` is worth surfacing.
 */

/** A spacing/radius variable from the design system, as `name -> value`. */
export interface DimensionToken {
  name: string;
  value: number;
}

/** One measured length, resolved against the scale. */
export interface SnappedLength {
  px: number;
  /** Set only on an exact match. */
  token?: string;
  /** Nearest token when `token` is unset — the linter hint. */
  nearest?: string;
  /** Signed distance to `nearest`, in px. */
  off?: number;
}

export interface LayoutSpec {
  columns: number;
  /** Most common child width, in px. Derived from the others, never authored. */
  columnWidth: number;
  gutter: SnappedLength;
  marginLeft: SnappedLength;
  marginRight: SnappedLength;
  rowGap?: SnappedLength;
  /** Children that established each column, for the evidence line. */
  sampleSize: number;
  /**
   * Which frames this came from. `deriveLayout` never sets it — one frame is an
   * anecdote. The store attaches it, and only marks `strong` once separate
   * frames agree, matching the threshold SOCK already uses for usage.
   */
  evidence?: { frames: string[]; confidence: "weak" | "strong" };
}

export interface DeriveLayoutOptions {
  /** Width of the frame the children sit in. */
  containerWidth: number;
  /** x of the frame, when child bounds are absolute. Defaults to 0. */
  originX?: number;
  /** Cluster tolerance for column starts, in px. */
  tolerance?: number;
  /** Children required in a cluster before it counts as a column. */
  minPerColumn?: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const DEFAULT_TOLERANCE = 8;
const DEFAULT_MIN_PER_COLUMN = 3;

/** Exact match, else nearest with its signed distance. */
export function snapToToken(px: number, tokens: DimensionToken[]): SnappedLength {
  const rounded = Math.round(px);
  const exact = tokens.find((t) => t.value === rounded);
  if (exact) return { px: rounded, token: exact.name };
  if (tokens.length === 0) return { px: rounded };
  let best = tokens[0];
  for (const t of tokens) {
    if (Math.abs(t.value - rounded) < Math.abs(best.value - rounded)) best = t;
  }
  return { px: rounded, nearest: best.name, off: rounded - best.value };
}

function mode(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let bestValue = values[0];
  let bestCount = 0;
  for (const [value, count] of counts) {
    // Ties resolve to the smaller value so a run of equals stays stable.
    if (count > bestCount || (count === bestCount && value < bestValue)) {
      bestValue = value;
      bestCount = count;
    }
  }
  return bestValue;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Group near-equal x positions into columns. */
function clusterColumns(xs: number[], tolerance: number): number[][] {
  const sorted = [...xs].sort((a, b) => a - b);
  const clusters: number[][] = [];
  for (const x of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && x - last[last.length - 1] <= tolerance) last.push(x);
    else clusters.push([x]);
  }
  return clusters;
}

/**
 * Derive a grid from sibling bounds. Returns `undefined` when the children do
 * not form one — too few, one column, or inconsistent pitch.
 */
export function deriveLayout(
  children: Rect[],
  tokens: DimensionToken[],
  options: DeriveLayoutOptions,
): LayoutSpec | undefined {
  const { containerWidth } = options;
  const originX = options.originX ?? 0;
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const minPerColumn = options.minPerColumn ?? DEFAULT_MIN_PER_COLUMN;
  if (containerWidth <= 0 || children.length < minPerColumn) return undefined;

  const relative = children.map((c) => ({ ...c, x: c.x - originX }));
  const clusters = clusterColumns(
    relative.map((c) => Math.round(c.x)),
    tolerance,
  ).filter((c) => c.length >= minPerColumn);
  if (clusters.length < 2) return undefined;

  const starts = clusters.map((c) => Math.round(c.reduce((a, b) => a + b, 0) / c.length));
  const columnWidth = mode(relative.map((c) => Math.round(c.width)));
  if (columnWidth === undefined || columnWidth <= 0) return undefined;

  const pitches: number[] = [];
  for (let i = 1; i < starts.length; i += 1) pitches.push(starts[i] - starts[i - 1]);
  const pitch = median(pitches);
  if (pitch === undefined) return undefined;

  // An irregular grid has pitches that disagree. Averaging them would invent a
  // convention nobody chose, so decline instead.
  const spread = Math.max(...pitches) - Math.min(...pitches);
  if (spread > tolerance) return undefined;

  const gutterPx = pitch - columnWidth;
  if (gutterPx < 0) return undefined;

  const marginLeftPx = starts[0];
  const marginRightPx = containerWidth - (starts[starts.length - 1] + columnWidth);
  if (marginLeftPx < 0 || marginRightPx < 0) return undefined;

  // Vertical rhythm, when the children stack into rows as well as columns.
  const ys = [...new Set(relative.map((c) => Math.round(c.y)))].sort((a, b) => a - b);
  const heights = mode(relative.map((c) => Math.round(c.height)));
  const rowPitches: number[] = [];
  for (let i = 1; i < ys.length; i += 1) {
    const gap = ys[i] - ys[i - 1];
    if (gap > 0) rowPitches.push(gap);
  }
  const rowPitch = mode(rowPitches);
  const rowGapPx =
    rowPitch !== undefined && heights !== undefined ? rowPitch - heights : undefined;

  return {
    columns: clusters.length,
    columnWidth,
    gutter: snapToToken(gutterPx, tokens),
    marginLeft: snapToToken(marginLeftPx, tokens),
    marginRight: snapToToken(marginRightPx, tokens),
    ...(rowGapPx !== undefined && rowGapPx >= 0
      ? { rowGap: snapToToken(rowGapPx, tokens) }
      : {}),
    sampleSize: clusters.reduce((sum, c) => sum + c.length, 0),
  };
}

/**
 * Column width is a consequence of viewport, margins and gutter — not a chosen
 * number. This recomputes it so a stored spec survives a viewport change.
 */
export function columnWidthFor(
  containerWidth: number,
  columns: number,
  marginLeft: number,
  marginRight: number,
  gutter: number,
): number {
  if (columns <= 0) return 0;
  const usable = containerWidth - marginLeft - marginRight - gutter * (columns - 1);
  return Math.round(usable / columns);
}

/** One line for a card. Tokens when known, px when not. */
export function layoutSummary(spec: LayoutSpec): string {
  const show = (l: SnappedLength) => l.token ?? `${l.px}px`;
  const parts = [
    `${spec.columns} cols`,
    `margin ${show(spec.marginLeft)}`,
    `gutter ${show(spec.gutter)}`,
  ];
  if (spec.rowGap) parts.push(`row ${show(spec.rowGap)}`);
  return parts.join(" · ");
}

/** Measured lengths that match a token but are not one. The linter output. */
export function offScale(spec: LayoutSpec): string[] {
  const rows: string[] = [];
  const check = (label: string, l: SnappedLength) => {
    if (l.token || !l.nearest) return;
    rows.push(`${label} ${l.px}px is off-scale — nearest ${l.nearest} (${l.off! > 0 ? "+" : ""}${l.off})`);
  };
  check("gutter", spec.gutter);
  check("margin-left", spec.marginLeft);
  check("margin-right", spec.marginRight);
  if (spec.rowGap) check("row-gap", spec.rowGap);
  return rows;
}
