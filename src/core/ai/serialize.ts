import type { AiGraphContext } from "./context";

/**
 * Two serialisations of the same payload:
 *  - JSON for programmatic consumers (MCP tools, Cursor, agent frameworks)
 *  - Markdown for pasting into a chat window
 */

export function toJsonPayload(context: AiGraphContext, pretty = true): string {
  return JSON.stringify(context, null, pretty ? 2 : 0);
}

const line = (parts: Array<string | undefined | false>): string =>
  parts.filter(Boolean).join(" · ");

export function toMarkdownPrompt(context: AiGraphContext, task?: string): string {
  const { focusNode, hierarchyPath, neighbors, edges, usageSummary, meta } = context;

  const out: string[] = [];
  out.push(`# Figma design graph context`);
  out.push(
    line([
      `File: **${meta.fileName}**`,
      `Source: ${meta.sourceKind}`,
      meta.truncated ? "⚠️ truncated to fit the node budget" : undefined,
      meta.omittedSelectionIds?.length
        ? `omitted: ${meta.omittedSelectionIds.join(", ")}`
        : undefined,
    ]),
  );
  out.push("");
  out.push(`## Focus`);
  out.push(
    line([
      `**${focusNode.name}**`,
      `type: \`${focusNode.type}\``,
      focusNode.figmaNodeId && `figma id: \`${focusNode.figmaNodeId}\``,
    ]),
  );
  if (focusNode.description) out.push(`> ${focusNode.description}`);
  if (focusNode.figmaUrl) out.push(`Figma: ${focusNode.figmaUrl}`);

  out.push("");
  out.push(`## Location`);
  out.push(hierarchyPath.map((node) => `${node.name} (${node.type})`).join(" → "));

  const summaryEntries = Object.entries(usageSummary).filter(([, value]) => value !== undefined);
  if (summaryEntries.length) {
    out.push("");
    out.push(`## Usage summary`);
    for (const [key, value] of summaryEntries) out.push(`- ${key}: ${value}`);
  }

  if (neighbors.length) {
    out.push("");
    out.push(`## Related nodes (${neighbors.length})`);
    for (const node of neighbors) {
      out.push(
        `- \`${node.id}\` **${node.name}** — ${node.type}${
          node.isRemote ? " (external library)" : ""
        }${node.mainComponentId ? ` → main: \`${node.mainComponentId}\`` : ""}`,
      );
    }
  }

  if (edges.length) {
    out.push("");
    out.push(`## Relationships (${edges.length})`);
    for (const edge of edges) {
      out.push(`- ${edge.source} —[${edge.type}]→ ${edge.target}`);
    }
  }

  if (task) {
    out.push("");
    out.push(`## Task`);
    out.push(task);
  }

  out.push("");
  out.push(
    `_Only the subgraph above was shared. Ask for more nodes by id if something is missing._`,
  );

  return out.join("\n");
}
