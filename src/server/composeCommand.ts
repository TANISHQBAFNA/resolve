import { briefAnswerIds, briefAnswerParts, briefAnswersFromFlags, composeCard, recordFromCompose, type ComposeCardLike, type ComposeInput } from "@/core/query";
import { recordFlag } from "./decisionCommand";
import { bindFromFlags, flag, printJson, withJsonErrors } from "./cliArgs";
import { loadRecipes, readBindRules, readPlaceholders, readSock, resolveGraph, saveSock } from "./store";

/** Input checks shared by the CLI and MCP. Returns what is wrong, or undefined. */
export function composeProblem(compose: unknown, propose: unknown, request: string): string | undefined {
  for (const [key, value] of [["compose", compose], ["propose", propose]] as const) {
    if (value !== undefined && typeof value !== "boolean") return `${key} must be true or false.`;
  }
  if (propose === true && compose !== true) return "propose needs compose.";
  if (!request || request === "list") return 'Compose needs a screen request: "<screen> with <parts>".';
  return undefined;
}

/** Compose, and save the proposal when one was filed. Nothing else writes. */
export function runCompose(input: ComposeInput, propose: boolean): object {
  const out = composeCard(input, propose, new Date().toISOString());
  if (out.state) saveSock(out.state);
  return out.card;
}

/** `resolve recipe "<screen> with <parts>" --compose [--answer topic=option ...] [--propose] [--json]`. Bad input with --json is ok:false, exit 1. */
export function composeFromCli(args: string[], query: string | undefined): void {
  const request = query?.trim() ?? "";
  const index = resolveGraph(flag(args, "id"))?.index;
  const compose = args.includes("--compose") || undefined;
  const propose = args.includes("--propose") || undefined;
  const problem = composeProblem(compose, propose, request) ?? (index ? undefined : "Compose needs a learned library. Run resolve learn first.");
  if (problem || !index) {
    if (!args.includes("--json")) throw new Error(problem);
    printJson({ ok: false, status: "error", query: request, message: problem, exitCode: 1 });
    process.exitCode = 1;
    return;
  }
  // Bad answers throw BriefAnswerError; runCli prints that as ok:false JSON with --json.
  const answers = briefAnswersFromFlags(args);
  const answerParts = briefAnswerParts(answers, index);
  const input = { request, answerParts, index, recipes: loadRecipes(), bind: bindFromFlags(args), sock: readSock(), bindRules: readBindRules(), placeholders: readPlaceholders() };
  const card = runCompose(input, Boolean(propose));
  const record = () => recordFlag(args, () => recordFromCompose({ request, answers: briefAnswerIds(answers, index), card: card as ComposeCardLike, createdAt: new Date().toISOString() }));
  if (withJsonErrors(args, record, request)) printJson(card);
}
