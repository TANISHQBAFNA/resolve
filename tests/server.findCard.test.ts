import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "@/server/cli";
import { clearCache } from "@/server/store";
import { callTool, encodeToolResult } from "@/server/tools";

type Hit = { name: string; why?: string; ex?: string; figmaNodeId?: string };
type Card = { candidates: Hit[]; truncated: boolean; match?: string };

/** The /find card on the internal Material fixture, learned the way CI scores it. F4-R3. */
describe("find card on a confident pick (F4-R3)", () => {
  const previousHome = process.env["RESOLVE_HOME"];

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "resolve-find-card-"));
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

  for (const ask of ["sign-in button", "list row", "confirm dialog"]) {
    it(`keeps the why line and lists the next hits for "${ask}"`, () => {
      const card = callTool("recommend", { intent: ask }) as Card;
      const wide = callTool("recommend", { intent: ask, budgetChars: 5000 }) as Card;
      const lead = card.candidates[0];
      expect(card.match).toBeUndefined();
      expect(lead?.name).toBe(wide.candidates[0]?.name);
      expect(lead?.why).toBeTruthy();
      // ex is a real instance id. With no real example the card leaves it off (find.md step 5).
      if (lead?.ex) expect(lead.ex).not.toBe("none");
      // Hits 2–3 are listed whenever the ranking has them; the cut keeps at least hit 2.
      expect(card.candidates.length).toBeGreaterThanOrEqual(Math.min(2, wide.candidates.length));
      for (const hit of card.candidates.slice(1)) {
        expect(hit.why).toBeTruthy();
        expect(hit.figmaNodeId).toBeTruthy();
      }
      expect(encodeToolResult(card, "markdown", "recommend")).toMatchSnapshot();
    });
  }
});
