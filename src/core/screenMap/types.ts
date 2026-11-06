/** Screen Map types. `schemas/screen-map.schema.json` is the source of truth. */
export const SCREEN_MAP_VERSION = 1;
export type ScreenMapSourceKind = "figma-rest" | "figma-plugin" | "figma-mcp" | "json" | "mock";
export type MapIdentity = "extracted" | "guessed" | "unknown";
export type BindingKind = "variable" | "style" | "raw" | "unknown";
export type ControlType = "VARIANT" | "BOOLEAN" | "TEXT" | "INSTANCE_SWAP" | "SLOT" | "UNKNOWN";
export type MapRaw = string | number | boolean | null | number[];
export interface MapBinding { slot: string; kind: BindingKind; id?: string; name?: string; raw?: MapRaw }
export interface MapLayout {
  direction?: "HORIZONTAL" | "VERTICAL" | "GRID";
  padding?: [number, number, number, number];
  gap?: number;
  align?: { primary?: string; counter?: string };
  wrap?: string;
  sizing?: { horizontal?: string; vertical?: string; primary?: string; counter?: string };
  radius?: number | { tl?: number; tr?: number; br?: number; bl?: number };
  unknown?: true;
}
export interface MapPaint { hex: string; bound: boolean; opacity?: number }
export interface MapStyle {
  fills?: MapPaint[];
  strokes?: MapPaint[];
  effects?: Array<{ type: string; bound: boolean }>;
  textStyle?: { fontSize?: number; fontWeight?: number; styleId?: string; variableId?: string };
}
/** Slot only. Never the words. */
export interface MapText { present: boolean; lines?: number }
export interface MapFlags { hidden?: boolean; detached?: boolean; overridden?: boolean; lookalike?: boolean; hasImageFill?: boolean }
export interface MapControl { property: string; type: ControlType }
export interface MapDs {
  componentId?: string;
  masterId?: string;
  setId?: string;
  variantProperties?: Record<string, string>;
  componentProperties?: Record<string, string | number | boolean | null>;
  propertyDefinitions?: Array<{ name: string; type: ControlType }>;
}
export interface MapNode {
  id: string;
  figmaNodeId?: string;
  type: string;
  name: string;
  path: string;
  parentId?: string;
  childIds: string[];
  ds?: MapDs;
  layout?: MapLayout;
  style?: MapStyle;
  binding?: MapBinding[];
  text?: MapText;
  flags?: MapFlags;
  controlledBy?: MapControl;
  identity?: MapIdentity;
  ref?: string;
  /** Reserved for a later meaning pass. Left null or omitted. */
  partJob?: null;
  /** Reserved for a later meaning pass. Left null or omitted. */
  slot?: null;
}
export interface MasterBody { id: string; name: string; childIds: string[]; nodes: Record<string, MapNode> }
export interface ScreenMapDocument {
  version: typeof SCREEN_MAP_VERSION;
  fileKey: string;
  fileName: string;
  fileVersion: string;
  sourceKind: ScreenMapSourceKind;
  builtAt: string;
  rootId: string;
  nodes: Record<string, MapNode>;
  masters?: Record<string, MasterBody>;
}
export interface MapWarning { code: string; message: string; next: string }
