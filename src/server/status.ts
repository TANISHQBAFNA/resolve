import { codeMapCard } from "@/core/query";
import { listGraphs, loadFileGraph, loadGraph, readWorkspace, resolveGraph, storeRoot } from "./store";

export interface StatusReport {
  store: string;
  files: Array<{ name: string; fileKey: string; role?: string; nodes: number; learnedAt?: string }>;
  codeMap: { configured: boolean; components: number; mapped: number; retired: number; unmapped: number } | null;
}

/** Which files are learned, when, and how much of the library links to code. Read-only. */
export function statusReport(): StatusReport {
  const files: StatusReport["files"] = [];
  const workspace = readWorkspace();
  if (workspace.files.length) {
    for (const file of workspace.files) {
      const graph = loadFileGraph(file.key);
      files.push({
        name: graph?.fileName ?? file.label ?? file.key,
        fileKey: file.key,
        role: file.role,
        nodes: graph?.nodes.length ?? 0,
        ...(graph ? { learnedAt: graph.source.ingestedAt } : {}),
      });
    }
  } else {
    const loaded = loadGraph();
    if (loaded) {
      files.push({ name: loaded.graph.fileName, fileKey: loaded.graph.fileKey, nodes: loaded.graph.nodes.length, learnedAt: loaded.graph.source.ingestedAt });
    }
  }
  const resolved = files.length || listGraphs().length ? resolveGraph() : undefined;
  const report = resolved ? codeMapCard(() => resolved.index) : undefined;
  return {
    store: storeRoot(),
    files,
    codeMap: report
      ? { configured: report.configured, components: report.counts.masters, mapped: report.counts.mapped, retired: report.counts.retired, unmapped: report.counts.unmapped }
      : null,
  };
}

export function formatStatus(report: StatusReport): string {
  if (!report.files.length) return `Nothing is learned yet (store: ${report.store}). Learn a Figma file first: /design-system <Figma link>.`;
  const when = (iso?: string) => (iso && !Number.isNaN(Date.parse(iso)) ? iso.slice(0, 16).replace("T", " ") + " UTC" : "unknown");
  const lines = [`Resolve store: ${report.store}`, "", "Learned files:"];
  for (const f of report.files) {
    lines.push(`- ${f.name} (${f.fileKey}): ${f.role === "library" ? "design system" : f.role ? `screens (${f.role})` : "learned"}, ${f.nodes} nodes, last learned ${when(f.learnedAt)}`);
  }
  const c = report.codeMap;
  lines.push("", !c ? "Code map: none." : c.configured ? `Code map: ${c.mapped} of ${c.components} components link to code (${c.retired} retired, ${c.unmapped} unmapped).` : "Code map: none yet (resolve code-map --init writes a spreadsheet to fill).");
  return lines.join("\n");
}
