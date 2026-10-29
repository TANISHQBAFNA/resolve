/**
 * The review state of one `.resolve/mapping.json` line, in the same words `code-map --draft` uses in component-map.json.
 * `proposed` is a draft nobody has reviewed: it is listed as awaiting review and never joins. `confirmed` joins.
 * `denied` is the same as `deny: true`. A line with no status was hand-written before states existed, so it counts as confirmed.
 * Any other value is not trusted: it is read as proposed and listed as a problem.
 */
export type MappingStatus = "proposed" | "confirmed" | "denied";

export function mappingStatus(value: unknown, where: string, problems: string[]): MappingStatus {
  if (value === undefined || value === "confirmed" || value === "denied" || value === "proposed") return value ?? "confirmed";
  problems.push(`${where} has status ${JSON.stringify(value)}. Use "proposed", "confirmed" or "denied". It is read as proposed and is not joined.`);
  return "proposed";
}

/** A line `code-map --write` should mark confirmed: not a deny, with a status that is set and is not confirmed. */
export const awaitsReview = (row: Record<string, unknown>) => row["deny"] !== true && row["status"] !== undefined && row["status"] !== "confirmed" && row["status"] !== "denied";
