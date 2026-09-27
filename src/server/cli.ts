import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DesignGraphSchema, type DesignGraph } from "@/core/model";
import { SourceDocumentSchema } from "@/core/ingestion/types";
import { adaptFigmaRestFile } from "@/core/ingestion/adapters/figmaRest";
import { adaptFigmaMcpMetadata } from "@/core/ingestion/adapters/figmaMcp";
import {
  fetchFigmaRestDocument,
  figmaAccessToken,
} from "@/core/ingestion/adapters/figmaRestSource";
import { isFigmaLiveTarget } from "@/core/ingestion/figmaFileKey";
import { buildGraph } from "@/core/transform";
import {
  buildOrientBrief,
  checkFrame,
  componentUsageCard,
  explainNode,
  listRecipes,
  packForRecommend,
  pathBetween,
  queryQuestion,
  recipeCard,
  checkCousins,
  describeRole,
  parseIngestRole,
  recommendMasters,
  toGraphReportMarkdown,
  verifyFrame,
  WORKSPACE_FILE_ROLES,
  type WorkspaceFileRole,
} from "@/core/query";
import {
  deleteGraph,
  graphPath,
  listGraphs,
  loadContextBind,
  loadRecipes,
  missingGraphMessage,
  readLibraryRules,
  readWorkspace,
  rebuildIndex,
  resolveGraph,
  saveIngestedFile,
  fsIngestCheckpointStore,
  storeInfo,
  workspacePath,
} from "./store";

/**
 * Resolve CLI — ingest each linked file into the workspace
 * (`.graphify/workspace.json` + `.graphify/files/`).
 *
 * Agents call resolve / cousins (usage cards), then Figma. Do not Read graph.json.
 */

/** Same flags `bindFromFlags` reads — keep help + usage errors in lockstep. */
const PACK_BIND_FLAGS =
  "[--pack <id>] [--product <name>] [--journey <step>] [--domain <domain>]";

function usage(): void {
  process.stdout.write(
    [
      "Resolve — Figma rules. Agents resolve.",
      "",
      "  resolve ingest <file.json | file.xml | figma-url | file-key> [--id <graphId>] [--file-key <key>] [--name <fileName>] [--from-metadata] [--scope node|screens|file] [--role library|product|client] [--force-role] [--label <name>]",
      "      Build a graph and add it to the workspace. JSON: plugin export, REST body, MCP capture, or a graph.",
      "      --from-metadata: raw Figma MCP get_metadata XML (no REST token). Same as wrapping { metadataXml }.",
      "      GRAPHIFY_HOME wins for the store folder; else nearest .graphify walking up from cwd. MCP and CLI must share it.",
      "      Live Figma: pass the shared screen/frame/section URL (node-id in the link).",
      "      No node-id → each top-level FRAME/SECTION/COMPONENT/COMPONENT_SET, one request at a time.",
      "      --scope file is one request — safer on a low API tier. Section walks honor Retry-After and resume.",
      "      Token from FIGMA_ACCESS_TOKEN (live URL only). Writes .graphify/files/<key>.json + workspace.json.",
      "      First file defaults to role library; later files default to product. Re-run to refresh.",
      "      Changing --role on a file already in the workspace is refused unless --force-role.",
      "      Agents call resolve / cousins — do not Read graph.json.",
      "",
      `  resolve recipe [list | "<name or intent>"] [--id] [--intent "<brief>"] ${PACK_BIND_FLAGS}`,
      "      Screen packs. Overlay .graphify/recipes.json still wins.",
      "      After ingest, list/get bind slots to live masters (or next recommend query).",
      "      Matching .graphify/context-packs.json scopes slot fills + nextRecommend.",
      "      Never invents node ids. Unbound: recommend then verify_frame.",
      `  resolve recommend "<intent>" [--id] [--budget <chars>] ${PACK_BIND_FLAGS}`,
      "      Ranked masters: name/intent, variant props, where-used, co-occurrence.",
      "      Product/journey/domain context on top. Live over stale. Deprecated demoted. Cap ~2000 chars. Place returned ids only.",
      "  resolve resolve \"<name>\" [--id] [--budget <chars>]",
      "      I know the name, give me the id. Exact master always returns id + fileKey + figmaNodeId, even with zero usage.",
      "      Miss: says so and points at recommend. Not an empty list.",
      `  resolve verify "<frame>" [--id] [--components a,b] [--rules <file>] ${PACK_BIND_FLAGS}`,
      "      After drawing: pass/fail, invents, deprecated, unresolved. Measures invent rate.",
      "      Component list: exact name or id only (fileKey:nodeId ok). Near match = unresolved + did you mean. Private (. / _) fails.",
      "      Optional .graphify/library-rules.json { allow, deny }. Else in-graph + not deprecated = approved.",
      "      Same pack flags as recommend. Pack libraryRules are a light hook. Wrong-cousin drift: resolve cousins.",
      `  resolve cousins ["<frame>"] [--job "<screen job>"] [--components a,b] ${PACK_BIND_FLAGS}`,
      "      Wrong-cousin report: same role / weak name, different master family than the shared DS library.",
      "      Needs a library-role file in .graphify/workspace.json. Unsure → says so. Never invents a master.",
      "  resolve workspace              Linked files + store path / builtAt (same as MCP list_graphs.store)",
      "  resolve orient [--id <graphId>]     Optional god-node summary. Prefer recommend / resolve.",
      "  resolve query \"<question>\" [--id] [--budget <chars>]",
      "      Optional scoped subgraph. Agents should recommend or resolve a component instead.",
      "  resolve path \"<A>\" \"<B>\" [--id]     Shortest relationship path",
      "  resolve explain \"<name>\" [--id]      Bounded markdown brief for one node",
      "  resolve check \"<intent>\" [--id]      Analog variant + deprecated to avoid (prefer recommend)",
      "",
      "  resolve list                 Show the stored graph",
      "  resolve reindex              Confirm graph.json loads",
      "  resolve rm                   Delete graph.json",
      "  resolve where                Print store path, graph.json, and builtAt (same as MCP list_graphs.store)",
      "",
      "  npm run resolve -- <command>     primary",
      "  npm run keyline -- <command>     deprecated alias (one release)",
      "",
    ].join("\n"),
  );
}

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
}

export function looksLikeMetadataXml(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("{") || trimmed.startsWith("[")) return false;
  return /<(frame|component|component-set|componentSet|instance|section|canvas|page)\b/i.test(
    trimmed,
  );
}

function graphFromMetadataXml(xml: string, args: string[]): DesignGraph {
  return buildGraph(
    adaptFigmaMcpMetadata({
      fileKey: flag(args, "file-key") ?? "local-file",
      fileName: flag(args, "name") ?? "Untitled",
      metadataXml: xml,
    }),
  );
}

function toGraph(payload: unknown, args: string[]): DesignGraph {
  const asGraph = DesignGraphSchema.safeParse(payload);
  if (asGraph.success) return asGraph.data;

  const asSource = SourceDocumentSchema.safeParse(payload);
  if (asSource.success) return buildGraph(asSource.data);

  const record = (payload ?? {}) as Record<string, unknown>;
  const fileKey = flag(args, "file-key") ?? (record["fileKey"] as string) ?? "local-file";
  const fileName = flag(args, "name") ?? (record["fileName"] as string) ?? "Untitled";

  if (record["metadataXml"] || record["captures"]) {
    return buildGraph(
      adaptFigmaMcpMetadata({
        fileKey,
        fileName,
        metadataXml: record["metadataXml"] as string | undefined,
        variableDefs: record["variableDefs"] as Record<string, unknown> | undefined,
        captures: record["captures"] as never,
      }),
    );
  }

  if (record["document"]) {
    return buildGraph(
      adaptFigmaRestFile({ fileKey, file: payload, variables: record["variables"] }),
    );
  }

  throw new Error(
    "Unrecognised JSON. Expected a plugin export, a Figma REST file body, an MCP capture, or a graph.",
  );
}

function ingestRole(args: string[]): WorkspaceFileRole | undefined {
  const at = args.indexOf("--role");
  if (at < 0) return undefined;
  const named = args[at + 1];
  if (!named || named.startsWith("--")) {
    throw new Error(`Unknown --role. Valid roles: ${WORKSPACE_FILE_ROLES.join(", ")}.`);
  }
  return parseIngestRole(named);
}

function writeStored(graph: DesignGraph, args: string[], target?: string): void {
  const summary = saveIngestedFile(graph, {
    graphId: flag(args, "id"),
    role: ingestRole(args),
    forceRole: args.includes("--force-role"),
    url: target && /^https?:\/\//.test(target) ? target : flag(args, "url"),
    label: flag(args, "label") ?? flag(args, "name"),
  });
  process.stdout.write(
    [
      `Stored ${summary.graphId}`,
      `  file      ${summary.fileName} (${summary.fileKey})`,
      summary.role ? `  role      ${summary.role} — ${describeRole(summary.role)}` : "",
      `  source    ${summary.sourceKind}`,
      `  graph     ${summary.nodes} nodes, ${summary.edges} edges`,
      summary.warnings ? `  warnings  ${summary.warnings}` : "",
      `  entry     ${summary.entryPoints.map((entry) => entry.name).join(", ") || "(none)"}`,
      `  workspace ${workspacePath()}`,
      `  graph     ${graphPath()}`,
      "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

function ingestScope(args: string[]): "auto" | "node" | "screens" | "file" {
  const named = flag(args, "scope");
  if (named === "node" || named === "screens" || named === "file" || named === "auto") return named;
  if (args.includes("--whole-file")) return "file";
  return "auto";
}

async function ingestLive(target: string, args: string[]): Promise<void> {
  const token = figmaAccessToken();
  if (!token) {
    throw new Error("Set FIGMA_ACCESS_TOKEN to ingest a live Figma file.");
  }
  const document = await fetchFigmaRestDocument(target, {
    token,
    scope: ingestScope(args),
    checkpoint: fsIngestCheckpointStore(),
    onProgress: (info) => {
      if (info.phase === "outline") {
        process.stderr.write(`Outlining ${info.name}\n`);
        return;
      }
      if (info.total <= 1 && info.done === 0) return;
      process.stderr.write(`  ${info.done}/${info.total} ${info.name}\n`);
    },
  });
  writeStored(buildGraph(document), args, target);
}

function requireGraph(args: string[]) {
  const resolved = resolveGraph(flag(args, "id"));
  if (!resolved) {
    throw new Error(missingGraphMessage());
  }
  return resolved;
}

function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function bindFromFlags(args: string[]) {
  return loadContextBind({
    pack: flag(args, "pack"),
    product: flag(args, "product"),
    journey: flag(args, "journey"),
    domain: flag(args, "domain"),
    packsFile: flag(args, "packs"),
  });
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function runCli(argv: string[]): Promise<void> {
  const [command, ...args] = argv;

  switch (command) {
    case "ingest": {
      ingestRole(args);
      const target = args.find((arg) => !arg.startsWith("--"));
      if (!target) throw new Error("Give a JSON file, Figma URL, or file key.");

      const resolved = resolve(target);
      if (existsSync(resolved)) {
        const raw = readFileSync(resolved, "utf8");
        const trimmed = raw.trim();
        const forceXml = args.includes("--from-metadata");
        if (looksLikeMetadataXml(raw) || (forceXml && !trimmed.startsWith("{") && !trimmed.startsWith("["))) {
          writeStored(graphFromMetadataXml(raw, args), args, target);
          return;
        }
        const payload = JSON.parse(raw);
        writeStored(toGraph(payload, args), args, target);
        return;
      }

      if (isFigmaLiveTarget(target)) {
        await ingestLive(target, args);
        return;
      }

      throw new Error(
        `No file at ${target}. Pass a JSON path, a Figma URL, or a file key (with FIGMA_ACCESS_TOKEN).`,
      );
    }

    case "recipe":
    case "recipes": {
      const query = positionals(args)[0];
      const recipes = loadRecipes();
      const bind = bindFromFlags(args);
      if (!query || query === "list") {
        printJson(listRecipes(recipes, resolveGraph(flag(args, "id"))?.index, bind));
        return;
      }
      printJson(
        recipeCard(recipes, query, resolveGraph(flag(args, "id"))?.index, flag(args, "intent"), bind),
      );
      return;
    }

    case "recommend": {
      const intent = positionals(args)[0];
      if (!intent) throw new Error('Usage: resolve recommend "<intent>"');
      const budget = Number(flag(args, "budget"));
      const bind = bindFromFlags(args);
      printJson(
        recommendMasters(requireGraph(args).index, intent, {
          budgetChars: Number.isFinite(budget) && budget > 0 ? budget : undefined,
          context: packForRecommend(bind),
          workspace: bind.workspace,
        }),
      );
      return;
    }

    case "resolve": {
      const name = positionals(args)[0];
      if (!name) throw new Error('Usage: resolve resolve "<name>"');
      const budget = Number(flag(args, "budget"));
      printJson(
        componentUsageCard(requireGraph(args).index, name, {
          budgetChars: Number.isFinite(budget) && budget > 0 ? budget : undefined,
        }),
      );
      return;
    }

    case "orient": {
      const { index, graphId } = requireGraph(args);
      const brief = buildOrientBrief(index);
      process.stdout.write(`# ${graphId}\n\n${toGraphReportMarkdown(brief)}`);
      return;
    }

    case "query": {
      const question = positionals(args)[0];
      if (!question) throw new Error('Usage: resolve query "<question>"');
      const budget = Number(flag(args, "budget"));
      const { index } = requireGraph(args);
      printJson(
        queryQuestion(index, question, {
          budgetChars: Number.isFinite(budget) && budget > 0 ? budget : undefined,
        }),
      );
      return;
    }

    case "path": {
      const names = positionals(args);
      const from = names[0];
      const to = names[1];
      if (!from || !to) throw new Error('Usage: resolve path "<A>" "<B>"');
      printJson(pathBetween(requireGraph(args).index, from, to));
      return;
    }

    case "explain": {
      const name = positionals(args)[0];
      if (!name) throw new Error('Usage: resolve explain "<name>"');
      printJson(explainNode(requireGraph(args).index, name));
      return;
    }

    case "check": {
      const intent = positionals(args)[0];
      if (!intent) throw new Error('Usage: resolve check "<intent>"');
      printJson(checkFrame(requireGraph(args).index, intent));
      return;
    }

    case "cousins":
    case "cousin": {
      const frame = positionals(args)[0];
      const componentsRaw = flag(args, "components");
      const components = componentsRaw
        ? componentsRaw
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
        : undefined;
      if (!frame && !components?.length && !flag(args, "job")) {
        throw new Error(
          `Usage: resolve cousins "<frame>" [--job "<screen job>"] [--components a,b] ${PACK_BIND_FLAGS}`,
        );
      }
      const bind = bindFromFlags(args);
      printJson(
        checkCousins(resolveGraph(flag(args, "id"))?.index, {
          frame,
          components,
          job: flag(args, "job"),
          recipes: loadRecipes(),
          context: packForRecommend(bind),
          workspace: bind.workspace ?? readWorkspace(),
        }),
      );
      return;
    }

    case "workspace": {
      const workspace = readWorkspace();
      if (!workspace.files.length) {
        process.stdout.write(
          "No workspace files yet. Ingest the shared DS with --role library, then product/client files. Or copy src/data/workspace.example.json to .graphify/workspace.json.\n",
        );
        return;
      }
      printJson({
        store: storeInfo(),
        workspace: workspace.files.map((file) => ({
          role: file.role,
          key: file.key,
          label: file.label,
          url: file.url,
        })),
        hint: "Ingest each linked file. Cards stamp fileKey + figmaNodeId. Then recipe → recommend → place those ids → verify. Run cousins on a product frame to catch wrong-cousin drift. Do not Read graph.json.",
      });
      return;
    }

    case "verify": {
      const frame = positionals(args)[0];
      const componentsRaw = flag(args, "components");
      const components = componentsRaw
        ? componentsRaw
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
        : undefined;
      if (!frame && !components?.length) {
        throw new Error(
          `Usage: resolve verify "<frame>" [--components a,b] [--rules file] ${PACK_BIND_FLAGS}`,
        );
      }
      const rulesPath = flag(args, "rules");
      printJson(
        verifyFrame(requireGraph(args).index, {
          frame,
          components,
          rules: readLibraryRules(rulesPath),
          context: packForRecommend(bindFromFlags(args)),
        }),
      );
      return;
    }

    case "list": {
      const graphs = listGraphs();
      if (!graphs.length) {
        process.stdout.write(`${missingGraphMessage()}\n`);
        return;
      }
      for (const entry of graphs) {
        process.stdout.write(
          `${entry.graphId}\n  ${entry.fileName} · ${entry.role ?? "file"} · ${entry.nodes} nodes · ${entry.edges} edges · ${entry.sourceKind}\n`,
        );
      }
      return;
    }

    case "rm": {
      process.stdout.write(deleteGraph() ? `Deleted ${graphPath()}\n` : "No graph.json stored.\n");
      return;
    }

    case "reindex": {
      const index = rebuildIndex();
      process.stdout.write(
        index.graphs.length ? `Loaded ${graphPath()}\n` : "No graph.json stored.\n",
      );
      return;
    }

    case "where":
      printJson(storeInfo());
      return;

    default:
      usage();
  }
}

if (!process.env["VITEST"]) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
