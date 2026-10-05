import { describe, expect, it } from "vitest";
import {
  buildAiGraphContext,
  compactNode,
  toJsonPayload,
  toMarkdownPrompt,
} from "@/core/ai";
import { ids, index, node } from "./fixture";

const context = buildAiGraphContext(index, ids.buttonPrimaryMedium, {
  generatedAt: "2026-01-01T00:00:00.000Z",
})!;

describe("AI graph context", () => {
  it("returns undefined for an unknown node", () => {
    expect(buildAiGraphContext(index, "node:nope")).toBeUndefined();
  });

  it("centres the payload on the focus node", () => {
    expect(context.focusNode.id).toBe(ids.buttonPrimaryMedium);
    expect(context.selectedNodeIds).toEqual([ids.buttonPrimaryMedium]);
  });

  it("carries the full hierarchy path", () => {
    expect(context.hierarchyPath.map((n) => n.id)).toEqual([
      ids.file,
      ids.pageDesignSystem,
      ids.sectionCore,
      ids.buttonSet,
      ids.buttonPrimaryMedium,
    ]);
  });

  it("summarises usage without shipping the whole file", () => {
    expect(context.usageSummary.instanceCount).toBe(5);
    expect(context.usageSummary.dependentFrameCount).toBe(4);
    expect(context.neighbors.length).toBeLessThanOrEqual(context.meta.nodeBudget);
  });

  it("respects the node budget", () => {
    const small = buildAiGraphContext(index, ids.file, { nodeBudget: 8 })!;
    expect(small.neighbors.length).toBeLessThan(8);
    expect(small.meta.truncated).toBe(true);
  });

  it("always includes explicitly selected nodes", () => {
    const withSelection = buildAiGraphContext(index, ids.frameWelcome, {
      selectedNodeIds: [ids.banner],
      nodeBudget: 20,
    })!;
    expect(withSelection.neighbors.map((n) => n.id)).toContain(ids.banner);
  });

  it("omits materialised inverse edges from the payload", () => {
    expect(context.edges.every((edge) => edge.type !== "PARENT_OF")).toBe(true);
  });

  it("strips heavy metadata unless asked for it", () => {
    const raw = node(ids.frameWelcome);
    expect(raw.metadata).toBeDefined();
    expect(compactNode(raw).metadata).toBeUndefined();
    expect(compactNode(raw, true).metadata).toBeDefined();
  });
});

describe("AI serialisation", () => {
  it("round-trips as JSON", () => {
    const parsed = JSON.parse(toJsonPayload(context));
    expect(parsed.focusNode.id).toBe(ids.buttonPrimaryMedium);
    expect(Array.isArray(parsed.edges)).toBe(true);
  });

  it("renders a prompt that names the focus, its path and the task", () => {
    const markdown = toMarkdownPrompt(context, "Explain this component.");
    expect(markdown).toContain("Variant=Primary, Size=Medium");
    expect(markdown).toContain("Design System");
    expect(markdown).toContain("## Task");
    expect(markdown).toContain("Explain this component.");
  });

  it("stays small enough to paste into a chat window", () => {
    expect(toMarkdownPrompt(context).length).toBeLessThan(20_000);
  });

  it("never includes access tokens or auth headers", () => {
    const payload = toJsonPayload(context);
    expect(payload).not.toMatch(/figd_/);
    expect(payload).not.toContain("FIGMA_ACCESS_TOKEN");
    expect(payload).not.toContain("X-Figma-Token");
    expect(payload).not.toContain("figma-resolve.pat");
    expect(payload).not.toContain("sessionStorage");
  });

  it("exports a bounded subgraph, not the whole graph", () => {
    expect(JSON.parse(toJsonPayload(context)).neighbors.length + 1).toBeLessThan(index.allNodes.length);
  });
});
