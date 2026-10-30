import { describe, expect, it } from "vitest";
import { listToolDefinitions, TOOLS } from "@/server/tools";

type Props = Record<string, { description?: string; enum?: string[]; type?: string }>;
const props = (tool: { inputSchema: Record<string, unknown> }) => (tool.inputSchema["properties"] ?? {}) as Props;

describe("served tool list describes a shared input once", () => {
  it("the first tool keeps the full text, later tools point back, and types and enums stay", () => {
    const tools = listToolDefinitions(true, "both");
    const [first, ...rest] = tools;
    expect(props(first!)["format"]?.description).toMatch(/Card the AI reads/);
    for (const tool of rest) {
      expect(props(tool)["format"], tool.name).toEqual({ type: "string", enum: ["markdown", "json"], description: `Same as ${first!.name}.` });
    }
    const withA11y = tools.filter((tool) => props(tool)["a11y"]);
    expect(withA11y.length).toBeGreaterThan(1);
    expect(props(withA11y[0]!)["a11y"]?.description).toMatch(/Accessibility bar/);
    for (const tool of withA11y.slice(1)) expect(props(tool)["a11y"]?.description).toBe(`Same as ${withA11y[0]!.name}.`);
  });

  it("a tool-specific description is never replaced, and the source tool table is not changed", () => {
    const served = listToolDefinitions(true, "figma");
    const cousins = served.find((tool) => tool.name === "check_cousins")!;
    expect(props(cousins)["fileKey"]?.description).toMatch(/Product\/client file key/);
    const recommend = TOOLS.find((tool) => tool.name === "recommend")!;
    expect(props(recommend)["a11y"]?.description).toMatch(/Accessibility bar/);
    expect(props(recommend)["graphId"]?.description).toMatch(/Graph to query/);
  });

  it("the default list is at least 10% smaller than with every shared input written out", () => {
    const tools = listToolDefinitions(false, "figma");
    const format = props(tools[0]!)["format"];
    const served = JSON.stringify(tools).length;
    const full = JSON.stringify(
      tools.map((tool) => {
        const source = TOOLS.find((row) => row.name === tool.name)!.inputSchema;
        return { ...tool, inputSchema: { ...source, properties: { ...props({ inputSchema: source }), format } } };
      }),
    ).length;
    expect(served).toBeLessThan(full * 0.9);
  });
});
