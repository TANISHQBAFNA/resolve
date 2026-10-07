import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "@/server/cli";
import { checkComponentFiles, checkComponentName } from "@/core/query/codeMapCheck";

const codeMap = {
  entries: [
    {
      fileKey: "ACMEUI",
      id: "30:10",
      name: "Button",
      code: {
        framework: "angular",
        import: "import { AcmeButtonComponent } from '@acme/ui-angular'",
        component: "AcmeButtonComponent",
        selector: "acme-button",
        module: "AcmeButtonModule",
      },
    },
    {
      fileKey: "ACMEUI",
      id: "30:50",
      name: "OldButton",
      status: "retired",
      replacedBy: "Button",
      code: {
        framework: "angular",
        import: "import { AcmeOldButtonComponent } from '@acme/ui-angular-legacy'",
        component: "AcmeOldButtonComponent",
        selector: "acme-old-button",
        module: "AcmeLegacyModule",
      },
    },
    {
      fileKey: "ACMEUI",
      id: "40:1",
      name: "MatButton",
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

const handoff = {
  ok: true,
  handoff: 1,
  draft: false,
  codeMap: true,
  screens: [
    {
      screen: { name: "Send money", id: "screen-send" },
      recipe: null,
      components: [
        {
          name: "Button",
          fileKey: "ACMEUI",
          figmaNodeId: "30:10",
          count: 1,
          copies: [],
          identity: "confirmed",
          status: "current",
          code: "AcmeButtonComponent from '@acme/ui-angular'",
          angular: { selector: "acme-button", module: "AcmeButtonModule", importPath: "@acme/ui-angular" },
          parts: [],
        },
        {
          name: "Avatar",
          fileKey: "ACMEUI",
          figmaNodeId: "30:40",
          count: 1,
          copies: [],
          identity: "confirmed",
          status: "current",
          code: "unmapped",
          parts: [],
        },
      ],
      ingredients: [],
      verify: { pass: true, approved: 1, retired: [], invents: [], unresolved: [] },
      decisions: [],
      openQuestions: [],
      summary: {
        components: 2,
        copies: 2,
        linkedToCode: 1,
        unmapped: 1,
        parts: 0,
        partsLinkedToCode: 0,
        nameGuesses: 0,
        notFound: 0,
        otherLibrary: 0,
      },
    },
  ],
  ingredients: [],
};

describe("code-map name check without a learned graph", () => {
  it("returns OK with the Angular selector, module, and import", () => {
    for (const query of ["Button", "acme-button", "AcmeButtonComponent", "import { AcmeButtonComponent } from '@acme/ui-angular'"]) {
      const card = checkComponentName(query, codeMap, handoff);
      expect(card.status, query).toBe("ok");
      expect(card.exitCode).toBe(0);
      expect(card.ok).toBe(true);
      expect(card.selector).toBe("acme-button");
      expect(card.module).toBe("AcmeButtonModule");
      expect(card.import).toBe("@acme/ui-angular");
      expect(card.component).toBe("AcmeButtonComponent");
      expect(card.message).toBe("Button. Use `<acme-button>` (AcmeButtonModule).");
      expect(card).not.toHaveProperty("use");
    }
  });

  it("refuses a retired name, selector, class, and legacy import with use Button", () => {
    for (const query of ["OldButton", "acme-old-button", "AcmeOldButtonComponent", "import { AcmeOldButtonComponent } from '@acme/ui-angular-legacy'", "import { AcmeLegacyModule } from '@acme/ui-angular-legacy'"]) {
      const card = checkComponentName(query, codeMap, handoff);
      expect(card.status, query).toBe("retired");
      expect(card.exitCode).toBe(2);
      expect(card.ok).toBe(false);
      expect(card.use).toBe("Button");
      expect(card.message).toBe("Don't use. Use Button.");
    }
  });

  it("says Avatar is unmapped and does not invent a twin", () => {
    const card = checkComponentName("Avatar", codeMap, handoff);
    expect(card.status).toBe("unmapped");
    expect(card.exitCode).toBe(4);
    expect(card.message).toBe("On the screen, no code yet. Build it or ask.");
    expect(card.selector).toBeUndefined();
    expect(card.module).toBeUndefined();
    expect(card.import).toBeUndefined();
    expect(card.component).toBeUndefined();
  });

  it("says MatButton is a code-map part this handoff does not use", () => {
    for (const query of ["MatButton", "button[mat-button]", "a[mat-button]", "import { MatButton } from '@angular/material/button'", "import { MatButtonModule } from '@angular/material/button'"]) {
      const card = checkComponentName(query, codeMap, handoff);
      expect(card.status, query).toBe("not-in-handoff");
      expect(card.exitCode).toBe(3);
      expect(card.selector).toBe("button[mat-button], a[mat-button]");
      expect(card.module).toBe("MatButtonModule");
      expect(card.import).toBe("@angular/material/button");
      expect(card.message).toBe("Real component, but not on this screen. Ask the designer.");
    }
  });

  it("does not guess a name that is in neither file", () => {
    const card = checkComponentName("PayeeDropdown", codeMap, handoff);
    expect(card.status).toBe("not-found");
    expect(card.exitCode).toBe(5);
    expect(card.message).toBe("Not in the design system or on this screen. Don't invent it.");
    expect(card.import).toBeUndefined();
  });

  it("answers a bare Angular module name like its class", () => {
    expect(checkComponentName("AcmeButtonModule", codeMap, handoff).status).toBe("ok");
    expect(checkComponentName("AcmeLegacyModule", codeMap, handoff).status).toBe("retired");
    expect(checkComponentName("ButtonModule", codeMap, handoff).status).toBe("not-found");
  });

  it("matches an HTML tag on selectors only, never on a design name", () => {
    for (const query of ["<button mat-raised-button>", "<button>", "<button></button>"]) {
      const card = checkComponentName(query, codeMap, handoff);
      expect(card.status, query).toBe("not-found");
      expect(card.exitCode).toBe(5);
    }
    expect(checkComponentName("<acme-button>", codeMap, handoff).status).toBe("ok");
    expect(checkComponentName("<acme-old-button>", codeMap, handoff).status).toBe("retired");
  });

  it("reads a part with no twin (code null) by its status: same library is unmapped, another library is other-library", () => {
    const withPart = (status: string) => {
      const sheet = structuredClone(handoff);
      sheet.screens[0]!.components[0]!.parts = [
        { name: "Badge", fileKey: status === "other-library" ? "GLOBEXUI" : "ACMEUI", figmaNodeId: "31:1", count: 1, status, code: null },
      ] as never;
      return sheet;
    };
    expect(checkComponentName("Badge", codeMap, withPart("current")).status).toBe("unmapped");
    expect(checkComponentName("Badge", codeMap, withPart("other-library")).status).toBe("other-library");
    expect(checkComponentName("Badge", codeMap, withPart("not-found")).status).toBe("not-found");
  });

  it("counts a recipe slot's master only when it is placed on the screen", () => {
    const withSlot = (onScreen: boolean) => {
      const sheet = structuredClone(handoff);
      sheet.screens[0]!.components = sheet.screens[0]!.components.filter((row) => row.name !== "Button");
      sheet.screens[0]!.recipe = {
        slots: [{ role: "primary-cta", required: true, status: "bound", component: { name: "Button", fileKey: "ACMEUI", figmaNodeId: "30:10" }, onScreen }],
      } as never;
      return sheet;
    };
    expect(checkComponentName("AcmeButtonComponent", codeMap, withSlot(false)).status).toBe("not-in-handoff");
    expect(checkComponentName("AcmeButtonComponent", codeMap, withSlot(true)).status).toBe("ok");
  });

  it("refuses the retired Acme part by its design name with the shipped example code map", () => {
    const example = JSON.parse(readFileSync(join(process.cwd(), "docs/examples/acme-code-map-angular.json"), "utf8")) as unknown;
    for (const query of ["Old Button", "OldButton"]) {
      const card = checkComponentName(query, example, handoff);
      expect(card.status, query).toBe("retired");
      expect(card.use).toBe("Button");
    }
  });

  it("explains a missing or malformed handoff and code map in plain English", () => {
    expect(checkComponentName("Button", { entries: [] }, handoff).message).toMatch(/no usable entries/);
    expect(checkComponentName("Button", { entries: "nope" }, handoff).status).toBe("error");
    expect(checkComponentName("Button", codeMap, { ok: false, refused: [{ message: "Old Button is retired." }] }).message).toMatch(/refused/);
    expect(checkComponentName("Button", codeMap, { ok: false, refused: [{ message: "Old Button is retired." }] }).message).not.toMatch(/^\s*at /m);
    expect(checkComponentName("Button", codeMap, []).status).toBe("error");
  });
});

describe("resolve code-map --check on committed files only", () => {
  const previousHome = process.env["RESOLVE_HOME"];
  let home: string;
  let stdout: string[];
  let stderr: string[];
  let writeOut: typeof process.stdout.write;
  let writeErr: typeof process.stderr.write;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "resolve-code-check-"));
    process.env["RESOLVE_HOME"] = home;
    writeFileSync(join(home, "code-map.json"), `${JSON.stringify(codeMap, null, 2)}\n`);
    writeFileSync(join(home, "handoff.json"), `${JSON.stringify(handoff, null, 2)}\n`);
    stdout = [];
    stderr = [];
    writeOut = process.stdout.write.bind(process.stdout);
    writeErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
    process.exitCode = undefined;
    if (previousHome === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previousHome;
  });

  async function run(args: string[]): Promise<{ out: string; err: string; code: number | undefined }> {
    stdout = [];
    stderr = [];
    process.exitCode = undefined;
    await runCli(args);
    return { out: stdout.join(""), err: stderr.join(""), code: process.exitCode };
  }

  it("checks every outcome with no graph cache and stable --json fields", async () => {
    expect(existsSync(join(home, "graph.json"))).toBe(false);
    const ok = await run(["code-map", "--check", "Button", "--handoff", join(home, "handoff.json"), "--json"]);
    expect(ok.code).toBeUndefined();
    expect(ok.err).not.toMatch(/^\s*at /m);
    const okJson = JSON.parse(ok.out) as Record<string, unknown>;
    expect(okJson["status"]).toBe("ok");
    expect(okJson["exitCode"]).toBe(0);
    expect(okJson["selector"]).toBe("acme-button");
    expect(okJson["module"]).toBe("AcmeButtonModule");
    expect(okJson["import"]).toBe("@acme/ui-angular");
    expect(Object.keys(okJson).sort()).toEqual(
      ["codeMapPath", "component", "exitCode", "handoffPath", "import", "matchedBy", "message", "module", "ok", "query", "selector", "status"].sort(),
    );

    const retired = await run(["code-map", "--check", "OldButton", "--handoff", home, "--json"]);
    expect(retired.code).toBe(2);
    expect(JSON.parse(retired.out)["use"]).toBe("Button");
    expect(JSON.parse(retired.out)["status"]).toBe("retired");

    const unmapped = await run(["code-map", "--check", "Avatar", "--handoff", join(home, "handoff.json"), "--json"]);
    expect(unmapped.code).toBe(4);
    expect(JSON.parse(unmapped.out)["status"]).toBe("unmapped");
    expect(JSON.parse(unmapped.out)["import"]).toBeUndefined();

    const elsewhere = await run(["code-map", "--check", "MatButton", "--handoff", join(home, "handoff.json"), "--json"]);
    expect(elsewhere.code).toBe(3);
    expect(JSON.parse(elsewhere.out)["status"]).toBe("not-in-handoff");

    const missing = await run(["code-map", "--check", "PayeeDropdown", "--handoff", join(home, "handoff.json"), "--json"]);
    expect(missing.code).toBe(5);
    expect(JSON.parse(missing.out)["status"]).toBe("not-found");

    expect(readdirSync(home).sort()).toEqual(["code-map.json", "handoff.json"]);
    expect(existsSync(join(home, "graph.json"))).toBe(false);
    expect(existsSync(join(home, "files"))).toBe(false);
  });

  it("prints a plain sentence for a missing or broken sheet, never a stack", async () => {
    const gone = await run(["code-map", "--check", "Button", "--handoff", join(home, "missing.json")]);
    expect(gone.code).toBe(1);
    expect(gone.out).toMatch(/No handoff sheet/);
    expect(gone.out).not.toMatch(/^\s*at /m);
    expect(gone.err).not.toMatch(/^\s*at /m);

    writeFileSync(join(home, "handoff.json"), "{not json");
    const badSheet = await run(["code-map", "--check", "Button", "--handoff", join(home, "handoff.json"), "--json"]);
    expect(badSheet.code).toBe(1);
    expect(JSON.parse(badSheet.out)["status"]).toBe("error");
    expect(JSON.parse(badSheet.out)["message"]).toMatch(/not valid JSON/);
    expect(badSheet.err).toBe("");

    writeFileSync(join(home, "handoff.json"), `${JSON.stringify(handoff)}\n`);
    writeFileSync(join(home, "code-map.json"), "{not json");
    const badMap = await run(["code-map", "--check", "Button", "--handoff", join(home, "handoff.json")]);
    expect(badMap.code).toBe(1);
    expect(badMap.out).toMatch(/code map is not valid JSON/i);
    expect(badMap.out).not.toMatch(/^\s*at /m);

    const noMap = checkComponentFiles("Button", join(home, "no-such-map.json"), join(home, "handoff.json"));
    expect(noMap.status).toBe("error");
    expect(noMap.message).toMatch(/No code map/);
    expect(noMap.message).not.toMatch(/^\s*at /m);
  });
});
