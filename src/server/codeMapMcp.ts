import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { scanAngularPackage } from "@/adapters/angular";
import type { GraphIndex } from "@/core/query/GraphIndex";
import { codeMapJson, entriesToCsv, readCodeMapDocument } from "@/core/query/codeMapCsv";
import { deprecationNotice } from "./deprecations";
import { importReview, mapFile, preparedSuggestions, writeSuggestions } from "./codeMapCommand";

/** Older names for `code_map`. They stay callable and say to use `code_map`. */
export const CODE_MAP_ALIASES: Record<string, "scan" | "suggest" | "review"> = {
  code_map_scan: "scan",
  code_map_suggest: "suggest",
  code_map_review: "review",
};

/** Undefined when `name` is not an alias. Throws the advanced-surface error when the switch is off. */
export function callCodeMapAlias(name: string, rawArgs: unknown, indexFor: (args: Record<string, unknown>) => GraphIndex): unknown | undefined {
  if (!(name in CODE_MAP_ALIASES)) return undefined;
  if (process.env["RESOLVE_MCP_ADVANCED"] !== "1") {
    throw new Error(`Tool "${name}" is not on the default MCP surface. Set RESOLVE_MCP_ADVANCED=1 to enable it. Agents cannot call advanced tools.`);
  }
  const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
  const raw = runCodeMapTool(name, args, CODE_MAP_ALIASES[name] === "scan" ? undefined : indexFor(args));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  return { deprecation: deprecationNotice(name, "code_map"), ...raw };
}

export function runCodeMapTool(name: string, args: Record<string, unknown>, index?: GraphIndex): unknown {
  if (name === "code_map_scan") return scanAngularPackage(resolve(asText(args["package"], "package")));
  if (name === "code_map_suggest") {
    if (!index) throw new Error("code_map_suggest needs a learned library.");
    const spec = asText(args["package"], "package");
    if (args["write"] === true) {
      const written = writeSuggestions(spec, index);
      return { wrote: written.path, suggestions: written.pairs, note: "Suggestions are not mapped. Review them before using one as a code twin." };
    }
    const prepared = preparedSuggestions(spec, index);
    return {
      packageName: prepared.inventory.packageName,
      packageVersion: prepared.inventory.packageVersion,
      suggestions: prepared.pairs,
      note: "Every pair is suggested. None is a code twin until review marks it mapped.",
    };
  }
  if (name === "code_map_review") {
    const csv = typeof args["csv"] === "string" ? args["csv"] : "";
    if (!csv.trim()) {
      const doc = readCodeMapDocument(mapFile());
      return { csv: entriesToCsv(doc.entries), note: "Set status to mapped on confirmed rows, then call code_map_review with that csv. A blank status stays suggested." };
    }
    const text = csv.includes("\n") || csv.includes(",") ? csv : readFileSync(resolve(csv), "utf8");
    const result = importReview(text, args["replace"] === true);
    if (!result.ok) return { ok: false, errors: result.errors };
    mkdirSync(dirname(result.path), { recursive: true });
    writeFileSync(result.path, codeMapJson(result.merged.entries, result.previous));
    const mapped = result.merged.entries.filter((entry) => isRow(entry) && entry["status"] === "mapped").length;
    return {
      ok: true,
      path: result.path,
      kept: result.merged.untouched.length,
      mapped,
      note: "Only rows marked mapped are confirmed. Entries the CSV left out were kept.",
    };
  }
  return undefined;
}

function asText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

function isRow(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
