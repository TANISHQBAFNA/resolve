import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import examplePacks from "@/data/context-packs.example.json";
import { starterRecipes } from "@/core/query";
import { A11Y_LEVELS, packValidation, validateContextPackDocument } from "@/core/query/packValidate";
import { runCli } from "@/server/cli";

const recipes = new Set(starterRecipes().map((recipe) => recipe.id));

const valid = {
  active: "acme-checkout",
  packs: [
    {
      id: "acme-checkout",
      product: { id: "acme-pay", name: "Acme Pay" },
      constraints: { a11y: "wcag-aa" },
      recipeIds: ["checkout-summary"],
      files: ["Acme Storefront"],
    },
  ],
};

describe("context pack validate", () => {
  it("accepts the shipped example and a made-up Acme pack", () => {
    expect(A11Y_LEVELS).toEqual(["wcag-a", "wcag-aa", "wcag-aaa"]);
    const example = packValidation(examplePacks, recipes);
    expect(example.ok).toBe(true);
    expect(example.exitCode).toBe(0);
    expect(example.errors).toEqual([]);
    expect(packValidation(valid, recipes).ok).toBe(true);
  });

  it("names a bad slug, accessibility level, recipe id, file key, and node id", () => {
    const slug = validateContextPackDocument(
      { packs: [{ id: "Acme Checkout", recipeIds: ["checkout-summary"] }] },
      recipes,
    );
    expect(slug[0]?.field).toBe("packs[0].id");
    expect(slug[0]?.message).toMatch(/slug/);
    expect(slug[0]?.message).toMatch(/acme-checkout/);

    const a11y = validateContextPackDocument(
      { packs: [{ id: "acme-checkout", constraints: { a11y: "section-508" }, recipeIds: ["checkout-summary"] }] },
      recipes,
    );
    expect(a11y.some((item) => item.field === "packs[0].constraints.a11y" && /wcag-aa/.test(item.message))).toBe(true);

    const recipe = validateContextPackDocument(
      { packs: [{ id: "acme-checkout", recipeIds: ["Checkout Summary"] }] },
      recipes,
    );
    expect(recipe.some((item) => item.field === "packs[0].recipeIds[0]" && /does not exist/.test(item.message))).toBe(true);

    const fileKey = "AcmeLibraryFileKey0001";
    expect(fileKey).toHaveLength(22);
    const keyIssue = validateContextPackDocument(
      { packs: [{ id: "acme-checkout", recipeIds: ["checkout-summary"], files: [fileKey] }] },
      recipes,
    );
    expect(keyIssue.some((item) => item.field === "packs[0].files[0]" && /file key/.test(item.message))).toBe(true);

    const nodeKey = validateContextPackDocument(
      { packs: [{ id: "acme-checkout", recipeIds: ["checkout-summary"], figmaNodeId: "30:10" }] },
      recipes,
    );
    expect(nodeKey.some((item) => item.field === "packs[0].figmaNodeId" && /Remove figmaNodeId/.test(item.message))).toBe(true);

    const nodeValue = validateContextPackDocument(
      { packs: [{ id: "acme-checkout", recipeIds: ["checkout-summary"], audience: "see 30:10" }] },
      recipes,
    );
    expect(nodeValue.some((item) => item.field === "packs[0].audience" && /node id/.test(item.message))).toBe(true);

    const link = validateContextPackDocument(
      { packs: [{ id: "acme-checkout", recipeIds: ["checkout-summary"], notes: "https://www.figma.com/design/AcmeLibraryFileKey0001/Acme" }] },
      recipes,
    );
    expect(link.some((item) => /Figma link/.test(item.message))).toBe(true);
  });

  it("does not put a stack trace in the message", () => {
    const report = packValidation({ packs: "nope" }, recipes);
    expect(report.ok).toBe(false);
    expect(report.exitCode).toBe(1);
    expect(report.message).toMatch(/packs list/);
    expect(report.message).not.toMatch(/\bat /);
  });
});

describe("resolve pack validate", () => {
  const previousHome = process.env["RESOLVE_HOME"];
  let home: string;
  let stdout: string[];
  let writeOut: typeof process.stdout.write;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "resolve-pack-validate-"));
    process.env["RESOLVE_HOME"] = home;
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
    if (previousHome === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previousHome;
  });

  it("prints JSON for an ok pack and a plain error for a broken file", async () => {
    writeFileSync(join(home, "context-packs.json"), `${JSON.stringify(valid)}\n`);
    await runCli(["pack", "validate", "--json"]);
    const ok = JSON.parse(stdout.join("")) as { ok: boolean; exitCode: number; errors: unknown[]; path: string; packs: number };
    expect(ok.ok).toBe(true);
    expect(ok.exitCode).toBe(0);
    expect(ok.packs).toBe(1);
    expect(ok.errors).toEqual([]);
    expect(ok.path).toMatch(/context-packs\.json$/);
    expect(process.exitCode).toBeUndefined();

    stdout = [];
    process.exitCode = undefined;
    writeFileSync(join(home, "broken.json"), "{not json");
    await runCli(["pack", "validate", join(home, "broken.json")]);
    expect(process.exitCode).toBe(1);
    expect(stdout.join("")).toMatch(/not valid JSON/);
    expect(stdout.join("")).not.toMatch(/\bat /);
  });
});
