import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
  applySociDecision,
  buildOrientBrief,
  checkFrame,
  componentUsageCard,
  explainNode,
  listRecipes,
  listSoci,
  mergeBindRules,
  packForRecommend,
  pathBetween,
  queryQuestion,
  recipeCard,
  checkCousins,
  describeRole,
  parseIngestRole,
  recommendMasters,
  exampleCard,
  iconLibraryWarnings,
  indexGraph,
  toGraphReportMarkdown,
  verifyFrame,
  WORKSPACE_FILE_ROLES,
  type WorkspaceFileRole,
  codeMapCard,
  formatCodeMapReport,
} from "@/core/query";
import {
  deltaAgainst,
  formatScoreTable,
  hashGoldenSet,
  initGoldenCases,
  loadGoldenCases,
  scoreExitCode,
  scoreGraph,
} from "@/core/query/scoreboard";
import {
  commitProposalDecision,
  clearCache,
  deleteGraph,
  graphPath,
  listGraphs,
  loadContextBind,
  loadGraph,
  loadRecipes,
  missingGraphMessage,
  readBindRules,
  readLibraryRules,
  readPlaceholders,
  readRecipeOverlay,
  readSock,
  readWorkspace,
  rebuildIndex,
  resolveGraph,
  saveIngestedFile,
  fsIngestCheckpointStore,
  storeInfo,
  storeRoot,
  workspacePath,
} from "./store";
import { learnLibrary } from "./learn";
import {
  previousScore,
  scoreboardHistoryDir,
  scoreboardWorkspaceName,
  writeScoreHistory,
} from "./scoreboardView";

/**
 * Resolve CLI — ingest each linked file into the workspace
 * (`.resolve/workspace.json` + `.resolve/files/`).
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
      "      Build a graph and add it to the workspace. JSON: REST body, MCP capture, or a graph.",
      "      --from-metadata: raw Figma MCP get_metadata XML (no REST token). Same as wrapping { metadataXml }.",
      "      RESOLVE_HOME wins for the store folder; else nearest .resolve walking up from cwd. MCP and CLI must share it.",
      "      Live Figma: pass the shared screen/frame/section URL (node-id in the link).",
      "      No node-id → each top-level FRAME/SECTION/COMPONENT/COMPONENT_SET, one request at a time.",
      "      --scope file is one request — safer on a low API tier. Section walks honor Retry-After and resume.",
      "      Token from FIGMA_ACCESS_TOKEN (live URL only). Writes .resolve/files/<key>.json + workspace.json.",
      "      First file defaults to role library; later files default to product. Re-run to refresh.",
      "      Changing --role on a file already in the workspace is refused unless --force-role.",
      "      Agents call resolve / cousins — do not Read graph.json.",
      "",
      "  resolve learn --file-key <key> [--role library|product|client] [--from-metadata <file.xml>] [--design-context <file>] [--name <fileName>]",
      "      Same as MCP learn_library. Figma get_metadata XML. Pass design context so master default text is stored. No REST token. Resumable.",
      "",
      `  resolve recipe [list | "<name or intent>"] [--id] [--intent "<brief>"] ${PACK_BIND_FLAGS}`,
      "      Screen packs. Overlay .resolve/recipes.json still wins.",
      "      After ingest, list/get bind slots to live masters (or next recommend query).",
      "      Matching .resolve/context-packs.json scopes slot fills + nextRecommend.",
      "      Never invents node ids. Unbound: recommend then verify_frame.",
      `  resolve recommend "<intent>" [--id] [--budget <chars>] ${PACK_BIND_FLAGS} [--screen-type <kind>]`,
      "      Ranked masters: name/intent first (exact, token, synonym). Context and usage break ties.",
      "      Context cannot pull in a name-irrelevant master. Deprecated names return the live replacement.",
      "      Top hit is place-ready and carries ex. Hits 2–3 are name, id, and a short reason. Cap 600 chars.",
      "      ex is a real instance node id, fileKey:nodeId when the example file differs, or none plus a short reason.",
      "      Call resolve example for the full config and for hits 2–3. Clone ex; do not start from the default.",
      "      Why line: SOCK facts, 'used N× in file', or 'not verified on a screen yet'.",
      `  resolve example "<name>" [--id] ${PACK_BIND_FLAGS}`,
      "      Full config for ex: file key, node id, screen, variant, structure, sizing.",
      "      Clone this instance and replace content; do not start from the default variant.",
      `  resolve resolve "<name>" [--id] [--budget <chars>] ${PACK_BIND_FLAGS} [--screen-type <kind>]`,
      "      I know the name, give me the id. Exact master always returns id + fileKey + figmaNodeId, even with zero usage.",
      "      Optional screen type / journey / domain, same as recommend, breaks ties between cousins.",
      "      Deprecated names come back flagged, with the live replacement. Private (_ / .) names only on an exact match.",
      "      One-line why from SOCK facts. Miss: says so and points at recommend. Not an empty list.",
      `  resolve verify "<frame>" [--id] [--components a,b] [--rules <file>] [--design-context <file>] [--texts <json>] ${PACK_BIND_FLAGS}`,
      "      After drawing: pass/fail, invents, deprecated, unresolved, bind-rule misses.",
      "      Before verify, fetch the frame's design context so Resolve can read the text. Pass that file as --design-context.",
      "      --texts fills empty layers in the frame only (JSON). It does not replace stored copy.",
      "      Component list: exact name or id only (fileKey:nodeId ok). Near match = unresolved + did you mean. Private (. / _) fails.",
      "      Bind rules: .resolve/bind-rules.json (require / forbid / prefer). A miss names the rule and the correct master id.",
      "      Optional .resolve/library-rules.json { allow, deny }. Else in-graph + not deprecated = approved.",
      "      Same pack flags as recommend. Wrong-cousin drift: resolve cousins.",
      "  resolve code-map [--json | --retired]   Report on .resolve/code-map.json: Figma component -> code component",
      "      Counts mapped / retired / unmapped / ambiguous / conflict / stale / ignored. Keyed by file key + id; a name works only when unique.",
      "      status retired keeps a part mapped but never recommends it. --retired lists every retired part with its code and replacement. No map: one-line hint.",
      "  resolve rules                  List human-authored bind rules",
      "  resolve soci                   List pending SOCI proposals (never auto-applied)",
      "  resolve approve <proposal-id> --who <name>   Approve: bind-rules, recipe overlay, or a recorded decision",
      "  resolve reject <proposal-id> --who <name>    Reject + audit line. SOCI never auto-applies.",
      `  resolve cousins ["<frame>"] [--file-key <key>] [--job "<screen job>"] [--components a,b] ${PACK_BIND_FLAGS}`,
      "      Wrong-cousin report: same role / weak name, different master family than the shared DS library.",
      "      Needs a library-role file in .resolve/workspace.json. Unsure → says so. Never invents a master.",
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
      "  resolve rm --yes             Delete the learned graph and the workspace file list",
      "  resolve score [--golden <path>] [--workspace <name>] [--json]",
      "  resolve score --init [--out <file>]   Write a starter golden set from the learned library",
      "      Accuracy of recommend / resolve / recipe / verify against a golden set.",
      "      Expected masters are names, resolved to ids in the current graph. Never invents an id.",
      "      --init skips names that still have two populated masters and prints them.",
      "      Default --out is RESOLVE_HOME/scoreboard/golden/from-library.json (the store folder), never the Resolve checkout.",
      "      Prints a short table. Exits non-zero when invent rate is above 0 or a card exceeds its budget.",
      "      Saves the run to RESOLVE_HOME/scoreboard when set, else ~/.resolve/<workspace>/scoreboard.",
      "      Default golden path: scoreboard/golden. Default workspace name: default (or RESOLVE_WORKSPACE).",
      "  resolve where                Print store path, graph.json, and builtAt (same as MCP list_graphs.store)",
      "",
      "  npm run resolve -- <command>     primary",
      "  npm run keyline -- <command>     deprecated alias (one release)",
      "",
    ].join("\n"),
  );
}

function readDesignContextFile(path: string): string {
  if (!existsSync(path)) {
    throw new Error(
      `Design context file not found: ${path}. Pass the path to the frame's get_design_context output.`,
    );
  }
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read design context file ${path}. ${detail}`);
  }
}

function parseTextsFlag(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`--texts must be JSON, for example '{"1:3":"Pay now"}'.`);
  }
}

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
}

export function looksLikeMetadataXml(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("{") || trimmed.startsWith("[")) return false;
  return /<(frame|component|component-set|component_set|componentSet|symbol|instance|section|canvas|page)\b/i.test(
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
    "Unrecognised JSON. Expected a Figma REST file body, an MCP capture, or a graph.",
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
      ...iconLibraryWarnings(indexGraph(graph)).map((line) => `  ${line}`),
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
          if (!flag(args, "file-key")) {
            throw new Error("XML ingest needs --file-key <key>. The file key is the id in the Figma URL.");
          }
          try {
            writeStored(graphFromMetadataXml(raw, args), args, target);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (/json|unexpected|parse|xml/i.test(message)) {
              throw new Error("This file is not valid XML. Expected Figma get_metadata output.");
            }
            throw error;
          }
          return;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(raw) as unknown;
        } catch {
          throw new Error("This file is not valid JSON. Expected a Figma file export or a graph.");
        }
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

    case "learn": {
      const target = args.find((arg) => !arg.startsWith("--"));
      const xmlPath = flag(args, "from-metadata") ?? target;
      const fileKey = flag(args, "file-key");
      if (!fileKey) throw new Error("Usage: resolve learn --file-key <key> [--from-metadata <file.xml>] [--role library]");
      const designContextPath = flag(args, "design-context");
      let metadataXml: string | undefined;
      if (xmlPath) {
        const resolved = resolve(xmlPath);
        if (!existsSync(resolved)) throw new Error(`No file at ${xmlPath}.`);
        metadataXml = readFileSync(resolved, "utf8");
      }
      printJson(
        learnLibrary({
          fileKey,
          role: ingestRole(args),
          fileName: flag(args, "name"),
          label: flag(args, "label") ?? flag(args, "name"),
          metadataXml,
          ...(designContextPath ? { designContext: readDesignContextFile(designContextPath) } : {}),
          lastModified: flag(args, "last-modified"),
          version: flag(args, "version"),
          resume: args.includes("--resume"),
        }),
      );
      return;
    }

    case "recipe":
    case "recipes": {
      const query = positionals(args)[0];
      const recipes = loadRecipes();
      const bind = bindFromFlags(args);
      const sock = readSock();
      const bindRules = readBindRules();
      if (!query || query === "list") {
        printJson(
          listRecipes(recipes, resolveGraph(flag(args, "id"))?.index, bind, sock, bindRules, readPlaceholders()),
        );
        return;
      }
      printJson(
        recipeCard(
          recipes,
          query,
          resolveGraph(flag(args, "id"))?.index,
          flag(args, "intent"),
          bind,
          sock,
          bindRules,
          readPlaceholders(),
        ),
      );
      return;
    }

    case "example": {
      const name = positionals(args)[0];
      if (!name) throw new Error('Usage: resolve example "<name>"');
      const bind = bindFromFlags(args);
      const pack = packForRecommend(bind);
      const screenType = flag(args, "screen-type");
      const context = pack || screenType
        ? { ...(pack ?? {}), ...(screenType ? { screenType, id: pack?.id ?? screenType } : {}) }
        : undefined;
      printJson(
        exampleCard(requireGraph(args).index, name, {
          ...(context ? { context } : {}),
          workspace: bind.workspace,
          sock: readSock(),
          placeholders: readPlaceholders(),
        }),
      );
      return;
    }

    case "recommend": {
      const intent = positionals(args)[0];
      if (!intent) throw new Error('Usage: resolve recommend "<intent>"');
      const budget = Number(flag(args, "budget"));
      const bind = bindFromFlags(args);
      const pack = packForRecommend(bind);
      const screenType = flag(args, "screen-type");
      const context = pack || screenType
        ? { ...(pack ?? {}), ...(screenType ? { screenType, id: pack?.id ?? screenType } : {}) }
        : undefined;
      printJson(
        recommendMasters(requireGraph(args).index, intent, {
          budgetChars: Number.isFinite(budget) && budget > 0 ? budget : undefined,
          ...(context ? { context } : {}),
          workspace: bind.workspace,
          sock: readSock(),
          bindRules: mergeBindRules(readBindRules(), pack?.bindRules),
          placeholders: readPlaceholders(),
        }),
      );
      return;
    }

    case "resolve": {
      const name = positionals(args)[0];
      if (!name) throw new Error('Usage: resolve resolve "<name>"');
      const budget = Number(flag(args, "budget"));
      const bind = bindFromFlags(args);
      const pack = packForRecommend(bind);
      const screenType = flag(args, "screen-type");
      printJson(
        componentUsageCard(requireGraph(args).index, name, {
          budgetChars: Number.isFinite(budget) && budget > 0 ? budget : undefined,
          sock: readSock(),
          placeholders: readPlaceholders(),
          workspace: bind.workspace ?? readWorkspace(),
          ...((pack || screenType)
            ? { context: { ...(pack ?? {}), ...(screenType ? { screenType, id: pack?.id ?? screenType } : {}) } }
            : {}),
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
      const fileKey = flag(args, "file-key");
      if (!frame && !components?.length && !flag(args, "job") && !fileKey) {
        throw new Error(
          `Usage: resolve cousins "<frame>" [--file-key <key>] [--job "<screen job>"] [--components a,b] ${PACK_BIND_FLAGS}`,
        );
      }
      const bind = bindFromFlags(args);
      printJson(
        checkCousins(resolveGraph(flag(args, "id"))?.index, {
          frame,
          fileKey,
          components,
          job: flag(args, "job"),
          recipes: loadRecipes(),
          context: packForRecommend(bind),
          workspace: bind.workspace ?? readWorkspace(),
        }),
      );
      return;
    }

    case "code-map": {
      const report = codeMapCard(() => requireGraph(args).index);
      if (args.includes("--json")) printJson(report);
      else process.stdout.write(`${formatCodeMapReport(report, args.includes("--retired"))}\n`);
      return;
    }

    case "workspace": {
      const workspace = readWorkspace();
      if (!workspace.files.length) {
        process.stdout.write(
          "No workspace files yet. Ingest the shared DS with --role library, then product/client files. Or copy src/data/workspace.example.json to .resolve/workspace.json.\n",
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
      const designContextPath = flag(args, "design-context");
      const textsRaw = flag(args, "texts");
      const designContext = designContextPath ? readDesignContextFile(designContextPath) : undefined;
      const texts = textsRaw ? parseTextsFlag(textsRaw) : undefined;
      const bind = bindFromFlags(args);
      const pack = packForRecommend(bind);
      const verified = verifyFrame(requireGraph(args).index, {
        frame,
        components,
        rules: readLibraryRules(rulesPath),
        context: pack,
        bindRules: mergeBindRules(readBindRules(), pack?.bindRules),
        sock: readSock(),
        workspace: bind.workspace ?? readWorkspace(),
        placeholders: readPlaceholders(),
        ...(designContext !== undefined ? { designContext } : {}),
        ...(texts !== undefined ? { texts } : {}),
      });
      printJson(verified);
      if (verified.pass === false) process.exitCode = 1;
      return;
    }

    case "rules": {
      const bindRules = readBindRules();
      printJson({
        rules: bindRules.rules,
        ...(bindRules.warnings?.length ? { warnings: bindRules.warnings } : {}),
        hint: "Human-authored. Copy src/data/bind-rules.example.json to bind-rules.json in the active store (resolve where). Approve SOCI proposals with resolve approve <id> --who <name>.",
      });
      return;
    }

    case "soci":
      printJson({
        proposals: listSoci(readSock()),
        hint: "SOCI never auto-applies. resolve approve <id> --who <name> writes bind-rules or a recipe overlay, or records a design-team decision. resolve reject <id> keeps files as-is.",
      });
      return;

    case "approve":
    case "reject": {
      const proposalId = positionals(args)[0];
      const who = flag(args, "who")?.trim();
      if (!proposalId || !who) {
        throw new Error(`Usage: resolve ${command} <proposal-id> --who <name>`);
      }
      const action = command === "approve" ? "approve" : "reject";
      const loaded = loadGraph();
      const decided = applySociDecision(
        readSock(),
        readBindRules(),
        proposalId,
        action,
        who,
        new Date().toISOString(),
        {
          index: loaded?.index,
          workspace: readWorkspace(),
          recipes: loadRecipes(),
          overlay: readRecipeOverlay(),
        },
      );
      commitProposalDecision(decided);
      printJson({
        ok: true,
        action,
        proposalId,
        who: decided.audit.who,
        when: decided.audit.when,
        rules: decided.rules.rules,
        ...(decided.writesRecipes ? { recipesWritten: true } : {}),
      });
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
      if (args.includes("--help") || args.includes("-h")) {
        process.stdout.write(
          "Usage: resolve rm --yes\nDeletes the learned graph and the workspace file list. Recipes and bind rules stay.\n",
        );
        return;
      }
      if (!args.includes("--yes")) {
        throw new Error("This deletes the learned library. Re-run with --yes to confirm. resolve rm --help explains it.");
      }
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

    case "score": {
      const namedWorkspace = flag(args, "workspace");
      if (namedWorkspace) process.env["RESOLVE_WORKSPACE"] = scoreboardWorkspaceName({ RESOLVE_WORKSPACE: namedWorkspace });
      clearCache();
      if (args.includes("--init")) {
        const loaded = resolveGraph(flag(args, "id"));
        if (!loaded) throw new Error(missingGraphMessage());
        const out = flag(args, "out") ?? join(storeRoot(), "scoreboard", "golden", "from-library.json");
        const skipped: string[] = [];
        const cases = initGoldenCases(loaded.index, skipped);
        const body = `${JSON.stringify({ version: 1, cases }, null, 2)}\n`;
        try {
          mkdirSync(dirname(out), { recursive: true });
          writeFileSync(out, body);
        } catch (error) {
          const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
          if (code === "ENOENT" || code === "EEXIST" || code === "ENOTDIR" || code === "EISDIR" || code === "EACCES" || code === "EPERM" || code === "EROFS") {
            throw new Error(`Could not write ${out}. Create that folder, or pass --out <file>.`);
          }
          throw error;
        }
        if (skipped.length) process.stdout.write(`Skipped ambiguous names: ${skipped.join(", ")}\n`);
        process.stdout.write(`Wrote ${cases.length} cases to ${out}\n`);
        return;
      }
      const goldenPath = flag(args, "golden") ?? resolve("scoreboard/golden");
      if (!existsSync(goldenPath)) {
        throw new Error(`No golden set at ${goldenPath}. Pass --golden <path>.`);
      }
      const loaded = resolveGraph(flag(args, "id"));
      if (!loaded) throw new Error(missingGraphMessage());
      const cases = loadGoldenCases(goldenPath);
      const workspaceName = scoreboardWorkspaceName();
      const historyDir = scoreboardHistoryDir(workspaceName);
      const goldenHash = hashGoldenSet(goldenPath);
      const previous = previousScore(historyDir, { goldenHash, workspace: workspaceName });
      const report = scoreGraph(loaded.index, cases, {
        recipes: loadRecipes(),
        sock: readSock(),
        bindRules: readBindRules(),
        workspace: readWorkspace(),
        workspaceName,
        golden: goldenPath,
        storePath: storeInfo().path,
      });
      const delta = deltaAgainst(report, previous);
      if (args.includes("--json")) printJson({ ...report, delta });
      else process.stdout.write(`${formatScoreTable(report, delta)}\n`);
      writeScoreHistory(historyDir, report);
      if (scoreExitCode(report) !== 0) process.exitCode = 1;
      return;
    }

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
