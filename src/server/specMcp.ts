import type { GraphIndex } from "@/core/query/GraphIndex";
import type { recommendMasters } from "@/core/query/recommendMasters";
import { mapSpec, readSpec } from "@/core/query/specMap";

/**
 * Advanced MCP tool. Same reader and ranking as `resolve spec`. The agent reads the Figma spec
 * (figma.spec.getContent) and passes its Markdown; Resolve never calls Figma. Not on the default tool list.
 */

export const SPEC_TOOLS = [
  {
    name: "spec_map",
    description:
      "Map the Markdown of a Figma spec to library components. Pass markdown from figma.spec.getContent. Each list item, table row and sentence is ranked like recommend and returned as mapped (real figmaNodeId + fileKey), weak (check first), no-match (nothing fits or not a screen part; never invent) or not-ui (dates, speed, audit; listed only with all: true). Echoes product, journey, audience and a11y only when the spec states them. Deterministic, no LLM. Advanced surface. Needs RESOLVE_MCP_ADVANCED=1.",
    inputSchema: {
      type: "object",
      properties: {
        markdown: { type: "string", description: "The spec's Markdown (the `markdown` field of figma.spec.getContent)." },
        all: { type: "boolean", description: "Also list the lines that are not screen parts." },
        graphId: { type: "string", description: "Graph to rank against. Optional when exactly one graph is stored." },
        pack: { type: "string" },
        product: { type: "string" },
        journey: { type: "string" },
        domain: { type: "string" },
      },
      required: ["markdown"],
    },
  },
];

export function runSpecTool(args: Record<string, unknown>, index: GraphIndex, ranking: Parameters<typeof recommendMasters>[2]): unknown {
  const markdown = args["markdown"];
  if (typeof markdown !== "string" || !markdown.trim()) throw new Error("`markdown` is required: the spec's text.");
  const map = mapSpec(index, readSpec(markdown), ranking);
  return args["all"] === true ? map : { ...map, rows: map.rows.filter((row) => row.status !== "not-ui") };
}
