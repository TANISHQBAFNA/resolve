import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import acmeFile from "../docs/examples/acme-ui.json";
import { adaptFigmaRestFile } from "@/core/ingestion";
import { buildGraph } from "@/core/transform";
import { fillRecipe, indexGraph, parseRecipeFile, type Recipe } from "@/core/query";
import { runCli } from "@/server/cli";
import { clearCache, saveGraph } from "@/server/store";
import { callTool } from "@/server/tools";

const FROZEN = "2026-01-01T00:00:00.000Z";

const graph = buildGraph(
  adaptFigmaRestFile({ fileKey: "ACMEUI", file: acmeFile, kind: "mock", ingestedAt: FROZEN }),
  { builtAt: FROZEN },
);
const index = indexGraph(graph);

function chooser(id = "chooser"): Recipe {
  return parseRecipeFile({
    recipes: [
      {
        id,
        title: id,
        slots: [{ role: "chooser", required: true, hints: ["row", "picker"] }],
      },
    ],
  })[0]!;
}

function slotName(card: { slots?: Array<{ master?: { name?: string }; nextRecommend?: string }> }): string | undefined {
  return card.slots?.[0]?.master?.name;
}

describe("extra intent steers an unbound slot", () => {
  const recipe = chooser();

  it("ranks method and payment-method onto Payment method row, and payee onto Payee picker", () => {
    const method = fillRecipe(index, recipe, "method");
    const payment = fillRecipe(index, recipe, "payment-method");
    const payee = fillRecipe(index, chooser("pick-payee"), "payee");
    const pickMethod = fillRecipe(index, chooser("pick-method"), "method");
    expect(method.slots[0]?.master?.name).toBe("Payment method row");
    expect(method.slots[0]?.nextRecommend).toMatch(/\bmethod\b/);
    expect(method.slots[0]?.nextRecommend).toMatch(/row picker/);
    expect(payment.slots[0]?.master?.name).toBe("Payment method row");
    expect(payee.slots[0]?.master?.name).toBe("Payee picker");
    expect(pickMethod.slots[0]?.master?.name).toBe("Payment method row");
  });
});

describe("CLI and MCP pass intent into slot ranking", () => {
  const previousHome = process.env["RESOLVE_HOME"];

  beforeEach(() => {
    process.env["RESOLVE_HOME"] = mkdtempSync(join(tmpdir(), "resolve-slot-intent-"));
    clearCache();
    saveGraph(graph);
    writeFileSync(
      join(process.env["RESOLVE_HOME"]!, "recipes.json"),
      JSON.stringify({
        recipes: [
          {
            id: "chooser",
            title: "Chooser",
            slots: [{ role: "chooser", required: true, hints: ["row", "picker"] }],
          },
        ],
      }),
    );
  });

  afterEach(() => {
    clearCache();
    if (previousHome === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previousHome;
  });

  async function cliRecipe(args: string[]): Promise<{ slots?: Array<{ master?: { name?: string } }> }> {
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runCli(args);
    } finally {
      process.stdout.write = write;
    }
    return JSON.parse(chunks.join("")) as { slots?: Array<{ master?: { name?: string } }> };
  }

  it("resolve recipe chooser --id --intent method fills Payment method row", async () => {
    const method = await cliRecipe(["recipe", "chooser", "--id", "--intent", "method"]);
    const payment = await cliRecipe(["recipe", "chooser", "--id", "--intent", "payment-method"]);
    expect(slotName(method)).toBe("Payment method row");
    expect(slotName(payment)).toBe("Payment method row");
  });

  it("MCP recipe intent fills Payment method row when query and intent are both set", () => {
    const method = callTool("recipe", { query: "chooser", intent: "method" }) as {
      slots?: Array<{ master?: { name?: string } }>;
    };
    const payment = callTool("recipe", { query: "chooser", intent: "payment-method" }) as {
      slots?: Array<{ master?: { name?: string } }>;
    };
    expect(slotName(method)).toBe("Payment method row");
    expect(slotName(payment)).toBe("Payment method row");
  });
});
