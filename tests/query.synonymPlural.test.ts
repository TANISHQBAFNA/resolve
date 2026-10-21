import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { adaptFigmaRestFile } from "@/core/ingestion/adapters/figmaRest";
import { SourceDocumentSchema } from "@/core/ingestion/types";
import { buildGraph } from "@/core/transform";
import { indexGraph, recommendMasters } from "@/core/query";
import type { GraphIndex } from "@/core/query/GraphIndex";
import { clearCache } from "@/server/store";

const repo = join(fileURLToPath(new URL("..", import.meta.url)));

function termsIn(path: string): string[] {
  const file = JSON.parse(readFileSync(path, "utf8")) as { groups?: { terms?: string[] }[] };
  return (file.groups ?? []).flatMap((group) => group.terms ?? []).map((term) => term.toLowerCase());
}

function pluralWord(word: string): string {
  if (/(?:s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

function pluralTerm(term: string): string {
  const words = term.split(/\s+/);
  words[words.length - 1] = pluralWord(words[words.length - 1] ?? "");
  return words.join(" ");
}

function leadOf(index: GraphIndex, text: string): { name?: string; match?: string } {
  const card = recommendMasters(index, text, { budgetChars: 4000 }) as { match?: string; candidates: Array<{ name?: string }> };
  return { name: card.candidates[0]?.name, match: card.match };
}

/** Position words are not plurals of a part. "bottoms" is not the footer. */
const NOT_A_PLURAL = new Set(["bottom", "secondary", "right", "compact", "comfortable", "desktop", "mobile"]);

function sameLead(index: GraphIndex, terms: string[]): void {
  const misses: string[] = [];
  for (const term of terms) {
    const plural = pluralTerm(term);
    // "bottoms" is not the footer. A position word with an extra s is not that part's plural.
    if (NOT_A_PLURAL.has(term)) continue;
    const one = leadOf(index, term);
    const many = leadOf(index, plural);
    if (one.name !== many.name || one.match !== many.match) {
      misses.push(`${term} → ${plural}: ${one.name ?? "empty"}/${one.match ?? "strong"} vs ${many.name ?? "empty"}/${many.match ?? "strong"}`);
    }
  }
  expect(misses).toEqual([]);
}

describe("a synonym's plural matches its singular", () => {
  const previous = process.env["RESOLVE_HOME"];
  afterEach(() => {
    clearCache();
    if (previous === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previous;
  });

  it("every built-in synonym on the sample library", () => {
    delete process.env["RESOLVE_HOME"];
    clearCache();
    const raw: unknown = JSON.parse(readFileSync(join(repo, "scoreboard", "fixture", "library.json"), "utf8"));
    const index = indexGraph(buildGraph(SourceDocumentSchema.parse(raw), { builtAt: "2026-01-01T00:00:00.000Z" }));
    sameLead(index, termsIn(join(repo, "src", "data", "synonyms.json")));
  });

  it("every Material synonym on the Material library", () => {
    const home = join(tmpdir(), "resolve-synonym-plural");
    mkdirSync(home, { recursive: true });
    const fix = join(repo, "fixtures", "material");
    writeFileSync(join(home, "synonyms.json"), readFileSync(join(fix, "synonyms.json")));
    process.env["RESOLVE_HOME"] = home;
    clearCache();
    const payload = JSON.parse(readFileSync(join(fix, "library.json"), "utf8")) as { fileKey: string; variables: unknown };
    const index = indexGraph(
      buildGraph(
        adaptFigmaRestFile({ fileKey: payload.fileKey, file: payload, variables: payload.variables, kind: "json", ingestedAt: "2026-10-21T00:00:00.000Z" }),
        { builtAt: "2026-10-21T00:00:00.000Z" },
      ),
    );
    sameLead(index, [...termsIn(join(fix, "synonyms.json")), ...termsIn(join(repo, "src", "data", "synonyms.json"))]);
  });
});
