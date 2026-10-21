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
    for (const text of ["heading strip for the page", "masthead strip on top", "heading for a settings screen"]) {
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
    for (const text of ["upload loading bar", "thin loading bar while saving"]) {
      expect(ask(text).candidates[0]?.name, text).toBe("Progress bar");
    }
  });

  it("floating-action phrases give FAB, not Button", () => {
    for (const text of ["floating plus button", "floating action to compose", "a floating button"]) {
      expect(ask(text).candidates[0]?.name, text).toBe("FAB");
    }
  });

  it("valid asks with an inflected word or a step word are not empty", () => {
    for (const [text, name] of [["a switch for toggling alerts", "Slide toggle"], ["wizard steps for signup", "Stepper"], ["choice in the select", "Select"]] as const) {
      expect(ask(text).candidates[0]?.name, text).toBe(name);
    }
  });

  it("'<x> input' leads with a field or the named part, never Button", () => {
    for (const [text, name] of [["promo code input", "Text field"], ["chip input", "Chip"], ["slider input", "Slider"], ["checkbox input", "Checkbox"]] as const) {
      const lead = ask(text).candidates[0]?.name;
      expect(lead, text).toBe(name);
      expect(lead, text).not.toBe("Button");
    }
  });

  it("a lone style word, only inflected words, or a generic picker to do something is empty", () => {
    for (const text of ["tonal", "elevated", "outlined", "dated picked", "checked selected", "scrolling sorted", "picker to choose a flavor", "picker to grab a topping"]) {
      expect(ask(text).candidates, text).toEqual([]);
    }
  });

  it("'<parts> in the <x> list' leads with the part", () => {
    for (const [text, name] of [["checkboxes in the settings list", "Checkbox"], ["chips in the tag list", "Chip"], ["radios in the plan list", "Radio button"]] as const) {
      expect(ask(text).candidates[0]?.name, text).toBe(name);
    }
  });

  it("an option inside a select or dropdown is the Select", () => {
    for (const text of ["option in a dropdown", "item inside the select", "choice within a dropdown menu"]) {
      expect(ask(text).candidates[0]?.name, text).toBe("Select");
    }
  });

  it("a well-known other name of the part is a full match, not weak", () => {
    for (const [text, name] of [["modal window", "Dialog"], ["toast notice", "Snackbar"], ["tick box for terms", "Checkbox"], ["accordion for faqs", "Expansion panel"], ["drawer for filters", "Sidenav"], ["floating compose button", "FAB"], ["separator line", "Divider"]] as const) {
      const card = ask(text);
      expect(card.candidates[0]?.name, text).toBe(name);
      expect(card.match, text).toBeUndefined();
    }
  });

  it("a plural of a multi-word synonym is a full match, same as the singular", () => {
    for (const [plural, singular] of [["tick boxes", "tick box"], ["text boxes", "text box"], ["floating action buttons", "floating action button"], ["navigation drawers", "navigation drawer"], ["list items", "list item"], ["top app bars", "top app bar"]] as const) {
      const one = ask(singular);
      const many = ask(plural);
      expect(many.candidates[0]?.name, plural).toBe(one.candidates[0]?.name);
      expect(many.match, plural).toBe(one.match);
      expect(many.match, plural).toBeUndefined();
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
