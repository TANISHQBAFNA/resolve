/**
 * Main's per-case evidence for the AI-picks scorer.
 * Frozen path: meaning candidates. Recommend path: scoreAsks (weak lead fails, empty lead is no fit).
 */
import { meaningCandidates } from "../src/core/query/meaning/sock";
import { scoreAsks } from "../tests/meaning.score";
import { loadPacks, type PackName } from "./meaning-sock-build";

interface CaseRow {
  id: string;
  pack: string;
  ask: string;
}

function recommendLibrary(pack: string): "fixture" | "material" | "acme-small" | undefined {
  if (pack === "acme") return "fixture";
  if (pack === "material") return "material";
  if (pack === "acme-small") return "acme-small";
  return undefined;
}

function meaningPack(name: string) {
  if (name === "material" || name === "acme" || name === "acme-small") return name;
  return undefined;
}

export function mainEvidence(cases: CaseRow[]): Array<{ id: string; frozenNames: string[]; lead: string; weak: boolean }> {
  const packs = loadPacks();
  const asks = cases.flatMap((row) => {
    const library = recommendLibrary(row.pack);
    return library ? [{ id: row.id, library, phrase: row.ask }] : [];
  });
  const scored = new Map(scoreAsks(asks).map((row) => [row.id, row]));
  return cases.map((row) => {
    const packName = meaningPack(row.pack);
    const pack = packName ? packs[packName as PackName] : undefined;
    const frozenNames = pack ? meaningCandidates(row.ask, pack).map((candidate) => candidate.name) : [];
    const found = scored.get(row.id);
    return { id: row.id, frozenNames, lead: found?.lead ?? "", weak: Boolean(found?.weak) };
  });
}
