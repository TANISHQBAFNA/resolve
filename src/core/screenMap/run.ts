import type { DesignGraph } from "@/core/model";
import { buildScreenMap, expandRef, writeScreenMap } from "./document";
import { driftView, journeyView, loadMap, mapWarning, nodeView, outlineView } from "./views";

const OFF = () => mapWarning("W-MAP-OFF", "Screen Map is off.");

export function screenMapUsageLines(enabled: boolean): string[] {
  if (!enabled) {
    return ["  resolve map", "      Screen Map is off. next: set screenMap.enabled true in .resolve/config.json"];
  }
  return [
    "  resolve map build [--file <key>] [--frame <id>] [--refs]",
    "      Private tree for an Acme file. Example: resolve map screen <Input field id>",
    "  resolve map outline | screen <id> | node <id> [--depth N] | journey <id> | drift [id] | expand <ref>",
  ];
}

export function screenMapTools(enabled: boolean) {
  if (!enabled) return [];
  const properties = {
    id: { type: "string" },
    fileKey: { type: "string" },
    depth: { type: "number" },
    page: { type: "number" },
    offset: { type: "number" },
    frame: { type: "string" },
    refs: { type: "boolean" },
    scope: { type: "string" },
  };
  return ["map_build", "map_outline", "map_screen", "map_node", "map_journey", "map_drift", "map_expand"].map((name) => ({
    name,
    description: `Acme Screen Map ${name}. Warning only, with a next hint.`,
    inputSchema: { type: "object", properties },
  }));
}

export interface MapIo {
  cwd: string;
  enabled: boolean;
  lookalikes?: boolean;
  loadGraph: () => DesignGraph | undefined;
  stdout?: (text: string) => void;
}

export function runMapCall(name: string, args: Record<string, unknown>, io: MapIo): Record<string, unknown> {
  if (!io.enabled) return { warnings: [OFF()], next: OFF().next };
  const graph = io.loadGraph();
  const id = typeof args["id"] === "string" ? args["id"] : "";
  const depth = typeof args["depth"] === "number" ? args["depth"] : undefined;
  const page = typeof args["page"] === "number" ? args["page"] : undefined;
  const offset = typeof args["offset"] === "number" ? args["offset"] : undefined;
  if (name === "map_build") {
    if (!graph) return { warnings: [mapWarning("E-MAP-GRAPH", "No learned graph.")], next: "resolve learn" };
    const doc = buildScreenMap(graph, {
      frameId: typeof args["frame"] === "string" ? args["frame"] : undefined,
      refs: args["refs"] === true,
      lookalikes: io.lookalikes === true,
      ...(typeof args["builtAt"] === "string" ? { builtAt: args["builtAt"] } : {}),
    });
    const written = writeScreenMap(io.cwd, doc);
    const warnings = written.rebuilt ? [mapWarning("W-MAP-REBUILT", "Rebuilt this file version.")] : [];
    return { ok: true, path: written.path, fileKey: doc.fileKey, fileVersion: doc.fileVersion, warnings, next: warnings[0]?.next ?? "resolve map outline" };
  }
  const loaded = loadMap(io.cwd, graph, typeof args["fileKey"] === "string" ? args["fileKey"] : graph?.fileKey, typeof args["builtAt"] === "string" ? args["builtAt"] : undefined, io.lookalikes === true);
  if (!loaded.doc) return { warnings: loaded.warnings, next: loaded.warnings[0]?.next ?? "resolve learn" };
  const doc = loaded.doc;
  const view = name === "map_outline" ? outlineView(doc, { page, offset })
    : name === "map_screen" ? nodeView(doc, id, depth, "screen")
    : name === "map_node" ? nodeView(doc, id, depth, "node")
    : name === "map_journey" ? (graph ? journeyView(doc, graph, id) : { warnings: [mapWarning("E-MAP-GRAPH", "No learned graph.")], next: "resolve learn" })
    : name === "map_drift" ? driftView(doc, typeof args["scope"] === "string" ? args["scope"] : id || undefined)
    : name === "map_expand" ? { view: "expand", master: expandRef(doc, id), warnings: expandRef(doc, id) ? [] : [mapWarning("W-MAP-NODE", `No ref ${id}.`)], next: "resolve map outline", truncated: false as const }
    : { warnings: [mapWarning("W-MAP-NODE", `Unknown map command ${name}.`)], next: "resolve map outline" };
  const warnings = [...loaded.warnings, ...((view as { warnings?: typeof loaded.warnings }).warnings ?? [])];
  return { ...view, warnings, next: warnings[0]?.next ?? (view as { next?: string }).next ?? "resolve map outline" };
}

export function renderMap(value: Record<string, unknown>): string {
  const rows = (value["items"] ?? value["nodes"] ?? value["steps"] ?? value["raw"] ?? []) as Array<Record<string, unknown>>;
  const warnings = (value["warnings"] as Array<{ code: string; message: string }> | undefined) ?? [];
  const lines = rows.map((row) => `${String(row["type"] ?? row["flag"] ?? row["slot"] ?? "step")} ${String(row["name"] ?? row["raw"] ?? "")}`);
  return [...lines, ...warnings.map((warning) => `warning ${warning.code}: ${warning.message}`), `next: ${String(value["next"] ?? "")}`, ""].join("\n");
}

export function runMapCli(argv: string[], io: MapIo): void {
  const words = argv.filter((arg, index) => !arg.startsWith("--") && !argv[index - 1]?.startsWith("--"));
  const take = (flag: string) => {
    const index = argv.indexOf(`--${flag}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const number = (flag: string) => {
    const raw = take(flag);
    return raw !== undefined && raw !== "" ? Number(raw) : undefined;
  };
  const result = runMapCall(`map_${words[0] ?? "outline"}`, {
    id: words[1],
    fileKey: take("file"),
    frame: take("frame"),
    depth: number("depth"),
    page: number("page"),
    offset: number("offset"),
    refs: argv.includes("--refs"),
    scope: words[0] === "drift" ? words[1] : undefined,
    builtAt: take("built-at"),
  }, io);
  const rows = (result["items"] ?? result["nodes"] ?? result["steps"] ?? [result]) as unknown[];
  io.stdout?.(argv.includes("--jsonl")
    ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n${JSON.stringify({ warnings: result["warnings"], next: result["next"] })}\n`
    : argv.includes("--json") ? `${JSON.stringify(result)}\n` : renderMap(result));
}
