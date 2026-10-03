import { useState } from "react";
import { useGraphStore } from "@/state/graphStore";
import { useAtlas } from "@/state/selectors";

/**
 * Portable exports, in the spirit of a portable `graph.json`: the graph should
 * leave this app in a form another tool can traverse without re-reading Figma.
 */
export function ExportMenu() {
  const graph = useGraphStore((state) => state.graph);
  const atlas = useAtlas();
  const [open, setOpen] = useState(false);

  if (!graph) return null;

  const download = (name: string, payload: unknown) => {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
    setOpen(false);
  };

  const slug = graph.fileName.replace(/[^\w-]+/g, "-").toLowerCase();

  return (
    <div className="export">
      <button type="button" onClick={() => setOpen((value) => !value)}>
        Export ▾
      </button>
      {open && (
        <div className="export__menu">
          <button type="button" onClick={() => download(`${slug}.graph.json`, graph)}>
            graph.json — full design graph
          </button>
          <button
            type="button"
            disabled={!atlas}
            onClick={() =>
              atlas &&
              download(`${slug}.atlas.json`, {
                fileKey: graph.fileKey,
                fileName: graph.fileName,
                stats: atlas.projection.stats,
                modularity: atlas.communities.modularity,
                communities: atlas.communities.communities,
                nodes: atlas.projection.nodes.map((node) => ({
                  id: node.id,
                  name: node.name,
                  type: node.type,
                  figmaNodeId: node.figmaNodeId,
                  community: atlas.communities.byNode.get(node.id),
                  placements: atlas.usage.get(node.id) ?? 0,
                })),
                edges: atlas.projection.edges.map((edge) => ({
                  source: edge.source,
                  target: edge.target,
                  type: edge.type,
                  weight: edge.weight,
                })),
              })
            }
          >
            atlas.json — collapsed graph + communities
          </button>
        </div>
      )}
    </div>
  );
}
