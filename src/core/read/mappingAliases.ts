import { readFileSync } from "node:fs";
import { overlayFile } from "./overlayFile";

export interface MappingRecord {
  figma: string;
  aliases: string[];
  /** A missing status counts as confirmed, same as the alias switch. */
  status: "proposed" | "confirmed" | "denied";
}

function mappingList(): unknown[] {
  const path = overlayFile("mapping.json");
  if (!path) return [];
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
    const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? (raw as { mappings?: unknown }).mappings : undefined;
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function rowOf(row: unknown): MappingRecord | undefined {
  const { figma, aliases, status } = (row && typeof row === "object" ? row : {}) as { figma?: unknown; aliases?: unknown; status?: unknown };
  if (typeof figma !== "string" || !figma.trim()) return undefined;
  const names = (Array.isArray(aliases) ? aliases : typeof aliases === "string" ? [aliases] : [])
    .flatMap((name) => (typeof name === "string" && name.trim() ? [name.trim().toLowerCase()] : []));
  const review = status === "proposed" || status === "denied" || status === "confirmed" ? status : status === undefined ? "confirmed" : "denied";
  return { figma: figma.trim(), aliases: [...new Set(names)], status: review };
}

/** Every mapping row with a Figma name. A missing or broken file is empty. Does not read the alias switch. */
export function mappingRecords(): MappingRecord[] {
  return mappingList().flatMap((row) => {
    const parsed = rowOf(row);
    return parsed ? [parsed] : [];
  });
}

/**
 * Off by default. RESOLVE_MAPPING_ALIASES=1 lets the Figma-side pick read the aliases a team wrote in
 * `.resolve/mapping.json` for a Figma component, as one synonym group per line: ["Status Pill", "pill", "status chip"].
 * A line whose status is not "confirmed" (a missing status counts as confirmed) adds nothing. Same path as synonyms.json, so "status chip" finds Status Pill. A missing or broken file adds nothing.
 * Changes ranking, so it needs a fresh blind run before it is turned on for anyone.
 */
export function mappingAliasGroups(): string[][] {
  if (process.env["RESOLVE_MAPPING_ALIASES"] !== "1") return [];
  return mappingRecords().flatMap((row) => {
    if (row.status !== "confirmed") return [];
    const names = [row.figma.toLowerCase(), ...row.aliases];
    return new Set(names).size > 1 ? [[...new Set(names)]] : [];
  });
}
