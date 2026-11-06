import { accessSync, constants as fsConstants, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  briefAnswerLines,
  briefAnswerIds,
  briefAnswerParts,
  briefAnswersFromFlags,
  formatHandoffIndex,
  formatHandoffIngredients,
  formatHandoffScreen,
  handoffEnabled, handoffOffText, handoffSheet,
  mergeBindRules,
  packForRecommend,
  recordFromHandoff,
  screenSlug,
} from "@/core/query";
import { presentToolResult } from "./cards";
import { writeDecision } from "./decisionCommand";
import { RECORD_PROPERTY } from "./decisionMcp";
import { PACK_BIND_FLAGS } from "./cliUsage";
import { graphIdProperty, screenContextProperties } from "./toolFields";
import { bindFromFlags, flag, printJson, requireGraph, withJsonErrors } from "./cliArgs";
import {
  loadRecipes,
  readApprovedDecisions,
  readBindRules,
  readLibraryRules,
  readPlaceholders,
  readDsck,
  readWorkspace,
} from "./store";

const HANDOFF_USAGE = 'Usage: resolve handoff "<frame>" ["<frame>" ...] [--draft] [--json] [--out <dir>] [--recipe <id>] [--depth 1-3]';

/** `resolve handoff` (moved out of cli.ts unchanged; cli.ts was at the 1000-line cap). Opt-in: RESOLVE_HANDOFF=1. */
/** With --json, any refusal (a used --out folder, a bad flag) is ok:false JSON and exit 1, not plain text. */
export function runHandoff(args: string[]): void {
  withJsonErrors(args, () => handoff(args));
}

function handoff(args: string[]): void {
  if (!handoffEnabled()) return void process.stderr.write(handoffOffText());
  if (args.includes("--help") || args.includes("-h")) throw new Error(HANDOFF_USAGE);
  const VALUE_FLAGS = ["--out", "--recipe", "--depth", "--rules", "--pack", "--product", "--journey", "--domain", "--audience", "--a11y", "--packs", "--id", "--answer"];
  const frames: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--json" || arg === "--draft" || arg === "--force" || arg === "--no-record" || arg === "--strict") continue;
    if (VALUE_FLAGS.includes(arg)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value.`);
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`Unknown handoff option "${arg}". Use --draft, --strict, --json, --out, --no-record, --recipe, --depth, --force, --answer, --rules or ${PACK_BIND_FLAGS}.`);
    frames.push(arg);
  }
  if (!frames.length) throw new Error(HANDOFF_USAGE);
  const rawDepth = flag(args, "depth");
  const depth = rawDepth === undefined ? 3 : Number(rawDepth);
  if (!Number.isInteger(depth) || depth < 1 || depth > 3) throw new Error("--depth must be 1, 2 or 3.");
  const bind = bindFromFlags(args);
  const pack = packForRecommend(bind);
  const index = requireGraph(args).index;
  const briefed = briefAnswersFromFlags(args);
  const answerIds = briefed ? briefAnswerIds(briefed, index) : undefined;
  const briefing = briefAnswerLines(briefed, index);
  const briefParts = briefAnswerParts(briefed, index);
  const result = handoffSheet(index, frames, {
    draft: args.includes("--draft"),
    strict: args.includes("--strict"),
    recipe: flag(args, "recipe"),
    recipes: loadRecipes(),
    ...(pack ? { context: pack } : {}),
    bindRules: mergeBindRules(readBindRules(), pack?.bindRules),
    dsck: readDsck(),
    workspace: bind.workspace ?? readWorkspace(),
    placeholders: readPlaceholders(),
    rules: readLibraryRules(flag(args, "rules")),
    decisions: readApprovedDecisions(),
    ...(briefing.length ? { briefing } : {}),
    ...(briefParts.length ? { briefParts } : {}),
    depth,
  });
  const json = args.includes("--json");
  if (!result.ok) {
    if (json) printJson(result);
    else process.stdout.write(`${presentToolResult(result, "markdown", "get_handoff")}\n`);
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
    // Our files only: handoff.md, handoff.json, ingredients.md, decision.json/.md and screen-*.md. Anything else in the folder is left alone.
    const ours = (f: string) => ["handoff.md", "handoff.json", "ingredients.md", "decision.json", "decision.md"].includes(f) || /^screen-.+\.md$/.test(f);
    // The decision record sits next to the handoff unless --no-record; an older one is then removed so it cannot mislead.
    const record = !args.includes("--no-record");
    const existing = existsSync(target) ? readdirSync(target).filter(ours).sort() : [];
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
    const stale = existing.filter((f) => (f.startsWith("screen-") && !files.includes(f)) || (!record && f.startsWith("decision.")));
    try {
      mkdirSync(target, { recursive: true });
      accessSync(target, fsConstants.W_OK);
      result.screens.forEach((sheet, n) => writeFileSync(join(target, files[n]!), formatHandoffScreen(sheet, result.draft)));
      writeFileSync(join(target, "ingredients.md"), formatHandoffIngredients(result));
      // Keep resolved briefing answers in handoff.json so a later handoff export can verify decision answers against the same source.
      const handoffJson = answerIds ? { ...result, answers: answerIds } : result;
      writeFileSync(join(target, "handoff.json"), `${JSON.stringify(handoffJson, null, 2)}\n`);
      writeFileSync(join(target, "handoff.md"), formatHandoffIndex(result, files));
      if (record) writeDecision(target, recordFromHandoff({ pack: result, ...(answerIds ? { answers: answerIds } : {}), createdAt: new Date().toISOString() }));
      for (const f of stale) rmSync(join(target, f), { force: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const why =
        code === "EACCES" || code === "EPERM"
          ? "no permission to write there"
          : code === "EEXIST" || code === "ENOTDIR"
            ? "part of that path is a file, not a folder"
            : code === "ENOENT"
              ? "that folder path does not exist"
            : code === "EROFS"
              ? "the file system is read-only"
              : code === "ENOSPC"
                ? "the disk is full"
                : "could not write files there";
      throw new Error(`Cannot write the handoff files to ${target}: ${why}. Pass another --out folder.`);
    }
    if (json) {
      printJson({
        ok: true,
        outDir: target,
        paths: {
          handoffMd: join(target, "handoff.md"),
          handoffJson: join(target, "handoff.json"),
          ingredientsMd: join(target, "ingredients.md"),
          screens: files.map((file) => join(target, file)),
          ...(record ? { decisionJson: join(target, "decision.json"), decisionMd: join(target, "decision.md") } : {}),
        },
        ...(stale.length ? { removed: stale.map((file) => join(target, file)) } : {}),
      });
      return;
    }
    process.stdout.write(
      `Wrote ${target}: handoff.md, ${files.join(", ")}, ingredients.md, handoff.json${record ? ", decision.json, decision.md" : ""}${result.draft ? " (DRAFT, not for build)" : ""}.\n${stale.length ? `Removed ${stale.length} older ${stale.every((f) => f.startsWith("screen-")) ? "screen " : ""}file${stale.length === 1 ? "" : "s"} from an earlier handoff there: ${stale.join(", ")}.\n` : ""}`,
    );
    return;
  }
  if (json) {
    printJson(result);
    return;
  }
  process.stdout.write(`${presentToolResult(result, "markdown", "get_handoff")}\n`);
  return;
}

export const HANDOFF_TOOL = {
  name: "get_handoff",
  description:
    "Developer handoff sheet for one or more designed screens (frames): recipe slots, each component placed on the screen with fileKey and figmaNodeId and its code from .resolve/code-map.json (unmapped when there is no entry; never guessed), selector, module, inputs and outputs, suggested inputs from Figma variant properties (Variant=Primary becomes variant=\"primary\") and a suggested template line, the parts inside each component, a PASS or FAIL line, approved decisions (who, when, why), and open questions. Never refuses: a retired component, a stale code link, a layer-name guess ('MCP metadata insufficient for component X. Use Figma REST or design_context.') or a missing component is listed under warnings, each with a next step to try. allowWeak makes a labelled draft (name-guess) with no warning; drafts are not for build. Over 40,000 characters of the structured card, parts are shown one level less deep at a time until it fits, and the card says how many parts are listed. Open questions and the summary counts always come from the full sheet. Markdown lists each part once, on its component, not again as a second parts table. A copy whose component is in no learned file is a not-found warning. A component from a library file that is not learned is other-library (no Figma id of this file, code unknown, not counted as unmapped). A not-found component is code unknown too. The card lists the other values of each Figma property (the placed one is left out). A recipe slot is placed, inside another component (the card names it), or missing. Placed and inside both count as covered. One copy fills one slot. A frame can be a pasted Figma link with node-id. Markdown by default. Advanced surface. Do not Read graph.json.",
  inputSchema: {
    type: "object",
    properties: {
      ...RECORD_PROPERTY,
      ...graphIdProperty,
      frame: { type: "string", description: "Frame name, graph id, figma node id or fileKey:nodeId." },
      frames: { type: "array", items: { type: "string" }, description: "Several frames for one handoff pack." },
      allowWeak: { type: "boolean", description: "Draft: allow components known only from layer names (labelled name-guess) or missing from the learned files (labelled not-found). Retired components stay a warning." },
      recipe: { type: "string", description: "Recipe id or intent to check the screen against. Default: matched from the screen name." },
      depth: { type: "number", description: "Levels of parts per component, 1-3. Default 3. Any other value is clamped, and depthNote says so." },
      answers: {
        type: "object",
        description: "Briefing answers. Shape and state answers are added to the parts, not only listed as a note. At most 3 answers.",
        additionalProperties: true,
      },
      pack: { type: "string" },
      product: { type: "string" },
      journey: { type: "string" },
      domain: { type: "string" },
      ...screenContextProperties,
    },
  },
};

