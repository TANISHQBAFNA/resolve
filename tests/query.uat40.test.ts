import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { checkComponentName } from "@/core/query/codeMapCheck";
import { clearCache, readContextPacks, saveGraph } from "@/server/store";
import { runCli } from "@/server/cli";
import { callTool } from "@/server/tools";
import { attachMcpStdio } from "@/server/mcpSession";
import { graph } from "./fixture";

const angular = (
  fileKey: string,
  id: string,
  component: string,
  selector: string,
  pkg: string,
  extra: Record<string, unknown> = {},
) => ({
  fileKey,
  id,
  code: {
    framework: "angular",
    import: `import { ${component} } from '${pkg}'`,
    component,
    selector,
    ...(extra["module"] ? { module: extra["module"] } : { standalone: true }),
  },
  ...("name" in extra ? { name: extra["name"] } : {}),
  ...("status" in extra ? { status: extra["status"] } : {}),
  ...("replacedBy" in extra ? { replacedBy: extra["replacedBy"] } : {}),
});

const storeA = {
  entries: [
    angular("ACMEUI", "30:10", "AcmeButtonComponent", "acme-button", "@acme/ui-angular", { module: "AcmeButtonModule" }),
    angular("ACMEUI", "30:20", "AcmeTextFieldComponent", "acme-text-field", "@acme/ui-angular"),
    angular("ACMEUI", "30:30", "AcmePayeePickerComponent", "acme-payee-picker", "@acme/payments-angular"),
    angular("ACMEUI", "30:50", "AcmeOldButtonComponent", "acme-old-button", "@acme/ui-angular-legacy", {
      status: "retired",
      replacedBy: "Button",
      module: "AcmeLegacyModule",
    }),
  ],
};

const withNames = (nameById: Record<string, string>) => ({
  entries: storeA.entries.map((entry) => ({ ...entry, ...(nameById[entry.id] ? { name: nameById[entry.id] } : {}) })),
});

const storeS = withNames({ "30:10": "Button", "30:20": "Text field", "30:30": "Payee picker", "30:50": "Old Button" });

const storeX = {
  entries: [
    ...storeA.entries,
    {
      fileKey: "OTHERLIB",
      id: "1:2",
      name: "Button",
      code: {
        framework: "angular",
        import: "import { MatButton } from '@angular/material/button'",
        component: "MatButton",
        selector: "button[mat-button], a[mat-button]",
        module: "MatButtonModule",
      },
    },
  ],
};

const storeL = {
  entries: storeA.entries.map((entry) => {
    if (entry.id !== "30:50") return entry;
    const rest = { ...entry };
    delete rest.status;
    return rest;
  }),
};

const storeN = {
  entries: [
    angular("NIMBUSDS", "4:1", "NimbusCardComponent", "nim-card", "@nimbus/ds", { name: "Card", module: "NimbusCardModule" }),
    angular("NIMBUSMKT", "8:1", "MktCardComponent", "mkt-card", "@nimbus/marketing", { name: "Card", module: "MktCardModule" }),
  ],
};

const reactMap = {
  entries: [
    { fileKey: "ACMEUI", id: "30:10", name: "Button", code: { framework: "react", import: "import { Button } from '@acme/ui'", component: "Button" } },
    { fileKey: "ACMEUI", id: "30:20", name: "TextField", code: { framework: "react", import: "import { TextField } from '@acme/ui'", component: "TextField" } },
  ],
};

const globex = {
  entries: [
    angular("GLOBEX", "2:1", "GlobexButtonComponent", "globex-button", "@globex/ui", { name: "Button", module: "GlobexButtonModule" }),
    angular("GLOBEX", "2:2", "GlobexTextFieldComponent", "globex-text-field", "@globex/ui", { name: "Text field" }),
  ],
};

function part(name: string, fileKey: string, figmaNodeId: string, code: string | null, status = "current", identity = "confirmed") {
  return { name, fileKey, figmaNodeId, identity, status, code, parts: [] as unknown[] };
}

const sendMoney = {
  ok: true,
  draft: false,
  screens: [
    {
      screen: { name: "Send money", fileKey: "ACMEPAY", figmaNodeId: "20:40" },
      components: [
        {
          ...part("Payee picker", "ACMEUI", "30:30", "AcmePayeePickerComponent from '@acme/payments-angular'"),
          parts: [
            part("Avatar", "ACMEUI", "30:40", "unmapped"),
            part("Button", "ACMEUI", "30:10", "AcmeButtonComponent from '@acme/ui-angular'"),
          ],
        },
        part("Button", "ACMEUI", "30:10", "AcmeButtonComponent from '@acme/ui-angular'"),
      ],
      ingredients: [],
    },
  ],
};

const paymentMethods = {
  ok: true,
  draft: false,
  screens: [
    {
      screen: { name: "Payment methods" },
      components: [
        part("Payment method row", "ACMEUI", "30:60", "unmapped"),
        part("Brand mark", "OTHER", "9:9", "unknown", "other-library"),
        { name: "Logo", fileKey: "OTHER", figmaNodeId: "9:10", identity: "confirmed", status: "other-library", code: null, parts: [] },
      ],
      ingredients: [],
    },
  ],
};

describe("code-map check UAT", () => {
  it("H40-1 does not treat a shared package as the same component", () => {
    for (const query of ["AcmeTextFieldComponent", "acme-text-field", "AcmeTextField"]) {
      const card = checkComponentName(query, storeA, sendMoney);
      expect(card.status, query).toBe("not-in-handoff");
      expect(card.exitCode).toBe(3);
    }
    expect(checkComponentName("TextField", reactMap, sendMoney).status).toBe("not-in-handoff");
    const globexSheet = {
      ok: true,
      draft: false,
      screens: [{ components: [part("Button", "GLOBEX", "2:1", "GlobexButtonComponent from '@globex/ui'")], ingredients: [] }],
    };
    expect(checkComponentName("globex-text-field", globex, globexSheet).status).toBe("not-in-handoff");
    expect(checkComponentName("AcmeTextFieldComponent", storeA, paymentMethods).exitCode).toBe(3);
  });

  it("H40-2 answers the sheet's Button, and another library's Button is not on this screen", () => {
    for (const query of ["Button", "button"]) {
      const card = checkComponentName(query, storeX, sendMoney);
      expect(card.status, query).toBe("ok");
      expect(card.component).toBe("AcmeButtonComponent");
      expect(card.import).toBe("@acme/ui-angular");
      expect(card.message.startsWith("Button. Use `<acme-button>` (AcmeButtonModule).")).toBe(true);
    }
    for (const query of ["MatButton", "button[mat-button]", "a[mat-button]", "import { MatButtonModule } from '@angular/material/button'", "import { MatButton } from '@angular/material/button'"]) {
      const card = checkComponentName(query, storeX, sendMoney);
      expect(card.status, query).toBe("not-in-handoff");
      expect(card.exitCode).toBe(3);
      expect(card.component).toBe("MatButton");
    }
    const nimbusSheet = {
      ok: true,
      draft: false,
      screens: [{ components: [part("Card", "NIMBUSDS", "4:1", "NimbusCardComponent from '@nimbus/ds'")], ingredients: [] }],
    };
    expect(checkComponentName("Card", storeN, nimbusSheet)).toMatchObject({ status: "ok", component: "NimbusCardComponent" });
    expect(checkComponentName("MktCardComponent", storeN, nimbusSheet).exitCode).toBe(3);
    expect(checkComponentName("mkt-card", storeN, nimbusSheet).exitCode).toBe(3);
  });

  it("H40-3 matches an import by the class or module, not the package", () => {
    expect(checkComponentName("import { AcmePayeeListComponent } from '@acme/payments-angular'", storeS, sendMoney)).toMatchObject({
      status: "not-found",
      exitCode: 5,
    });
    expect(checkComponentName('import {AcmeButtonComponent} from "@acme/ui-angular"', storeA, sendMoney)).toMatchObject({
      status: "ok",
      component: "AcmeButtonComponent",
      matchedBy: "import",
    });
    expect(checkComponentName("import { AcmeButtonModule } from '@acme/ui-angular'", storeA, sendMoney)).toMatchObject({
      status: "ok",
      component: "AcmeButtonComponent",
    });
    expect(checkComponentName("@acme/ui-angular", storeA, sendMoney).status).toBe("not-found");
  });

  it("M40-1 resolves a handoff display name through fileKey and id", () => {
    expect(checkComponentName("Button", storeA, sendMoney)).toMatchObject({ status: "ok", exitCode: 0 });
    expect(checkComponentName("Payee picker", storeA, sendMoney)).toMatchObject({
      status: "ok",
      component: "AcmePayeePickerComponent",
      standalone: true,
    });
    expect(checkComponentName("Payee picker", storeA, sendMoney).message).toBe("Payee picker. Use `<acme-payee-picker>` (standalone).");
    expect(checkComponentName("Text field", storeA, sendMoney).status).toBe("not-found");
    expect(checkComponentName("Text field", storeS, sendMoney)).toMatchObject({ status: "not-in-handoff", exitCode: 3 });
    expect(checkComponentName("Old Button", storeS, sendMoney)).toMatchObject({ status: "retired", exitCode: 2, use: "Button" });
    expect(checkComponentName("Button", globex, {
      ok: true,
      draft: false,
      screens: [{ components: [part("Button", "GLOBEX", "2:1", "GlobexButtonComponent from '@globex/ui'")], ingredients: [] }],
    }).status).toBe("ok");
  });

  it("M40-3 labels unknown code and a null code as other-library", () => {
    expect(checkComponentName("Brand mark", storeA, paymentMethods)).toMatchObject({ status: "other-library", exitCode: 6 });
    expect(checkComponentName("Brand mark", storeA, paymentMethods).message).toBe("On the screen, from another library, no code twin.");
    expect(checkComponentName("Logo", storeA, paymentMethods).exitCode).toBe(6);
  });

  it("M40-4 uses an omitted status as current unless the sheet says retired", () => {
    expect(checkComponentName("AcmeOldButtonComponent", storeL, sendMoney)).toMatchObject({ status: "not-in-handoff", exitCode: 3 });
    const retiredOnSheet = {
      ok: true,
      draft: false,
      screens: [{ components: [part("Old Button", "ACMEUI", "30:50", "AcmeOldButtonComponent from '@acme/ui-angular-legacy'", "retired")], ingredients: [] }],
    };
    expect(checkComponentName("AcmeOldButtonComponent", storeL, retiredOnSheet)).toMatchObject({ status: "retired", exitCode: 2, use: "Button" });
  });

  it("M40-5 refuses a draft and does not approve a name guess", () => {
    const draft = {
      ok: true,
      draft: true,
      screens: [{ components: [{ ...part("Badge", "ACMEUI", "30:70", "unmapped"), identity: "name-guess" }], ingredients: [] }],
    };
    const card = checkComponentName("Badge", storeA, draft);
    expect(card.status).toBe("error");
    expect(card.exitCode).toBe(1);
    expect(card.message).toBe("This handoff is a draft, not for a build. Run resolve handoff again without --draft.");
    const guessed = {
      ok: true,
      draft: false,
      screens: [{ components: [{ ...part("Badge", "ACMEUI", "30:70", "NimBadgeComponent from '@nimbus/ds'"), identity: "name-guess" }], ingredients: [] }],
    };
    expect(checkComponentName("Badge", storeA, guessed).status).not.toBe("ok");
    expect(checkComponentName("nim-badge", storeA, guessed).status).not.toBe("ok");
  });

  it("M40-6 echoes the design-system name for button and BUTTON", () => {
    for (const query of ["button", "BUTTON"]) {
      const card = checkComponentName(query, storeS, sendMoney);
      expect(card.status).toBe("ok");
      expect(card.message.startsWith("Button. Use `<acme-button>` (AcmeButtonModule).")).toBe(true);
    }
  });

  it("follows a retired replacement for three hops and stops on a loop", () => {
    const chain = {
      entries: [
        angular("ACMEUI", "1:1", "OldA", "old-a", "@acme/old", { status: "retired", replacedBy: "OldB", module: "OldModule" }),
        angular("ACMEUI", "1:2", "OldB", "old-b", "@acme/old", { status: "retired", replacedBy: "OldA", module: "OldModule" }),
      ],
    };
    expect(checkComponentName("OldA", chain, sendMoney).message).toBe("Don't use. There is no current replacement.");
    expect(checkComponentName("OldA", chain, sendMoney)).not.toHaveProperty("use");
  });

  it("L40-1 accepts an HTML tag, an upper-case selector, an attribute, and a comma selector", () => {
    expect(checkComponentName("<acme-payee-picker>", storeA, sendMoney)).toMatchObject({ status: "ok", matchedBy: "selector" });
    expect(checkComponentName("<acme-button></acme-button>", storeA, sendMoney).status).toBe("ok");
    expect(checkComponentName("ACME-PAYEE-PICKER", storeA, sendMoney).status).toBe("ok");
    const attr = {
      entries: [angular("ACMEUI", "30:20", "AcmeTextFieldComponent", "[nimField]", "@acme/ui-angular")],
    };
    expect(checkComponentName("nimField", attr, sendMoney).status).toBe("not-in-handoff");
    expect(checkComponentName("[nimField]", attr, sendMoney).status).toBe("not-in-handoff");
    expect(checkComponentName("button[mat-button], a[mat-button]", storeX, sendMoney)).toMatchObject({ status: "not-in-handoff", component: "MatButton" });
  });

  it("L40-2 strips a variant suffix and ignores spaces in Old Button", () => {
    expect(checkComponentName("Button / Variant=Primary, Size=Medium", storeA, sendMoney)).toMatchObject({ status: "ok", component: "AcmeButtonComponent" });
    expect(checkComponentName("OldButton", storeS, sendMoney).status).toBe("retired");
    expect(checkComponentName("Old Button", storeS, sendMoney).status).toBe("retired");
  });

  it("L40-5 describes a React entry as React", () => {
    const card = checkComponentName("Button", reactMap, sendMoney);
    expect(card.status).toBe("ok");
    expect(card.message).toBe("Button. Use Button from '@acme/ui' (React).");
    expect(card.message).not.toMatch(/Angular/);
  });

  it("L40-10 says a skipped code-map row was skipped", () => {
    const map = {
      entries: [
        ...storeA.entries,
        { fileKey: "ACMEUI", id: "30:99", name: "Badge", code: { import: "import { 1Badge } from '@acme/ui'", component: "1Badge" } },
      ],
    };
    const card = checkComponentName("Badge", map, sendMoney);
    expect(card.status).toBe("not-found");
    expect(card.message).toMatch(/Entry \d+ was skipped/);
    expect(card.message).toMatch(/Don't invent it/);
  });
});

describe("context pack load stays out of the command's way", () => {
  const previousHome = process.env["RESOLVE_HOME"];
  let dir: string;
  let stderr: string[];
  let writeErr: typeof process.stderr.write;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "resolve-pack-load-"));
    process.env["RESOLVE_HOME"] = dir;
    clearCache();
    stderr = [];
    writeErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = writeErr;
    clearCache();
    if (previousHome === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previousHome;
  });

  function writePack(raw: unknown) {
    const body = typeof raw === "string" ? raw : JSON.stringify(raw);
    writeFileSync(join(dir, "context-packs.json"), body);
  }

  it("H40-4 keeps a file-key files entry from failing the load", () => {
    writePack({
      active: "acme-checkout",
      packs: [{ id: "acme-checkout", product: "Acme Pay", recipeIds: ["checkout-summary"], files: ["AbCdEfGhIjKlMnOpQrStUv"] }],
    });
    const file = readContextPacks();
    expect(file.packs).toHaveLength(1);
    expect(file.packs[0]?.files).toBeUndefined();
    expect(file.active).toBe("acme-checkout");
    expect(stderr.join("")).toMatch(/was skipped/);
  });

  it("normalises AA, keeps a ratio phrase, drops a deleted recipe, and skips one bad pack", () => {
    writePack({
      packs: [
        { id: "acme-checkout", product: "Acme Pay", recipeIds: ["checkout-summary", "gone-recipe"], constraints: { a11y: "AA" }, audience: "tablet 16:9 layout" },
        { id: "Acme Checkout", product: "Acme Pay", recipeIds: ["checkout-summary"] },
      ],
    });
    const file = readContextPacks();
    expect(file.packs).toHaveLength(1);
    expect(file.packs[0]?.id).toBe("acme-checkout");
    expect(file.packs[0]?.constraints?.a11y).toBe("wcag-aa");
    expect(file.packs[0]?.audience).toBe("tablet 16:9 layout");
    expect(file.packs[0]?.recipeIds).toEqual(["checkout-summary"]);
    expect(stderr.join("")).toMatch(/was skipped/);
  });

  it("accepts a top-level array and a BOM, and an unreadable JSON file loads as no packs", () => {
    writePack([{ id: "acme-checkout", product: "Acme Pay", recipeIds: ["checkout-summary"] }]);
    expect(readContextPacks().packs).toHaveLength(1);
    writeFileSync(join(dir, "context-packs.json"), `\uFEFF${JSON.stringify({ packs: [{ id: "acme-checkout", recipeIds: ["checkout-summary"] }] })}`);
    stderr = [];
    expect(readContextPacks().packs[0]?.id).toBe("acme-checkout");
    expect(stderr.join("")).not.toMatch(/was skipped/);
    writePack("{not json");
    stderr = [];
    expect(readContextPacks()).toEqual({ packs: [] });
    expect(stderr.join("")).toMatch(/was skipped/);
  });
});

describe("commands keep working when the pack file is bad", () => {
  const previousHome = process.env["RESOLVE_HOME"];
  let dir: string;
  let stdout: string[];
  let writeOut: typeof process.stdout.write;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "resolve-pack-commands-"));
    process.env["RESOLVE_HOME"] = dir;
    clearCache();
    saveGraph(graph);
    writeFileSync(
      join(dir, "context-packs.json"),
      JSON.stringify({
        active: "acme-checkout",
        packs: [{ id: "acme-checkout", product: "Acme Pay", recipeIds: ["checkout-summary"], files: ["AbCdEfGhIjKlMnOpQrStUv"], a11y: "AA" }],
      }),
    );
    stdout = [];
    writeOut = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.stdout.write = writeOut;
    process.exitCode = undefined;
    clearCache();
    if (previousHome === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previousHome;
  });

  async function run(args: string[]) {
    stdout = [];
    process.exitCode = undefined;
    await runCli(args);
    return { out: stdout.join(""), code: process.exitCode };
  }

  it("recommend, resolve, recipe, verify, handoff, cousins, and example do not fail on the pack", async () => {
    const recommend = await run(["recommend", "button"]);
    expect(recommend.out).not.toMatch(/file key/);
    expect(recommend.code).toBeUndefined();

    const resolved = await run(["resolve", "Button"]);
    expect(resolved.out).not.toMatch(/file key/);
    expect(resolved.code).toBeUndefined();

    const recipe = await run(["recipe", "list"]);
    expect(recipe.out).not.toMatch(/file key/);
    expect(recipe.code).toBeUndefined();

    const verified = await run(["verify", "Create account"]);
    expect(verified.out).not.toMatch(/file key|Figma file key/);
    expect(verified.code).toBeUndefined();

    const cousins = await run(["cousins", "Welcome"]);
    expect(cousins.out).not.toMatch(/file key/);
    expect(cousins.code).toBeUndefined();

    const example = await run(["example", "Button"]);
    expect(example.out).not.toMatch(/file key/);
    expect(example.code).toBeUndefined();

    const handoff = await run(["handoff", "Welcome", "--draft"]);
    expect(handoff.out).not.toMatch(/file key/);
    expect(handoff.code).toBeUndefined();
  });

  it("MCP recommend is not an error when the pack file is bad", async () => {
    expect(() => callTool("recommend", { intent: "button" })).not.toThrow();
    const lines: string[] = [];
    await new Promise<void>((done) => {
      const input = Readable.from([
        `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "recommend", arguments: { intent: "button" } } })}\n`,
      ]);
      attachMcpStdio({
        input,
        write: (line) => lines.push(line),
        onClose: () => done(),
      });
    });
    const reply = JSON.parse(lines[0] ?? "{}") as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
    expect(reply.result?.isError).toBeUndefined();
    expect(reply.result?.content?.[0]?.text ?? "").not.toMatch(/file key/);
  });

  it("L40-4 emits JSON when the name or --handoff value is missing", async () => {
    const empty = await run(["code-map", "--check", "", "--json"]);
    expect(empty.code).toBe(1);
    const emptyJson = JSON.parse(empty.out) as { ok: boolean; status: string; message: string; exitCode: number };
    expect(emptyJson).toMatchObject({ ok: false, status: "error", exitCode: 1 });
    expect(emptyJson.message).toMatch(/name was empty/);

    const missingHandoff = await run(["code-map", "--check", "Button", "--handoff", "--json"]);
    expect(missingHandoff.code).toBe(1);
    const handoffJson = JSON.parse(missingHandoff.out) as { status: string; message: string };
    expect(handoffJson.status).toBe("error");
    expect(handoffJson.message).toMatch(/--handoff needs/);
  });
});
