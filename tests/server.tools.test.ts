import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolError, TOOLS, callTool, encodeToolResult } from "@/server/tools";
import { clearCache, graphPath, saveGraph, storeRoot } from "@/server/store";
import { graph } from "./fixture";

describe("agent tools", () => {
  const previousHome = process.env["RESOLVE_HOME"];
  const previousAdvanced = process.env["RESOLVE_MCP_ADVANCED"];

  beforeEach(() => {
    process.env["RESOLVE_HOME"] = mkdtempSync(join(tmpdir(), "resolve-tools-"));
    process.env["RESOLVE_MCP_ADVANCED"] = "1";
    clearCache();
  });

  afterEach(() => {
    clearCache();
    if (previousHome === undefined) delete process.env["RESOLVE_HOME"];
    else process.env["RESOLVE_HOME"] = previousHome;
    if (previousAdvanced === undefined) delete process.env["RESOLVE_MCP_ADVANCED"];
    else process.env["RESOLVE_MCP_ADVANCED"] = previousAdvanced;
  });

  it("sees a graph written after the process started (no restart, no clearCache)", () => {
    expect(() => callTool("resolve", { name: "Button" })).toThrow(ToolError);
    writeFileSync(graphPath(), `${JSON.stringify(graph)}\n`);
    const result = callTool("resolve", { name: "Button" }) as { found?: boolean; kind?: string };
    expect(result.found).toBe(true);
    expect(result.kind).toBe("component");
  });

  it("missing-graph error names the store path", () => {
    expect(() => callTool("resolve", { name: "Main Card" })).toThrow(ToolError);
    try {
      callTool("resolve", { name: "Main Card" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain(graphPath());
      expect(message).toContain(storeRoot());
    }
  });

  it("list_graphs reports the store path so an agent can see which folder MCP is reading", () => {
    const result = callTool("list_graphs", {}) as {
      store?: { path: string; graph: string; builtAt?: string };
    };
    expect(result.store?.path).toBe(storeRoot());
    expect(result.store?.graph).toBe(graphPath());
  });

  it("resolve tool description says it returns the id when you know the name", () => {
    const resolve = TOOLS.find((tool) => tool.name === "resolve");
    expect(resolve?.description).toMatch(/know the name|figmaNodeId|id/i);
    expect(resolve?.description).toMatch(/zero|unused|even when/i);
  });

  it("exposes recommend and verify_frame on the same surface as resolve", () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(names).toContain("recommend");
    expect(names).toContain("verify_frame");
    expect(names).toContain("resolve");
    expect(names).toContain("check_frame");
    expect(names).toContain("check_cousins");
  });

  it("exposes list_recipes and recipe next to recommend", () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(names).toContain("list_recipes");
    expect(names).toContain("recipe");
    expect(names).toContain("get_recipe");
  });

  it("list_recipes returns the starter pack without a stored graph", () => {
    const result = callTool("list_recipes", {}) as {
      recipes?: Array<{
        id: string;
        slots: Array<{ status: string; master?: unknown; nextRecommend?: string }>;
      }>;
      recipe?: {
        id: string;
        slots?: Array<{ status: string; master?: unknown; nextRecommend?: string }>;
      };
      also?: string[];
    };
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(2000);
    const listed = result.recipes?.find((recipe) => recipe.id === "checkout-summary");
    const best = result.recipe?.id === "checkout-summary" ? result.recipe : listed;
    expect(best?.id).toBe("checkout-summary");
    expect(best?.slots?.every((slot) => slot.status === "unbound")).toBe(true);
    expect(best?.slots?.every((slot) => !slot.master)).toBe(true);
    if (result.recipes) {
      expect(best?.slots?.some((slot) => slot.nextRecommend)).toBe(true);
    } else {
      expect(result.also?.length).toBeGreaterThan(0);
    }
  });

  it("recipe intent picks the matching pack, same as query", () => {
    const byQuery = callTool("recipe", { query: "sign-in" }) as { recipe?: { id: string } };
    const byIntent = callTool("recipe", { intent: "sign-in" }) as { recipe?: { id: string } };
    expect(byQuery.recipe?.id).toBe("sign-in");
    expect(byIntent.recipe?.id).toBe("sign-in");
    expect(JSON.stringify(byIntent).length).toBeLessThanOrEqual(2000);
  });

  it("list_recipes binds live masters when a graph is stored", () => {
    saveGraph(graph);
    const listed = callTool("list_recipes", {}) as { recipes?: unknown; recipe?: { id: string }; also?: string[] };
    expect(JSON.stringify(listed).length).toBeLessThanOrEqual(2000);
    const result = callTool("recipe", { query: "checkout summary" }) as {
      recipe?: { id: string };
      slots: Array<{ role: string; status: string; master?: { id: string; figmaNodeId?: string } }>;
    };
    expect(result.recipe?.id).toBe("checkout-summary");
    const bound = result.slots.filter((slot) => slot.status === "filled" || slot.status === "bound");
    expect(bound.length).toBeGreaterThan(0);
    expect(bound.every((slot) => slot.master?.id && slot.master.figmaNodeId)).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(2000);
  });

  it("recipe list binds an active context pack without inventing ids", () => {
    writeFileSync(
      join(process.env["RESOLVE_HOME"]!, "context-packs.json"),
      JSON.stringify({
        active: "storefront-checkout-summary",
        packs: [
          {
            id: "storefront-checkout-summary",
            product: { id: "storefront", name: "Storefront" },
            domain: "checkout",
            journey: { step: "summary", screenJob: "checkout summary" },
            recipeIds: ["checkout-summary"],
          },
        ],
      }),
    );
    const result = callTool("recipe", { query: "checkout summary" }) as {
      recipe?: { id: string };
      context?: { id: string; domain?: string };
      slots: Array<{ master?: unknown; nextRecommend?: string }>;
    };
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(2000);
    expect(result.recipe?.id).toBe("checkout-summary");
    expect(result.context?.id).toBe("storefront-checkout-summary");
    expect(result.context?.domain).toBe("checkout");
    expect(result.slots.every((slot) => !slot.master)).toBe(true);
    expect(result.slots[0]?.nextRecommend).toMatch(/storefront|checkout/i);
  });

  it("recommend accepts product/journey flags on the tool", () => {
    saveGraph(graph);
    const names = TOOLS.find((tool) => tool.name === "recommend")?.inputSchema as {
      properties: Record<string, unknown>;
    };
    expect(names.properties).toHaveProperty("pack");
    expect(names.properties).toHaveProperty("product");
    expect(names.properties).toHaveProperty("journey");
    expect(names.properties).toHaveProperty("domain");
    const result = callTool("recommend", {
      intent: "primary button",
      product: "storefront",
      journey: "checkout summary",
      domain: "checkout",
    }) as { candidates: Array<{ id: string }>; context?: { id: string } };
    expect(Array.isArray(result.candidates)).toBe(true);
  });

  it("encodes MCP tool results as compact JSON", () => {
    const payload = { pass: true, approved: 1 };
    const text = encodeToolResult(payload);
    expect(text).toBe(JSON.stringify(payload));
    expect(text).not.toContain("\n");
  });

  it("recipe, list_recipes, and verify_frame accept the same pack-bind fields as recommend", () => {
    for (const name of ["recipe", "get_recipe", "list_recipes", "verify_frame"] as const) {
      const schema = TOOLS.find((tool) => tool.name === name)?.inputSchema as {
        properties: Record<string, unknown>;
      };
      expect(schema.properties).toHaveProperty("pack");
      expect(schema.properties).toHaveProperty("product");
      expect(schema.properties).toHaveProperty("journey");
      expect(schema.properties).toHaveProperty("domain");
    }
  });
});
