import type { GraphNode } from "./graph";

export const DESIGN_STATUSES = ["draft", "approved", "deprecated", "experimental"] as const;
export type DesignStatus = (typeof DESIGN_STATUSES)[number];

export const EDGE_CONFIDENCES = ["EXTRACTED", "INFERRED", "AMBIGUOUS"] as const;
export type EdgeConfidence = (typeof EDGE_CONFIDENCES)[number];

export interface Governance {
  status?: DesignStatus;
  owner?: string;
  platforms?: string[];
  /** How status was established. Missing status => undefined. */
  statusSource?: "front-matter" | "name" | "keyword" | "inherited";
}

const STATUS_SET = new Set<string>(DESIGN_STATUSES);

function asStatus(value: string): DesignStatus | undefined {
  const normalised = value.trim().toLowerCase();
  return STATUS_SET.has(normalised) ? (normalised as DesignStatus) : undefined;
}

/**
 * Read governance from Figma text. Front-matter wins:
 *
 *   status: deprecated
 *   owner: payments
 *   platform: web, ios
 *
 * Name `[deprecated]` / word "deprecated" is a fallback, tagged INFERRED.
 */
export function parseGovernance(name: string, description?: string): Governance {
  const governance: Governance = {};
  const blob = description ?? "";

  for (const line of blob.split(/\n/)) {
    const match = line.match(/^\s*(status|owner|platform|platforms)\s*:\s*(.+?)\s*$/i);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const value = match[2]!;
    if (key === "status") {
      const status = asStatus(value);
      if (status) {
        governance.status = status;
        governance.statusSource = "front-matter";
      }
    } else if (key === "owner") {
      governance.owner = value;
    } else if (key === "platform" || key === "platforms") {
      governance.platforms = value
        .split(/[,/]/)
        .map((part) => part.trim())
        .filter(Boolean);
    }
  }

  if (!governance.status) {
    if (/\[deprecated\]|\bdeprecated\b/i.test(name)) {
      governance.status = "deprecated";
      governance.statusSource = "name";
    } else if (
      /\bdeprecated\b/i.test(blob) ||
      /\bretired\b/i.test(`${name} ${blob}`) ||
      /\blegacy\b/i.test(`${name} ${blob}`) ||
      /\bdo not use\b/i.test(blob)
    ) {
      governance.status = "deprecated";
      governance.statusSource = "keyword";
    } else if (/\bexperimental\b/i.test(`${name} ${blob}`)) {
      governance.status = "experimental";
      governance.statusSource = "keyword";
    }
  }

  return governance;
}

export function applyGovernance(node: GraphNode): void {
  const parsed = parseGovernance(node.name, node.description);
  if (parsed.status) node.status = parsed.status;
  if (parsed.owner) node.owner = parsed.owner;
  if (parsed.platforms?.length) node.platforms = parsed.platforms;
  if (parsed.statusSource) {
    node.metadata = { ...node.metadata, statusSource: parsed.statusSource };
  }
}

export function inheritGovernance(instance: GraphNode, main: GraphNode): void {
  if (instance.status || !main.status) return;
  instance.status = main.status;
  if (main.owner && !instance.owner) instance.owner = main.owner;
  if (main.platforms && !instance.platforms) instance.platforms = main.platforms;
  instance.metadata = { ...instance.metadata, statusSource: "inherited" };
}
