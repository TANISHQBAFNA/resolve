import type { GraphIndex } from "@/core/query/GraphIndex";
import type { GraphNode } from "@/core/model";
import { cleanPropertyName } from "@/core/model/componentProperties";
import { propertyBlock, type PropertyRow } from "@/core/query/componentProperties";
import { recommendMasters } from "@/core/query/recommendMasters";
import { controllingFromReferences } from "@/core/screenMap/capture";

export interface ConfigureWarning {
  warning: string;
  next: string;
}

export type ConfigureBasis = "library-rule" | "unverified" | "stale" | "usage";

export interface ConfigureChoice {
  id: string;
  name: string;
  fileKey?: string;
  figmaNodeId?: string;
  why: string;
  basis: ConfigureBasis;
}

export interface ConfigureProperty {
  property: string;
  type: string;
  values?: string[];
  set?: string;
  evidence: "request" | "unset";
}

export interface ControlledChild {
  child: string;
  property: string;
  type: string;
  hidden?: true;
  overridden?: true;
  value: true | false | "missing";
}

export type ConfigureVisibility =
  | { state: "unknown"; reason: string }
  | { state: "controlled"; children: ControlledChild[]; ignored?: string };

const VISIBILITY_ABSENT = "This graph does not name which property shows or hides a child.";

export interface ConfigureReport {
  ask: string;
  choice: ConfigureChoice | null;
  configuration: ConfigureProperty[];
  slots: string[];
  visibility: ConfigureVisibility;
  alternatives: Array<{ id: string; name: string; why: string }>;
  warnings: ConfigureWarning[];
  next: string;
}

const PLACE = "Place fileKey and figmaNodeId. Leave unset properties unset.";

/** Choose one real component and the properties the request may set. Gaps are warnings. */
export function configureChoice(
  index: GraphIndex,
  ask: string,
  context?: { journey?: string; screenType?: string },
): ConfigureReport {
  const journey = context?.journey?.trim();
  const screenType = context?.screenType?.trim();
  const card = recommendMasters(index, ask, {
    ...(journey || screenType
      ? {
          context: {
            ...(screenType ? { id: screenType, screenType, domain: screenType } : {}),
            ...(journey ? { id: journey, journey: { screenJob: journey, step: journey } } : {}),
          },
        }
      : {}),
  });
  const lead = card.candidates[0];
  const full = lead && "instances" in lead ? lead : undefined;
  const warnings: ConfigureWarning[] = [];
  if (!lead) {
    warnings.push({
      warning: "No component in the learned library matched.",
      next: "Name a component that is in the library, or learn the library. Do not invent one.",
    });
    return finish(ask, null, [], [], [], warnings, { state: "unknown", reason: VISIBILITY_ABSENT });
  }
  if (card.match === "weak match") {
    warnings.push({ warning: "Weak match. The name is not a clear hit.", next: "Check the name before placing it." });
  }
  if (full?.deprecated) {
    warnings.push({ warning: `${lead.name} is deprecated.`, next: "Do not place it. Pick another candidate." });
  }
  const why = lead.why;
  const parts = why.split("; ").map((part) => part.trim());
  if (parts.includes("stale")) {
    warnings.push({ warning: "Usage for this component is stale.", next: "Treat the count as out of date." });
  }
  if (parts.some((part) => part.startsWith("not verified")) || (full?.instances ?? 0) === 0) {
    warnings.push({
      warning: "No confirmed usage on a learned screen.",
      next: "Use it only when the name and the allowed values match the request.",
    });
  }
  if (card.note) warnings.push({ warning: card.note, next: "Resolve the name clash before placing." });
  const visibility = visibilityFor(index, lead.id);
  if (visibility.state === "unknown") {
    warnings.push({ warning: visibility.reason, next: "Leave visibility unset." });
  } else if (visibility.ignored) {
    warnings.push({ warning: visibility.ignored, next: "Leave that child unset." });
  }
  const node = index.getNode(lead.id);
  const fromDefs = full?.properties ?? (node ? propertyBlock(index, node, ask)?.properties : undefined) ?? [];
  const rows = fromDefs.length ? fromDefs.map(publicProperty) : variantConfiguration(index, node, ask);
  return finish(
    ask,
    {
      id: lead.id,
      name: lead.name,
      ...(lead.fileKey ? { fileKey: lead.fileKey } : {}),
      ...(lead.figmaNodeId ? { figmaNodeId: lead.figmaNodeId } : {}),
      why,
      basis: basisOf(parts),
    },
    rows,
    full?.slots ?? [],
    card.candidates.slice(1, 4).map((row) => ({ id: row.id, name: row.name, why: row.why })),
    warnings,
    visibility,
  );
}

/** A gap before ranking: empty request, or no learned library. */
export function configureGap(ask: string, warning: string, next: string): ConfigureReport {
  return finish(ask, null, [], [], [], [{ warning, next }], { state: "unknown", reason: warning });
}

function basisOf(parts: string[]): ConfigureBasis {
  if (parts.some((part) => part.startsWith("bind rule"))) return "library-rule";
  if (parts.includes("stale")) return "stale";
  if (parts.some((part) => part.startsWith("not verified"))) return "unverified";
  return "usage";
}

function publicProperty(row: PropertyRow): ConfigureProperty {
  const set = row.designerSays?.split("→")[1]?.trim();
  return {
    property: row.property,
    type: row.type,
    ...(row.values?.length ? { values: row.values } : {}),
    ...(set ? { set, evidence: "request" as const } : { evidence: "unset" as const }),
  };
}

/** Variant values live on the set's children when the component has no property definitions. */
function variantConfiguration(index: GraphIndex, node: GraphNode | undefined, ask: string): ConfigureProperty[] {
  if (!node) return [];
  const values = new Map<string, string[]>();
  for (const child of index.getChildren(node.id)) {
    for (const [key, value] of Object.entries(child.variantProperties ?? {})) {
      if (!value) continue;
      const list = values.get(key) ?? [];
      if (!list.includes(value)) list.push(value);
      values.set(key, list);
    }
  }
  const askText = ask.toLowerCase();
  return [...values].map(([property, allowed]) => {
    const set = allowed.find((value) => askText.includes(value.toLowerCase()));
    return {
      property,
      type: "VARIANT",
      values: allowed,
      ...(set ? { set, evidence: "request" as const } : { evidence: "unset" as const }),
    };
  });
}

function finish(
  ask: string,
  choice: ConfigureChoice | null,
  configuration: ConfigureProperty[],
  slots: string[],
  alternatives: ConfigureReport["alternatives"],
  warnings: ConfigureWarning[],
  visibility: ConfigureVisibility,
): ConfigureReport {
  return {
    ask,
    choice,
    configuration,
    slots,
    visibility,
    alternatives,
    warnings,
    next: warnings[0]?.next ?? PLACE,
  };
}

function definitionsOf(index: GraphIndex, node: GraphNode): Array<{ name: string; type: string }> {
  const set = node.componentSetId ? index.getNode(node.componentSetId) : undefined;
  return [...(node.propertyDefinitions ?? []), ...(set?.propertyDefinitions ?? [])].map((row) => ({ name: row.name, type: row.type }));
}

function descendants(index: GraphIndex, id: string): GraphNode[] {
  const out: GraphNode[] = [];
  for (const child of index.getChildren(id)) out.push(child, ...descendants(index, child.id));
  return out;
}

function booleanValue(node: GraphNode, property: string): true | false | "missing" {
  const raw = node.metadata?.["componentProperties"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "missing";
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (cleanPropertyName(key).name !== property) continue;
    const inner = value && typeof value === "object" && "value" in value ? (value as { value: unknown }).value : value;
    if (inner === true || inner === false) return inner;
    return "missing";
  }
  return "missing";
}

/** A child is controlled only when its captured visible reference names a real property. */
export function visibilityFor(index: GraphIndex, nodeId: string): ConfigureVisibility {
  const lead = index.getNode(nodeId);
  if (!lead) return { state: "unknown", reason: VISIBILITY_ABSENT };
  const definitions = definitionsOf(index, lead);
  const children: ControlledChild[] = [];
  let guessed = false;
  let unmatched = false;
  for (const child of descendants(index, lead.id)) {
    const raw = child.metadata?.["componentPropertyReferences"];
    const visible = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>)["visible"] : undefined;
    if (typeof visible !== "string" || !visible.trim()) continue;
    if (child.metadata?.["identity"] === "inferred-from-name") {
      guessed = true;
      continue;
    }
    const control = controllingFromReferences({ visible }, definitions);
    if (!control || !definitions.some((row) => row.name === control.property && row.type === control.type)) {
      unmatched = true;
      continue;
    }
    const hidden = child.metadata?.["hidden"] === true;
    const overrides = child.metadata?.["overrides"];
    const overridden = Array.isArray(overrides) && overrides.length > 0;
    children.push({
      child: child.name,
      property: control.property,
      type: control.type,
      ...(hidden ? { hidden: true } : {}),
      ...(overridden ? { overridden: true } : {}),
      value: booleanValue(child, control.property),
    });
  }
  if (children.length) {
    return {
      state: "controlled",
      children,
      ...(unmatched ? { ignored: "A visible reference does not match a property on this component." } : {}),
    };
  }
  if (guessed) return { state: "unknown", reason: "The visible reference is on a guessed layer, so it is not a property." };
  if (unmatched) return { state: "unknown", reason: "The visible reference does not match a property on this component." };
  return { state: "unknown", reason: VISIBILITY_ABSENT };
}
