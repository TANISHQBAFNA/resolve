import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DesignGraph, GraphEdge, GraphNode, NodeType } from "@/core/model";
import { fillRecipe, indexGraph, recommendMasters, starterRecipes, verifyFrame } from "@/core/query";
import { searchDetail } from "@/core/query/recommendDetail";
import { parseBindRulesFile } from "@/core/query/bindRules";
import { shrinkNameFields } from "@/core/query/cardFit";
import { checkComponentName } from "@/core/query/codeMapCheck";
import { exampleSentence } from "@/core/query/examples";
import { attachProperUse, checkProperUse } from "@/core/query/properUse";
import { presentToolResult } from "@/server/cards";
import { formatStatus, propertiesMissing, statusReport } from "@/server/status";
import { clearCache } from "@/server/store";

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
    const card = checkComponentName("Acme dialog", codeMap, empty, ["Acme dialog", "Button"]);
    expect(card.status).toBe("unmapped");
    expect(card.exitCode).toBe(4);
    expect(card.message).toBe("Real component, but no code link, and it is not on this screen.");
    expect(checkComponentName("dialog", codeMap, empty, ["Acme dialog"]).status).toBe("not-found");
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

describe("a plain noun beats a composite, and icon shelves stay searchable", () => {
  function library() {
    const file = n("file", "FILE", "Acme UI", { fileKey: "ACMEUI" });
    const page = n("page", "PAGE", "Controls", { parentId: "file", fileKey: "ACMEUI" });
    const icons = n("icons", "PAGE", "Icons", { parentId: "file", fileKey: "ACMEUI" });
    const button = n("button", "COMPONENT_SET", "Button", { parentId: "page", fileKey: "ACMEUI", figmaNodeId: "1:1" });
    const primary = n("primary", "VARIANT", "Style=Primary", {
      parentId: "button",
      componentSetId: "button",
      fileKey: "ACMEUI",
      figmaNodeId: "1:2",
      variantProperties: { Style: "Primary" },
    });
    const bar = n("bar", "COMPONENT_SET", "Bottom action bar", {
      parentId: "page",
      fileKey: "ACMEUI",
      figmaNodeId: "1:3",
      variantProperties: { Style: "Primary" },
    });
    const card = n("card", "COMPONENT_SET", "Card", { parentId: "page", fileKey: "ACMEUI", figmaNodeId: "1:4" });
    const party = n("party", "COMPONENT_SET", "Party card", { parentId: "page", fileKey: "ACMEUI", figmaNodeId: "1:5" });
    const menu = n("menu", "COMPONENT_SET", "Mega menu", { parentId: "page", fileKey: "ACMEUI", figmaNodeId: "1:6" });
    const field = n("field", "COMPONENT_SET", "Search field", { parentId: "page", fileKey: "ACMEUI", figmaNodeId: "1:7" });
    const input = n("input", "COMPONENT_SET", "Input", { parentId: "page", fileKey: "ACMEUI", figmaNodeId: "1:8" });
    const remote = (id: string, name: string, fig: string) =>
      n(id, "MAIN_COMPONENT", name, {
        parentId: "icons",
        pageId: "icons",
        fileKey: "ACMEUI",
        figmaNodeId: fig,
        isRemote: true,
        isMainComponent: true,
      });
    const nodes = [
      file,
      page,
      icons,
      button,
      primary,
      bar,
      card,
      party,
      menu,
      field,
      input,
      remote("search", "Search", "9:1"),
      remote("home", "Home", "9:2"),
      remote("settings", "Settings", "9:3"),
      remote("chevron", "Chevron down", "9:4"),
      remote("kebab", "Kebab", "9:5"),
    ];
    const edges = [
      e("CONTAINS", "file", "page"),
      e("CONTAINS", "file", "icons"),
      e("CONTAINS", "page", "button"),
      e("CONTAINS", "button", "primary"),
      e("VARIANT_OF", "primary", "button"),
      e("CONTAINS", "page", "bar"),
      e("CONTAINS", "page", "card"),
      e("CONTAINS", "page", "party"),
      e("CONTAINS", "page", "menu"),
      e("CONTAINS", "page", "field"),
      e("CONTAINS", "page", "input"),
      e("CONTAINS", "icons", "search"),
      e("CONTAINS", "icons", "home"),
      e("CONTAINS", "icons", "settings"),
      e("CONTAINS", "icons", "chevron"),
      e("CONTAINS", "icons", "kebab"),
    ];
    const index = indexGraph(graphOf("ACMEUI", nodes, edges));
    const workspace = { version: 1 as const, files: [{ role: "library" as const, key: "ACMEUI", label: "Acme UI" }] };
    return { index, workspace };
  }

  it("picks Button over an action bar, and Card over a party card", () => {
    const { index, workspace } = library();
    expect(recommendMasters(index, "primary button", { workspace }).candidates[0]?.name).toBe("Button");
    expect(recommendMasters(index, "card", { workspace }).candidates[0]?.name).toBe("Card");
    expect(recommendMasters(index, "large button", { workspace }).candidates[0]?.name).toBe("Button");
  });

  it("fills the sign-in primary slot with the button", () => {
    const { index, workspace } = library();
    const recipe = starterRecipes().find((row) => row.id === "sign-in");
    expect(recipe).toBeDefined();
    const filled = fillRecipe(index, recipe!, undefined, undefined, workspace);
    const slot = filled.slots.find((row) => row.role === "primary-cta");
    expect(slot?.status).toBe("filled");
    expect(slot?.master?.name).toBe("Button");
  });

  it("finds icon-shelf parts that are remote stubs", () => {
    const { index, workspace } = library();
    expect(recommendMasters(index, "search icon", { workspace }).candidates[0]?.name).toBe("Search");
    expect(recommendMasters(index, "home icon", { workspace }).candidates[0]?.name).toBe("Home");
    expect(recommendMasters(index, "settings icon", { workspace }).candidates[0]?.name).toBe("Settings");
    expect(recommendMasters(index, "chevron down", { workspace }).candidates[0]?.name).toBe("Chevron down");
    expect(recommendMasters(index, "kebab menu icon", { workspace }).candidates[0]?.name).toBe("Kebab");
    expect(recommendMasters(index, "search", { workspace }).candidates[0]?.name).toBe("Search");
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

describe("check card wording", () => {
  it("clips a slash name from the end and keeps proper use when the card fits", () => {
    const original = "workspace/screens/ingredients/page-shell".repeat(2);
    const payload = { name: original, pad: "y".repeat(500) };
    shrinkNameFields(payload, 70);
    expect(payload.name.endsWith("…")).toBe(true);
    expect(payload.name.startsWith("…")).toBe(false);
    expect(original.startsWith(payload.name.slice(0, -1))).toBe(true);
    expect(exampleSentence("bare defaults only")).toBe(
      "Copies are on screens, but each one still shows the default text, so there is no filled example to clone.",
    );
    const card = attachProperUse(
      { pass: false, result: "nothing checked" as const, approved: 1, hint: "Named components are in the library. No placed screen was checked." },
      {
        summary: "0 errors",
        errors: 0,
        warnings: 0,
        unknown: 0,
        exitCode: 0,
        level: "wcag-a",
        findings: [],
      },
    );
    expect(card.properUse?.errors).toBe(0);
    const first = presentToolResult(card, "markdown", "verify_frame").split("\n")[0] ?? "";
    expect(first).toContain("Proper use: N/A");
    expect(first).toContain("NAMES ONLY");
  });
});

describe("a nested library still prefers the plain component", () => {
  function nested() {
    const file = n("file", "FILE", "Acme UI", { fileKey: "ACMEUI" });
    const page = n("page", "PAGE", "Library", { parentId: "file", fileKey: "ACMEUI" });
    const buttonPage = n("buttonPage", "PAGE", "Button", { parentId: "file", fileKey: "ACMEUI" });
    const cardPage = n("cardPage", "PAGE", "Card", { parentId: "file", fileKey: "ACMEUI" });
    const actions = n("actions", "FRAME", "Actions", { parentId: "page", fileKey: "ACMEUI" });
    const button = n("button", "COMPONENT_SET", "Button", { parentId: "actions", fileKey: "ACMEUI", figmaNodeId: "1:1" });
    const primary = n("primary", "VARIANT", "Type=Primary, Size=Large", {
      parentId: "button",
      componentSetId: "button",
      fileKey: "ACMEUI",
      figmaNodeId: "1:2",
      variantProperties: { Type: "Primary", Size: "Large" },
    });
    const loose = n("loose", "MAIN_COMPONENT", "Type=Primary, Size=Large", {
      parentId: "buttonPage",
      fileKey: "ACMEUI",
      figmaNodeId: "1:8",
      variantProperties: { Type: "Primary", Size: "Large" },
    });
    const bar = n("bar", "COMPONENT_SET", "Bottom action bar", { parentId: "page", fileKey: "ACMEUI", figmaNodeId: "1:3" });
    const nounBar = n("nounBar", "COMPONENT_SET", "Primary button bar", { parentId: "page", fileKey: "ACMEUI", figmaNodeId: "1:9" });
    const pathButton = n("pathButton", "COMPONENT_SET", "Controls / Button", { parentId: "page", fileKey: "ACMEUI", figmaNodeId: "1:10" });
    const pathVariant = n("pathVariant", "VARIANT", "Type=Primary, Size=Large", {
      parentId: "pathButton",
      componentSetId: "pathButton",
      fileKey: "ACMEUI",
      figmaNodeId: "1:11",
      variantProperties: { Type: "Primary", Size: "Large" },
    });
    const cardLoose = n("cardLoose", "MAIN_COMPONENT", "Type=Default", {
      parentId: "cardPage",
      fileKey: "ACMEUI",
      figmaNodeId: "1:12",
      variantProperties: { Type: "Default" },
    });
    const pathCard = n("pathCard", "COMPONENT_SET", "Surfaces / Card", { parentId: "page", fileKey: "ACMEUI", figmaNodeId: "1:13" });
    const party = n("party", "COMPONENT_SET", "Party card", { parentId: "page", fileKey: "ACMEUI", figmaNodeId: "1:5" });
    const profile = n("profile", "COMPONENT_SET", "Profile card", { parentId: "page", fileKey: "ACMEUI", figmaNodeId: "1:14" });
    const radio = n("radio", "COMPONENT_SET", "Radio", { parentId: "page", fileKey: "ACMEUI", figmaNodeId: "1:15" });
    const group = n("group", "COMPONENT_SET", "button-group", { parentId: "page", fileKey: "ACMEUI", figmaNodeId: "1:16" });
    const alert = n("alert", "COMPONENT_SET", "Alert", {
      parentId: "page",
      fileKey: "ACMEUI",
      figmaNodeId: "1:17",
      description: "A notice the user must see",
    });
    const badges = n("badges", "COMPONENT_SET", "Badge group", { parentId: "page", fileKey: "ACMEUI", figmaNodeId: "1:18" });
    const nodes = [file, page, buttonPage, cardPage, actions, button, primary, loose, bar, nounBar, pathButton, pathVariant, cardLoose, pathCard, party, profile, radio, group, alert, badges];
    const edges = [
      e("CONTAINS", "file", "page"),
      e("CONTAINS", "file", "buttonPage"),
      e("CONTAINS", "file", "cardPage"),
      e("CONTAINS", "page", "actions"),
      e("CONTAINS", "actions", "button"),
      e("CONTAINS", "button", "primary"),
      e("VARIANT_OF", "primary", "button"),
      e("CONTAINS", "buttonPage", "loose"),
      e("CONTAINS", "page", "bar"),
      e("CONTAINS", "page", "nounBar"),
      e("CONTAINS", "page", "pathButton"),
      e("CONTAINS", "pathButton", "pathVariant"),
      e("VARIANT_OF", "pathVariant", "pathButton"),
      e("CONTAINS", "cardPage", "cardLoose"),
      e("CONTAINS", "page", "pathCard"),
      e("CONTAINS", "page", "party"),
      e("CONTAINS", "page", "profile"),
      e("CONTAINS", "page", "radio"),
      e("CONTAINS", "page", "group"),
      e("CONTAINS", "page", "alert"),
      e("CONTAINS", "page", "badges"),
    ];
    const index = indexGraph(graphOf("ACMEUI", nodes, edges));
    const workspace = { version: 1 as const, files: [{ role: "library" as const, key: "ACMEUI", label: "Acme UI" }] };
    return { index, workspace };
  }

  it("ranks the button family when it is nested, path-named, or only a variant under its page", () => {
    const { index, workspace } = nested();
    for (const ask of ["primary button", "large primary button"]) {
      const card = recommendMasters(index, ask, { workspace });
      expect(card.candidates[0]?.name, ask).toBe("Button");
      expect(card.match, ask).not.toBe("weak match");
    }
    const card = recommendMasters(index, "card", { workspace });
    expect(card.candidates[0]?.name).toBe("Card");
    expect(card.match).not.toBe("weak match");
    expect(card.candidates[0]?.name).not.toBe("Party card");
    expect(card.candidates[0]?.name).not.toBe("Profile card");
  });

  it("fills the sign-in slot from a nested button", () => {
    const { index, workspace } = nested();
    const recipe = starterRecipes().find((row) => row.id === "sign-in");
    const filled = fillRecipe(index, recipe!, undefined, undefined, workspace);
    const slot = filled.slots.find((row) => row.role === "primary-cta");
    expect(slot?.status).toBe("filled");
    expect(slot?.master?.name).toBe("Button");
  });

  it("keeps radio ahead of a button group, and flags a different category", () => {
    const { index, workspace } = nested();
    const radio = recommendMasters(index, "radio group", { workspace });
    expect(radio.candidates[0]?.name).toBe("Radio");
    expect(recommendMasters(index, "button group", { workspace }).candidates[0]?.name).toBe("button-group");
    for (const ask of ["notification count", "chat bubble", "toast notification"]) {
      const card = recommendMasters(index, ask, { workspace });
      expect(card.candidates.length, ask).toBeGreaterThan(0);
      expect(card.match, ask).toBe("weak match");
    }
  });
});

describe("a placed screen counts the instances the designer put there", () => {
  it("does not count an icon nested inside a button", () => {
    const nodes = [
      n("file", "FILE", "Acme", { fileKey: "ACMEUI" }),
      n("screen", "FRAME", "Checkout", { fileKey: "ACMEUI", figmaNodeId: "8:1" }),
      n("button", "MAIN_COMPONENT", "Button", { fileKey: "ACMEUI", figmaNodeId: "1:1" }),
      n("field", "MAIN_COMPONENT", "Text field", { fileKey: "ACMEUI", figmaNodeId: "1:2" }),
      n("link", "MAIN_COMPONENT", "Link", { fileKey: "ACMEUI", figmaNodeId: "1:3" }),
      n("icon", "MAIN_COMPONENT", "Icon", { fileKey: "ACMEUI", figmaNodeId: "1:4" }),
      n("b", "COMPONENT_INSTANCE", "Button", { parentId: "screen", fileKey: "ACMEUI", mainComponentId: "button", figmaNodeId: "8:2" }),
      n("f", "COMPONENT_INSTANCE", "Text field", { parentId: "screen", fileKey: "ACMEUI", mainComponentId: "field", figmaNodeId: "8:3" }),
      n("l", "COMPONENT_INSTANCE", "Link", { parentId: "screen", fileKey: "ACMEUI", mainComponentId: "link", figmaNodeId: "8:4" }),
      n("i", "COMPONENT_INSTANCE", "Icon", { parentId: "b", fileKey: "ACMEUI", mainComponentId: "icon", figmaNodeId: "8:5" }),
    ];
    const edges = [
      e("CONTAINS", "screen", "b"),
      e("CONTAINS", "screen", "f"),
      e("CONTAINS", "screen", "l"),
      e("CONTAINS", "b", "i"),
      e("INSTANCE_OF", "b", "button"),
      e("INSTANCE_OF", "f", "field"),
      e("INSTANCE_OF", "l", "link"),
      e("INSTANCE_OF", "i", "icon"),
    ];
    const checked = verifyFrame(indexGraph(graphOf("ACMEUI", nodes, edges)), { frame: "8:1" });
    expect(checked.approved).toBe(3);
  });

  it("does not count an icon the frame also links when its parent is the button", () => {
    const nodes = [
      n("file", "FILE", "Acme", { fileKey: "ACMEUI" }),
      n("screen", "FRAME", "Checkout", { fileKey: "ACMEUI", figmaNodeId: "8:1" }),
      n("button", "MAIN_COMPONENT", "Button", { fileKey: "ACMEUI", figmaNodeId: "1:1" }),
      n("field", "MAIN_COMPONENT", "Text field", { fileKey: "ACMEUI", figmaNodeId: "1:2" }),
      n("link", "MAIN_COMPONENT", "Link", { fileKey: "ACMEUI", figmaNodeId: "1:3" }),
      n("icon", "MAIN_COMPONENT", "Icon", { fileKey: "ACMEUI", figmaNodeId: "1:4" }),
      n("b", "COMPONENT_INSTANCE", "Button", { parentId: "screen", fileKey: "ACMEUI", mainComponentId: "button", figmaNodeId: "8:2" }),
      n("f", "COMPONENT_INSTANCE", "Text field", { parentId: "screen", fileKey: "ACMEUI", mainComponentId: "field", figmaNodeId: "8:3" }),
      n("l", "COMPONENT_INSTANCE", "Link", { parentId: "screen", fileKey: "ACMEUI", mainComponentId: "link", figmaNodeId: "8:4" }),
      n("i", "COMPONENT_INSTANCE", "Icon", { parentId: "b", fileKey: "ACMEUI", mainComponentId: "icon", figmaNodeId: "8:5" }),
    ];
    const edges = [
      e("CONTAINS", "screen", "b"),
      e("CONTAINS", "screen", "f"),
      e("CONTAINS", "screen", "l"),
      e("CONTAINS", "screen", "i"),
      e("CONTAINS", "b", "i"),
      e("INSTANCE_OF", "b", "button"),
      e("INSTANCE_OF", "f", "field"),
      e("INSTANCE_OF", "l", "link"),
      e("INSTANCE_OF", "i", "icon"),
    ];
    const checked = verifyFrame(indexGraph(graphOf("ACMEUI", nodes, edges)), { frame: "8:1" });
    expect(checked.approved).toBe(3);
  });
});

describe("an older single-library store", () => {
  function older() {
    const file = n("file", "FILE", "Acme UI", { fileKey: "ACMEUI" });
    const page = n("page", "PAGE", "Artwork", { parentId: "file", fileKey: "ACMEUI" });
    const pdf = n("pdf", "MAIN_COMPONENT", "PDF", {
      parentId: "page",
      pageId: "page",
      fileKey: "ACMEUI",
      figmaNodeId: "4:1",
      isRemote: true,
      isMainComponent: true,
    });
    const alert = n("alert", "MAIN_COMPONENT", "Alert", { parentId: "page", fileKey: "ACMEUI", figmaNodeId: "4:2" });
    const tabs = n("tabs", "COMPONENT_SET", "Tabs", { parentId: "page", fileKey: "ACMEUI", figmaNodeId: "4:3" });
    const field = n("field", "COMPONENT_SET", "Text field", {
      parentId: "page",
      fileKey: "ACMEUI",
      figmaNodeId: "4:4",
      propertyDefinitions: [{ name: "Font", type: "TEXT", defaultValue: "Courier" }],
    });
    const slot = n("slot", "FRAME", "Caption", {
      parentId: "field",
      fileKey: "ACMEUI",
      metadata: { figmaType: "SLOT" },
    });
    const index = indexGraph(
      graphOf("ACMEUI", [file, page, pdf, alert, tabs, field, slot], [
        e("CONTAINS", "file", "page"),
        e("CONTAINS", "page", "pdf"),
        e("CONTAINS", "page", "alert"),
        e("CONTAINS", "page", "tabs"),
        e("CONTAINS", "page", "field"),
        e("CONTAINS", "field", "slot"),
      ]),
    );
    const workspace = { version: 1 as const, files: [{ role: "library" as const, key: "ACMEUI", label: "Acme UI" }] };
    return { index, workspace, field };
  }

  it("finds a remote pdf icon and flags an alert that is not a banner", () => {
    const { index, workspace, field } = older();
    const pdf = recommendMasters(index, "pdf icon", { workspace });
    expect(pdf.candidates[0]?.name).toBe("PDF");
    expect(pdf.match).not.toBe("weak match");
    const banner = recommendMasters(index, "alert banner", { workspace });
    expect(banner.candidates[0]?.name).toBe("Alert");
    expect(banner.match).toBe("weak match");
    const tabs = recommendMasters(index, "tab bar", { workspace });
    expect(tabs.candidates[0]?.name).toBe("Tabs");
    expect(tabs.match).not.toBe("weak match");
    const detail = searchDetail(index, field);
    expect(detail.variant.toLowerCase()).toContain("courier");
    expect(detail.describe).toContain("Caption");
    const font = recommendMasters(index, "courier field", { workspace });
    expect(font.candidates[0]?.name).toBe("Text field");
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
