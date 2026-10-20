import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { scanAngularPackage } from "@/adapters/angular";
import type { GraphIndex } from "@/core/query/GraphIndex";
import { codeMapJson, entriesToCsv, readCodeMapDocument } from "@/core/query/codeMapCsv";
import { importReview, mapFile, preparedSuggestions, writeSuggestions } from "./codeMapCommand";

/**
 * Advanced MCP tools. They call the same scan, suggest, and review functions as the CLI.
 * They are not on the default tool list.
 */

export const CODE_MAP_TOOLS = [
  {
    name: "code_map_scan",
    description:
      "Read an Angular package and return its component inventory (selector, inputs including signal inputs, outputs, module or standalone). Ivy .d.ts first, then the @Component decorator. Advanced surface. Needs RESOLVE_MCP_ADVANCED=1. Does not write the code map.",
    inputSchema: {
      type: "object",
      properties: {
        package: { type: "string", description: "Package path or name, for example a path to @acme/ui-angular." },
      },
      required: ["package"],
    },
  },
  {
    name: "code_map_suggest",
    description:
      "Propose Figma ↔ code pairs from names and from Figma properties ↔ inputs. Every pair is suggested or partial, never mapped. write:true saves them and keeps confirmed entries. Advanced surface. Needs RESOLVE_MCP_ADVANCED=1.",
    inputSchema: {
      type: "object",
      properties: {
        package: { type: "string", description: "Package path or name to scan." },
        write: { type: "boolean", description: "Save suggestions into code-map.json. Confirmed rows stay. Nothing is marked mapped." },
        graphId: { type: "string", description: "Graph to read. Optional when one graph is stored." },
      },
      required: ["package"],
    },
  },
  {
    name: "code_map_review",
    description:
      "Accept or fix code-map suggestions through the CSV import. Only a row whose status is mapped becomes mapped. Entries the CSV leaves out are kept. Omit csv to get the review sheet. Advanced surface. Needs RESOLVE_MCP_ADVANCED=1.",
    inputSchema: {
      type: "object",
      properties: {
        csv: { type: "string", description: "CSV text, or a path to a .csv file. Omit to return the review CSV." },
        replace: { type: "boolean", description: "Drop entries the CSV has no row for. Default keeps them." },
      },
    },
  },
];

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
