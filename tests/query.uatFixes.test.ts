import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DesignGraph, GraphEdge, GraphNode, NodeType } from "@/core/model";
import { SourceDocumentSchema } from "@/core/ingestion/types";
import { buildGraph } from "@/core/transform";
import { indexGraph, recommendMasters, verifyFrame } from "@/core/query";
import { parseBindRulesFile } from "@/core/query/bindRules";
import { checkComponentName } from "@/core/query/codeMapCheck";
import { checkProperUse } from "@/core/query/properUse";
import { loadPhraseCases, scorePhrases } from "@/core/query/phraseScore";
import { formatStatus, propertiesMissing, statusReport } from "@/server/status";
import { clearCache } from "@/server/store";

const root = fileURLToPath(new URL("..", import.meta.url));
const FROZEN = "2026-01-01T00:00:00.000Z";

function n(id: string, type: NodeType, name: string, extra: Partial<GraphNode> = {}): GraphNode {
  return { id, type, name, ...extra };
}

function e(type: GraphEdge["type"], source: string, target: string): GraphEdge {
  return { id: `${type}|${source}|${target}`, source, target, type };
}

function graphOf(fileKey: string, nodes: GraphNode[], edges: GraphEdge[]): DesignGraph {
  return {
    fileKey,
    fileName: "Acme",
    schemaVersion: 1,
    builtAt: FROZEN,
    source: { kind: "mock", ingestedAt: FROZEN },
    warnings: [],
    nodes,
    edges,
  };
}

const codeMap = {
  entries: [
    {
      fileKey: "ACMEUI",
      id: "30:10",
      name: "Button",
      code: { framework: "angular", import: "import { AcmeButtonModule } from '@acme/ui-angular'", component: "AcmeButtonComponent", selector: "acme-button", module: "AcmeButtonModule" },
    },
  ],
};

const variantSheet = {
  ok: true,
  screens: [
    {
      components: [
        { name: "Button", fileKey: "ACMEUI", figmaNodeId: "30:11", componentSetId: "30:10", status: "current", code: "AcmeButtonComponent from '@acme/ui-angular'" },
      ],
      ingredients: [
        { name: "Button", fileKey: "ACMEUI", figmaNodeId: "30:13", componentSetId: "30:10", status: "mapped", code: "AcmeButtonComponent from '@acme/ui-angular'" },
      ],
    },
  ],
};

describe("code-map check matches a variant to its set", () => {
  it("accepts the set id, the class, and the selector when the sheet lists the variant", () => {
    for (const query of ["Button", "AcmeButtonComponent", "acme-button", "Button|AcmeButtonComponent|acme-button"]) {
      const card = checkComponentName(query, codeMap, variantSheet);
      expect(card.status, query).toBe("ok");
      expect(card.exitCode, query).toBe(0);
    }
  });

  it("does not treat a different set as the mapped button", () => {
    const other = {
      ok: true,
      screens: [
        {
          components: [{ name: "Button", fileKey: "ACMEUI", figmaNodeId: "40:11", componentSetId: "40:10", status: "current", code: "unmapped" }],
          ingredients: [],
        },
      ],
    };
    expect(checkComponentName("Button", codeMap, other).status).toBe("not-in-handoff");
  });

  it("says a learned unmapped part has no code link", () => {
    const empty = { ok: true, screens: [{ components: [], ingredients: [] }] };
    const card = checkComponentName("ingredients/modal", codeMap, empty, ["ingredients/modal", "Button"]);
    expect(card.status).toBe("unmapped");
    expect(card.exitCode).toBe(4);
    expect(card.message).toBe("Real component, but no code link, and it is not on this screen.");
    expect(checkComponentName("modal", codeMap, empty, ["ingredients/modal"]).status).toBe("not-found");
    expect(checkComponentName("Made up", codeMap, empty).message).toBe("Not in the design system or on this screen. Don't invent it.");
  });
});

describe("workspace ranking stays on learned parts", () => {
  it("does not pick a remote button from a file that was not learned", () => {
    const nodes = [
      n("file", "FILE", "Acme", { fileKey: "ACMEUI" }),
      n("set", "COMPONENT_SET", "Button", { fileKey: "ACMEUI", figmaNodeId: "9:0" }),
      n("primary", "VARIANT", "Primary", {
        fileKey: "ACMEUI",
        figmaNodeId: "9:1",
        componentSetId: "set",
        variantProperties: { Style: "Primary" },
      }),
      n("remote", "COMPONENT_SET", "Button", { fileKey: "OLDUI", figmaNodeId: "3:587", isRemote: true }),
    ];
    const index = indexGraph(graphOf("ACMEUI", nodes, [e("VARIANT_OF", "primary", "set")]));
    const workspace = { version: 1 as const, files: [{ role: "library" as const, key: "ACMEUI", label: "Acme UI" }] };
    const result = recommendMasters(index, "primary button", { workspace });
    expect(result.candidates[0]?.fileKey).toBe("ACMEUI");
    expect(result.candidates.some((row) => row.fileKey === "OLDUI")).toBe(false);
  });

  it("prefers the named library over a busier copy", () => {
    const nodes = [
      n("a", "MAIN_COMPONENT", "Button", { fileKey: "ACMEUI", figmaNodeId: "1:1" }),
      n("b", "MAIN_COMPONENT", "Button", { fileKey: "GLOBEX", figmaNodeId: "2:2" }),
      n("screen", "FRAME", "Checkout", { fileKey: "GLOBEX", figmaNodeId: "8:1" }),
      n("copy", "COMPONENT_INSTANCE", "Button", { fileKey: "GLOBEX", mainComponentId: "b", figmaNodeId: "8:2" }),
    ];
    const edges = [e("INSTANCE_OF", "copy", "b"), e("USED_IN", "b", "copy"), e("NESTS", "screen", "copy")];
    const index = indexGraph(graphOf("ACMEUI", nodes, edges));
    const workspace = {
      version: 1 as const,
      files: [
        { role: "library" as const, key: "ACMEUI", label: "Acme" },
        { role: "product" as const, key: "GLOBEX", label: "Globex" },
      ],
    };
    const rules = parseBindRulesFile({ rules: [{ prefer: "Acme", over: "Globex" }] });
    const result = recommendMasters(index, "button", { workspace, bindRules: rules });
    expect(result.candidates[0]?.fileKey).toBe("ACMEUI");
  });
});

describe("the noun beats size and accessibility words", () => {
  function library() {
    const raw: unknown = JSON.parse(readFileSync(join(root, "scoreboard", "realistic", "library.json"), "utf8"));
    return indexGraph(buildGraph(SourceDocumentSchema.parse(raw), { builtAt: FROZEN }));
  }

  it("keeps large, compact, and screen-reader asks on the button", () => {
    const index = library();
    for (const phrase of ["large button", "large primary button", "compact button", "button for screen reader users", "CTA button"]) {
      const result = recommendMasters(index, phrase);
      expect(result.candidates[0]?.name, phrase).toBe("Button");
      expect(result.match, phrase).toBeUndefined();
    }
    expect(recommendMasters(index, "plus icon").candidates[0]?.name).toBe("Icon plus");
    expect(recommendMasters(index, "chat bubble").candidates).toEqual([]);
    expect(recommendMasters(index, "account card").candidates).toEqual([]);
    expect(recommendMasters(index, "notification count").candidates).toEqual([]);
  });
});

describe("check runs proper use on a placed screen", () => {
  it("checks the placed page shell and says why when the main component is missing", () => {
    const nodes = [
      n("file", "FILE", "Acme", { fileKey: "ACMEUI" }),
      n("page", "PAGE", "Screens", { fileKey: "ACMEUI" }),
      n("shell", "MAIN_COMPONENT", "Page shell", { fileKey: "ACMEUI", figmaNodeId: "364:3066" }),
      n("placed", "COMPONENT_INSTANCE", "Page shell", {
        fileKey: "GLOBEX",
        figmaNodeId: "128:69514",
        mainComponentId: "shell",
        parentId: "page",
      }),
      n("orphan", "COMPONENT_INSTANCE", "Loose", { fileKey: "GLOBEX", figmaNodeId: "128:1" }),
    ];
    const index = indexGraph(
      graphOf("GLOBEX", nodes, [e("INSTANCE_OF", "placed", "shell"), e("CONTAINS", "page", "placed")]),
    );
    const checked = verifyFrame(index, { frame: "128:69514" });
    expect(checked.approved).toBeGreaterThan(0);
    expect(checked.hint).not.toMatch(/No component id or key/);
    expect(checked.properUse?.summary).toBeTruthy();
    expect(checked.properUse?.summary).not.toMatch(/was not run/);
    const missing = checkProperUse(index, "128:1");
    expect(missing?.summary).toMatch(/Proper use was not run/);
  });
});

describe("realistic Acme phrases", () => {
  it("puts the right part in the top 3 for at least 80 percent", () => {
    const raw: unknown = JSON.parse(readFileSync(join(root, "scoreboard", "realistic", "library.json"), "utf8"));
    const index = indexGraph(buildGraph(SourceDocumentSchema.parse(raw), { builtAt: FROZEN }));
    const cases = loadPhraseCases([join(root, "scoreboard", "realistic", "phrases.json")]);
    const match = cases.filter((row) => row.expect !== "none" && row.expect !== "weak");
    expect(match.length).toBeGreaterThanOrEqual(42);
    const report = scorePhrases(index, cases);
    expect(report.skipped).toEqual([]);
    expect(report.totals.invented).toBe(0);
    expect(report.totals.retiredRecommended).toBe(0);
    expect(report.totals.correctEmpty).toBe(report.totals.emptyCases);
    expect(report.totals.top3 / report.totals.matchCases).toBeGreaterThanOrEqual(0.8);
    expect(report.pass).toBe(true);
  });
});

describe("status", () => {
  const previous = process.env["RESOLVE_HOME"];
  afterEach(() => {
    if (previous === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previous;
    clearCache();
  });

  it("asks to learn again when variant names were saved without properties", () => {
    expect(propertiesMissing([
      { type: "COMPONENT_SET", name: "Button" },
      { type: "VARIANT", name: "Size=Large" },
    ])).toBe(true);
    expect(propertiesMissing([
      { type: "COMPONENT_SET", name: "Button", propertyDefinitions: [{ name: "Size" }] },
      { type: "VARIANT", name: "Size=Large" },
    ])).toBe(false);
    expect(propertiesMissing([{ type: "MAIN_COMPONENT", name: "Icon" }])).toBe(false);
    const store = mkdtempSync(join(tmpdir(), "resolve-status-"));
    mkdirSync(store, { recursive: true });
    const graph = graphOf("ACMEUI", [
      n("set", "COMPONENT_SET", "Button", { fileKey: "ACMEUI" }),
      n("variant", "VARIANT", "Size=Large", { fileKey: "ACMEUI", componentSetId: "set" }),
    ], []);
    writeFileSync(join(store, "graph.json"), `${JSON.stringify(graph)}\n`);
    process.env["RESOLVE_HOME"] = store;
    clearCache();
    expect(formatStatus(statusReport())).toMatch(/Learn this library again so Properties show up/);
  });
});
