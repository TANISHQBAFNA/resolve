import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import acmeFile from "../docs/examples/acme-ui.json";
import angularMap from "../docs/examples/acme-code-map-angular.json";
import { adaptFigmaRestFile } from "@/core/ingestion";
import { adaptFigmaMcpMetadata } from "@/core/ingestion/adapters/figmaMcp";
import { buildGraph } from "@/core/transform";
import {
  angularTemplate,
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
        hint: "Replace the retired components (run verify for the list), then run handoff again.",
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
    expect(formatHandoffScreen(draft.screens[0]!, true)).toContain("> **Draft, not for build.**");
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
    expect(formatHandoffScreen(sheet, false)).toContain("- 2026-02-03, Ana (design): summary by-screen Why: Agreed in review (`by-screen`)");
  });

  it("recipe: matched from the screen name or asked; slots say whether their component is on the screen", () => {
    const index = indexGraph(fixedGraph());
    const asked = ok(handoffSheet(index, ["Send money"], { recipe: "confirm-dialog", recipes: starterRecipes() })).screens[0]!;
    expect(asked.recipe).toMatchObject({ id: "confirm-dialog", matchedBy: "asked" });
    expect(asked.recipe?.slots.find((s) => s.role === "primary-cta")).toMatchObject({ onScreen: true, component: { name: "Button" } });
    expect(asked.components.find((c) => c.figmaNodeId === "30:11")?.slot).toBe("primary-cta");
    const none = ok(handoffSheet(index, ["Send money"], { recipes: starterRecipes() })).screens[0]!;
    expect(none.recipe).toBeNull();
    expect(none.recipeNote).toContain("Pass --recipe <id>");
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
    await expect(cli(["handoff", "Send money", "--out", dir])).rejects.toThrow("already exists. Add --force");
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
