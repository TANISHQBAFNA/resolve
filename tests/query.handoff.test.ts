import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import acmeFile from "../docs/examples/acme-ui.json";
import angularMap from "../docs/examples/acme-code-map-angular.json";
import { adaptFigmaRestFile } from "@/core/ingestion";
import { adaptFigmaMcpMetadata } from "@/core/ingestion/adapters/figmaMcp";
import { buildGraph } from "@/core/transform";
import {
  angularTemplate,
  formatHandoffIndex,
  formatHandoffScreen,
  handoffSheet,
  indexGraph,
  inputHints,
  starterRecipes,
  type HandoffDecisionInput,
  type HandoffPack,
} from "@/core/query";
import { runCli } from "@/server/cli";
import { callTool, listToolDefinitions } from "@/server/tools";
import { appendBindAudit, clearCache, saveGraph, saveSock } from "@/server/store";
import { emptySock } from "@/core/query/sock";

const FROZEN = "2026-01-01T00:00:00.000Z";

it("M41-3 handoff markdown shows audience and a11y", () => {
  const text = formatHandoffScreen(
    {
      screen: { name: "Send money", id: "node:send", fileKey: "ACMEPAY", figmaNodeId: "20:40" },
      context: { product: "Acme Pay", journey: "confirm", audience: "returning customer", accessibility: "wcag-aa", a11y: "wcag-aa" },
      recipe: null,
      components: [],
      ingredients: [],
      verify: { pass: true, approved: 0, retired: [], invents: [], unresolved: [] },
      decisions: [],
      openQuestions: [],
      summary: { components: 0, copies: 0, linkedToCode: 0, unmapped: 0, parts: 0, partsLinkedToCode: 0, nameGuesses: 0, notFound: 0, otherLibrary: 0 },
    },
    false,
  );
  expect(text).toContain("Audience: returning customer");
  expect(text).toContain("Accessibility (a11y): wcag-aa");
  expect(text).not.toContain("Context pack:");
});
const graphOf = (file: unknown) => buildGraph(adaptFigmaRestFile({ fileKey: "ACMEUI", file, kind: "mock", ingestedAt: FROZEN }), { builtAt: FROZEN });
const acmeGraph = () => graphOf(acmeFile);
/** Acme with the fix applied: the retired Old Button copy on Send money (20:43) swapped for Button / Variant=Secondary. */
function fixedAcmeFile(): unknown {
  const file = structuredClone(acmeFile) as { document: unknown };
  const swap = (node: { id?: string; name?: string; componentId?: string; children?: unknown[] }) => {
    if (node.id === "20:43") {
      node.name = "Button";
      node.componentId = "30:13";
    }
    for (const child of (node.children ?? []) as (typeof node)[]) swap(child);
  };
  swap(file.document as Parameters<typeof swap>[0]);
  return file;
}
const fixedGraph = () => graphOf(fixedAcmeFile());
/** Acme plus a "Big screen" holding one copy of a 3-level shell: 3 sections x 4 groups x 12 leaf parts (159 parts at depth 3). */
function bigAcmeFile(): unknown {
  const file = fixedAcmeFile() as { document: { children: Array<{ id: string; name: string; type: string; children: unknown[] }> } };
  const bb = { x: 0, y: 0, width: 10, height: 10 };
  const copy = (id: string, componentId: string, name: string) => ({ id, name, type: "INSTANCE", componentId, absoluteBoundingBox: bb });
  const comps: unknown[] = [];
  let n = 0;
  const id = () => `70:${(n += 1)}`;
  const shellKids: unknown[] = [];
  for (let i = 0; i < 3; i += 1) {
    const sectionId = id();
    const sectionKids: unknown[] = [];
    for (let j = 0; j < 4; j += 1) {
      const groupId = id();
      const groupKids: unknown[] = [];
      for (let k = 0; k < 12; k += 1) {
        const leafId = id();
        comps.push({ id: leafId, name: `Leaf part ${i}-${j}-${k}`, type: "COMPONENT", absoluteBoundingBox: bb });
        groupKids.push(copy(id(), leafId, `Leaf part ${i}-${j}-${k}`));
      }
      comps.push({ id: groupId, name: `Group ${i}-${j}`, type: "COMPONENT", absoluteBoundingBox: bb, children: groupKids });
      sectionKids.push(copy(id(), groupId, `Group ${i}-${j}`));
    }
    comps.push({ id: sectionId, name: `Section ${i}`, type: "COMPONENT", absoluteBoundingBox: bb, children: sectionKids });
    shellKids.push(copy(id(), sectionId, `Section ${i}`));
  }
  comps.push({ id: "70:999", name: "Big shell", type: "COMPONENT", absoluteBoundingBox: bb, children: shellKids });
  file.document.children.push({ id: "71:1", name: "Big lib", type: "CANVAS", children: comps });
  file.document.children.push({ id: "72:1", name: "Big page", type: "CANVAS", children: [{ id: "72:2", name: "Big screen", type: "FRAME", absoluteBoundingBox: bb, children: [copy("72:3", "70:999", "Big shell")] }] });
  return file;
}

const ok = (pack: HandoffPack) => {
  if (!pack.ok) throw new Error(`refused: ${JSON.stringify(pack.refused)}`);
  return pack;
};
const GOLDEN = join(__dirname, "fixtures", "handoff");

describe("handoff sheet", () => {
  const previousHome = process.env["RESOLVE_HOME"];
  let home: string;
  const putMap = (map: unknown) => writeFileSync(join(home, "code-map.json"), JSON.stringify(map));
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "resolve-handoff-"));
    process.env["RESOLVE_HOME"] = home;
    clearCache();
  });
  afterEach(() => {
    clearCache();
    process.exitCode = undefined;
    if (previousHome === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previousHome;
  });

  it("golden: Acme Send money is refused because the retired Old Button is on it, draft or not", () => {
    putMap(angularMap);
    const index = indexGraph(acmeGraph());
    for (const draft of [false, true]) {
      const pack = handoffSheet(index, ["Send money"], { draft, recipes: starterRecipes() });
      expect(pack).toEqual({
        ok: false,
        handoff: 1,
        draft,
        refused: [
          {
            screen: "Send money",
            figmaNodeId: "20:40",
            kind: "retired",
            component: "Old Button",
            message:
              "Retired component Old Button is on this screen (copy ACMEUI 20:43). Replace it with Button (code: AcmeButtonComponent from '@acme/ui-angular', <acme-button>, AcmeButtonModule), then run handoff again. A draft does not skip this.",
          },
        ],
        hint: "Replace the retired components named above (verify lists the ones placed on the screen), then run handoff again.",
      });
    }
  });

  it("golden: after the fix, Send money exports cleanly with the ingredient tree, code and suggested inputs", async () => {
    putMap(angularMap);
    const pack = ok(handoffSheet(indexGraph(fixedGraph()), ["Send money"], { recipes: starterRecipes() }));
    expect(pack.draft).toBe(false);
    const sheet = pack.screens[0]!;
    expect(sheet.screen).toEqual({ name: "Send money", id: "node:20:40", fileKey: "ACMEUI", figmaNodeId: "20:40", link: "https://www.figma.com/design/ACMEUI/?node-id=20-40" });
    expect(sheet.components.map((c) => [c.name, c.variant ?? "", c.figmaNodeId, c.code])).toEqual([
      ["Payee picker", "", "30:30", "AcmePayeePickerComponent from '@acme/payments-angular'"],
      ["Button", "Variant=Primary, Size=Medium", "30:11", "AcmeButtonComponent from '@acme/ui-angular'"],
      ["Button", "Variant=Secondary, Size=Medium", "30:13", "AcmeButtonComponent from '@acme/ui-angular'"],
    ]);
    const secondary = sheet.components[2]!;
    expect(secondary.inputs).toEqual([
      { input: "variant", value: "secondary", from: "Variant=Secondary" },
      { input: "size", value: "medium", from: "Size=Medium" },
    ]);
    expect(secondary.template).toBe('<acme-button variant="secondary" size="medium" [disabled]="…" (pressed)="…"></acme-button>');
    expect(sheet.components[0]!.template).toBe('<acme-payee-picker [payees]="…" [(selected)]="…"></acme-payee-picker>');
    expect(sheet.components[0]!.parts.map((p) => [p.name, p.code])).toEqual([
      ["Avatar", null],
      ["Button / Variant=Primary, Size=Medium", "AcmeButtonComponent from '@acme/ui-angular'"],
    ]);
    expect(sheet.ingredients.map((i) => [i.name, i.status, i.usedBy])).toEqual([
      ["Avatar", "unmapped", ["Payee picker"]],
      ["Button / Variant=Primary, Size=Medium", "mapped", ["Payee picker"]],
    ]);
    expect(sheet.verify).toEqual({ pass: true, approved: 3, retired: [], invents: [], unresolved: [] });
    expect(sheet.decisions).toEqual([]);
    expect(sheet.openQuestions).toContain("Part Avatar [ACMEUI 30:40] (inside Payee picker) has no code link.");
    await expect(formatHandoffScreen(sheet, false)).toMatchFileSnapshot(join(GOLDEN, "send-money.md"));
    await expect(`${JSON.stringify(pack, null, 2)}\n`).toMatchFileSnapshot(join(GOLDEN, "send-money.json"));
  });

  it("never guesses code: with no map every component says unmapped and there is one open question about it", () => {
    const sheet = ok(handoffSheet(indexGraph(fixedGraph()), ["Send money"])).screens[0]!;
    expect(sheet.components.every((c) => c.code === "unmapped" && !c.angular && !c.template && !c.inputs)).toBe(true);
    expect(sheet.openQuestions[0]).toBe("No code map, so no component has a code link. Add .resolve/code-map.json (resolve code-map --init writes a spreadsheet to fill).");
    expect(pack(sheet)).toBe(false);
    function pack(s: typeof sheet) {
      return s.summary.linkedToCode > 0;
    }
  });

  it("a React map gives the code line only: Figma properties are shown, no inputs or template are invented", () => {
    putMap({ entries: [{ fileKey: "ACMEUI", id: "30:10", code: { import: "import { Button } from '@acme/ui'", component: "Button" } }] });
    const sheet = ok(handoffSheet(indexGraph(fixedGraph()), ["Send money"])).screens[0]!;
    const button = sheet.components.find((c) => c.figmaNodeId === "30:11")!;
    expect(button).toMatchObject({ code: "Button from '@acme/ui'", figmaProps: { Variant: "Primary", Size: "Medium" } });
    expect(button).not.toHaveProperty("inputs");
    expect(button).not.toHaveProperty("template");
  });

  it("identity gate: a component known only from its layer name refuses production; --draft labels it and sets draft", () => {
    const graph = buildGraph(
      adaptFigmaMcpMetadata({
        fileKey: "ACMEXML",
        fileName: "Acme XML",
        metadataXml: '<canvas id="0:1" name="Page"><frame id="4:1" name="Home"><instance id="4:2" name="Promo card" /></frame></canvas>',
      }),
      { builtAt: FROZEN },
    );
    const index = indexGraph(graph);
    const refused = handoffSheet(index, ["Home"]);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refused).toEqual([
      expect.objectContaining({ kind: "identity", message: expect.stringContaining("MCP metadata insufficient for component Promo card. Use Figma REST or design_context.") }),
    ]);
    const draft = ok(handoffSheet(index, ["Home"], { draft: true }));
    expect(draft.draft).toBe(true);
    expect(draft.screens[0]!.components[0]).toMatchObject({ name: "Promo card", identity: "name-guess" });
    expect(draft.screens[0]!.openQuestions).toContain("Promo card: identity is a guess from the layer name. Confirm it with Figma REST or design_context before building.");
    const text = formatHandoffScreen(draft.screens[0]!, true);
    expect(text).toContain("> **Draft, not for build.** Below: 1 name guess (marked `name-guess`; confirm with Figma REST or design_context).");
    // A pseudo id is never shown as a Figma id.
    expect(text).not.toMatch(/Figma: .*mcp-name/);
    expect(text).toContain("- Figma: no Figma component id (known by its layer name only)");
  });

  it("decisions: approved decisions about this screen, its recipe or its components show who / when / why; others do not", () => {
    const decision = (id: string, extra: object): HandoffDecisionInput => ({
      proposal: { id, createdAt: FROZEN, status: "approved", type: "require-rule", summary: `summary ${id}`, evidence: [], ...extra },
      who: "Ana (design)",
      when: "2026-02-03T10:00:00.000Z",
    });
    const sheet = ok(
      handoffSheet(indexGraph(fixedGraph()), ["Send money"], {
        decisions: [
          decision("by-screen", { evidence: [{ screenName: "Send money" }], decisionNote: "Agreed in review" }),
          decision("by-component", { suggestedRule: { require: "Button", masterId: "node:30:11" } }),
          decision("elsewhere", { suggestedRule: { require: "Payment method row", masterId: "node:30:60" } }),
        ],
      }),
    ).screens[0]!;
    expect(sheet.decisions).toEqual([
      { proposalId: "by-screen", type: "require-rule", summary: "summary by-screen", who: "Ana (design)", when: "2026-02-03T10:00:00.000Z", why: "Agreed in review" },
      { proposalId: "by-component", type: "require-rule", summary: "summary by-component", who: "Ana (design)", when: "2026-02-03T10:00:00.000Z", why: "summary by-component" },
    ]);
    expect(formatHandoffScreen(sheet, false)).toContain("- 2026-02-03 10:00 UTC, Ana (design): summary by-screen Why: Agreed in review (`by-screen`)");
  });

  it("recipe: matched from the screen name or asked; slots say whether their component is on the screen", () => {
    const index = indexGraph(fixedGraph());
    const asked = ok(handoffSheet(index, ["Send money"], { recipe: "confirm-dialog", recipes: starterRecipes() })).screens[0]!;
    expect(asked.recipe).toMatchObject({ id: "confirm-dialog", matchedBy: "asked" });
    expect(asked.recipe?.slots.find((s) => s.role === "primary-cta")).toMatchObject({ onScreen: true, component: { name: "Button" } });
    expect(asked.components.find((c) => c.figmaNodeId === "30:11")?.slot).toBe("primary-cta");
    const none = ok(handoffSheet(index, ["Send money"], { recipes: starterRecipes() })).screens[0]!;
    expect(none.recipe).toBeNull();
    expect(none.recipeNote).toContain("Pass --recipe and a recipe id");
  });

  it("a copy placed as a whole screen is its own single component; verify checks its components as a list", () => {
    const file = fixedAcmeFile() as { document: { children: Array<{ id: string; children: unknown[] }> } };
    const page = file.document.children.find((p) => p.id === "20:1")!;
    page.children.push({
      id: "20:90",
      name: "Payee picker",
      type: "INSTANCE",
      componentId: "30:30",
      absoluteBoundingBox: { x: 3000, y: 0, width: 342, height: 48 },
      children: [
        { id: "20:91", name: "Avatar", type: "INSTANCE", componentId: "30:40", absoluteBoundingBox: { x: 0, y: 0, width: 40, height: 40 } },
        { id: "20:92", name: "Old Button", type: "INSTANCE", componentId: "30:50", absoluteBoundingBox: { x: 50, y: 0, width: 80, height: 40 } },
      ],
    });
    const index = indexGraph(graphOf(file));
    // The retired copy inside the shared copy still refuses.
    const refused = handoffSheet(index, ["ACMEUI:20:90"]);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refused[0]).toMatchObject({ kind: "retired", component: "Old Button" });
    page.children[page.children.length - 1] = {
      ...(page.children[page.children.length - 1] as object),
      children: [{ id: "20:91", name: "Avatar", type: "INSTANCE", componentId: "30:40", absoluteBoundingBox: { x: 0, y: 0, width: 40, height: 40 } }],
    };
    const sheet = ok(handoffSheet(indexGraph(graphOf(file)), ["ACMEUI:20:90"])).screens[0]!;
    expect(sheet.components.map((c) => [c.name, c.count])).toEqual([["Payee picker", 1]]);
    expect(sheet.note).toBe("This screen is one placed copy of Payee picker; everything on it is listed as that component's parts.");
    expect(sheet.verify).toMatchObject({ pass: true, checked: "components", approved: 2 });
  });

  it("variant -> input values and template: aliases, booleans, two-way pairs, attribute selectors; never for attribute-only selectors", () => {
    const ng = { selector: "button[mat-button], a[mat-button]", importPath: "x", inputs: ["color: tone", "disabled", "selected"], outputs: ["selectedChange", "pressed"] };
    const hints = inputHints({ Tone: "Warn Light", Disabled: "True", Size: "Large" }, ng);
    expect(hints).toEqual([
      { input: "tone", value: "warn-light", from: "Tone=Warn Light" },
      { input: "disabled", value: "true", from: "Disabled=True" },
    ]);
    expect(angularTemplate(ng, hints)).toBe('<button mat-button tone="warn-light" [disabled]="true" [(selected)]="…" (pressed)="…"></button>');
    expect(angularTemplate({ selector: "[acmeTooltip]", importPath: "x" }, [])).toBeUndefined();
    expect(angularTemplate({ selector: ".acme-card", importPath: "x" }, [])).toBeUndefined();
    expect(inputHints({ Variant: "Primary" }, undefined)).toEqual([]);
  });
});

describe("resolve handoff (CLI) and get_handoff (MCP)", () => {
  const previousHome = process.env["RESOLVE_HOME"];
  const previousAdvanced = process.env["RESOLVE_MCP_ADVANCED"];
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "resolve-handoff-cli-"));
    process.env["RESOLVE_HOME"] = home;
    clearCache();
  });
  afterEach(() => {
    clearCache();
    process.exitCode = undefined;
    if (previousHome === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previousHome;
    if (previousAdvanced === undefined) delete process.env["RESOLVE_MCP_ADVANCED"];
    else process.env["RESOLVE_MCP_ADVANCED"] = previousAdvanced;
  });
  async function cli(argv: string[]): Promise<string> {
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string | Uint8Array) => (out.push(String(c)), true)) as typeof process.stdout.write;
    try {
      await runCli(argv);
    } finally {
      process.stdout.write = write;
    }
    return out.join("");
  }

  it("refusal prints why, exits 1 and writes nothing", async () => {
    saveGraph(acmeGraph());
    const dir = join(home, "out");
    const text = await cli(["handoff", "Send money", "--out", dir]);
    expect(text).toContain("Handoff refused. Nothing written.\n- Send money: Retired component Old Button is on this screen (copy ACMEUI 20:43).");
    expect(process.exitCode).toBe(1);
    expect(existsSync(dir)).toBe(false);
  });

  it("--out writes handoff.md, one screen file per frame, ingredients.md and handoff.json; never overwrites without --force", async () => {
    saveGraph(fixedGraph());
    writeFileSync(join(home, "code-map.json"), JSON.stringify(angularMap));
    const dir = join(home, "artifacts", "acme-142", "handoff");
    const said = await cli(["handoff", "Send money", "Confirm payment", "--out", dir]);
    expect(said).toContain("Wrote");
    expect(readdirSync(dir).sort()).toEqual(["handoff.json", "handoff.md", "ingredients.md", "screen-confirm-payment.md", "screen-send-money.md"]);
    const json = JSON.parse(readFileSync(join(dir, "handoff.json"), "utf8")) as { screens: unknown[]; ingredients: Array<{ screens: string[] }> };
    expect(json.screens).toHaveLength(2);
    expect(json.ingredients[0]?.screens).toEqual(["Send money", "Confirm payment"]);
    expect(readFileSync(join(dir, "handoff.md"), "utf8")).toContain("- [Send money](screen-send-money.md): 3 components, 3 linked to code, verify PASS");
    await expect(cli(["handoff", "Send money", "--out", dir])).rejects.toThrow("already has handoff files (handoff.json, handoff.md, ingredients.md, …). Add --force to replace them.");
    expect(await cli(["handoff", "Send money", "--out", dir, "--force"])).toContain("Wrote");
    const md = await cli(["handoff", "Send money"]);
    expect(md.startsWith("# Handoff: Send money\n")).toBe(true);
  });

  it("option and frame errors are one plain line", async () => {
    saveGraph(fixedGraph());
    await expect(cli(["handoff"])).rejects.toThrow('Usage: resolve handoff "<frame>"');
    await expect(cli(["handoff", "Send money", "--bogus"])).rejects.toThrow('Unknown handoff option "--bogus"');
    await expect(cli(["handoff", "Send money", "--depth", "9"])).rejects.toThrow("--depth must be 1, 2 or 3.");
    await expect(cli(["handoff", "Send money", "--out"])).rejects.toThrow("--out needs a value.");
    expect(await cli(["handoff", "Button"])).toContain('"Button" is a COMPONENT_SET, not a screen.');
    expect(await cli(["handoff", "No such screen xyz"])).toContain("Handoff refused");
  });

  it("decisions come from approved SOCI proposals and their audit line", async () => {
    saveGraph(fixedGraph());
    saveSock({
      ...emptySock(),
      proposals: [
        { id: "soci-btn", createdAt: FROZEN, status: "approved", type: "require-rule", summary: "Primary action uses Button", evidence: [{ screenName: "Send money" }] },
        { id: "soci-pending", createdAt: FROZEN, status: "pending", type: "require-rule", summary: "Not yet", evidence: [{ screenName: "Send money" }] },
      ],
    });
    appendBindAudit({ who: "Ana", when: "2026-03-04T09:00:00.000Z", proposalId: "soci-btn", action: "approve", before: [], after: [] });
    const json = JSON.parse(await cli(["handoff", "Send money", "--json"])) as { screens: Array<{ decisions: unknown[] }> };
    expect(json.screens[0]?.decisions).toEqual([
      { proposalId: "soci-btn", type: "require-rule", summary: "Primary action uses Button", who: "Ana", when: "2026-03-04T09:00:00.000Z", why: "Primary action uses Button" },
    ]);
  });

  it("MCP: get_handoff is advanced only (the default surface stays at 7); allowWeak makes a draft", () => {
    saveGraph(fixedGraph());
    delete process.env["RESOLVE_MCP_ADVANCED"];
    expect(listToolDefinitions(false)).toHaveLength(7);
    expect(listToolDefinitions(false).map((t) => t.name)).not.toContain("get_handoff");
    expect(() => callTool("get_handoff", { frame: "Send money" })).toThrow("not on the default MCP surface");
    process.env["RESOLVE_MCP_ADVANCED"] = "1";
    const pack = callTool("get_handoff", { frame: "Send money" }) as HandoffPack;
    expect(pack).toMatchObject({ ok: true, draft: false });
    const draft = callTool("get_handoff", { frames: ["Send money"], allowWeak: true }) as HandoffPack;
    expect(draft).toMatchObject({ ok: true, draft: true });
    expect(() => callTool("get_handoff", {})).toThrow("`frame` or `frames` is required.");
  });
});

describe("handoff fixes after PR #37 UAT", () => {
  const previousHome = process.env["RESOLVE_HOME"];
  const previousAdvanced = process.env["RESOLVE_MCP_ADVANCED"];
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "resolve-handoff-uat-"));
    process.env["RESOLVE_HOME"] = home;
    clearCache();
  });
  afterEach(() => {
    clearCache();
    process.exitCode = undefined;
    if (previousHome === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previousHome;
    if (previousAdvanced === undefined) delete process.env["RESOLVE_MCP_ADVANCED"];
    else process.env["RESOLVE_MCP_ADVANCED"] = previousAdvanced;
  });

  it("M2: the MCP cut keeps every open question and the true part count, and says how many parts are listed", () => {
    saveGraph(graphOf(bigAcmeFile()));
    writeFileSync(join(home, "code-map.json"), JSON.stringify(angularMap));
    process.env["RESOLVE_MCP_ADVANCED"] = "1";
    const full = ok(handoffSheet(indexGraph(graphOf(bigAcmeFile())), ["Big screen"], { maxCharsPerCard: 40_000 }));
    expect(JSON.stringify(full).length).toBeGreaterThan(40_000);
    const cut = callTool("get_handoff", { frame: "Big screen" }) as Extract<HandoffPack, { ok: true }> & { cut: { partsShown: number; partsTotal: number; depth: number; reason: string } };
    expect(JSON.stringify(cut).length).toBeLessThanOrEqual(40_000);
    expect(cut.cut.depth).toBeLessThan(3);
    expect(cut.screens[0]!.openQuestions).toEqual(full.screens[0]!.openQuestions);
    expect(cut.screens[0]!.summary).toEqual(full.screens[0]!.summary);
    expect(cut.screens[0]!.summary.parts).toBe(159);
    expect(cut.cut.partsTotal).toBe(159);
    expect(cut.cut.partsShown).toBe(cut.screens[0]!.ingredients.length);
    expect(cut.cut.reason).toContain(`${cut.cut.partsShown} of 159 parts are listed`);
    expect(cut.cut.reason).toContain(`All ${full.screens[0]!.openQuestions.length} open questions and the summary counts are from the full sheet.`);
    // L7: a bad depth is clamped and says so.
    expect(callTool("get_handoff", { frame: "Send money", depth: 9 })).toMatchObject({ ok: true, depthNote: "depth 9 is not 1, 2 or 3; used 3." });
    expect(callTool("get_handoff", { frame: "Send money", depth: 2 })).not.toHaveProperty("depthNote");
  });

  it("M3: a retired part read from a main component refuses, draft or not", () => {
    const file = fixedAcmeFile() as { document: unknown };
    const point = (node: { id?: string; componentId?: string; children?: unknown[] }) => {
      if (node.id === "30:31") node.componentId = "30:50";
      for (const child of (node.children ?? []) as (typeof node)[]) point(child);
    };
    point(file.document as Parameters<typeof point>[0]);
    const index = indexGraph(graphOf(file));
    for (const draft of [false, true]) {
      const pack = handoffSheet(index, ["Send money"], { draft });
      expect(pack.ok).toBe(false);
      if (pack.ok) continue;
      expect(pack.refused).toEqual([
        expect.objectContaining({
          kind: "retired",
          component: "Old Button",
          message: expect.stringContaining("Retired component Old Button is inside Payee picker [ACMEUI 30:30] (read from its main component, because the copy ACMEUI 20:41 on this screen has no learned insides of its own). Replace it with Button"),
        }),
      ]);
    }
  });

  it("M4: a copy whose component is in no learned file refuses as not-found with the real fix; the draft labels it not-found", () => {
    const index = indexGraph(fixedGraph());
    const pack = handoffSheet(index, ["Receipt"]);
    expect(pack.ok).toBe(false);
    if (pack.ok) return;
    expect(pack.refused).toEqual([
      {
        screen: "Receipt",
        figmaNodeId: "20:30",
        kind: "not-found",
        component: "Legacy badge",
        message: "The component of Legacy badge (copy ACMEUI 20:36) is not in the learned library: its main component 40:99 is in no learned file. Learn the library file that holds it, or replace the copy, then run handoff again. (Or pass --draft for a labelled draft that is not for build.)",
      },
    ]);
    expect(pack.hint).toContain("Learn the library file that holds the missing components");
    expect(JSON.stringify(pack)).not.toContain("MCP metadata insufficient");
    const draft = ok(handoffSheet(index, ["Receipt"], { draft: true })).screens[0]!;
    expect(draft.components.find((c) => c.name === "Legacy badge")).toMatchObject({ identity: "not-found", status: "not-found" });
    expect(draft.summary).toMatchObject({ nameGuesses: 0, notFound: 1 });
    const text = formatHandoffScreen(draft, true);
    expect(text).toContain("- Identity: **not-found** (the copy's component is in no learned file)");
    expect(text).toContain("1 component not in the learned library (marked `not-found`");
    expect(text).not.toContain("name-guess");
    expect(draft.openQuestions).toContain("Legacy badge: its component (40:99) is not in the learned library. Learn the library file that holds it, or replace the copy, before building.");
  });

  it("M1: a copy from a library file that is not learned is other-library, with no Figma id of this file and no code-map advice", () => {
    putMap(angularMap);
    const sheet = ok(handoffSheet(indexGraph(fixedGraph()), ["Payment methods"])).screens[0]!;
    const brand = sheet.components.find((c) => c.name === "Brand mark")!;
    expect(brand).toMatchObject({ status: "other-library", copies: ["20:18"], code: "unknown" });
    expect(sheet.summary.unmapped).toBe(sheet.components.filter((c) => c.code === "unmapped").length);
    expect(sheet.summary.linkedToCode + sheet.summary.unmapped + 1).toBe(sheet.summary.components);
    expect(brand).not.toHaveProperty("figmaNodeId");
    expect(brand).not.toHaveProperty("fileKey");
    expect(sheet.summary.otherLibrary).toBe(1);
    expect(sheet.openQuestions).toContain("Brand mark (placed: 20:18) is from a library file that is not learned, so its code is unknown. Learn that library file to see its code and parts.");
    expect(sheet.openQuestions.join("\n")).not.toMatch(/Brand mark \[.*has no code link/);
    const text = formatHandoffScreen(sheet, false);
    expect(text).toContain("- Figma: placed as 20:18; its component is in a library file that is not learned");
    expect(text).toContain("- Code: unknown (its library file is not learned)");
    expect(text).not.toContain("RE:1001");
  });

  it("L10 + L8: slots and decisions count components placed on the screen, not parts inside other components; decision time has its zone", () => {
    const index = indexGraph(fixedGraph());
    const sheet = ok(handoffSheet(index, ["Confirm payment"], { recipe: "confirm-dialog", recipes: starterRecipes() })).screens[0]!;
    const onScreen = Object.fromEntries(sheet.recipe!.slots.map((s) => [s.role, s.onScreen]));
    expect(onScreen["primary-cta"]).toBe(true);
    const decision: HandoffDecisionInput = {
      proposal: { id: "btn", createdAt: FROZEN, status: "approved", type: "require-rule", summary: "Use Button", evidence: [], suggestedRule: { require: "Button", masterId: "node:30:11" } },
      who: "Ana",
      when: "2026-02-03T20:00:00.000Z",
    };
    // Payment methods has Button only inside Payment method row: the Button decision is not about this screen.
    expect(ok(handoffSheet(index, ["Payment methods"], { decisions: [decision] })).screens[0]!.decisions).toEqual([]);
    const send = ok(handoffSheet(index, ["Send money"], { decisions: [decision] })).screens[0]!;
    expect(formatHandoffScreen(send, false)).toContain("- 2026-02-03 20:00 UTC, Ana: Use Button");
  });

  it("recipes from the screen name only on an exact name; a loose match is named, not used", () => {
    const index = indexGraph(fixedGraph());
    const sheet = ok(handoffSheet(index, ["Confirm payment"], { recipes: starterRecipes() })).screens[0]!;
    expect(sheet.recipe).toBeNull();
    expect(sheet.recipeNote).toMatch(/^No recipe has this screen's name\. The closest by name is .+ \(confirm-dialog\), a loose match, so it is not checked; pass --recipe confirm-dialog to check the screen against it\.$/);
  });

  it("L2: a loose frame match is labelled; an empty frame name is refused plainly", () => {
    const index = indexGraph(fixedGraph());
    const sheet = ok(handoffSheet(index, ["money"])).screens[0]!;
    expect(sheet.screen.name).toBe("Send money");
    expect(sheet.matchedFrame).toBe('closest match for "money"; no frame has that exact name or id');
    expect(formatHandoffScreen(sheet, false)).toContain('- Frame: closest match for "money"; no frame has that exact name or id. Pass the exact name or Figma id to be sure.');
    expect(ok(handoffSheet(index, ["Send money"])).screens[0]).not.toHaveProperty("matchedFrame");
    const empty = handoffSheet(index, ["  "]);
    expect(empty).toMatchObject({ ok: false, refused: [{ kind: "not-found", message: "Give a frame name or Figma id (the frame name was empty)." }] });
  });

  it("L4, L9, L12: names are inert markdown, +N more after 10 copies, other variants leave out the placed value, a blank screen says so", () => {
    const file = fixedAcmeFile() as { document: { children: Array<{ id: string; children: Array<Record<string, unknown>> }> } };
    const page = file.document.children.find((p) => p.id === "20:1")!;
    const bb = { x: 0, y: 0, width: 10, height: 10 };
    page.children.push({
      id: "20:80",
      name: "Pay `now` *fast* [x](http://e) <img src=x onerror=alert(1)> ]",
      type: "FRAME",
      absoluteBoundingBox: bb,
      children: Array.from({ length: 12 }, (_, i) => ({ id: `20:${81 + i}`, name: "Button", type: "INSTANCE", componentId: "30:11", absoluteBoundingBox: bb })),
    });
    page.children.push({ id: "20:99", name: "Blank", type: "FRAME", absoluteBoundingBox: bb, children: [] });
    const index = indexGraph(graphOf(file));
    const pack = ok(handoffSheet(index, ["20:80"]));
    const text = formatHandoffScreen(pack.screens[0]!, false);
    expect(text).toContain("# Handoff: Pay \\`now\\` \\*fast\\* [x]\\(http://e) \\<img src=x onerror=alert(1)\\> ]");
    expect(text).not.toMatch(/(^|[^\\])<img/);
    expect(text).toContain("(placed: 20:81, 20:82, 20:83, 20:84, 20:85, 20:86, 20:87, 20:88, 20:89, 20:90, +2 more)");
    expect(text).toContain("- Other variants in Figma (states to build): Variant: Secondary, Danger; Size: Large");
    const indexMd = formatHandoffIndex(pack, ["screen-pay.md"]);
    expect(indexMd).toContain("- [Pay \\`now\\` \\*fast\\* \\[x\\]\\(http://e) \\<img src=x onerror=alert(1)\\> \\]](screen-pay.md)");
    const blank = ok(handoffSheet(index, ["Blank"])).screens[0]!;
    expect(blank.openQuestions[0]).toBe("No components are placed on this screen, so there is nothing to build from the library. Is it the right frame?");
  });

  it("R-L5: a copy whose Figma value conflicts with a selector-pinned attribute gets no template value for it, and an open question", () => {
    putMap({ entries: [{ fileKey: "ACMEUI", id: "30:10", code: { framework: "angular", import: "import { AcmeButtonComponent } from '@acme/ui-angular'", component: "AcmeButtonComponent", selector: 'acme-button[variant="primary"]', module: "AcmeButtonModule", inputs: ["variant", "size"] } }] });
    const sheet = ok(handoffSheet(indexGraph(fixedGraph()), ["Send money"])).screens[0]!;
    const primary = sheet.components.find((c) => c.variant?.startsWith("Variant=Primary"))!;
    const secondary = sheet.components.find((c) => c.variant?.startsWith("Variant=Secondary"))!;
    expect(primary.template).toBe('<acme-button variant="primary" size="medium"></acme-button>');
    expect(secondary.inputs?.map((i) => i.input)).toEqual(["size"]);
    expect(secondary.template).not.toContain('variant="');
    expect(sheet.openQuestions).toContain('Button: the selector only matches variant="primary"; this copy is Secondary (Variant=Secondary). Check how the code builds this variant.');
  });

  it("R-B + R-L10: a slot is placed, inside another component, or missing; one copy fills one slot", () => {
    const index = indexGraph(fixedGraph());
    const sheet = ok(handoffSheet(index, ["Confirm payment"], { recipe: "confirm-dialog", recipes: starterRecipes() })).screens[0]!;
    const slots = sheet.recipe!.slots;
    // One direct Button fills primary-cta; secondary-cta is the Button part inside Payee picker, not the same copy again.
    expect(slots.map((s) => [s.role, s.state, s.insideOf])).toEqual([
      ["body", undefined, undefined],
      ["primary-cta", "placed", undefined],
      ["secondary-cta", "inside", "Payee picker"],
    ]);
    expect(sheet.recipe!.coverage).toEqual({ slots: 3, covered: 2, placed: 1, inside: 1 });
    const text = formatHandoffScreen(sheet, false);
    expect(text).toContain("2/3 slots covered (1 placed, 1 inside another component).");
    expect(text).toContain("| secondary-cta | no | filled | Button [ACMEUI 30:10] | inside Payee picker |");
  });

  it("R-N1: a not-found part inside a library component's definition refuses, like a retired one; a draft only labels it", () => {
    const file = fixedAcmeFile() as { document: unknown };
    const add = (node: { id?: string; children?: unknown[] }) => {
      if (node.id === "30:30") node.children = [...(node.children ?? []), { id: "30:34", name: "Legacy badge", type: "INSTANCE", componentId: "40:99", absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 }, children: [] }];
      for (const child of (node.children ?? []) as (typeof node)[]) add(child);
    };
    add(file.document as Parameters<typeof add>[0]);
    const index = indexGraph(graphOf(file));
    const pack = handoffSheet(index, ["Send money"]);
    expect(pack.ok).toBe(false);
    if (pack.ok) return;
    expect(pack.refused).toEqual([
      expect.objectContaining({ kind: "not-found", component: "Legacy badge", message: expect.stringContaining("is inside Payee picker [ACMEUI 30:30]") }),
    ]);
    expect(handoffSheet(index, ["Send money"], { draft: true }).ok).toBe(true);
  });

  it("R-N2: other-library and not-found components are code unknown, not unmapped", () => {
    putMap(angularMap);
    const sheet = ok(handoffSheet(indexGraph(fixedGraph()), ["Payment methods"])).screens[0]!;
    const unknown = sheet.components.filter((c) => c.code === "unknown");
    expect(unknown.map((c) => c.name)).toEqual(["Brand mark"]);
    expect(sheet.summary.unmapped).toBe(sheet.components.filter((c) => c.code === "unmapped").length);
    expect(sheet.summary.linkedToCode + sheet.summary.unmapped + unknown.length).toBe(sheet.summary.components);
  });

  it("a pasted Figma link with node-id works wherever a frame is asked for; status shows what is learned", async () => {
    saveGraph(fixedGraph());
    const link = "https://www.figma.com/design/ACMEUI/Acme-UI?node-id=20-40&t=abc";
    const byName = ok(handoffSheet(indexGraph(fixedGraph()), ["Send money"])).screens[0]!;
    const byLink = ok(handoffSheet(indexGraph(fixedGraph()), [link])).screens[0]!;
    expect(byLink).toEqual(byName);
    expect(byLink.screen.figmaNodeId).toBe("20:40");
    expect(byLink.matchedFrame).toBeUndefined();
    expect(callTool("verify_frame", { frame: link })).toMatchObject({ frame: { name: "Send money" } });
    expect(JSON.parse(await cli(["cousins", link]))).toBeTruthy();
    expect(await cli(["handoff", link])).toContain("# Handoff: Send money");
    // The node is in another file: not found, never a loose match on the link text.
    expect(handoffSheet(indexGraph(fixedGraph()), ["https://www.figma.com/design/OTHERFILE/X?node-id=999-1"]).ok).toBe(false);
    const status = await cli(["status"]);
    expect(status).toContain("Learned files:");
    expect(status).toContain("last learned 2026-01-01 00:00 UTC");
    expect(status).toContain("Code map: none yet");
    expect(status).toMatch(/version /);
    expect(status).toMatch(/Figma token: (missing|set)/);
    expect(status).toMatch(/Always-on rule: (installed|not installed)/);
    expect(status).toContain("Next:");
    expect(JSON.parse(await cli(["status", "--json"])).files).toHaveLength(1);
  });

  it("L5, L6: a selector attribute is written once; non-ASCII values keep their letters; boolean hints read the same in text and template", () => {
    const ng = { selector: 'acme-button[variant="primary"]', importPath: "x", inputs: ["variant", "size", "disabled", "größe"] };
    const hints = inputHints({ Variant: "Secondary", Size: "Größe Ärger", Disabled: "Yes", Größe: "Groß" }, ng);
    expect(hints).toEqual([
      { input: "variant", value: "secondary", from: "Variant=Secondary" },
      { input: "size", value: "größe-ärger", from: "Size=Größe Ärger" },
      { input: "disabled", value: "true", from: "Disabled=Yes" },
      { input: "größe", value: "groß", from: "Größe=Groß" },
    ]);
    expect(angularTemplate(ng, hints)).toBe('<acme-button variant="primary" size="größe-ärger" [disabled]="true" größe="groß"></acme-button>');
    putMap({ entries: [{ fileKey: "ACMEUI", id: "30:10", code: { framework: "angular", import: "import { AcmeButtonComponent } from '@acme/ui-angular'", component: "AcmeButtonComponent", selector: "acme-button", module: "AcmeButtonModule", inputs: ["variant", "size", "disabled"] } }] });
    const text = formatHandoffScreen(ok(handoffSheet(indexGraph(fixedGraph()), ["Send money"])).screens[0]!, false);
    expect(text).toContain('→ inputs (suggested): variant="primary", size="medium"');
  });

  it("L3: --out refuses over any earlier handoff file, removes stale screen files with --force, and gives plain errors", async () => {
    saveGraph(fixedGraph());
    const dir = join(home, "out");
    await cli(["handoff", "Send money", "Confirm payment", "--out", dir]);
    // Only an old screen file and handoff.md, no handoff.json: still refused.
    const lone = join(home, "lone");
    mkdirSync(lone);
    writeFileSync(join(lone, "handoff.md"), "old");
    await expect(cli(["handoff", "Send money", "--out", lone])).rejects.toThrow("already has handoff files (handoff.md). Add --force to replace them.");
    const again = await cli(["handoff", "Send money", "--out", dir, "--force"]);
    expect(again).toContain("Removed 1 older screen file from an earlier handoff there: screen-confirm-payment.md.");
    expect(readdirSync(dir).sort()).toEqual(["handoff.json", "handoff.md", "ingredients.md", "screen-send-money.md"]);
    const file = join(home, "a-file");
    writeFileSync(file, "x");
    await expect(cli(["handoff", "Send money", "--out", file])).rejects.toThrow(`${file} is a file, not a folder. Pass a folder for --out.`);
    await expect(cli(["handoff", "Send money", "--out", join(file, "sub")])).rejects.toThrow(/Cannot write the handoff files to .*: part of that path is a file, not a folder\. Pass another --out folder\./);
  });

  const putMap = (map: unknown) => writeFileSync(join(home, "code-map.json"), JSON.stringify(map));
  async function cli(argv: string[]): Promise<string> {
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string | Uint8Array) => (out.push(String(c)), true)) as typeof process.stdout.write;
    try {
      await runCli(argv);
    } finally {
      process.stdout.write = write;
    }
    return out.join("");
  }
});
