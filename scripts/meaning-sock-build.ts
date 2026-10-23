/**
 * Generate meaning/ from pack data.
 *   node scripts/build-meaning-sock.mjs <out-dir>
 *
 * Angular Material docs attach only when the library id is angular-material.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { adaptFigmaRestFile } from "@/core/ingestion/adapters/figmaRest";
import { SourceDocumentSchema } from "@/core/ingestion/types";
import type { DesignGraph, GraphNode, NodeType } from "@/core/model";
import { indexGraph, type GraphIndex } from "@/core/query/GraphIndex";
import { ANGULAR_MATERIAL_LIBRARY_ID } from "@/core/query/meaning/materialDocs";
import { estimateTokens, staleWarning, writeMeaningPack, buildMeaningPack, type MeaningPack } from "@/core/query/meaning/sock";
import { buildGraph } from "@/core/transform/buildGraph";

const FROZEN = "2026-01-01T00:00:00.000Z";
const root = process.cwd();

export type PackName = "material" | "acme" | "acme-small";

function node(id: string, type: NodeType, name: string): GraphNode {
  return { id, type, name, figmaNodeId: id, isMainComponent: type === "MAIN_COMPONENT" };
}

function acmeSmall(): GraphIndex {
  const names = [
    "Data Table", "Card List", "Summary Card", "Stat Block", "Text Field", "Pay CTA", "Save CTA", "Search Field",
    "Empty Message", "Error Alert", "Pending Banner", "Loading Spinner", "Compact List", "Comfortable List",
    "Mobile Nav", "Desktop Nav", "Button",
  ];
  const graph: DesignGraph = {
    fileKey: "ACMEUI",
    fileName: "Acme UI",
    builtAt: FROZEN,
    source: { kind: "mock", ingestedAt: FROZEN },
    warnings: [],
    nodes: [node("file:acme-ui", "FILE", "Acme UI"), ...names.map((name, index) => node(`node:10:${index}`, "MAIN_COMPONENT", name))],
    edges: [],
  };
  return indexGraph(graph);
}

function fixtureIndex(): GraphIndex {
  const raw: unknown = JSON.parse(readFileSync(join(root, "scoreboard/fixture/library.json"), "utf8"));
  return indexGraph(buildGraph(SourceDocumentSchema.parse(raw), { builtAt: FROZEN }));
}

function materialIndex(): GraphIndex {
  const payload = JSON.parse(readFileSync(join(root, "fixtures/material/library.json"), "utf8")) as { variables: unknown };
  const file = payload as { fileKey?: string };
  return indexGraph(
    buildGraph(
      adaptFigmaRestFile({ fileKey: file.fileKey ?? "library", file: payload, variables: payload.variables, kind: "json", ingestedAt: FROZEN }),
      { builtAt: FROZEN },
    ),
  );
}

export function loadPacks(): Record<PackName, MeaningPack> {
  return {
    material: buildMeaningPack(materialIndex(), "Angular Material", FROZEN, ANGULAR_MATERIAL_LIBRARY_ID),
    acme: buildMeaningPack(fixtureIndex(), "Acme", FROZEN, "fixture"),
    "acme-small": buildMeaningPack(acmeSmall(), "Acme UI", FROZEN, "acme-small"),
  };
}

const MATERIAL_SOURCE = "https://material.angular.dev/";
const MATERIAL_LICENCE = "https://creativecommons.org/licenses/by/4.0/";

function stampMaterialIndex(indexPath: string): void {
  const text = readFileSync(indexPath, "utf8");
  const [title, ...rest] = text.split("\n");
  if (!title?.startsWith("# ")) throw new Error("material index has no title");
  const header = [
    title,
    `Source: ${MATERIAL_SOURCE}`,
    "© Google LLC. Licensed under CC BY 4.0.",
    MATERIAL_LICENCE,
    ...rest,
  ];
  writeFileSync(indexPath, header.join("\n"));
}

export function writePacks(dir: string): { tokens: number; stale: string | undefined } {
  mkdirSync(dir, { recursive: true });
  const packs = loadPacks();
  let sample = "";
  for (const [name, pack] of Object.entries(packs)) {
    const files = writeMeaningPack(join(dir, name), pack);
    if (name === "material") stampMaterialIndex(join(dir, name, "index.md"));
    if (name === "acme") {
      const alert = files.get("alert") ?? "";
      const toggle = files.get("switch") ?? "";
      sample = [`# ${pack.library}`, alert, toggle].filter(Boolean).join("\n\n");
    }
  }
  writeFileSync(join(dir, "pack.txt"), `${sample}\n`);
  const acme = packs.acme;
  return { tokens: estimateTokens(`${sample}\n`), stale: staleWarning("2026-02-01T00:00:00.000Z", acme?.builtAt ?? "") };
}
