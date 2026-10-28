import { readFileSync } from "node:fs";
import { overlayFile } from "./overlayFile";

/**
 * Off by default. RESOLVE_MAPPING_ALIASES=1 lets the Figma-side pick read the aliases a team wrote in
 * `.resolve/mapping.json` for a Figma component, as one synonym group per line: ["Status Pill", "pill", "status chip"].
 * Same path as synonyms.json, so "status chip" finds Status Pill. A missing or broken file adds nothing.
 * Changes ranking, so it needs a fresh blind run before it is turned on for anyone.
 */
export function mappingAliasGroups(): string[][] {
  if (process.env["RESOLVE_MAPPING_ALIASES"] !== "1") return [];
  const path = overlayFile("mapping.json");
  if (!path) return [];
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
    const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? (raw as { mappings?: unknown }).mappings : undefined;
    if (!Array.isArray(list)) return [];
    return list.flatMap((row): string[][] => {
      const { figma, aliases } = (row && typeof row === "object" ? row : {}) as { figma?: unknown; aliases?: unknown };
      const names = [figma, ...(Array.isArray(aliases) ? aliases : typeof aliases === "string" ? [aliases] : [])]
        .flatMap((name) => (typeof name === "string" && name.trim() ? [name.trim().toLowerCase()] : []));
      return typeof figma === "string" && new Set(names).size > 1 ? [[...new Set(names)]] : [];
    });
  } catch {
    return [];
  }
}
