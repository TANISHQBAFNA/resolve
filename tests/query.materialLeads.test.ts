import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adaptFigmaRestFile } from "@/core/ingestion/adapters/figmaRest";
import { buildGraph } from "@/core/transform/buildGraph";
import { indexGraph } from "@/core/query/GraphIndex";
import { recommendMasters } from "@/core/query";
import { clearCache } from "@/server/store";

const repo = join(fileURLToPath(new URL("..", import.meta.url)));
const fix = join(repo, "fixtures", "material");

function materialIndex() {
  const payload = JSON.parse(readFileSync(join(fix, "library.json"), "utf8")) as { fileKey: string; variables: unknown };
  return indexGraph(
    buildGraph(
      adaptFigmaRestFile({ fileKey: payload.fileKey, file: payload, variables: payload.variables, kind: "json", ingestedAt: "2026-10-21T00:00:00.000Z" }),
      { builtAt: "2026-10-21T00:00:00.000Z" },
    ),
  );
}

type Card = { candidates: Array<{ name?: string }>; match?: string };

// Made-up phrases on the public Angular Material example. None of them is a scoreboard phrase.
describe("Material leads after the #68 merge (r17)", () => {
  const previous = process.env["RESOLVE_HOME"];
  let ask: (text: string) => Card;
  beforeEach(() => {
    const home = join(tmpdir(), "resolve-material-leads");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "synonyms.json"), readFileSync(join(fix, "synonyms.json")));
    process.env["RESOLVE_HOME"] = home;
    clearCache();
    const index = materialIndex();
    ask = (text) => recommendMasters(index, text, { budgetChars: 4000 }) as unknown as Card;
  });
  afterEach(() => {
    clearCache();
    if (previous === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previous;
  });

  it("a generic top-of-screen bar leads with Toolbar, not a sorting part", () => {
    for (const text of ["heading strip for the page", "page header bar", "heading for a settings screen"]) {
      expect(ask(text).candidates[0]?.name, text).toBe("Toolbar");
    }
  });

  it("'<part> list' leads with the named part, not List", () => {
    for (const [text, name] of [["chip list", "Chip"], ["checkbox list", "Checkbox"], ["slider list", "Slider"]] as const) {
      expect(ask(text).candidates[0]?.name, text).toBe(name);
    }
  });

  it("a word that is only an -ed or -ing form, or a picker for an object, is empty", () => {
    for (const text of ["toggled", "fetched", "picker for fruit"]) {
      expect(ask(text).candidates, text).toEqual([]);
    }
  });

  it("a loading bar is a progress bar, never Navigation bar", () => {
    for (const text of ["upload loading bar", "linear loading bar for sync"]) {
      expect(ask(text).candidates[0]?.name, text).toBe("Progress bar");
    }
  });

  it("floating-action phrases give FAB, not Button", () => {
    for (const text of ["floating plus button", "floating action to compose", "a floating button"]) {
      expect(ask(text).candidates[0]?.name, text).toBe("FAB");
    }
  });

  it("valid asks with an inflected word or a step word are not empty", () => {
    for (const [text, name] of [["toggling switch", "Slide toggle"], ["wizard steps for signup", "Stepper"], ["choice in the select", "Select"]] as const) {
      expect(ask(text).candidates[0]?.name, text).toBe(name);
    }
  });

  it("an empty answer never carries the weak flag", () => {
    for (const text of ["promo banner", "banner", "toggled"]) {
      const card = ask(text);
      expect(card.candidates, text).toEqual([]);
      expect(card.match, text).toBeUndefined();
    }
  });
});
