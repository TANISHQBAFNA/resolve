import { trimmedStrings } from "@/core/query/recommendSupport";

export function parseLearnOutline(value: unknown): Array<{ id: string; name: string; kind: "page" | "frame" }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const units: Array<{ id: string; name: string; kind: "page" | "frame" }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec["id"] === "string" ? rec["id"].trim() : "";
    const name = typeof rec["name"] === "string" ? rec["name"].trim() : id;
    const kind = rec["kind"] === "page" ? "page" : "frame";
    if (!id) continue;
    units.push({ id, name: name || id, kind });
  }
  return units.length ? units : undefined;
}


export const asStringList = (value: unknown): string[] | undefined => {
  if (typeof value === "string") {
    const items = value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    return items.length ? items : undefined;
  }
  return trimmedStrings(value);
};
