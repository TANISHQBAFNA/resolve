import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clipHint } from "@/core/query/cardFit";
import { REFRESH_HINT } from "@/core/query/recommendSupport";
import { runCli } from "@/server/cli";
import { clearCache } from "@/server/store";
import { callTool, encodeToolResult } from "@/server/tools";

type Row = { name?: string; given?: string; id?: string };
type Check = { pass: boolean; resolved: Row[]; invents: Row[]; hint: string };

const FAIL_HINT = `Fail — invents/deprecated/unresolved listed. Replace invents with recommend() figmaNodeIds. ${REFRESH_HINT}`;

/** A cut hint is the full hint up to a word boundary, with or without "…". */
function cutAtWord(hint: string, full: string): boolean {
  const kept = hint.replace(/…$/, "");
  return full.startsWith(kept) && (kept.length === full.length || full[kept.length] === " ");
}

/** The /check FAIL card on the internal Material fixture, learned the way CI scores it. F4-R12. */
describe("check FAIL card (F4-R12)", () => {
  const previousHome = process.env["RESOLVE_HOME"];

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "resolve-check-fail-"));
    process.env["RESOLVE_HOME"] = home;
    copyFileSync("fixtures/material/synonyms.json", join(home, "synonyms.json"));
    copyFileSync("fixtures/material/recipes.json", join(home, "recipes.json"));
    clearCache();
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await runCli(["ingest", "fixtures/material/library.json", "--role", "library", "--name", "Material 3"]);
    } finally {
      process.stdout.write = write;
    }
  });

  afterAll(() => {
    clearCache();
    if (previousHome === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previousHome;
  });

  it("never lists an invented part under resolved", () => {
    const check = callTool("verify_frame", { frame: "Sign in", components: ["Button", "Gold", "Sparkle"] }) as Check;
    expect(check.pass).toBe(false);
    expect(check.invents.map((row) => row.name)).toEqual(["Gold", "Sparkle"]);
    expect(check.resolved.map((row) => row.name)).toEqual(["Button"]);
    expect(check.resolved.every((row) => row.id)).toBe(true);
    const card = encodeToolResult(check, "markdown", "verify_frame");
    const listed = card.slice(card.indexOf("resolved:"), card.indexOf("invents:"));
    expect(listed).toContain("Button");
    expect(listed).not.toMatch(/Gold|Sparkle/);
  });

  it("cuts a crowded card's hint at a word boundary", () => {
    const check = callTool("verify_frame", {
      frame: "Sign in",
      components: ["Button", "Gold", "Sparkle", "Glitter", "Shimmer", "Velvet"],
    }) as Check;
    expect(check.invents).toHaveLength(5);
    expect(check.hint.length).toBeLessThan(FAIL_HINT.length);
    expect(cutAtWord(check.hint, FAIL_HINT)).toBe(true);
    const line = encodeToolResult(check, "markdown", "verify_frame").split("\n").find((row) => row.startsWith("hint: "));
    expect(cutAtWord(line!.slice("hint: ".length), FAIL_HINT)).toBe(true);
  });

  it("clips hints to whole sentences, else whole words", () => {
    expect(clipHint(FAIL_HINT, 48)).toBe("Fail — invents/deprecated/unresolved listed.");
    expect(clipHint(FAIL_HINT, FAIL_HINT.length)).toBe(FAIL_HINT);
    expect(clipHint("Place this part on the screen", 16)).toBe("Place this part…");
    expect(clipHint("Unbreakable", 6)).toBe("Unbre…");
    for (let max = 12; max < FAIL_HINT.length; max += 1) {
      const cut = clipHint(FAIL_HINT, max);
      expect(cut.length, String(max)).toBeLessThanOrEqual(max);
      expect(cutAtWord(cut, FAIL_HINT), cut).toBe(true);
    }
  });
});
