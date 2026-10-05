import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesignGraph, GraphEdge, GraphNode, NodeType } from "@/core/model";
import { descriptionIsRetired } from "@/core/model/governance";
import {
  componentUsageCard,
  exampleCard,
  fillRecipe,
  iconLibraryWarnings,
  indexGraph,
  recommendMasters,
  type Recipe,
} from "@/core/query";
import { initGoldenCases } from "@/core/query/scoreboard";
import type { WorkspaceManifest } from "@/core/query/workspace";
import { clearCache } from "@/server/store";

const FROZEN = "2026-01-01T00:00:00.000Z";

function n(id: string, type: NodeType, name: string, extra: Partial<GraphNode> = {}): GraphNode {
  return { id, type, name, ...extra };
}

function e(type: GraphEdge["type"], source: string, target: string): GraphEdge {
  return { id: `${type}|${source}|${target}`, source, target, type };
}

function graph(nodes: GraphNode[], edges: GraphEdge[] = [], fileName = "Acme UI"): DesignGraph {
  return {
    fileKey: "LIB",
    fileName,
    builtAt: FROZEN,
    source: { kind: "mock", ingestedAt: FROZEN },
    warnings: [],
    nodes,
    edges,
  };
}

const workspace: WorkspaceManifest = {
  version: 1,
  files: [
    { key: "LIB", role: "library", label: "Library" },
    { key: "ICONS", role: "library", label: "Acme Icons" },
  ],
};

describe("stage 0 reliability", () => {
  const previousHome = process.env["RESOLVE_HOME"];
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "resolve-stage0-"));
    process.env["RESOLVE_HOME"] = home;
    clearCache();
  });

  afterEach(() => {
    clearCache();
    if (previousHome === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previousHome;
  });

  it("stays silent when the pinned store has no icon-libraries.json", () => {
    const index = indexGraph(graph([n("file:LIB", "FILE", "Library", { fileKey: "LIB" })]));
    const err: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      err.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(iconLibraryWarnings(index, workspace)).toEqual([]);
      componentUsageCard(index, "Library");
      expect(err.join("")).not.toContain("malformed");
    } finally {
      process.stderr.write = write;
    }
    writeFileSync(join(home, "icon-libraries.json"), "{");
    expect(iconLibraryWarnings(index, workspace)).toContain("icon-libraries.json is malformed; ignored");
  });

  it("warns when an icon library name matches nothing, and when the file is malformed", () => {
    const index = indexGraph(
      graph([
        n("file:LIB", "FILE", "Library", { fileKey: "LIB" }),
        n("node:mark", "COMPONENT_SET", "Acme Mark", { fileKey: "LIB", figmaNodeId: "1:1", isMainComponent: true }),
      ]),
    );
    writeFileSync(join(home, "icon-libraries.json"), JSON.stringify(["Nope Icons"]));
    expect(iconLibraryWarnings(index, workspace)).toContain(
      'icon library "Nope Icons" matched no components',
    );
    writeFileSync(join(home, "icon-libraries.json"), "{");
    expect(iconLibraryWarnings(index, workspace)).toContain("icon-libraries.json is malformed; ignored");
  });

  it("resolve and recommend share one top pick for the same ask", () => {
    writeFileSync(join(home, "icon-libraries.json"), JSON.stringify(["Acme Icons"]));
    const mark = "node:mark";
    const icon = "node:icon-mark";
    const index = indexGraph(
      graph(
        [
          n("file:LIB", "FILE", "Library", { fileKey: "LIB" }),
          n("node:lib-page", "PAGE", "Controls", { parentId: "file:LIB", pageId: "node:lib-page", fileKey: "LIB" }),
          n(mark, "COMPONENT_SET", "Acme Mark", {
            parentId: "node:lib-page",
            pageId: "node:lib-page",
            fileKey: "LIB",
            figmaNodeId: "1:1",
            isMainComponent: true,
          }),
          n("file:ICONS", "FILE", "Acme Icons", { fileKey: "ICONS" }),
          n("node:icon-page", "PAGE", "Glyphs", { parentId: "file:ICONS", pageId: "node:icon-page", fileKey: "ICONS" }),
          n(icon, "MAIN_COMPONENT", "Acme Mark", {
            parentId: "node:icon-page",
            pageId: "node:icon-page",
            fileKey: "ICONS",
            figmaNodeId: "9:1",
            isMainComponent: true,
          }),
        ],
        [
          e("CONTAINS", "file:LIB", "node:lib-page"),
          e("CONTAINS", "node:lib-page", mark),
          e("CONTAINS", "file:ICONS", "node:icon-page"),
          e("CONTAINS", "node:icon-page", icon),
        ],
      ),
    );
    const options = { workspace };
    const recommended = recommendMasters(index, "acme mark", options);
    expect(recommended.candidates[0]?.id).toBe(mark);
    for (const ask of ["acme mark", "Acme Mark", "acme-mark"]) {
      const card = componentUsageCard(index, ask, options);
      expect(card.found).toBe(true);
      if (!card.found || card.kind !== "component") continue;
      expect(card.component.id).toBe(recommended.candidates[0]?.id);
      expect(card.component.name).toBe("Acme Mark");
      expect(card.component.id).not.toBe(icon);
    }
  });

  it("returns the exact component name before a similar ranked name", () => {
    const exact = n("node:exact", "MAIN_COMPONENT", "acme-mark", {
      fileKey: "LIB",
      figmaNodeId: "10:1",
      isMainComponent: true,
    });
    const similar = n("node:similar", "COMPONENT_SET", "Acme Mark", {
      fileKey: "LIB",
      figmaNodeId: "10:2",
      isMainComponent: true,
    });
    const variant = n("node:similar-v", "VARIANT", "Size=Large", {
      parentId: "node:similar",
      fileKey: "LIB",
      figmaNodeId: "10:3",
    });
    const index = indexGraph(
      graph(
        [n("file:LIB", "FILE", "Library", { fileKey: "LIB" }), exact, similar, variant],
        [e("CONTAINS", "file:LIB", similar.id), e("CONTAINS", similar.id, variant.id)],
      ),
    );
    const card = componentUsageCard(index, "acme-mark");
    expect(card.found).toBe(true);
    if (!card.found || card.kind !== "component") throw new Error("expected component card");
    expect(card.component.id).toBe(exact.id);
    expect(card.component.name).toBe("acme-mark");
    const folded = componentUsageCard(index, "ACME-MARK");
    if (!folded.found || folded.kind !== "component") throw new Error("expected component card");
    expect(folded.component.id).toBe(exact.id);
    const example = exampleCard(index, "acme-mark");
    if (!("id" in example)) throw new Error("expected example id");
    expect(example.id).toBe(exact.id);
    expect(example.name).toBe("acme-mark");
  });

  it("does not suggest an icon as the replacement for a retired part", () => {
    const index = indexGraph(
      graph([
        n("file:LIB", "FILE", "Library", { fileKey: "LIB" }),
        n("node:field", "COMPONENT_SET", "Field", { fileKey: "LIB", figmaNodeId: "1:1", isMainComponent: true }),
        n("node:old", "COMPONENT_SET", "Legacy Field", {
          fileKey: "LIB",
          figmaNodeId: "2:2",
          isMainComponent: true,
          status: "deprecated",
          description: "Legacy component",
        }),
        n("node:icon", "MAIN_COMPONENT", "icon-24-field", {
          fileKey: "LIB",
          figmaNodeId: "9:9",
          isMainComponent: true,
        }),
      ]),
    );
    const result = recommendMasters(index, "Legacy Field");
    expect(result.candidates[0]?.name).toBe("Field");
    expect(result.candidates.map((row) => row.name)).not.toContain("icon-24-field");
    expect(result.candidates.map((row) => row.name)).not.toContain("Legacy Field");

    const onlyIcon = indexGraph(
      graph([
        n("file:LIB", "FILE", "Library", { fileKey: "LIB" }),
        n("node:old", "COMPONENT_SET", "Legacy Field", {
          fileKey: "LIB",
          figmaNodeId: "2:2",
          isMainComponent: true,
          status: "deprecated",
          description: "Legacy component",
        }),
        n("node:icon", "MAIN_COMPONENT", "icon-24-field", {
          fileKey: "LIB",
          figmaNodeId: "9:9",
          isMainComponent: true,
        }),
      ]),
    );
    const abstain = recommendMasters(onlyIcon, "Legacy Field");
    expect(abstain.candidates).toEqual([]);
    expect(abstain.hint).toBe("Only match is retired: Legacy Field. Use none.");
  });

  it("does not fill a content slot with an icon", () => {
    const card = n("node:card", "COMPONENT_SET", "Card", {
      fileKey: "LIB",
      figmaNodeId: "1:1",
      isMainComponent: true,
    });
    const icon = n("node:icon", "MAIN_COMPONENT", "icon-24-card", {
      fileKey: "LIB",
      figmaNodeId: "9:9",
      isMainComponent: true,
    });
    const recipe: Recipe = {
      id: "acme-shell",
      title: "Acme shell",
      intentAliases: ["acme shell"],
      slots: [{ role: "content", required: true, hints: ["card"] }],
    };
    const both = fillRecipe(indexGraph(graph([n("file:LIB", "FILE", "Library", { fileKey: "LIB" }), card, icon])), recipe);
    expect(both.slots[0]?.status).toBe("filled");
    expect(both.slots[0]?.master?.name).toBe("Card");
    const iconsOnly = fillRecipe(
      indexGraph(graph([n("file:LIB", "FILE", "Library", { fileKey: "LIB" }), icon])),
      recipe,
    );
    expect(iconsOnly.slots[0]?.status).toBe("unbound");
    expect(iconsOnly.slots[0]?.master).toBeUndefined();

    const hyphenated = n("node:hyphen", "MAIN_COMPONENT", "acme-pay-56-mark", {
      fileKey: "LIB",
      figmaNodeId: "9:8",
      isMainComponent: true,
    });
    const hyphenRecipe: Recipe = {
      id: "acme-detail",
      title: "Acme detail",
      intentAliases: ["acme detail"],
      slots: [
        { role: "content", required: true, hints: ["mark"] },
        { role: "body", required: true, hints: ["mark"] },
        { role: "detail", required: false, hints: ["mark"] },
      ],
    };
    const hyphenFilled = fillRecipe(
      indexGraph(graph([n("file:LIB", "FILE", "Library", { fileKey: "LIB" }), hyphenated])),
      hyphenRecipe,
    );
    for (const slot of hyphenFilled.slots) {
      expect(slot.status).toBe("unbound");
      expect(slot.master).toBeUndefined();
    }
  });

  it("recommends the live replacement, and says so, when a code map swaps a retired part", () => {
    writeFileSync(
      join(home, "code-map.json"),
      JSON.stringify({
        entries: [
          {
            fileKey: "LIB",
            id: "1:1",
            code: { import: "import { Button } from '@acme/ui'", component: "Button" },
          },
          {
            fileKey: "LIB",
            id: "2:2",
            status: "retired",
            replacedBy: "Button",
            code: { import: "import { OldButton } from '@acme/ui'", component: "OldButton" },
          },
          {
            fileKey: "LIB",
            id: "3:3",
            code: { import: "import { Chip } from '@acme/ui'", component: "Chip" },
          },
        ],
      }),
    );
    const index = indexGraph(
      graph([
        n("file:LIB", "FILE", "Acme UI", { fileKey: "LIB" }),
        n("node:LIB:1:1", "COMPONENT_SET", "Button", { fileKey: "LIB", figmaNodeId: "1:1", isMainComponent: true }),
        n("node:LIB:2:2", "COMPONENT_SET", "Old Button", {
          fileKey: "LIB",
          figmaNodeId: "2:2",
          isMainComponent: true,
          status: "deprecated",
        }),
        n("node:LIB:3:3", "COMPONENT_SET", "Chip", { fileKey: "LIB", figmaNodeId: "3:3", isMainComponent: true }),
      ]),
    );
    const result = recommendMasters(index, "Old Button");
    expect(result.candidates[0]?.name).toBe("Button");
    expect(result.candidates[0]?.why).toBe("replaces Old Button (deprecated)");
    expect(result.candidates.map((row) => row.name)).not.toContain("Old Button");
    expect(result.retired).toMatch(/Old Button is retired, use Button/);
  });

  it("gives colliding golden case ids a unique suffix", () => {
    const index = indexGraph(
      graph([
        n("node:a", "COMPONENT_SET", "Acme Mark", { fileKey: "LIB", figmaNodeId: "1:1", isMainComponent: true }),
        n("node:b", "COMPONENT_SET", "acme-mark", { fileKey: "LIB", figmaNodeId: "1:2", isMainComponent: true }),
      ]),
    );
    const cases = initGoldenCases(index).filter((row) => row.expect === "master" && row.id.startsWith("name-acme-mark"));
    const ids = cases.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("name-acme-mark");
    expect(ids).toContain("name-acme-mark-2");
  });

  it("treats a bare Legacy note as retired and leaves live sentences alone", () => {
    expect(descriptionIsRetired("Legacy")).toBe(true);
    expect(descriptionIsRetired("Legacy.")).toBe(true);
    expect(descriptionIsRetired("Legacy: will be removed in v4")).toBe(true);
    expect(descriptionIsRetired("Legacy users still see this")).toBe(false);
    expect(descriptionIsRetired("Do not use inside tables")).toBe(false);
    expect(descriptionIsRetired("Supports legacy browsers")).toBe(false);
  });
});
