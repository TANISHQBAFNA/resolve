import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { PACK_BIND_FLAGS, usage } from "./cliUsage";
import {
  bindFromFlags,
  defaultGoldenDir,
  flag,
  graphFromMetadataXml,
  ingestLive,
  ingestRole,
  looksLikeMetadataXml,
  parseTextsFlag,
  positionals,
  printJson,
  readDesignContextFile,
  requireGraph,
  setJsonPretty,
  toGraph,
  writeStored,
} from "./cliArgs";
import { composeFromCli } from "./composeCommand";
import { runHandoff } from "./handoffCommand";
import { contextFromFlags, recordFlag, runDecisions, runExport } from "./decisionCommand";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isFigmaLiveTarget } from "@/core/ingestion/figmaFileKey";
import { overlayFile } from "@/core/query/overlayFile";
import { publishedVerdict, verifyExitCode } from "@/core/query/properUse";
import {
  componentUsageCard,
  listRecipes,
  listSoci,
  mergeBindRules,
  appliedContext,
  packForRecommend,
  withScreenType,
  recipeCard,
  checkCousins,
  recommendMasters,
  screenAskCard,
  exampleCard,
  verifyFrame,
  codeMapCard,
  codeMapFromCsv,
  codeMapJson,
  csvIsReviewSheet,
  entryLabel,
  readCodeMapDocument,
  reviewEntries,
  mergeCodeMap,
  codeMapRows,
  codeMapTemplate,
  formatCodeMapReport,
  checkComponentFiles,
  checkNamesFromNodes,
  packValidation,
  ingredientCard,
  ingredientCoverage,
  screenPartsCard,
  applyBriefIntent,
  BriefAnswerError,
  briefAnswersFromFlags,
  briefAnswerParts,
  briefAnswerIds,
  recordFromBrief,
  briefScreen,
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
  clearCache,
  deleteGraph,
  graphPath,
  listGraphs,
  loadRecipes,
  missingGraphMessage,
  readBindRules,
  readLibraryRules,
  proposalDecisionBody,
  readPlaceholders,
  readSock,
  readApprovedDecisions,
  readWorkspace,
  runProposalDecision,
  contextPacksPath,
  rebuildIndex,
  resolveGraph,
  storeInfo,
  storeRoot,
} from "./store";
import { stripFiller } from "./cards";
import { formatGaps, readGaps, recordGap } from "./gaps";
import { refuseBadRows, runCodeMapExtra } from "./codeMapCommand";
import { recordVerifyUsage } from "./tools";
import { learnLibrary } from "./learn";
import { DESIGNER, designerFailure } from "./designerMessages";
import { presentToolResult } from "./cards";
import { statusReport } from "./status";
import { DEPRECATED_INSTEAD } from "./deprecations";
import {
  previousScore,
  scoreboardHistoryDir,
  scoreboardWorkspaceName,
  writeScoreHistory,
} from "./scoreboardView";

function csvFlag(args: string[], name: string): string[] | undefined {
  const raw = flag(args, name);
  if (!raw) return undefined;
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

function recommendContextFromFlags(args: string[]) {
  const bind = bindFromFlags(args);
  const pack = packForRecommend(bind);
  const screenType = flag(args, "screen-type");
  const context = withScreenType(pack, screenType);
  // The options brief and recommend both rank with.
  const ranking = {
    ...(context ? { context } : {}),
    workspace: bind.workspace,
    sock: readSock(),
    bindRules: mergeBindRules(readBindRules(), pack?.bindRules),
    placeholders: readPlaceholders(),
  };
  return { bind, pack, context, ranking };
}

/**
 * Resolve CLI — ingest each linked file into the workspace
 * (`.resolve/workspace.json` + `.resolve/files/`).
 *
 * Agents call resolve / cousins (usage cards), then Figma. Do not Read graph.json.
 */

export async function runCli(argv: string[]): Promise<void> {
  const pretty = argv.includes("--pretty");
  const previous = setJsonPretty(pretty);
  try {
    await dispatchCli(pretty ? argv.filter((arg) => arg !== "--pretty") : argv);
  } catch (error) {
    if (!argv.includes("--json") || !(error instanceof BriefAnswerError || argv[0] === "brief")) throw error;
    printJson({ ok: false, status: "error", message: error instanceof Error ? error.message : String(error), exitCode: 1 });
    process.exitCode = 1;
  } finally {
    setJsonPretty(previous);
  }
}

async function dispatchCli(argv: string[]): Promise<void> {
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
      if (!fileKey) {
        throw new Error(
          "Usage: resolve learn --file-key <key> [--from-metadata <file.xml>] [--role library] [--design-context <file>] [--libraries <file.json>]",
        );
      }
      const designContextPath = flag(args, "design-context");
      const librariesPath = flag(args, "libraries");
      const readLearnFile = (path: string) => {
        const resolved = resolve(path);
        if (!existsSync(resolved)) throw new Error(`No file at ${path}.`);
        return readFileSync(resolved, "utf8");
      };
      const metadataXml = xmlPath ? readLearnFile(xmlPath) : undefined;
      printJson(
        stripFiller(
          learnLibrary({
            fileKey,
            role: ingestRole(args),
            fileName: flag(args, "name"),
            label: flag(args, "label") ?? flag(args, "name"),
            metadataXml,
            ...(designContextPath ? { designContext: readDesignContextFile(designContextPath) } : {}),
            ...(librariesPath ? { libraries: readLearnFile(librariesPath) } : {}),
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
      if (args.includes("--compose") || args.includes("--propose")) return composeFromCli(args, query);
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
      const { bind, context } = recommendContextFromFlags(args);
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

    case "brief": {
      const request = positionals(args)[0];
      if (!request) throw new Error('Usage: resolve brief "<screen request>"');
      const { ranking } = recommendContextFromFlags(args);
      const answers = briefAnswersFromFlags(args);
      const index = requireGraph(args).index;
      const result = briefScreen({ request, answers, index, recipes: loadRecipes(), decisions: readApprovedDecisions(), ...ranking });
      const createdAt = new Date().toISOString();
      recordFlag(args, () => recordFromBrief({ request, answers: briefAnswerIds(answers, index), answerParts: briefAnswerParts(answers, index), context: contextFromFlags(args), result, createdAt }));
      return printJson(result);
    }

    case "export":
      return runExport(args);

    case "decisions":
      return runDecisions(args);

    case "pick": {
      const { runPickCommand } = await import("./commands");
      runPickCommand(args);
      return;
    }

    case "recommend": {
      const asked = positionals(args)[0];
      if (!asked) throw new Error('Usage: resolve recommend "<intent>"');
      const budget = Number(flag(args, "budget"));
      const { ranking } = recommendContextFromFlags(args);
      const index = requireGraph(args).index;
      const intent = applyBriefIntent(asked, briefAnswersFromFlags(args), index);
      const screen = screenAskCard(intent, { sock: readSock(), index, recipes: loadRecipes() });
      if (screen) {
        recordGap(intent, screen);
        printJson(screen);
        return;
      }
      const card = recommendMasters(index, intent, {
        budgetChars: Number.isFinite(budget) && budget > 0 ? budget : undefined,
        ...ranking,
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
      const { bind, pack, context } = recommendContextFromFlags(args);
      const card = componentUsageCard(requireGraph(args).index, name, {
        budgetChars: Number.isFinite(budget) && budget > 0 ? budget : undefined,
        sock: readSock(),
        placeholders: readPlaceholders(),
        workspace: bind.workspace ?? readWorkspace(),
        bindRules: mergeBindRules(readBindRules(), pack?.bindRules),
        ...(context ? { context } : {}),
      });
      const echo = pack ? appliedContext(pack) : undefined;
      const cap = Number.isFinite(budget) && budget > 0 ? budget : 2000;
      const shown = echo ? { ...card, context: echo, ...(pack?.warning ? { warning: pack.warning } : {}) } : card;
      printJson(JSON.stringify(shown).length <= cap ? shown : card);
      return;
    }

    case "orient":
    case "query":
    case "path":
    case "explain": {
      const instead = DEPRECATED_INSTEAD[command] ?? "recommend";
      throw new Error(`\`${command}\` was removed. Use ${instead}.`);
    }

    case "cousins":
    case "cousin": {
      const frame = positionals(args)[0];
      const components = csvFlag(args, "components");
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
      if (args.includes("--help") || args.includes("-h")) {
        throw new Error('Usage: resolve code-map [--json | --retired | --check "<name>" | --init | --import <file.csv> | scan <package> | suggest <package> | review]');
      }
      if (runCodeMapExtra(args)) return;
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
        const checked = checkComponentFiles(name, mapPath, handoff, checkNamesFromNodes(resolveGraph()?.index.getNodesByType("COMPONENT_SET", "MAIN_COMPONENT") ?? []));
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
          `Wrote ${out}: ${rows.length} components, ${filled} already mapped. Fill in component and importPath (and for a selector component: selector, module or standalone, inputs, outputs), then run: resolve code-map --import ${out}\n`,
        );
        return;
      }
      if (args.includes("--import")) {
        const file = flag(args, "import");
        if (!file || file.startsWith("--")) throw new Error("Usage: resolve code-map --import <file.csv> [--dry-run] [--force | --replace]");
        if (args.includes("--json")) throw new Error("--json is not used with --import. Use --dry-run to see the JSON that would be written.");
        if (force && replace) throw new Error("Use either --force (keep entries the CSV has no row for) or --replace (drop them), not both.");
        if (!existsSync(file)) throw new Error(`No such file: ${file}`);
        const raw = codeMapFromCsv(readFileSync(file, "utf8"));
        const result = force && csvIsReviewSheet(raw) ? reviewEntries(codeMapFromCsv(readFileSync(file, "utf8"), { blankStatus: "suggested" })) : raw;
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
        const previous = exists ? readCodeMapDocument(mapPath) : { entries: [] as unknown[] };
        const merged = mergeCodeMap(previous.entries, result, replace);
        const json = codeMapJson(merged.entries, previous);
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
        if (refuseBadRows(result.entries, index)) return;
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

    case "handoff":
      return runHandoff(args);

    case "parts": {
      const ask = positionals(args).join(" ").trim();
      if (!ask) throw new Error('Usage: resolve parts "<screen link or frame name>" [--json]');
      const card = screenPartsCard(requireGraph(args).index, ask);
      if (args.includes("--json")) printJson(card);
      else process.stdout.write(`${presentToolResult(card, "markdown", "parts")}\n`);
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
        else process.stdout.write(`${presentToolResult(coverage, "markdown", "ingredients")}\n`);
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
      else process.stdout.write(`${presentToolResult(card, "markdown", "get_ingredients")}\n`);
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

    case "check":
    case "verify": {
      const frame = positionals(args)[0];
      const components = csvFlag(args, "components");
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
        ...(args.includes("--all") ? { all: true } : {}),
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
      const exitCode = verifyExitCode(verified);
      if (command === "check" && !args.includes("--json")) {
        process.stdout.write(`${presentToolResult(verified, "markdown", "verify_frame")}\n`);
      } else printJson(publishedVerdict(verified));
      if (exitCode !== 0) process.exitCode = exitCode;
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
      const decided = runProposalDecision(proposalId, action, who);
      printJson(proposalDecisionBody(decided, action, proposalId));
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
      else process.stdout.write(`${presentToolResult(report, "markdown", "status")}\n`);
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

if (!process.env["VITEST"] && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).catch((error) => {
    const raw = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${designerFailure(raw)}\n`);
    process.exit(1);
  });
}
