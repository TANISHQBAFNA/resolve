import type { GraphIndex } from "@/core/query/GraphIndex";
import type { GraphNode } from "@/core/model";
import { propertyBlock, type PropertyRow } from "@/core/query/componentProperties";
import { recommendMasters } from "@/core/query/recommendMasters";

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

export interface ConfigureReport {
  ask: string;
  choice: ConfigureChoice | null;
  configuration: ConfigureProperty[];
  slots: string[];
  visibility: "unknown";
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
    return finish(ask, null, [], [], [], warnings);
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
  warnings.push({
    warning: "Which property shows or hides a child is not in this graph.",
    next: "Leave visibility unset.",
  });
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
  );
}

/** A gap before ranking: empty request, or no learned library. */
export function configureGap(ask: string, warning: string, next: string): ConfigureReport {
  return finish(ask, null, [], [], [], [{ warning, next }]);
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
): ConfigureReport {
  return {
    ask,
    choice,
    configuration,
    slots,
    visibility: "unknown",
    alternatives,
    warnings,
    next: warnings[0]?.next ?? PLACE,
  };
}
