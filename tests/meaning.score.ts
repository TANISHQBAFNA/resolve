/**
 * Score a list of asks with this checkout's recommend.
 * Usage: vite-node tests/meaning.score.ts <asks.json> <out.json>
 * The asks file is [{ id, library, phrase }]. library is fixture, material, or acme-small.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adaptFigmaRestFile } from "@/core/ingestion/adapters/figmaRest";
import { SourceDocumentSchema } from "@/core/ingestion/types";
import type { DesignGraph, GraphNode, NodeType } from "@/core/model";
import { indexGraph, type GraphIndex } from "@/core/query/GraphIndex";
import { recommendMasters } from "@/core/query/recommendMasters";
import { buildGraph } from "@/core/transform/buildGraph";
import { clearCache } from "@/server/store";

type PurposeFallback = typeof import("@/core/query/meaning/parse").purposeFallback;
type WordFormFallback = typeof import("@/core/query/meaning/parse").wordFormFallback;
type MeaningDictionaryFn = typeof import("@/core/query/meaning/buildDictionary").meaningDictionary;

interface Ask {
  id: string;
  library: "fixture" | "material" | "acme-small";
  phrase: string;
}

const FROZEN = "2026-01-01T00:00:00.000Z";
const root = process.cwd();

function node(id: string, type: NodeType, name: string): GraphNode {
  return { id, type, name, fileKey: "ACMEUI", figmaNodeId: id, isMainComponent: type === "MAIN_COMPONENT" };
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
    nodes: [node("file:ACMEUI", "FILE", "Acme UI"), ...names.map((name, index) => node(`node:10:${index}`, "MAIN_COMPONENT", name))],
    edges: [],
  };
  return indexGraph(graph);
}

function fixtureIndex(): GraphIndex {
  const raw: unknown = JSON.parse(readFileSync(join(root, "scoreboard/fixture/library.json"), "utf8"));
  return indexGraph(buildGraph(SourceDocumentSchema.parse(raw), { builtAt: FROZEN }));
}

function materialIndex(): GraphIndex {
  const payload = JSON.parse(readFileSync(join(root, "fixtures/material/library.json"), "utf8")) as { fileKey: string; variables: unknown };
  return indexGraph(
    buildGraph(
      adaptFigmaRestFile({ fileKey: payload.fileKey, file: payload, variables: payload.variables, kind: "json", ingestedAt: FROZEN }),
      { builtAt: FROZEN },
    ),
  );
}

function withHome(home: string | undefined): void {
  if (home) process.env["RESOLVE_HOME"] = home;
  else delete process.env["RESOLVE_HOME"];
  clearCache();
}

let purposeFallback: PurposeFallback | undefined;
let wordFormFallback: WordFormFallback | undefined;
let meaningDictionary: MeaningDictionaryFn | undefined;
try {
  const parse = await import("@/core/query/meaning/parse");
  const dictionary = await import("@/core/query/meaning/buildDictionary");
  purposeFallback = parse.purposeFallback;
  wordFormFallback = parse.wordFormFallback;
  meaningDictionary = dictionary.meaningDictionary;
} catch {
  purposeFallback = undefined;
  wordFormFallback = undefined;
  meaningDictionary = undefined;
}

function score(index: GraphIndex, phrase: string): { lead: string; weak: boolean; via: string } {
  const card = recommendMasters(index, phrase, { budgetChars: 4000 }) as { match?: string; candidates: Array<{ name?: string }> };
  const lead = card.candidates[0]?.name ?? "";
  const weak = card.match === "weak match";
  let via = "";
  if (lead && purposeFallback && wordFormFallback && meaningDictionary) {
    const skipped = recommendMasters(index, phrase, { budgetChars: 4000, skipFallback: true }) as { candidates: Array<{ name?: string }> };
    if ((skipped.candidates[0]?.name ?? "") !== lead) {
      const tokens = phrase.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const live = meaningDictionary(index).entries.filter((entry) => !entry.retired);
      if (purposeFallback(tokens, live)?.name === lead) via = "purpose";
      else if (wordFormFallback(tokens, live)?.name === lead) via = "word-form";
      else via = "fallback";
    }
  }
  return { lead, weak, via };
}

export function scoreAsks(asks: Ask[]): Array<{ id: string; lead: string; weak: boolean; via: string }> {
  const home = join(tmpdir(), "resolve-meaning-regression");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "synonyms.json"), readFileSync(join(root, "fixtures/material/synonyms.json")));
  withHome(undefined);
  const fixture = fixtureIndex();
  withHome(home);
  const material = materialIndex();
  const acme = acmeSmall();
  return asks.map((ask) => {
    if (ask.library === "fixture") withHome(undefined);
    else withHome(home);
    const index = ask.library === "fixture" ? fixture : ask.library === "material" ? material : acme;
    return { id: ask.id, ...score(index, ask.phrase) };
  });
}

const direct = process.argv[1]?.includes("meaning.score");
if (direct && process.argv[2] && process.argv[3]) {
  const asks = JSON.parse(readFileSync(process.argv[2], "utf8")) as Ask[];
  writeFileSync(process.argv[3], `${JSON.stringify(scoreAsks(asks))}\n`);
}
