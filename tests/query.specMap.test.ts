import { describe, expect, it } from "vitest";
import { formatSpecMap, mapSpec, readSpec } from "@/core/query/specMap";
import { runSpecTool } from "@/server/specMcp";
import { listToolDefinitions } from "@/server/tools";
import { index } from "./fixture";

const SPEC = `# Pay

| Field | Value |
| Product | Acme Pay |
| Audience | Small business owners |

## Screen
- Primary button
- Weekly audit of team latency and uptime
`;

describe("spec map", () => {
  it("reads only the context the spec states", () => {
    const read = readSpec(SPEC);
    expect(read.title).toBe("Pay");
    expect(read.context).toEqual({ product: "Acme Pay", audience: "Small business owners" });
    expect(read.lines.map((line) => line.text)).toEqual(["Primary button", "Weekly audit of team latency and uptime"]);
  });

  it("maps a screen line to a real component and leaves a non-screen line off the default card", () => {
    const read = readSpec(SPEC);
    const first = mapSpec(index, read);
    const second = mapSpec(index, read);
    expect(second).toEqual(first);
    const button = first.rows.find((row) => row.text === "Primary button");
    expect(button?.status === "mapped" || button?.status === "weak").toBe(true);
    expect(button?.pick?.name.toLowerCase()).toContain("button");
    expect(button?.pick?.figmaNodeId).toBeTruthy();
    const audit = first.rows.find((row) => row.text.startsWith("Weekly audit"));
    expect(audit?.status).toBe("not-ui");
    expect(audit?.pick).toBeUndefined();

    const hidden = runSpecTool({ markdown: SPEC }, index, {});
    const shown = runSpecTool({ markdown: SPEC, all: true }, index, {});
    expect((hidden as { rows: Array<{ status: string }> }).rows.some((row) => row.status === "not-ui")).toBe(false);
    expect((shown as { rows: Array<{ status: string }> }).rows.some((row) => row.status === "not-ui")).toBe(true);
    expect(formatSpecMap(first)).toContain("Primary button");
    expect(formatSpecMap(first)).not.toContain("Weekly audit");
    expect(formatSpecMap(first, true)).toContain("Weekly audit");
  });

  it("refuses an empty spec and stays off the default tool list", () => {
    expect(() => runSpecTool({ markdown: "  " }, index, {})).toThrow(/markdown/);
    expect(listToolDefinitions(false, "figma").map((tool) => tool.name)).not.toContain("spec_map");
    expect(listToolDefinitions(true, "figma").map((tool) => tool.name)).toContain("spec_map");
    expect(listToolDefinitions(true, "figma")).toHaveLength(18);
    expect(listToolDefinitions(false, "both")).toHaveLength(12);
    expect(listToolDefinitions(true, "both").map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["spec_map", "code_scan", "learn_library"]),
    );
  });
});
