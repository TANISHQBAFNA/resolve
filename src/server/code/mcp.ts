import { isAbsolute, resolve } from "node:path";
import type { ResolveConfig } from "../mode.ts";
import { readConfig } from "../mode.ts";
import { resolveGraph } from "../store";
import type { ToolDefinition } from "../tools";
import { runCodeMapTool } from "../codeMapMcp";
import { checkHtml } from "./check.ts";
import { attachImportReport, linkFigma, mapReport } from "./map.ts";
import { pickComponents } from "./pick.ts";
import type { FigmaMaster } from "./scan.ts";
import { catalogPath, loadCatalog, rescan, saveCatalog, summarize } from "./scan.ts";

export const CODE_TOOL_NAMES = ["code_scan", "code_pick", "code_check", "code_map"] as const;

export const CODE_TOOLS: ToolDefinition[] = [
  {
    name: "code_scan",
    description:
      "Learn the coded design system in the repo: component classes, variants, tokens, deprecated classes, real markup. Reads CSS and HTML under repoPath (config or RESOLVE_REPO_PATH). Saves .resolve/code-catalog.json. Read-only on the repo. Re-run after the design system changes. list:true also returns the component list.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string", description: "Repo or folder with the design system CSS. Default: config repoPath." },
        cssEntry: { type: "string", description: "Entry stylesheet inside repoPath, e.g. acme-ds/css/acme.css. Default: config cssEntry, else every CSS file." },
        theme: { type: "string", description: "Theme token file inside repoPath (e.g. theme/tokens.css) or a data-theme name." },
        figma: {
          type: "array",
          description: "Figma components to join with the coded ones (by name, alias or .resolve/mapping.json): [{ name, nodeId?, fileKey?, variants?, aliases? }]. Optional; both mode reads them from the learned library.",
          items: { type: "object", properties: { name: { type: "string" }, nodeId: { type: "string" }, fileKey: { type: "string" }, variants: { type: "array", items: { type: "string" } }, aliases: { type: "array", items: { type: "string" } } }, required: ["name"] },
        },
        list: { type: "boolean", description: "Also return every component with its variants." },
      },
    },
  },
  {
    name: "code_pick",
    description:
      'Pick coded components for a screen need, e.g. "transaction table with pagination". Returns real classes, variants, markup, CSS file, rules and deprecated classes to avoid. Never invent a class that is not returned. Scans the repo first if no catalog is saved.',
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What the screen needs, in plain words or a component name." },
        limit: { type: "number", description: "Max components, 1-12. Default 5." },
      },
      required: ["query"],
    },
  },
  {
    name: "code_check",
    description:
      "Check a finished HTML screen against the coded design system. Flags unknown and deprecated classes, modifiers without their base class, literal colours and fonts, unknown tokens, and a missing design-system or theme stylesheet. Run before finishing any HTML screen. Pass the file path (absolute or relative to the current folder).",
    inputSchema: { type: "object", properties: { file: { type: "string", description: "HTML file to check." } }, required: ["file"] },
  },
  {
    name: "code_map",
    description:
      'One map tool. Default (action links): how Figma components and coded components join, plus the import map when a library is learned. Pairs carry a confidence: mapped (named in .resolve/mapping.json), exact (same name plus a specific shared variant, modifier, or description; a generic state does not count). Also lists Figma and coded components with no match. suggest:true adds likely pairs ("suggested"), including a same name with no evidence. A suggested pair is not a link. action scan, suggest, or review reads a component package and confirms import pairs (the same work as the older code_map_scan, code_map_suggest, and code_map_review names, which still run and say to use code_map).',
    inputSchema: {
      type: "object",
      properties: {
        suggest: { type: "boolean", description: "Also propose likely pairs for the Figma components with no match." },
        limit: { type: "number", description: "Suggestions per Figma component, 1-5. Default 3." },
        action: { type: "string", enum: ["links", "scan", "suggest", "review"], description: "links (default) is the join report. scan, suggest, and review read a component package." },
        package: { type: "string", description: "Package path or name for action scan or suggest." },
        write: { type: "boolean", description: "With action suggest, save suggestions into code-map.json. Confirmed rows stay. Nothing is marked mapped." },
        csv: { type: "string", description: "With action review, CSV text or a path to a .csv file. Omit to return the review sheet." },
        replace: { type: "boolean", description: "With action review, drop entries the CSV has no row for. Default keeps them." },
      },
    },
  },
];

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/** Config plus per-call overrides. A relative repoPath resolves from the current folder. */
export function codeConfig(args: Record<string, unknown> = {}, base: ResolveConfig = readConfig()): ResolveConfig {
  const repo = text(args["repoPath"]);
  const cssEntry = text(args["cssEntry"]);
  const theme = text(args["theme"]);
  return {
    ...base,
    ...(repo ? { repoPath: isAbsolute(repo) ? repo : resolve(repo) } : {}),
    ...(cssEntry ? { cssEntry } : {}),
    ...(theme ? { theme } : {}),
  };
}

function masters(value: unknown): FigmaMaster[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = (item ?? {}) as Record<string, unknown>;
    const name = text(row["name"]);
    const nodeId = text(row["nodeId"]);
    const fileKey = text(row["fileKey"]);
    const list = (key: string) => (Array.isArray(row[key]) ? (row[key] as unknown[]).flatMap((v) => (typeof v === "string" && v.trim() ? [v.trim()] : [])) : []);
    const variants = list("variants");
    const aliases = list("aliases");
    return name ? [{ name, ...(nodeId ? { nodeId } : {}), ...(fileKey ? { fileKey } : {}), ...(variants.length ? { variants } : {}), ...(aliases.length ? { aliases } : {}) }] : [];
  });
}

export function scanTool(cfg: ResolveConfig, args: Record<string, unknown> = {}, graphMasters?: () => FigmaMaster[]) {
  const catalog = rescan(needRepo(cfg));
  const given = masters(args["figma"]);
  const source = given.length ? given : (graphMasters?.() ?? []);
  const link = source.length ? linkFigma(catalog, cfg, source) : undefined;
  if (link) saveCatalog(cfg, catalog);
  return {
    ...summarize(catalog),
    saved: catalogPath(cfg),
    ...(link ? { figmaLinked: link.linked, matchedBy: link.byKind, figmaOnly: link.figmaOnly.slice(0, 20), ...(link.problems.length ? { mappingProblems: link.problems } : {}) } : {}),
    ...(args["list"] === true ? { list: catalog.components.map((c) => ({ name: c.name, kind: c.kind, variants: c.variants.length, description: c.description })) } : {}),
    next: 'Call code_pick "<what the screen needs>", build with the classes returned, then code_check on the HTML file.',
  };
}

export function mapTool(cfg: ResolveConfig, args: { suggest?: boolean; limit?: number } = {}, graphMasters?: () => FigmaMaster[]) {
  const catalog = loadCatalog(needRepo(cfg));
  const fresh = graphMasters?.() ?? [];
  if (fresh.length) {
    linkFigma(catalog, cfg, fresh);
    saveCatalog(cfg, catalog);
  }
  return mapReport(catalog, cfg, args);
}

export function pickTool(cfg: ResolveConfig, query: string, limit = 5) {
  if (!query.trim()) throw new Error("`query` is required.");
  return pickComponents(loadCatalog(needRepo(cfg)), query, limit);
}

export function checkTool(cfg: ResolveConfig, file: string) {
  if (!file.trim()) throw new Error("`file` is required.");
  return checkHtml(loadCatalog(needRepo(cfg)), cfg, file);
}

function needRepo(cfg: ResolveConfig): ResolveConfig {
  if (!cfg.repoPath) throw new Error("No repo set. Add repoPath to .resolve/config.json, set RESOLVE_REPO_PATH, or run `resolve code scan --repo <folder>`.");
  return cfg;
}

/** MCP entry. `graphMasters` supplies Figma masters from the learned graph when both workflows are active. Throws plain Errors. */
export function runCodeTool(name: string, args: Record<string, unknown>, graphMasters?: () => FigmaMaster[]) {
  const cfg = codeConfig(args);
  if (name === "code_scan") return scanTool(cfg, args, graphMasters);
  if (name === "code_pick") return pickTool(cfg, text(args["query"]) ?? "", typeof args["limit"] === "number" ? args["limit"] : 5);
  if (name === "code_map") {
    const action = typeof args["action"] === "string" ? args["action"] : "links";
    if (action === "scan") return runCodeMapTool("code_map_scan", args);
    if (action === "suggest") {
      const index = resolveGraph()?.index;
      if (!index) throw new Error("code_map suggest needs a learned library.");
      return runCodeMapTool("code_map_suggest", args, index);
    }
    if (action === "review") return runCodeMapTool("code_map_review", args, resolveGraph()?.index);
    if (action !== "links") throw new Error("action must be links, scan, suggest, or review.");
    return attachImportReport(mapTool(cfg, { suggest: args["suggest"] === true, limit: Math.min(5, Math.max(1, Number(args["limit"]) || 3)) }, graphMasters));
  }
  if (name === "code_check") return checkTool(cfg, text(args["file"]) ?? "");
  throw new Error(`Unknown code tool \`${name}\`.`);
}
