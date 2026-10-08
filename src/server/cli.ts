import { accessSync, constants as fsConstants, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
import { overlayFile } from "@/core/query/overlayFile";
import {
  applySociDecision,
  buildOrientBrief,
  checkFrame,
  componentUsageCard,
  explainNode,
  listRecipes,
  listSoci,
  mergeBindRules,
  appliedContext,
  packForRecommend,
  pathBetween,
  queryQuestion,
  recipeCard,
  checkCousins,
  describeRole,
  parseIngestRole,
  recommendMasters,
  screenAskCard,
  exampleCard,
  iconLibraryWarnings,
  indexGraph,
  toGraphReportMarkdown,
  verifyFrame,
  WORKSPACE_FILE_ROLES,
  type WorkspaceFileRole,
  codeMapCard,
  codeMapFromCsv,
  entryLabel,
  formatHandoffIndex,
  formatHandoffIngredients,
  formatHandoffRefusal,
  formatHandoffScreen,
  handoffSheet,
  screenSlug,
  mergeCodeMap,
  codeMapRows,
  codeMapTemplate,
  formatCodeMapReport,
  checkComponentFiles,
  packValidation,
  formatIngredientCard,
  formatIngredientCoverage,
  ingredientCard,
  ingredientCoverage,
  screenPartsCard,
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
import { formatPhraseTable, isSampleLibrary, loadPhraseCases, phraseExitCode, scorePhrases } from "@/core/query/phraseScore";
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
  readApprovedDecisions,
  readWorkspace,
  contextPacksPath,
  rebuildIndex,
  resolveGraph,
  saveIngestedFile,
  fsIngestCheckpointStore,
  storeInfo,
  storeRoot,
  workspacePath,
} from "./store";
import { stripFiller } from "./cards";
import { formatGaps, readGaps, recordGap } from "./gaps";
import { recordVerifyUsage } from "./tools";
import { learnLibrary } from "./learn";
import { DESIGNER, designerFailure } from "./designerMessages";
import { formatStatus, statusReport } from "./status";
import { warnDeprecated } from "./deprecations";
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
  "[--pack <id>] [--product <name>] [--journey <step>] [--domain <domain>] [--audience <who>] [--a11y <bar>]";

function usage(): void {
  process.stdout.write(
    [
      "Resolve — Figma rules. Agents resolve.",
      "JSON commands print one compact line. --pretty prints indented JSON. Exit codes stay the same.",
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
      `  resolve verify "<frame>" [--id] [--components a,b] [--rules <file>] [--design-context <file>] [--texts <json>] [--slot <role>] ${PACK_BIND_FLAGS}`,
      "      After drawing: pass/fail, invents, deprecated, unresolved, bind-rule misses.",
      "      Before verify, fetch the frame's design context so Resolve can read the text. Pass that file as --design-context.",
      "      --texts fills empty layers in the frame only (JSON). It does not replace stored copy.",
      "      Component list: exact name or id only (fileKey:nodeId ok). Near match = unresolved + did you mean. Private (. / _) fails.",
      "      Bind rules: .resolve/bind-rules.json (require / forbid / prefer). A miss names the rule and the correct master id.",
      "      Optional .resolve/library-rules.json { allow, deny }. Else in-graph + not deprecated = approved.",
      "      Same pack flags as recommend. Wrong-cousin drift: resolve cousins.",
      "      A passing check of a real frame is saved to SOCK, the same as MCP verify_frame (--slot <role> tags its top-level parts).",
      "      Its screen job comes from --journey, else --domain, else the frame name, so \"payment screen\" can answer from it.",
      "  resolve code-map [--json | --retired]   Report on .resolve/code-map.json: Figma component -> code component",
      "  resolve code-map --check \"<name>\" [--handoff <handoff.json>] [--json]",
      "      One answer from the committed handoff and code map only. No learned cache, and nothing is guessed.",
      "      --handoff defaults to ./handoff.json. OK, retired, not on this screen, unmapped, other library, or not found.",
      "      Exit 0 ok, 2 retired, 3 not-in-handoff, 4 unmapped, 5 not-found, 6 other-library, 1 when a file or the name is unusable.",
      "  resolve pack validate [path] [--json]",
      "      Check a context pack: id is a slug, accessibility is wcag-a, wcag-aa, or wcag-aaa, every recipe id exists,",
      "      and the file has no Figma file key, token, or node id. Errors name the field and how to fix it.",
      "      Unknown fields are warnings. Exit 0 when there are no errors, 1 when there are. Loading a pack skips a bad field instead.",
      "  resolve code-map --init [--out <file.csv>] [--force]   Write a CSV with one row per component, to fill in a spreadsheet",
      "  resolve code-map --import <file.csv> [--dry-run] [--force | --replace]   Turn the filled CSV into code-map.json (same checks as the loader)",
      "      --force keeps (and lists) existing entries the CSV has no row for; --replace drops them (and lists them). Extra columns are ignored.",
      "      Counts mapped / retired / unmapped / ambiguous / conflict / stale / ignored. Keyed by file key + id; a name works only when unique.",
      "      status retired keeps a part mapped but never recommends it. --retired lists every retired part with its code and replacement. No map: one-line hint.",
      "  resolve ingredients \"<component>\" [--variant \"<Prop=Value, ...>\"] [--depth 1-3] [--json] [--id <graphId>]",
      "      What is inside a component: the library parts placed directly in it, from the graph's nests links.",
      "      Follows one variant: the one you name, else the first in the set. A placed instance id reads that copy's own parts at every level;",
      "      where a copy's insides were not learned, the main component's parts are shown and labelled so.",
      "      Each part shows its code component from .resolve/code-map.json, or 'no code link yet'. Never guessed.",
      "      A part known only from a layer name is labelled as a guess. Retired parts show their code and their replacement. Exact name or id only.",
      "  resolve ingredients --all [--json]   Library-wide counts: composites, parts inside them, and how many link to code.",
      `  resolve handoff "<frame>" ["<frame>" ...] [--draft] [--json] [--out <dir>] [--recipe <id>] [--depth 1-3] [--force] ${PACK_BIND_FLAGS}`,
      "      Developer handoff sheet for a designed screen: recipe slots, each placed component with its Figma id and code (React or Angular),",
      "      the parts inside it, suggested inputs from Figma variant properties, verify result, approved decisions, open questions.",
      "      Refuses when a retired component is on the screen (always) or a component is only a layer-name guess (unless --draft).",
      "      --out writes handoff.md, screen-<name>.md, ingredients.md and handoff.json. Never guesses code: unmapped says unmapped.",
      "  resolve rules                  List human-authored bind rules",
      "  resolve soci                   List pending SOCI proposals (never auto-applied)",
      "  resolve approve <proposal-id> --who <name>   Approve: bind-rules, recipe overlay, or a recorded decision",
      "  resolve reject <proposal-id> --who <name>    Reject + audit line. SOCI never auto-applies.",
      `  resolve cousins ["<frame>"] [--file-key <key>] [--job "<screen job>"] [--components a,b] ${PACK_BIND_FLAGS}`,
      "      Wrong-cousin report: same role / weak name, different master family than the shared DS library.",
      "      Needs a library-role file in .resolve/workspace.json. Unsure → says so. Never invents a master.",
      "  resolve workspace              Linked files + store path / builtAt (same as MCP list_graphs.store)",
      "  resolve orient [--id <graphId>]     Deprecated. God-node summary. Use recommend or recipe.",
      "  resolve query \"<question>\" [--id] [--budget <chars>]",
      "      Deprecated. Scoped subgraph. Use recommend or resolve.",
      "  resolve path \"<A>\" \"<B>\" [--id]     Deprecated. Shortest relationship path. Use recommend.",
      "  resolve explain \"<name>\" [--id]      Deprecated. Use the why line on a recommend or resolve card.",
      "  resolve check \"<intent>\" [--id]      Deprecated. Analog variant. Use verify.",
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
      "      Default golden path: <store>/scoreboard/golden when that folder exists, else ./scoreboard/golden.",
      "      Default workspace name: default (or RESOLVE_WORKSPACE).",
      "  resolve score phrases [--phrases <path>] [--json]",
      "      Designer phrases (\"payee picker\", \"6 digit OTP box\") against recommend. Plain summary first, details below.",
      "      Uses your own <store>/scoreboard/phrases/*.json when there are any. Otherwise the built-in ./scoreboard/phrases,",
      "      but only on the sample library. Never mixes the two. --phrases <path> uses only that path.",
      "      Exits non-zero when a part is invented or a retired/private part is recommended.",
      "  resolve gaps [--json]        What designers asked recommend for that found nothing or only a weak match, most asked first.",
      "      Read from <store>/scoreboard/gaps.jsonl (local, git-ignored). Each row needs a team word, a recipe, or a new part.",
      "  resolve status [--json]      One short answer: learned files, when, version, Figma token, always-on rule, code map, and what to do next",
      "  resolve where                Print store path, graph.json, and builtAt (same as MCP list_graphs.store)",
      "",
      "  npm run resolve -- <command>     primary",
      "  npm run keyline -- <command>     Deprecated alias. Use npm run resolve. Removed after a quarter.",
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
      fileName: flag(args, "name") ?? flag(args, "file-key") ?? "file",
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
    audience: flag(args, "audience"),
    a11y: flag(args, "a11y"),
    packsFile: flag(args, "packs"),
  });
}

/** Entries of the code map on disk, as written (good or bad). A file that is not a map gives none. */
function existingEntries(path: string): unknown[] {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "").trim() || "{}") as { entries?: unknown };
    return Array.isArray(raw.entries) ? raw.entries : [];
  } catch {
    return [];
  }
}

let jsonPretty = false;

function printJson(value: unknown): void {
  const text = jsonPretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  process.stdout.write(`${text}\n`);
}

function defaultGoldenDir(): string {
  const stored = join(storeRoot(), "scoreboard", "golden");
  if (existsSync(stored)) return stored;
  return resolve("scoreboard/golden");
}

export async function runCli(argv: string[]): Promise<void> {
  const previous = jsonPretty;
  jsonPretty = argv.includes("--pretty");
  try {
    await dispatchCli(jsonPretty ? argv.filter((arg) => arg !== "--pretty") : argv);
  } finally {
    jsonPretty = previous;
  }
}

async function dispatchCli(argv: string[]): Promise<void> {
  if (process.env["npm_lifecycle_event"] === "keyline") warnDeprecated("npm run keyline");
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

      const looksLikePath = target.startsWith("/") || target.startsWith(".") || /\.(json|xml)$/i.test(target);
      if (!looksLikePath) throw new Error(DESIGNER.badLink);
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
        stripFiller(
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
        ),
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
      const screen = screenAskCard(query, { sock, index: resolveGraph(flag(args, "id"))?.index, recipes });
      if (screen) {
        printJson(screen);
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
      const index = requireGraph(args).index;
      const screen = screenAskCard(intent, { sock: readSock(), index, recipes: loadRecipes() });
      if (screen) {
        recordGap(intent, screen);
        printJson(screen);
        return;
      }
      const card = recommendMasters(index, intent, {
        budgetChars: Number.isFinite(budget) && budget > 0 ? budget : undefined,
        ...(context ? { context } : {}),
        workspace: bind.workspace,
        sock: readSock(),
        bindRules: mergeBindRules(readBindRules(), pack?.bindRules),
        placeholders: readPlaceholders(),
      });
      recordGap(intent, card);
      printJson(card);
      return;
    }

    case "gaps": {
      const rows = readGaps();
      if (args.includes("--json")) printJson(rows);
      else process.stdout.write(`${formatGaps(rows)}\n`);
      return;
    }

    case "resolve": {
      const name = positionals(args)[0];
      if (!name) throw new Error('Usage: resolve resolve "<name>"');
      const budget = Number(flag(args, "budget"));
      const bind = bindFromFlags(args);
      const pack = packForRecommend(bind);
      const screenType = flag(args, "screen-type");
      const card = componentUsageCard(requireGraph(args).index, name, {
        budgetChars: Number.isFinite(budget) && budget > 0 ? budget : undefined,
        sock: readSock(),
        placeholders: readPlaceholders(),
        workspace: bind.workspace ?? readWorkspace(),
        ...((pack || screenType)
          ? { context: { ...(pack ?? {}), ...(screenType ? { screenType, id: pack?.id ?? screenType } : {}) } }
          : {}),
      });
      const echo = pack ? appliedContext(pack) : undefined;
      const cap = Number.isFinite(budget) && budget > 0 ? budget : 2000;
      const shown = echo ? { ...card, context: echo, ...(pack?.warning ? { warning: pack.warning } : {}) } : card;
      printJson(JSON.stringify(shown).length <= cap ? shown : card);
      return;
    }

    case "orient": {
      warnDeprecated("orient");
      warnDeprecated("communities");
      const { index, graphId } = requireGraph(args);
      const brief = buildOrientBrief(index);
      process.stdout.write(`# ${graphId}\n\n${toGraphReportMarkdown(brief)}`);
      return;
    }

    case "query": {
      warnDeprecated("query");
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
      warnDeprecated("path");
      const names = positionals(args);
      const from = names[0];
      const to = names[1];
      if (!from || !to) throw new Error('Usage: resolve path "<A>" "<B>"');
      printJson(pathBetween(requireGraph(args).index, from, to));
      return;
    }

    case "explain": {
      warnDeprecated("explain");
      const name = positionals(args)[0];
      if (!name) throw new Error('Usage: resolve explain "<name>"');
      printJson(explainNode(requireGraph(args).index, name));
      return;
    }

    case "check": {
      warnDeprecated("check");
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
      const cousins = checkCousins(resolveGraph(flag(args, "id"))?.index, {
        frame,
        fileKey,
        components,
        job: flag(args, "job"),
        recipes: loadRecipes(),
        context: packForRecommend(bind),
        workspace: bind.workspace ?? readWorkspace(),
      });
      printJson(cousins);
      if (cousins.checked === false && cousins.reason !== "no-placements" && cousins.reason !== "no-library-file" && cousins.reason !== "no-graph") {
        process.exitCode = 1;
      }
      return;
    }

    case "code-map": {
      const mapPath = overlayFile("code-map.json") ?? join(storeRoot(), "code-map.json");
      const force = args.includes("--force");
      const replace = args.includes("--replace");
      for (let i = 0; i < args.length; i += 1) {
        const arg = args[i]!;
        if (["--out", "--import", "--id", "--check", "--handoff"].includes(arg)) i += 1;
        else if (arg.startsWith("--") && !["--json", "--retired", "--init", "--force", "--dry-run", "--replace"].includes(arg)) {
          throw new Error(`Unknown code-map option "${arg}". Use --check "<name>" [--handoff <handoff.json>] [--json], --init [--out <file.csv>] [--force], --import <file.csv> [--dry-run] [--force | --replace], --json or --retired.`);
        }
      }
      if (args.includes("--check")) {
        if (args.includes("--init") || args.includes("--import") || args.includes("--retired")) {
          throw new Error("Use --check on its own. It cannot be combined with --init, --import, or --retired.");
        }
        const json = args.includes("--json");
        const name = flag(args, "check");
        const handoffGiven = flag(args, "handoff");
        const handoffDefault = join(process.cwd(), "handoff.json");
        if (args.includes("--handoff") && (!handoffGiven || handoffGiven.startsWith("--"))) {
          const message = "--handoff needs the handoff.json from resolve handoff --out <folder>.";
          if (json) {
            printJson({ ok: false, status: "error", query: name && !name.startsWith("--") ? name : "", message, exitCode: 1, codeMapPath: mapPath, handoffPath: "" });
            process.exitCode = 1;
            return;
          }
          throw new Error(message);
        }
        if (!name || name.startsWith("--")) {
          const message = "The name was empty.";
          if (json) {
            printJson({ ok: false, status: "error", query: "", message, exitCode: 1, codeMapPath: mapPath, handoffPath: handoffGiven ?? handoffDefault });
            process.exitCode = 1;
            return;
          }
          throw new Error('Usage: resolve code-map --check "<name>" [--handoff <handoff.json>] [--json]');
        }
        const handoff = handoffGiven ?? handoffDefault;
        const checked = checkComponentFiles(name, mapPath, handoff);
        if (args.includes("--json")) printJson(checked);
        else process.stdout.write(`${checked.message}\n`);
        if (checked.exitCode !== 0) process.exitCode = checked.exitCode;
        return;
      }
      if (args.includes("--init") && args.includes("--import")) throw new Error("Use either --init or --import, not both.");
      if (args.includes("--init")) {
        const given = flag(args, "out");
        if (args.includes("--out") && (!given || given.startsWith("--"))) throw new Error("--out needs a file name, for example --out code-map.csv");
        const out = given ?? join(dirname(mapPath), "code-map.csv");
        if (existsSync(out) && !force) throw new Error(`${out} already exists. Add --force to replace it.`);
        const rows = codeMapRows(requireGraph(args).index);
        writeFileSync(out, codeMapTemplate(rows));
        const filled = rows.filter((r) => r.twin).length;
        process.stdout.write(
          `Wrote ${out}: ${rows.length} components, ${filled} already mapped. Fill in component and importPath (and for Angular: framework angular, selector, module or standalone, inputs, outputs), then run: resolve code-map --import ${out}\n`,
        );
        return;
      }
      if (args.includes("--import")) {
        const file = flag(args, "import");
        if (!file || file.startsWith("--")) throw new Error("Usage: resolve code-map --import <file.csv> [--dry-run] [--force | --replace]");
        if (args.includes("--json")) throw new Error("--json is not used with --import. Use --dry-run to see the JSON that would be written.");
        if (force && replace) throw new Error("Use either --force (keep entries the CSV has no row for) or --replace (drop them), not both.");
        if (!existsSync(file)) throw new Error(`No such file: ${file}`);
        const result = codeMapFromCsv(readFileSync(file, "utf8"));
        const ignoredCols = result.ignoredColumns.length
          ? `Ignored column${result.ignoredColumns.length > 1 ? "s" : ""} Resolve does not use: ${result.ignoredColumns.join(", ")}.\n`
          : "";
        if (result.errors.length) {
          const fileLevel = result.errors.every((e) => !e.startsWith("row "));
          process.stdout.write(`${ignoredCols}Nothing written. Fix ${fileLevel ? "this" : "these rows"} in ${file}:\n${result.errors.slice(0, 20).map((e) => `  ${e}`).join("\n")}${result.errors.length > 20 ? `\n  +${result.errors.length - 20} more` : ""}\n`);
          process.exitCode = 1;
          return;
        }
        if (!result.entries.length) {
          process.stdout.write(`${ignoredCols}Nothing written: no filled-in rows in ${file} (${result.skipped} empty).\n`);
          process.exitCode = 1;
          return;
        }
        const exists = existsSync(mapPath);
        if (exists && !force && !replace && !args.includes("--dry-run")) {
          throw new Error(`${mapPath} already exists. Add --force to update it (entries the CSV has no row for are kept), --replace to write only the CSV's entries, or --dry-run to see the result.`);
        }
        const old = exists ? existingEntries(mapPath) : [];
        const merged = mergeCodeMap(old, result, replace);
        const json = `${JSON.stringify({ entries: merged.entries }, null, 2)}\n`;
        const list = (items: unknown[]) => items.slice(0, 12).map((e) => `  ${entryLabel(e)}`).join("\n") + (items.length > 12 ? `\n  +${items.length - 12} more` : "");
        const notes = [
          merged.untouched.length
            ? `${replace ? "Dropped" : "Kept"} ${merged.untouched.length} existing entr${merged.untouched.length === 1 ? "y" : "ies"} the CSV has no row for${replace ? " (--replace)" : " (use --replace to drop them)"}:\n${list(merged.untouched)}\n`
            : "",
          merged.cleared.length
            ? `Removed ${merged.cleared.length} entr${merged.cleared.length === 1 ? "y" : "ies"} whose row was left empty:\n${list(merged.cleared)}\n`
            : "",
          merged.replaced.length
            ? `Replaced ${merged.replaced.length} existing entr${merged.replaced.length === 1 ? "y" : "ies"} with the CSV row for the same component:\n${list(merged.replaced)}\n`
            : "",
        ].join("");
        if (args.includes("--dry-run")) {
          process.stdout.write(json);
          if (ignoredCols || notes) process.stderr.write(`${ignoredCols}${notes}`);
          return;
        }
        const index = requireGraph(args).index;
        mkdirSync(dirname(mapPath), { recursive: true });
        writeFileSync(mapPath, json);
        process.stdout.write(
          `${ignoredCols}Wrote ${mapPath}: ${merged.entries.length} entries (${result.entries.length} from the CSV, ${result.skipped} empty rows skipped).\n${notes}`,
        );
        const report = codeMapCard(() => index);
        process.stdout.write(`${formatCodeMapReport(report)}\n`);
        return;
      }
      const report = codeMapCard(() => requireGraph(args).index);
      if (args.includes("--json")) printJson(report);
      else process.stdout.write(`${formatCodeMapReport(report, args.includes("--retired"))}\n`);
      return;
    }

    case "handoff": {
      const VALUE_FLAGS = ["--out", "--recipe", "--depth", "--rules", "--pack", "--product", "--journey", "--domain", "--audience", "--a11y", "--packs", "--id"];
      const frames: string[] = [];
      for (let i = 0; i < args.length; i += 1) {
        const arg = args[i]!;
        if (arg === "--json" || arg === "--draft" || arg === "--force") continue;
        if (VALUE_FLAGS.includes(arg)) {
          const value = args[i + 1];
          if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value.`);
          i += 1;
          continue;
        }
        if (arg.startsWith("--")) throw new Error(`Unknown handoff option "${arg}". Use --draft, --json, --out, --recipe, --depth, --force, --rules or ${PACK_BIND_FLAGS}.`);
        frames.push(arg);
      }
      if (!frames.length) {
        throw new Error('Usage: resolve handoff "<frame>" ["<frame>" ...] [--draft] [--json] [--out <dir>] [--recipe <id>] [--depth 1-3]');
      }
      const rawDepth = flag(args, "depth");
      const depth = rawDepth === undefined ? 3 : Number(rawDepth);
      if (!Number.isInteger(depth) || depth < 1 || depth > 3) throw new Error("--depth must be 1, 2 or 3.");
      const bind = bindFromFlags(args);
      const pack = packForRecommend(bind);
      const index = requireGraph(args).index;
      const result = handoffSheet(index, frames, {
        draft: args.includes("--draft"),
        recipe: flag(args, "recipe"),
        recipes: loadRecipes(),
        ...(pack ? { context: pack } : {}),
        bindRules: mergeBindRules(readBindRules(), pack?.bindRules),
        sock: readSock(),
        workspace: bind.workspace ?? readWorkspace(),
        placeholders: readPlaceholders(),
        rules: readLibraryRules(flag(args, "rules")),
        decisions: readApprovedDecisions(),
        depth,
      });
      const json = args.includes("--json");
      if (!result.ok) {
        if (json) printJson(result);
        else process.stdout.write(`${formatHandoffRefusal(result)}\n`);
        process.exitCode = 1;
        return;
      }
      const out = flag(args, "out");
      if (out) {
        const target = resolve(out);
        if (/^\/(proc|sys|dev)(\/|$)/.test(target)) {
          throw new Error(`Cannot write the handoff files to ${target}: that is not a folder for a handoff. Pass another --out folder.`);
        }
        const force = args.includes("--force");
        if (existsSync(target) && !statSync(target).isDirectory()) throw new Error(`${target} is a file, not a folder. Pass a folder for --out.`);
        // Our files only: handoff.md, handoff.json, ingredients.md and screen-*.md. Anything else in the folder is left alone.
        const ours = (f: string) => ["handoff.md", "handoff.json", "ingredients.md"].includes(f) || /^screen-.+\.md$/.test(f);
        const existing = existsSync(target) ? readdirSync(target).filter(ours) : [];
        if (existing.length && !force) {
          throw new Error(`${target} already has handoff files (${existing.slice(0, 3).join(", ")}${existing.length > 3 ? ", …" : ""}). Add --force to replace them.`);
        }
        const used = new Set<string>();
        const files = result.screens.map((sheet) => {
          let name = `screen-${screenSlug(sheet.screen.name)}`;
          for (let n = 2; used.has(name); n += 1) name = `screen-${screenSlug(sheet.screen.name)}-${n}`;
          used.add(name);
          return `${name}.md`;
        });
        const stale = existing.filter((f) => f.startsWith("screen-") && !files.includes(f));
        try {
          mkdirSync(target, { recursive: true });
          accessSync(target, fsConstants.W_OK);
          result.screens.forEach((sheet, n) => writeFileSync(join(target, files[n]!), formatHandoffScreen(sheet, result.draft)));
          writeFileSync(join(target, "ingredients.md"), formatHandoffIngredients(result));
          writeFileSync(join(target, "handoff.json"), `${JSON.stringify(result, null, 2)}\n`);
          writeFileSync(join(target, "handoff.md"), formatHandoffIndex(result, files));
          for (const f of stale) rmSync(join(target, f), { force: true });
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          const why =
            code === "EACCES" || code === "EPERM"
              ? "no permission to write there"
              : code === "EEXIST" || code === "ENOTDIR"
                ? "part of that path is a file, not a folder"
                : code === "EROFS"
                  ? "the file system is read-only"
                  : code === "ENOSPC"
                    ? "the disk is full"
                    : String((error as Error).message ?? error).split("\n")[0];
          throw new Error(`Cannot write the handoff files to ${target}: ${why}. Pass another --out folder.`);
        }
        process.stdout.write(
          `Wrote ${target}: handoff.md, ${files.join(", ")}, ingredients.md, handoff.json${result.draft ? " (DRAFT, not for build)" : ""}.\n${stale.length ? `Removed ${stale.length} older screen file${stale.length === 1 ? "" : "s"} from an earlier handoff there: ${stale.join(", ")}.\n` : ""}`,
        );
        return;
      }
      if (json) {
        printJson(result);
        return;
      }
      const sheets = result.screens.map((sheet) => formatHandoffScreen(sheet, result.draft));
      process.stdout.write(sheets.join("\n---\n\n"));
      if (result.screens.length > 1) process.stdout.write(`\n---\n\n${formatHandoffIngredients(result)}`);
      return;
    }

    case "parts": {
      const ask = positionals(args).join(" ").trim();
      if (!ask) throw new Error('Usage: resolve parts "<screen link or frame name>" [--json]');
      const card = screenPartsCard(requireGraph(args).index, ask);
      printJson(card);
      if (!card.ok) process.exitCode = 1;
      return;
    }

    case "ingredients":
    case "ingredient": {
      const words: string[] = [];
      for (let i = 0; i < args.length; i += 1) {
        const arg = args[i]!;
        if (arg === "--json" || arg === "--all") continue;
        if (arg === "--variant" || arg === "--depth" || arg === "--id") {
          i += 1;
          continue;
        }
        if (arg.startsWith("--")) throw new Error(`Unknown ingredients option "${arg}". Use --variant, --depth, --json, --all or --id.`);
        words.push(arg);
      }
      const json = args.includes("--json");
      if (args.includes("--all")) {
        if (words.length) throw new Error('Use either --all or a component name, not both.');
        const coverage = ingredientCoverage(requireGraph(args).index);
        if (json) printJson(coverage);
        else process.stdout.write(`${formatIngredientCoverage(coverage)}\n`);
        return;
      }
      const name = words.join(" ").trim();
      if (!name) throw new Error('Usage: resolve ingredients "<component>" [--variant "<Prop=Value>"] [--depth 1-3] [--json]');
      const rawDepth = flag(args, "depth");
      const depth = rawDepth === undefined ? undefined : Number(rawDepth);
      const depthGiven = args.includes("--depth");
      if (depthGiven && (rawDepth === undefined || rawDepth.startsWith("--") || !Number.isInteger(depth) || depth! < 1 || depth! > 3)) {
        throw new Error("--depth must be 1, 2 or 3.");
      }
      const variant = flag(args, "variant");
      if (args.includes("--variant") && (!variant || variant.startsWith("--"))) {
        throw new Error('--variant needs a value, for example --variant "Size=Medium".');
      }
      const card = ingredientCard(requireGraph(args).index, name, { variant, depth });
      if (json) printJson(card);
      else process.stdout.write(`${formatIngredientCard(card)}\n`);
      if (!card.found) process.exitCode = 1;
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
      const index = requireGraph(args).index;
      const verified = verifyFrame(index, {
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
      recordVerifyUsage(index, verified, {
        frame,
        components,
        bind,
        slot: flag(args, "slot"),
        journey: flag(args, "journey"),
        product: flag(args, "product"),
        pack: flag(args, "pack"),
        domain: flag(args, "domain"),
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

    case "status": {
      const report = statusReport();
      if (args.includes("--json")) printJson(report);
      else process.stdout.write(`${formatStatus(report)}\n`);
      return;
    }

    case "score": {
      const namedWorkspace = flag(args, "workspace");
      if (namedWorkspace) process.env["RESOLVE_WORKSPACE"] = scoreboardWorkspaceName({ RESOLVE_WORKSPACE: namedWorkspace });
      clearCache();
      // Words after "score" that are not flags or flag values. Only "phrases" is known.
      const scoreValueFlags = new Set(["--workspace", "--id", "--phrases", "--golden", "--out"]);
      const scoreWords = args.filter((arg, at) => !arg.startsWith("--") && !scoreValueFlags.has(args[at - 1] ?? ""));
      const unknownWord = scoreWords.find((word) => !/^phrases?$/i.test(word));
      if (unknownWord) {
        throw new Error(`Unknown score option "${unknownWord}". Use "resolve score" or "resolve score phrases".`);
      }
      if (scoreWords.length) {
        const loaded = resolveGraph(flag(args, "id"));
        if (!loaded) throw new Error(missingGraphMessage());
        const given = flag(args, "phrases");
        if (given && !existsSync(given)) throw new Error(`No phrase set at ${given}.`);
        const teamDir = join(storeRoot(), "scoreboard", "phrases");
        const shippedDir = resolve("scoreboard/phrases");
        const hasJson = (dir: string) =>
          existsSync(dir) && statSync(dir).isDirectory() && readdirSync(dir).some((name) => name.endsWith(".json"));
        // Never mix the shipped sample-library set with a team's own phrases in one total.
        let source: string[];
        let note: string | undefined;
        if (given) {
          source = [given];
        } else if (hasJson(teamDir)) {
          source = [teamDir];
          note = `Scored your team's phrases only (${teamDir}). The built-in set is for the sample library: pass --phrases scoreboard/phrases to run it.`;
        } else if (!isSampleLibrary(loaded.index)) {
          throw new Error(
            `No team phrases yet. The built-in phrase set only fits the sample library, so it was not run on yours (its score would be misleading). Add your own .json phrase files to ${teamDir}, or pass --phrases <path>.`,
          );
        } else if (existsSync(shippedDir)) {
          source = [shippedDir];
          note = "Scored the built-in phrase set on the sample library.";
        } else {
          throw new Error(`No phrase set found. Run from the Resolve checkout, add phrase files to ${teamDir}, or pass --phrases <path>.`);
        }
        const report = scorePhrases(loaded.index, loadPhraseCases(source), {
          ...(note ? { note } : {}),
          source,
          sock: readSock(),
          bindRules: readBindRules(),
          workspace: readWorkspace(),
        });
        if (args.includes("--json")) printJson(report);
        else process.stdout.write(`${formatPhraseTable(report)}\n`);
        if (phraseExitCode(report) !== 0) process.exitCode = 1;
        return;
      }
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
      const goldenPath = flag(args, "golden") ?? defaultGoldenDir();
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

    case "pack": {
      const sub = args.find((arg) => !arg.startsWith("--"));
      for (const arg of args) {
        if (arg.startsWith("--") && arg !== "--json") {
          throw new Error(`Unknown pack option "${arg}". Use resolve pack validate [path] [--json].`);
        }
      }
      if (sub !== "validate") throw new Error("Usage: resolve pack validate [path] [--json]");
      const pathArg = args.filter((arg) => !arg.startsWith("--") && arg !== "validate");
      if (pathArg.length > 1) throw new Error("Usage: resolve pack validate [path] [--json]");
      const target = pathArg[0] ? resolve(pathArg[0]) : contextPacksPath();
      const failPack = (message: string, field = "(file)"): void => {
        const payload = { ok: false, path: target, packs: 0, message, exitCode: 1, errors: [{ field, message }], warnings: [] as { field: string; message: string }[] };
        if (args.includes("--json")) printJson(payload);
        else process.stdout.write(`${message}\n`);
        process.exitCode = 1;
      };
      if (!existsSync(target)) {
        failPack(`No context pack file at ${target}. Copy src/data/context-packs.example.json to .resolve/context-packs.json, then run resolve pack validate.`);
        return;
      }
      let info: ReturnType<typeof statSync>;
      try {
        info = statSync(target);
      } catch {
        failPack(`Could not read ${target}. Check the path and the file permissions.`);
        return;
      }
      if (info.isDirectory()) {
        failPack(`${target} is a folder. Pass the context-packs.json file, not a folder.`);
        return;
      }
      let text: string;
      try {
        text = readFileSync(target, "utf8").replace(/^\uFEFF/, "");
      } catch {
        failPack(`Could not read ${target}. Check the file permissions.`);
        return;
      }
      if (!text.trim()) {
        failPack(`${target} is empty. Add a packs list, or copy src/data/context-packs.example.json.`);
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text) as unknown;
      } catch {
        failPack(`${target} is not valid JSON. Fix the commas and quotes, then run resolve pack validate again.`);
        return;
      }
      let recipeIds: Set<string>;
      try {
        recipeIds = new Set(loadRecipes().map((recipe) => recipe.id));
      } catch {
        const message = "recipes.json is not valid JSON, so recipe ids cannot be checked. Fix .resolve/recipes.json, then run resolve pack validate again.";
        const payload = { ok: false, path: target, packs: 0, message, exitCode: 1, errors: [{ field: "recipes.json", message }], warnings: [] as { field: string; message: string }[] };
        if (args.includes("--json")) printJson(payload);
        else process.stdout.write(`${message}\n`);
        process.exitCode = 1;
        return;
      }
      const report = packValidation(raw, recipeIds);
      const payload = { ...report, path: target };
      if (args.includes("--json")) printJson(payload);
      else process.stdout.write(`${report.message}\n`);
      if (report.exitCode !== 0) process.exitCode = report.exitCode;
      return;
    }

    default:
      usage();
  }
}

if (!process.env["VITEST"]) {
  runCli(process.argv.slice(2)).catch((error) => {
    const raw = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${designerFailure(raw)}\n`);
    process.exit(1);
  });
}
