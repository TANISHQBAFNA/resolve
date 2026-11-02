import type { CatalogEntry } from "./code/scan.ts";
import { nameWords, RELATED, stem } from "./code/words.ts";

export const RISKY_TIER = "risky: same name only";

const plural = (word: string) => (word.length > 3 && word.endsWith("ies") ? `${word.slice(0, -3)}y` : word.length > 3 && word.endsWith("s") && !/(ss|us|is)$/.test(word) ? word.slice(0, -1) : word);

/** Comparable key for a Figma or code name. Same folding as the pairer: case, hyphen, plural. */
export function pairKey(name: string): string {
  return (nameWords(name).toLowerCase().match(/[a-z0-9]+/g) ?? []).map(plural).join("");
}

/** Same name after namespace prefixes and plurals. Related words, one shared token, and a `-container` name with a different code name are not evidence. */
export function evidencePair(figma: string, code: string): boolean {
  return pairKey(figma) === pairKey(code);
}

export function suggestionTier(row: { confidence?: string; reasons?: readonly string[] }): "suggested" | "risky" {
  if (row.confidence === RISKY_TIER || (row.reasons ?? []).some((reason) => reason === RISKY_TIER || reason === "same name, no evidence")) return "risky";
  return "suggested";
}

/** Evidence rows that share a Figma side or a code side drop to suggested. */
export function demoteSharedLinks<T extends { figma: string; code: string; tier: "evidence" | "suggested" | "risky" }>(rows: readonly T[]): T[] {
  const evidence = rows.filter((row) => row.tier === "evidence");
  const figma = new Map<string, number>();
  const code = new Map<string, number>();
  for (const row of evidence) {
    figma.set(row.figma, (figma.get(row.figma) ?? 0) + 1);
    code.set(row.code, (code.get(row.code) ?? 0) + 1);
  }
  return rows.map((row) => {
    if (row.tier !== "evidence") return row;
    if (!evidencePair(row.figma, row.code) || (figma.get(row.figma) ?? 0) > 1 || (code.get(row.code) ?? 0) > 1) return { ...row, tier: "suggested" };
    return row;
  });
}

/** A same name is only a suggestion for review. It never links on its own. */
export function sameNameRow(figma: string, code: string): { figma: string; code: string; confidence: typeof RISKY_TIER; score: number; reasons: string[] } {
  return { figma, code, confidence: RISKY_TIER, score: 1, reasons: [RISKY_TIER, "same name, no evidence; confirm it or add the shared ID"] };
}

/** `paired + parts + unmatched` against the Figma total. Parts on a pair and parts on an unpaired block both count once. */
export function figmaTotalCheck(report: { figmaComponents: number; pairs: Array<{ figma: string; parts?: string[] }>; unpairedParts?: Array<{ parts: string[] }>; unmatchedFigma: string[]; heldFigma?: string[] }): string {
  const paired = new Set(report.pairs.map((pair) => pair.figma)).size;
  const parts = new Set([...report.pairs.flatMap((pair) => pair.parts ?? []), ...(report.unpairedParts ?? []).flatMap((row) => row.parts)]).size;
  const open = report.unmatchedFigma.length;
  const held = report.heldFigma?.length ?? 0;
  const sum = paired + parts + open + held;
  const review = held ? ` + ${held} in review` : "";
  return `${paired} paired + ${parts} parts + ${open} unmatched${review} = ${sum}${sum === report.figmaComponents ? "" : `, not ${report.figmaComponents}`}`;
}

/** Block a part belongs on: plural (tab/tabs), compound (field-label), or a prefix family (steps/stepper). */
export function partOwner(partName: string, blocks: CatalogEntry[], namespaces: ReadonlySet<string>, plural: (word: string) => string, order: (a: string, b: string) => number): CatalogEntry | undefined {
  const words = nameWords(partName, namespaces).toLowerCase().split(/\s+/).filter(Boolean).map(plural);
  const slug = words.join("-");
  const head = stem(words[0] ?? "");
  return blocks.filter((entry) => {
    const body = entry.name.toLowerCase().split("-").map(plural);
    const block = body.join("-");
    if (slug && (slug === block || slug.startsWith(`${block}-`))) return true;
    const other = stem(body[0] ?? "");
    const prefixed = head.length >= 4 && other.length >= 4 && head !== other && (head.startsWith(other) || other.startsWith(head));
    return prefixed && ((RELATED.get(head) ?? []).some(([word]) => word === other) || (RELATED.get(other) ?? []).some(([word]) => word === head));
  }).sort((a, b) => b.name.length - a.name.length || order(a.name, b.name))[0];
}
