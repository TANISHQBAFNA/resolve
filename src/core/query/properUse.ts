/** Proper use of a learned library on one frame. One module owns these rules. */
import type { GraphNode } from "@/core/model";
import type { SourcePaint } from "@/core/ingestion/types";
import { hexFromColor, payloadHasBindings, paintsByNodeId } from "@/core/ingestion/restPaint";
import { setOf } from "@/core/rules/family";
import { foldLibName, isNameInferredMaster, isPrivateMasterName } from "@/core/rules/names";
import { isRetired } from "@/core/rules/retired";
import { type AgentCost, withCost } from "./cost";
import { instancePropertyFindings } from "./componentProperties";
import type { GraphIndex } from "./GraphIndex";
import { normaliseA11y } from "./contextPacks";
import {
  MASTER_TYPES,
  otherNamedMasters,
  preferNamedMaster,
  realMastersNamed,
} from "./masterNames";
import { resolveNode } from "./nodeLookup";
import { replacementOf } from "./replacements";
import type { WorkspaceManifest } from "./workspace";
import { componentKeyOf, nodeFileKey } from "./workspaceMerge";

/** Process exit when the component check passed and proper-use still has errors. */
export const PROPER_USE_EXIT = 7;

export type ProperUseSeverity = "error" | "warning" | "info";

export type ProperUseCheck =
  | "detached"
  | "colour"
  | "spacing"
  | "radius"
  | "effect"
  | "property"
  | "placeholder"
  | "contrast"
  | "tap"
  | "icon"
  | "unknown";

export interface ProperUseFinding {
  severity: ProperUseSeverity;
  check: ProperUseCheck;
  name: string;
  figmaNodeId?: string;
  problem: string;
  fix: string;
  token?: string;
  component?: string;
  fileKey?: string;
  componentKey?: string;
}

export interface ProperUseReport {
  summary: string;
  errors: number;
  warnings: number;
  unknown: number;
  /** 7 when this section has errors. The process keeps exit 1 when the rest of the check failed. */
  exitCode: 0 | 7;
  level: string;
  findings: ProperUseFinding[];
  truncated?: string;
}

export interface ProperUseOptions {
  a11y?: string;
  workspace?: WorkspaceManifest;
  designContext?: unknown;
}

const DETACHED_TYPES = new Set(["FRAME", "GROUP", "AUTO_LAYOUT_CONTAINER"]);
const TAP_NAME = /\b(button|link|checkbox|switch|radio)\b/i;
const PLACEHOLDER = new Set(["button", "label"]);
const SPACE_NAME = /space|spacing|gap|padding|inset/i;
const RADIUS_NAME = /radius|corner|round/i;
const COLOUR_DISTANCE = 36;
const SEVERITY_RANK: Record<ProperUseSeverity, number> = { error: 0, warning: 1, info: 2 };
const CHECK_RANK: Record<ProperUseCheck, number> = {
  detached: 0,
  colour: 1,
  spacing: 1,
  radius: 1,
  effect: 1,
  property: 2,
  placeholder: 2,
  contrast: 3,
  tap: 3,
  icon: 3,
  unknown: 4,
};

interface Token {
  name: string;
  hex?: string;
  value?: number;
}

type A11yLevel = "aa" | "aaa" | "a" | "aa-minimum";

interface Bars {
  level: string;
  normal: number;
  large: number;
  tap: number;
  contrast: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function a11yLevel(raw: string | undefined): A11yLevel {
  const compact = (raw ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!compact) return "aa";
  if (compact === "aaminimum" || compact === "wcagaaminimum" || compact === "minimum") return "aa-minimum";
  const norm = normaliseA11y(raw ?? "");
  if (norm === "wcag-aaa") return "aaa";
  if (norm === "wcag-a") return "a";
  if (norm === "wcag-aa") return "aa";
  return "aa";
}

function barsFor(level: A11yLevel): Bars {
  switch (level) {
    case "aaa":
      return { level: "wcag-aaa", normal: 7, large: 4.5, tap: 44, contrast: true };
    case "a":
      return { level: "wcag-a", normal: 0, large: 0, tap: 24, contrast: false };
    case "aa-minimum":
      return { level: "wcag-aa-minimum", normal: 4.5, large: 3, tap: 24, contrast: true };
    case "aa":
      return { level: "wcag-aa", normal: 4.5, large: 3, tap: 44, contrast: true };
    default: {
      const unexpected: never = level;
      return unexpected;
    }
  }
}

function paintOf(node: GraphNode, overlay: Map<string, SourcePaint>): SourcePaint | undefined {
  const id = node.figmaNodeId;
  if (id && overlay.has(id)) return overlay.get(id);
  const raw = node.metadata?.["paint"];
  return isRecord(raw) ? (raw as SourcePaint) : undefined;
}

function hidden(node: GraphNode): boolean {
  return node.metadata?.["hidden"] === true;
}

function insideInstance(index: GraphIndex, node: GraphNode): boolean {
  return index.getAncestors(node.id).some((ancestor) => ancestor.type === "COMPONENT_INSTANCE");
}

function overridden(index: GraphIndex, node: GraphNode, field: string): boolean {
  const id = node.figmaNodeId;
  const needle = field.toLowerCase();
  for (const ancestor of index.getAncestors(node.id)) {
    if (ancestor.type !== "COMPONENT_INSTANCE") continue;
    const rows = ancestor.metadata?.["overrides"];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!isRecord(row)) continue;
      if (row["id"] !== id && row["id"] !== node.id) continue;
      const fields = Array.isArray(row["overriddenFields"]) ? row["overriddenFields"] : [];
      if (fields.some((item) => typeof item === "string" && item.toLowerCase().includes(needle))) return true;
    }
  }
  return false;
}

function skipBuried(index: GraphIndex, node: GraphNode, field: string): boolean {
  return insideInstance(index, node) && !overridden(index, node, field);
}

function rgb(hex: string): [number, number, number] | undefined {
  const match = /^#([0-9A-F]{6})$/i.exec(hex.trim());
  const body = match?.[1];
  if (!body) return undefined;
  const value = Number.parseInt(body, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function colourDistance(left: string, right: string): number | undefined {
  const a = rgb(left);
  const b = rgb(right);
  if (!a || !b) return undefined;
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number | undefined {
  const row = rgb(hex);
  if (!row) return undefined;
  return 0.2126 * channel(row[0]) + 0.7152 * channel(row[1]) + 0.0722 * channel(row[2]);
}

function contrastRatio(foreground: string, background: string): number | undefined {
  const fg = luminance(foreground);
  const bg = luminance(background);
  if (fg === undefined || bg === undefined) return undefined;
  const lighter = Math.max(fg, bg);
  const darker = Math.min(fg, bg);
  return (lighter + 0.05) / (darker + 0.05);
}

function libraryTokens(index: GraphIndex): Token[] {
  const byId = new Map<string, GraphNode>();
  for (const node of index.getNodesByType("VARIABLE")) {
    if (node.figmaNodeId) byId.set(node.figmaNodeId, node);
  }
  const out: Token[] = [];
  const resolve = (node: GraphNode, depth: number): { hex?: string; value?: number } | undefined => {
    if (depth > 4) return undefined;
    const modes = node.metadata?.["valuesByMode"];
    if (!isRecord(modes)) return undefined;
    const first = Object.values(modes)[0];
    if (typeof first === "number") return { value: first };
    if (!isRecord(first)) return undefined;
    if (first["type"] === "VARIABLE_ALIAS" && typeof first["id"] === "string") {
      const next = byId.get(first["id"]);
      return next ? resolve(next, depth + 1) : undefined;
    }
    if (typeof first["r"] === "number" && typeof first["g"] === "number" && typeof first["b"] === "number") {
      const hex = hexFromColor(first);
      return hex ? { hex } : undefined;
    }
    return undefined;
  };
  for (const node of index.getNodesByType("VARIABLE")) {
    const resolved = resolve(node, 0);
    if (!resolved) continue;
    out.push({ name: node.name, ...resolved });
  }
  return out;
}

function nearestColour(tokens: Token[], hex: string): Token | undefined {
  let best: { token: Token; distance: number } | undefined;
  for (const token of tokens) {
    if (!token.hex) continue;
    const distance = colourDistance(hex, token.hex);
    if (distance === undefined || distance > COLOUR_DISTANCE) continue;
    if (!best || distance < best.distance - 0.01 || (Math.abs(distance - best.distance) <= 0.01 && token.name < best.token.name)) {
      best = { token, distance };
    }
  }
  return best?.token;
}

function nearestNumber(tokens: Token[], value: number, nameTest: RegExp): Token | undefined {
  const hits = tokens.filter(
    (token) => token.value !== undefined && Math.abs(token.value - value) < 0.01 && nameTest.test(token.name),
  );
  hits.sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
  return hits[0];
}

function uniqueMaster(index: GraphIndex, name: string, workspace?: WorkspaceManifest): GraphNode | undefined {
  const hits = realMastersNamed(index, name).filter(
    (node) => !isPrivateMasterName(node.name) && !isNameInferredMaster(node),
  );
  const picked = preferNamedMaster(index, hits, workspace, name);
  if (!picked || isPrivateMasterName(picked.name) || isNameInferredMaster(picked)) return undefined;
  if (otherNamedMasters(index, hits, picked).length) return undefined;
  return picked;
}

function childKey(index: GraphIndex, node: GraphNode): string | undefined {
  const children = index.getChildren(node.id).filter((child) => !hidden(child));
  if (children.length < 2) return undefined;
  if (children.some((child) => child.type === "COMPONENT_INSTANCE")) return undefined;
  return children.map((child) => foldLibName(child.name)).join("|");
}

function structureMaster(index: GraphIndex, node: GraphNode): GraphNode | undefined {
  const key = childKey(index, node);
  if (!key) return undefined;
  const hits: GraphNode[] = [];
  for (const master of index.getNodesByType(...MASTER_TYPES)) {
    if (master.id === node.id || isPrivateMasterName(master.name) || isNameInferredMaster(master)) continue;
    if (childKey(index, master) !== key) continue;
    hits.push(master);
  }
  return hits.length === 1 ? hits[0] : undefined;
}

function familyIds(index: GraphIndex, master: GraphNode): Set<string> {
  const ids = new Set<string>([master.id]);
  const set = setOf(index, master);
  if (!set) return ids;
  ids.add(set.id);
  for (const variant of index.getVariantsOf(set.id)) ids.add(variant.id);
  return ids;
}

function containsFamily(index: GraphIndex, node: GraphNode, master: GraphNode): boolean {
  const ids = familyIds(index, master);
  return index.getDescendants(node.id).some((child) => {
    if (child.type !== "COMPONENT_INSTANCE") return false;
    if (child.mainComponentId && ids.has(child.mainComponentId)) return true;
    return Boolean(child.componentSetId && ids.has(child.componentSetId));
  });
}

function suggestion(index: GraphIndex, master: GraphNode): {
  name: string;
  fileKey?: string;
  componentKey?: string;
  retired: boolean;
} {
  const set = setOf(index, master) ?? master;
  let target = set;
  const retired = isRetired(index, set);
  if (retired) {
    const next = replacementOf(index, set)?.node;
    if (next) target = setOf(index, next) ?? next;
  }
  const fileKey = nodeFileKey(target, index.graph.fileKey);
  const componentKey = componentKeyOf(target) ?? componentKeyOf(set);
  return {
    name: target.name,
    ...(fileKey ? { fileKey } : {}),
    ...(componentKey ? { componentKey } : {}),
    retired,
  };
}

function sameFamily(index: GraphIndex, left: GraphNode, right: GraphNode): boolean {
  return left.id === right.id || setOf(index, left)?.id === setOf(index, right)?.id;
}

function detachedFindings(index: GraphIndex, frame: GraphNode, workspace?: WorkspaceManifest): ProperUseFinding[] {
  const nodes = [frame, ...index.getDescendants(frame.id)].filter(
    (node) => DETACHED_TYPES.has(node.type) && !hidden(node) && !insideInstance(index, node),
  );
  const findings: ProperUseFinding[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const byName = uniqueMaster(index, node.name, workspace);
    const byStructure = structureMaster(index, node);
    if (byName && byStructure && !sameFamily(index, byName, byStructure)) continue;
    const master = byName ?? byStructure;
    if (!master || seen.has(node.id) || containsFamily(index, node, master)) continue;
    seen.add(node.id);
    const suggested = suggestion(index, master);
    const looked = byName?.name ?? master.name;
    findings.push({
      severity: "error",
      check: "detached",
      name: node.name,
      ...(node.figmaNodeId ? { figmaNodeId: node.figmaNodeId } : {}),
      problem: suggested.retired
        ? `This frame looks like ${looked}, which is retired.`
        : `This frame looks like ${looked} but is not a library instance.`,
      fix: "Re-insert the instance.",
      component: suggested.name,
      ...(suggested.fileKey ? { fileKey: suggested.fileKey } : {}),
      ...(suggested.componentKey ? { componentKey: suggested.componentKey } : {}),
    });
  }
  return findings;
}

function pushColour(
  findings: ProperUseFinding[],
  node: GraphNode,
  kind: "Fill" | "Stroke",
  hex: string,
  token: Token | undefined,
): void {
  findings.push({
    severity: "warning",
    check: "colour",
    name: node.name,
    ...(node.figmaNodeId ? { figmaNodeId: node.figmaNodeId } : {}),
    problem: token
      ? `${kind} ${hex} is not bound to a library variable or style. Nearest token is ${token.name}.`
      : `${kind} ${hex} is not bound to a library variable or style.`,
    fix: token ? `Bind it to ${token.name}.` : "Bind it to a library colour variable or style.",
    ...(token ? { token: token.name } : {}),
  });
}

function hardCodedFindings(index: GraphIndex, frame: GraphNode, tokens: Token[], paintAt: (node: GraphNode) => SourcePaint | undefined): ProperUseFinding[] {
  const findings: ProperUseFinding[] = [];
  const effectStyles = index.getNodesByType("STYLE").filter((node) => node.metadata?.["styleType"] === "EFFECT");
  const nodes = [frame, ...index.getDescendants(frame.id)];
  for (const node of nodes) {
    if (hidden(node)) continue;
    const paint = paintAt(node);
    if (!paint) continue;
    if (!skipBuried(index, node, "fill")) {
      for (const fill of paint.fills ?? []) {
        if (!fill.bound) pushColour(findings, node, "Fill", fill.hex, nearestColour(tokens, fill.hex));
      }
    }
    if (!skipBuried(index, node, "stroke")) {
      for (const stroke of paint.strokes ?? []) {
        if (!stroke.bound) pushColour(findings, node, "Stroke", stroke.hex, nearestColour(tokens, stroke.hex));
      }
    }
    if (paint.effectUnbound && !skipBuried(index, node, "effect") && effectStyles.length) {
      const only = effectStyles.length === 1 ? effectStyles[0] : undefined;
      findings.push({
        severity: "warning",
        check: "effect",
        name: node.name,
        ...(node.figmaNodeId ? { figmaNodeId: node.figmaNodeId } : {}),
        problem: "This effect is not bound to a library style or variable.",
        fix: only ? `Bind it to ${only.name}.` : "Bind it to an effect style.",
        ...(only ? { token: only.name } : {}),
      });
    }
    if (paint.padding && !skipBuried(index, node, "padding")) {
      const seen = new Set<number>();
      paint.padding.forEach((value, indexSide) => {
        if (!value || paint.paddingBound?.[indexSide] || seen.has(value)) return;
        const token = nearestNumber(tokens, value, SPACE_NAME);
        if (!token) return;
        seen.add(value);
        findings.push({
          severity: "warning",
          check: "spacing",
          name: node.name,
          ...(node.figmaNodeId ? { figmaNodeId: node.figmaNodeId } : {}),
          problem: `Padding ${value} is not bound to a spacing variable.`,
          fix: `Bind it to ${token.name}.`,
          token: token.name,
        });
      });
    }
    if (paint.gap && paint.gapBound === false && !skipBuried(index, node, "itemspacing")) {
      const token = nearestNumber(tokens, paint.gap, SPACE_NAME);
      if (token) {
        findings.push({
          severity: "warning",
          check: "spacing",
          name: node.name,
          ...(node.figmaNodeId ? { figmaNodeId: node.figmaNodeId } : {}),
          problem: `Gap ${paint.gap} is not bound to a spacing variable.`,
          fix: `Bind it to ${token.name}.`,
          token: token.name,
        });
      }
    }
    if (paint.radius && paint.radiusBound === false && !skipBuried(index, node, "radius")) {
      const token = nearestNumber(tokens, paint.radius, RADIUS_NAME);
      if (token) {
        findings.push({
          severity: "warning",
          check: "radius",
          name: node.name,
          ...(node.figmaNodeId ? { figmaNodeId: node.figmaNodeId } : {}),
          problem: `Corner radius ${paint.radius} is not bound to a radius variable.`,
          fix: `Bind it to ${token.name}.`,
          token: token.name,
        });
      }
    }
  }
  return findings;
}

function propertyFindings(index: GraphIndex, frame: GraphNode): ProperUseFinding[] {
  const findings: ProperUseFinding[] = [];
  const seenFlag = new Set<string>();
  const seenNote = new Set<string>();
  for (const instance of index.getDescendants(frame.id)) {
    if (instance.type !== "COMPONENT_INSTANCE" || hidden(instance)) continue;
    const found = instancePropertyFindings(index, instance);
    for (const flag of found.flags) {
      const key = `${instance.id}:${flag.property}=${flag.value}`;
      if (seenFlag.has(key)) continue;
      seenFlag.add(key);
      findings.push({
        severity: "error",
        check: "property",
        name: instance.name,
        ...(instance.figmaNodeId ? { figmaNodeId: instance.figmaNodeId } : {}),
        problem: `${flag.property} is "${flag.value}", which is not an allowed value (${flag.allowed.join(", ")}).`,
        fix: `Set ${flag.property} to one of: ${flag.allowed.join(", ")}.`,
      });
    }
    for (const note of found.notes) {
      if (!PLACEHOLDER.has(note.value.trim().toLowerCase())) continue;
      const key = `${instance.id}:${note.property}=${note.value}`;
      if (seenNote.has(key)) continue;
      seenNote.add(key);
      findings.push({
        severity: "warning",
        check: "placeholder",
        name: instance.name,
        ...(instance.figmaNodeId ? { figmaNodeId: instance.figmaNodeId } : {}),
        problem: `${note.property} is still the placeholder "${note.value}".`,
        fix: "Replace the placeholder text.",
      });
    }
  }
  return findings;
}

function placedInstances(index: GraphIndex, frame: GraphNode): GraphNode[] {
  return index.getDescendants(frame.id).filter((node) => {
    if (node.type !== "COMPONENT_INSTANCE" || hidden(node)) return false;
    return !index.getAncestors(node.id).some((ancestor) => ancestor.type === "COMPONENT_INSTANCE");
  });
}

function interactive(index: GraphIndex, instance: GraphNode): boolean {
  if (TAP_NAME.test(instance.name)) return true;
  const main = index.getMainComponent(instance.id);
  if (!main) return false;
  const set = setOf(index, main);
  return TAP_NAME.test(main.name) || Boolean(set && TAP_NAME.test(set.name));
}

function labelOf(index: GraphIndex, instance: GraphNode): { text: string; known: boolean } {
  const bits: string[] = [];
  let saw = false;
  const raw = instance.metadata?.["componentProperties"];
  if (isRecord(raw)) {
    saw = true;
    for (const [key, value] of Object.entries(raw)) {
      const name = key.split("#")[0] ?? key;
      if (!/label|text|aria|description|alt/i.test(name)) continue;
      const inner = isRecord(value) ? value["value"] : value;
      if (typeof inner === "string" && inner.trim()) bits.push(inner.trim());
    }
  }
  if (instance.description?.trim()) bits.push(instance.description.trim());
  for (const node of index.getDescendants(instance.id)) {
    if (node.type !== "TEXT_LAYER" && node.metadata?.["figmaType"] !== "TEXT") continue;
    saw = true;
    const text = node.metadata?.["text"];
    if (typeof text === "string" && text.trim()) bits.push(text.trim());
  }
  if (bits.length) return { text: bits.join(" "), known: true };
  const main = index.getMainComponent(instance.id);
  if (!main) return { text: "", known: saw };
  const masterText: string[] = [];
  for (const node of [main, ...index.getDescendants(main.id)]) {
    const text = node.metadata?.["text"];
    if (typeof text === "string" && text.trim()) masterText.push(text.trim());
  }
  if (masterText.length) return { text: masterText.join(" "), known: true };
  if (index.getChildren(main.id).length > 0) return { text: "", known: true };
  return { text: "", known: saw };
}

function hasIcon(index: GraphIndex, instance: GraphNode): boolean {
  const nodes = [instance, ...index.getDescendants(instance.id)];
  const main = index.getMainComponent(instance.id);
  if (main) nodes.push(main, ...index.getDescendants(main.id));
  return nodes.some((node) => node.id !== instance.id && /\bicon\b/i.test(node.name));
}

function backgroundOf(
  index: GraphIndex,
  node: GraphNode,
  paintAt: (node: GraphNode) => SourcePaint | undefined,
): { hex?: string; reason?: string } {
  const ancestors = index.getAncestors(node.id);
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    const ancestor = ancestors[i];
    if (!ancestor || ancestor.id === node.id) continue;
    const fill = paintAt(ancestor)?.fills?.find((entry) => entry.hex);
    if (!fill) continue;
    if (fill.opacity !== undefined && fill.opacity < 1) return { reason: "the background colour is translucent" };
    return { hex: fill.hex };
  }
  return { reason: "the background colour is not in the capture" };
}

function accessFindings(
  index: GraphIndex,
  frame: GraphNode,
  bars: Bars,
  paintAt: (node: GraphNode) => SourcePaint | undefined,
  coloursKnown: boolean,
): ProperUseFinding[] {
  const findings: ProperUseFinding[] = [];
  if (!coloursKnown) {
    findings.push({
      severity: "info",
      check: "unknown",
      name: frame.name,
      ...(frame.figmaNodeId ? { figmaNodeId: frame.figmaNodeId } : {}),
      problem: "Hard-coded colours, strokes, effects, and text contrast could not be checked.",
      fix: "This capture has no boundVariables, styles, or fillStyleId. Re-check with a Figma REST payload.",
    });
  } else if (!bars.contrast) {
    findings.push({
      severity: "info",
      check: "unknown",
      name: frame.name,
      ...(frame.figmaNodeId ? { figmaNodeId: frame.figmaNodeId } : {}),
      problem: "Text contrast was not checked.",
      fix: "WCAG A does not set a text contrast ratio.",
    });
  } else {
    let between = 0;
    for (const node of index.getDescendants(frame.id)) {
      if (hidden(node) || skipBuried(index, node, "fill")) continue;
      const paint = paintAt(node);
      if (!paint?.textHex) continue;
      if (paint.fills?.some((fill) => fill.opacity !== undefined && fill.opacity < 1)) {
        findings.push({
          severity: "info",
          check: "unknown",
          name: node.name,
          ...(node.figmaNodeId ? { figmaNodeId: node.figmaNodeId } : {}),
          problem: "Text contrast could not be checked.",
          fix: "The text colour is translucent, so the contrast against the background was not guessed.",
        });
        continue;
      }
      const background = backgroundOf(index, node, paintAt);
      if (!background.hex) {
        findings.push({
          severity: "info",
          check: "unknown",
          name: node.name,
          ...(node.figmaNodeId ? { figmaNodeId: node.figmaNodeId } : {}),
          problem: "Text contrast could not be checked.",
          fix: `${background.reason ?? "The background colour is not in the capture"}.`,
        });
        continue;
      }
      const ratio = contrastRatio(paint.textHex, background.hex);
      if (ratio === undefined) continue;
      const large =
        paint.fontSize !== undefined &&
        (paint.fontSize >= 24 || (paint.fontSize >= 18.66 && (paint.fontWeight ?? 400) >= 600));
      const bar = large ? bars.large : bars.normal;
      if (paint.fontSize === undefined && ratio < bars.normal && ratio >= bars.large) {
        between += 1;
        continue;
      }
      const used = paint.fontSize === undefined ? bars.normal : bar;
      if (ratio + 0.05 >= used) continue;
      const shown = ratio.toFixed(1);
      findings.push({
        severity: "error",
        check: "contrast",
        name: node.name,
        ...(node.figmaNodeId ? { figmaNodeId: node.figmaNodeId } : {}),
        problem: `Text contrast is ${shown}:1, below ${used}:1 for ${bars.level}.`,
        fix: `Use a darker text colour or a lighter background so the contrast reaches ${used}:1.`,
      });
    }
    if (between) {
      findings.push({
        severity: "info",
        check: "unknown",
        name: frame.name,
        ...(frame.figmaNodeId ? { figmaNodeId: frame.figmaNodeId } : {}),
        problem: `${between} text layer${between === 1 ? "" : "s"} could not be judged for contrast.`,
        fix: "Font size is not in the capture, and the ratio sits between the normal and large-text bars.",
      });
    }
  }

  let missingSize = 0;
  let missingLabel = 0;
  for (const instance of placedInstances(index, frame)) {
    if (!interactive(index, instance)) continue;
    const box = instance.bounds;
    if (!box || box.width <= 0 || box.height <= 0) {
      missingSize += 1;
    } else if (box.width < bars.tap || box.height < bars.tap) {
      const width = Math.round(box.width);
      const height = Math.round(box.height);
      findings.push({
        severity: "error",
        check: "tap",
        name: instance.name,
        ...(instance.figmaNodeId ? { figmaNodeId: instance.figmaNodeId } : {}),
        problem: `This control is ${width}×${height}, under the ${bars.tap}×${bars.tap} tap target for ${bars.level}.`,
        fix: `Resize it to at least ${bars.tap}×${bars.tap}.`,
      });
    }
    const label = labelOf(index, instance);
    if (!label.known) {
      missingLabel += 1;
      continue;
    }
    if (!label.text.trim() && hasIcon(index, instance)) {
      findings.push({
        severity: "error",
        check: "icon",
        name: instance.name,
        ...(instance.figmaNodeId ? { figmaNodeId: instance.figmaNodeId } : {}),
        problem: "This icon-only button has no label or description.",
        fix: "Add a text label, or a description a screen reader can read.",
      });
    }
  }
  if (missingSize) {
    findings.push({
      severity: "info",
      check: "unknown",
      name: frame.name,
      ...(frame.figmaNodeId ? { figmaNodeId: frame.figmaNodeId } : {}),
      problem: `${missingSize} control${missingSize === 1 ? "" : "s"} had no size, so tap targets were not checked.`,
      fix: "Re-check with a payload that includes width and height.",
    });
  }
  if (missingLabel) {
    findings.push({
      severity: "info",
      check: "unknown",
      name: frame.name,
      ...(frame.figmaNodeId ? { figmaNodeId: frame.figmaNodeId } : {}),
      problem: `${missingLabel} control${missingLabel === 1 ? "" : "s"} had no text in the capture, so an icon-only label was not checked.`,
      fix: "Re-check with instance text or a description.",
    });
  }
  return findings;
}

function coloursKnown(index: GraphIndex, designContext: unknown): boolean {
  if (designContext !== undefined && payloadHasBindings(designContext)) return true;
  const kind = index.graph.source.kind;
  if (kind === "figma-mcp") return false;
  if (kind === "figma-rest" || kind === "mock") return true;
  return index.graph.nodes.some((node) => isRecord(node.metadata?.["paint"]));
}

function countPhrase(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function summaryOf(findings: ProperUseFinding[]): string {
  const count = (check: ProperUseCheck, severity?: ProperUseSeverity) =>
    findings.filter((finding) => finding.check === check && (!severity || finding.severity === severity)).length;
  const parts: string[] = [];
  const detached = count("detached", "error");
  if (detached) parts.push(countPhrase(detached, "detached", "detached"));
  const colours = count("colour", "warning");
  if (colours) parts.push(countPhrase(colours, "hard-coded colour", "hard-coded colours"));
  const spacing = count("spacing", "warning");
  if (spacing) parts.push(countPhrase(spacing, "hard-coded spacing", "hard-coded spacing"));
  const radius = count("radius", "warning");
  if (radius) parts.push(countPhrase(radius, "hard-coded radius", "hard-coded radii"));
  const effects = count("effect", "warning");
  if (effects) parts.push(countPhrase(effects, "hard-coded effect"));
  const contrast = count("contrast", "error");
  if (contrast) parts.push(countPhrase(contrast, "contrast fail"));
  const taps = count("tap", "error");
  if (taps) parts.push(countPhrase(taps, "tap target"));
  const properties = count("property", "error");
  if (properties) parts.push(countPhrase(properties, "property error"));
  const placeholders = count("placeholder", "warning");
  if (placeholders) parts.push(countPhrase(placeholders, "placeholder"));
  const icons = count("icon", "error");
  if (icons) parts.push(countPhrase(icons, "icon-only button"));
  const unknown = findings.filter((finding) => finding.severity === "info").length;
  if (!parts.length) return unknown ? `0 errors, ${countPhrase(unknown, "unknown", "unknown")}` : "0 errors";
  if (unknown) parts.push(countPhrase(unknown, "unknown", "unknown"));
  return parts.join(", ");
}

function sortFindings(findings: ProperUseFinding[]): ProperUseFinding[] {
  return [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || CHECK_RANK[a.check] - CHECK_RANK[b.check]);
}

function reportFrom(findings: ProperUseFinding[], level: string, truncated?: string): ProperUseReport {
  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.filter((finding) => finding.severity === "warning").length;
  const unknown = findings.filter((finding) => finding.severity === "info").length;
  return {
    summary: summaryOf(findings),
    errors,
    warnings,
    unknown,
    exitCode: errors > 0 ? PROPER_USE_EXIT : 0,
    level,
    findings,
    ...(truncated ? { truncated } : {}),
  };
}

/** Existing check exit stays 1. Proper-use errors exit 7 only when that check passed. */
export function verifyExitCode(result: { pass?: boolean; properUse?: { exitCode?: number } }): number {
  if (result.pass === false) return 1;
  const code = result.properUse?.exitCode ?? 0;
  return code === 0 ? 0 : code;
}

/**
 * JSON `pass` for a check. True only when the verdict exit code is 0.
 * A proper-use failure keeps the component pass on the object verify uses for
 * Markdown (`Components: PASS`), and this copy sets `pass` false for exit 7.
 */
function withPass(value: object): value is { pass: boolean; properUse?: { exitCode?: number } } {
  return "pass" in value && typeof value.pass === "boolean";
}

export function publishedVerdict<T>(result: T): T {
  if (!result || typeof result !== "object" || Array.isArray(result) || !withPass(result)) return result;
  const pass = verifyExitCode(result) === 0;
  if (result.pass === pass) return result;
  return { ...result, pass } as T;
}

export function checkProperUse(index: GraphIndex, frameName: string | undefined, options: ProperUseOptions = {}): ProperUseReport | undefined {
  const asked = frameName?.trim();
  if (!asked) return undefined;
  const frame = resolveNode(index, asked);
  if (!frame || frame.type === "COMPONENT_INSTANCE") return undefined;
  const bars = barsFor(a11yLevel(options.a11y));
  const overlay = options.designContext !== undefined ? paintsByNodeId(options.designContext) : new Map<string, SourcePaint>();
  const paintAt = (node: GraphNode) => paintOf(node, overlay);
  const known = coloursKnown(index, options.designContext);
  const tokens = libraryTokens(index);
  const findings = [
    ...detachedFindings(index, frame, options.workspace),
    ...(known ? hardCodedFindings(index, frame, tokens, paintAt) : []),
    ...propertyFindings(index, frame),
    ...accessFindings(index, frame, bars, paintAt, known),
  ];
  return reportFrom(sortFindings(findings), bars.level);
}

function dropKey(host: Record<string, unknown>, key: string): boolean {
  if (!(key in host)) return false;
  delete host[key];
  return true;
}

/** Low-value check fields. Proper-use errors outrank them when the card is over 600. */
function shedProperUseHost(host: Record<string, unknown>, step: number): boolean {
  switch (step) {
    case 0:
      return dropKey(host, "builtAt");
    case 1:
      return dropKey(host, "renamed") || dropKey(host, "renamedNote");
    case 2:
      return dropKey(host, "warningNote") || dropKey(host, "warnings");
    case 3:
      return dropKey(host, "labelDiffers");
    case 4:
      return dropKey(host, "pendingImprovements");
    case 5: {
      const unchecked = host["unchecked"];
      if (!isRecord(unchecked) || !Array.isArray(unchecked["names"])) return false;
      host["unchecked"] = { count: unchecked["count"] };
      return true;
    }
    case 6:
      return dropKey(host, "textReason");
    case 7: {
      const hint = host["hint"];
      if (typeof hint !== "string" || hint.length < 48) return false;
      const sentence = hint.split(/(?<=\.) /)[0] ?? hint;
      if (sentence.length >= hint.length) return false;
      host["hint"] = sentence;
      return true;
    }
    case 8:
      return dropKey(host, "hint");
    default:
      return false;
  }
}

function moreLine(hidden: number): string | undefined {
  if (hidden <= 0) return undefined;
  const count = hidden === 1 ? "+1 more" : `+${hidden} more`;
  return `${count}. resolve check --all, or verify_frame all:true`;
}

/**
 * Shrink the proper-use list until the card fits. Every error stays, ahead of `+N more`.
 * `all` returns the full list. Counts and the exit code stay either way.
 */
export function attachProperUse<T extends object>(
  card: T,
  report: ProperUseReport | undefined,
  options: { all?: boolean } = {},
): T & { properUse?: ProperUseReport; cost?: AgentCost } {
  if (!report) return card;
  const price = (value: object) => {
    const next = { ...value } as { cost?: unknown };
    delete next.cost;
    return withCost(next);
  };
  const full = sortFindings(report.findings);
  const host = { ...card } as Record<string, unknown>;
  delete host["cost"];
  if (options.all) {
    const properUse: ProperUseReport = { ...report, findings: full };
    delete properUse.truncated;
    return price({ ...host, properUse }) as T & { properUse?: ProperUseReport; cost?: AgentCost };
  }
  const budget = 600;
  let shown = full;
  let truncated: string | undefined;
  let shed = 0;
  const build = () =>
    price({
      ...host,
      properUse: {
        ...report,
        findings: shown,
        ...(truncated ? { truncated } : {}),
      },
    });
  let priced = build();
  while (JSON.stringify(priced).length > budget) {
    const last = shown[shown.length - 1];
    if (last && last.severity !== "error") {
      shown = shown.slice(0, -1);
      truncated = moreLine(full.length - shown.length);
    } else if (report.errors > 0 && shed <= 8) {
      shedProperUseHost(host, shed);
      shed += 1;
    } else break;
    priced = build();
  }
  if (JSON.stringify(priced).length > budget && report.errors === 0) return card;
  return priced as T & { properUse?: ProperUseReport; cost?: AgentCost };
}
