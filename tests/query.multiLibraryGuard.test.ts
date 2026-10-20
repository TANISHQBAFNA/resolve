import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SourceDocumentSchema } from "@/core/ingestion";
import { buildGraph } from "@/core/transform/buildGraph";
import { fillRecipe, indexGraph, mergeWorkspaceGraphs, recommendMasters, starterRecipes } from "@/core/query";

const FROZEN = "2026-01-01T00:00:00.000Z";

function load(path: string) {
  return SourceDocumentSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

const paths = ["scoreboard/guards/acme-app.json", "scoreboard/guards/acme-ds.json", "scoreboard/guards/acme-marketing.json"];
const graphs = paths.map((path) => buildGraph(load(path), { builtAt: FROZEN }));

const several = {
  version: 1 as const,
  files: [
    { role: "library" as const, key: "ACMEAPP", label: "Acme App" },
    { role: "library" as const, key: "ACMEDS", label: "Acme DS" },
    { role: "library" as const, key: "ACMEMKT", label: "Acme Marketing" },
  ],
};
const dsOnly = { version: 1 as const, files: [{ role: "library" as const, key: "ACMEDS", label: "Acme DS" }] };

function merged(workspace: typeof several | typeof dsOnly, which: typeof graphs) {
  return indexGraph(mergeWorkspaceGraphs(which.map((graph) => ({ graph, role: "library" as const })), workspace));
}

const severalIndex = merged(several, graphs);
const dsIndex = merged(dsOnly, [graphs[1]!]);

const BUTTON_ASKS = [
  "primary button",
  "large primary button",
  "main action button",
  "primary CTA",
  "submit button",
  "main button",
  "primary action",
] as const;

describe("synthetic multi-library guard", () => {
  it.each(BUTTON_ASKS)("%s picks Acme DS Button, not a bar or another library", (ask) => {
    const card = recommendMasters(severalIndex, ask, { workspace: several });
    expect(card.candidates[0]?.name, ask).toBe("Button");
    expect(card.candidates[0]?.fileKey, ask).toBe("ACMEDS");
    expect(card.match, ask).not.toBe("weak match");
  });

  it("fills the sign-in main button slot with Acme DS Button", () => {
    const recipe = starterRecipes().find((row) => row.id === "sign-in");
    expect(recipe?.slots.some((slot) => slot.role === "primary-cta" && slot.hints.includes("button"))).toBe(true);
    const filled = fillRecipe(severalIndex, recipe!, undefined, undefined, several);
    const slot = filled.slots.find((row) => row.role === "primary-cta");
    expect(slot?.status).toBe("filled");
    expect(slot?.master?.name).toBe("Button");
    expect(slot?.master?.fileKey).toBe("ACMEDS");
  });

  it("does not pick Button for the bottom action bar", () => {
    const card = recommendMasters(severalIndex, "bottom action bar", { workspace: several });
    expect(card.candidates[0]?.name).toBe("Bottom action bar");
    expect(card.candidates[0]?.name).not.toBe("Button");
  });

  it("picks the info icon, not the arrows set", () => {
    const card = recommendMasters(severalIndex, "info icon", { workspace: several });
    expect(card.candidates[0]?.name).toBe("Info");
    expect(card.candidates[0]?.fileKey).toBe("ACMEDS");
    expect(card.candidates.some((row) => row.name === "Arrows")).toBe(false);
  });

  it("still picks Button when only Acme DS is learned", () => {
    const card = recommendMasters(dsIndex, "primary button", { workspace: dsOnly });
    expect(card.candidates[0]?.name).toBe("Button");
    expect(card.candidates[0]?.fileKey).toBe("ACMEDS");
    expect(card.match).not.toBe("weak match");
  });

  it("picks Card from Acme DS", () => {
    const card = recommendMasters(severalIndex, "card", { workspace: several });
    expect(card.candidates[0]?.name).toBe("Card");
    expect(card.candidates[0]?.fileKey).toBe("ACMEDS");
  });
});
