import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolError, TOOLS, callTool, listToolDefinitions } from "@/server/tools";
import { clearCache, graphPath, loadGraph, readSock, storeRoot } from "@/server/store";
import { saveGraph } from "@/server/store";
import { graph } from "./fixture";
import { fillRecipe, starterRecipes } from "@/core/query";
import { emptySock, recordVerifiedUsage } from "@/core/query/sock";
import { indexGraph } from "@/core/query";
import type { DesignGraph } from "@/core/model";

const XML = `<frame id="1:1" name="Home"><component id="9:9" name="Main Card" /></frame>`;

describe("MCP default surface + SOCK loop", () => {
  const previousHome = process.env["GRAPHIFY_HOME"];
  const previousAdvanced = process.env["RESOLVE_MCP_ADVANCED"];

  beforeEach(() => {
    process.env["GRAPHIFY_HOME"] = mkdtempSync(join(tmpdir(), "resolve-mcp-surf-"));
    delete process.env["RESOLVE_MCP_ADVANCED"];
    clearCache();
  });

  afterEach(() => {
    clearCache();
    if (previousHome === undefined) delete process.env["GRAPHIFY_HOME"];
    else process.env["GRAPHIFY_HOME"] = previousHome;
    if (previousAdvanced === undefined) delete process.env["RESOLVE_MCP_ADVANCED"];
    else process.env["RESOLVE_MCP_ADVANCED"] = previousAdvanced;
  });

  it("default tool list is the six agent tools", () => {
    const names = listToolDefinitions(false).map((tool) => tool.name);
    expect(names).toHaveLength(6);
    expect(new Set(names)).toEqual(
      new Set(["learn_library", "recipe", "recommend", "resolve", "verify_frame", "check_cousins"]),
    );
    expect(TOOLS.length).toBeGreaterThan(6);
    expect(listToolDefinitions(true).length).toBe(TOOLS.length);
  });

  it("missing-graph error names the path and the one learn step", () => {
    try {
      callTool("resolve", { name: "Main Card" });
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain(graphPath());
      expect(message).toContain(storeRoot());
      expect(message).toMatch(/learn_library/);
    }
  });

  it("learn_library then resolve sees the master with place-ready ids", () => {
    callTool("learn_library", {
      fileKey: "LIB",
      role: "library",
      metadataXml: XML,
    });
    expect(loadGraph()).toBeDefined();
    const card = callTool("resolve", { name: "Main Card" }) as {
      found: boolean;
      kind?: string;
      component?: { nodeId?: string; fileKey?: string; published?: boolean; publishState?: string };
    };
    expect(card.found).toBe(true);
    expect(card.kind).toBe("component");
    expect(card.component?.nodeId).toBe("9:9");
    expect(card.component?.fileKey).toBe("LIB");
    expect(card.component?.published).toBe(false);
    expect(card.component?.publishState).toBe("local-only");
  });

  it("verify_frame pass records usage facts without a relearn", () => {
    saveGraph(graph);
    const result = callTool("verify_frame", { components: ["Button"] }) as { pass: boolean };
    expect(result.pass).toBe(true);
    const sock = readSock();
    expect(sock.facts.some((fact) => fact.name === "Button")).toBe(true);
    expect(sock.facts.every((fact) => fact.countsTowardThreshold === false)).toBe(true);
  });

  it("three list-only verify permutations do not make Button strong", () => {
    saveGraph(graph);
    callTool("verify_frame", { components: ["Button"] });
    callTool("verify_frame", { components: ["Button", "Card"] });
    callTool("verify_frame", { components: ["Card", "Button"] });
    const sock = readSock();
    const screens = new Set(
      sock.facts.filter((fact) => fact.name === "Button" && fact.countsTowardThreshold !== false).map((fact) => fact.screenId),
    );
    expect(screens.size).toBe(0);
    expect(sock.facts.filter((fact) => fact.name === "Button").length).toBeGreaterThan(0);
    expect(sock.proposals).toEqual([]);
  });

  it("stale version on a later query is exposed in card metadata", () => {
    callTool("learn_library", {
      fileKey: "LIB",
      role: "library",
      metadataXml: XML,
      version: "1",
    });
    const first = callTool("resolve", { name: "Main Card", fileKey: "LIB", version: "1" }) as {
      freshness?: { stale: boolean; version?: string };
    };
    expect(first.freshness?.stale).toBe(false);
    const next = callTool("resolve", { name: "Main Card", fileKey: "LIB", version: "2" }) as {
      freshness?: { stale: boolean };
    };
    expect(next.freshness?.stale).toBe(true);
  });

  it("singleton SOCK usage does not fill a recipe; N screens can", () => {
    const unused: DesignGraph = {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.name === "Banner" ? { ...node, status: undefined } : node,
      ),
      edges: graph.edges,
    };
    const index = indexGraph(unused);
    const recipe = starterRecipes().find((row) => row.id === "empty-state");
    expect(recipe).toBeDefined();
    const banner = unused.nodes.find((node) => node.name === "Banner");
    expect(banner).toBeDefined();

    let sock = emptySock(3);
    sock = recordVerifiedUsage(sock, {
      screenId: "only",
      screenName: "One",
      masters: [{ id: banner!.id, name: "Banner", figmaNodeId: banner!.figmaNodeId }],
    });
    const weak = fillRecipe(index, recipe!, undefined, undefined, undefined, sock);
    const weakSlot = weak.slots.find((slot) => slot.role === "illustration" || slot.hints.includes("empty"));
    void weakSlot;
    const bannerFill = weak.slots.find((slot) => slot.master?.name === "Banner");
    expect(bannerFill).toBeUndefined();

    sock = recordVerifiedUsage(sock, {
      screenId: "two",
      screenName: "Two",
      masters: [{ id: banner!.id, name: "Banner" }],
    });
    sock = recordVerifiedUsage(sock, {
      screenId: "three",
      screenName: "Three",
      masters: [{ id: banner!.id, name: "Banner" }],
    });
    expect(usageReady(sock, banner!.id)).toBe(true);
  });
});

function usageReady(sock: ReturnType<typeof readSock>, id: string): boolean {
  const screens = new Set(sock.facts.filter((fact) => fact.masterId === id).map((fact) => fact.screenId));
  return screens.size >= sock.threshold;
}
