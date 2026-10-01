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

const RETIRE_LEAD =
  /^(?:deprecated|retired|legacy|do not use|obsolete|no longer used|replaced by)\b/i;
const RETIRE_NEGATION = /\bno\b|\bnot needed\b|\bwithout\b|\bbut\b|\bback\b|\bsupports\b/i;

function peelRetireDecor(text: string): string {
  let rest = text.trim();
  for (let step = 0; step < 8; step += 1) {
    const bracket = rest.match(/^\[([^\]]*)\]\s*/u);
    if (bracket) {
      const inner = bracket[1]!.trim();
      rest = RETIRE_LEAD.test(inner)
        ? `${inner} ${rest.slice(bracket[0].length)}`.trim()
        : rest.slice(bracket[0].length).trim();
      continue;
    }
    const emoji = rest.match(/^[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]+\s*/u);
    if (emoji) {
      rest = rest.slice(emoji[0].length).trim();
      continue;
    }
    const colon = rest.match(/^:+\s*/);
    if (colon) {
      rest = rest.slice(colon[0].length).trim();
      continue;
    }
    break;
  }
  return rest;
}

/**
 * Description marks a set retired only when it *starts* with a retire phrase
 * (after trim, and optional leading bracket / emoji / colon). A negation in
 * the same sentence ("but", "supports", "no", …) cancels it.
 */
export function descriptionIsRetired(description?: string): boolean {
  if (!description) return false;
  const lead = peelRetireDecor(description);
  const hit = lead.match(RETIRE_LEAD);
  if (!hit) return false;
  const sentenceEnd = lead.search(/[.!?]/);
  const sentence = sentenceEnd === -1 ? lead : lead.slice(0, sentenceEnd);
  const after = sentence.slice(hit[0].length);
  return !RETIRE_NEGATION.test(after);
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
    } else if (/\blegacy\b/i.test(name)) {
      governance.status = "deprecated";
      governance.statusSource = "keyword";
    } else if (descriptionIsRetired(blob)) {
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
