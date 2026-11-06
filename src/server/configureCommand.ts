import { configureChoice, configureGap, type ConfigureReport } from "@/core/chooseConfigure/configure";
import { flag, positionals, printJson } from "./cliArgs";
import { resolveGraph } from "./store";

const EMPTY = "Say what the screen needs, then run configure again.";
const UNLEARNED = "Learn the library, then run configure again.";

function configureReport(
  ask: string,
  graphId?: string,
  context?: { journey?: string; screenType?: string },
): ConfigureReport {
  if (!ask.trim()) return configureGap(ask, "The request is empty.", EMPTY);
  const resolved = resolveGraph(graphId);
  if (!resolved) return configureGap(ask, "No design system is learned yet.", UNLEARNED);
  return configureChoice(resolved.index, ask, context);
}

/** CLI `resolve configure`. Prints a card and returns. A gap is a warning, not a thrown error. */
export function runConfigureCli(args: string[]): void {
  const journey = flag(args, "journey");
  const screenType = flag(args, "screen-type");
  printJson(configureReport(positionals(args)[0] ?? "", flag(args, "id"), {
    ...(journey ? { journey } : {}),
    ...(screenType ? { screenType } : {}),
  }));
}

export const CONFIGURE_TOOL = {
  name: "configure",
  description:
    "Choose one real component for a screen and set only properties the library allows. Returns the choice, allowed values, which values the request set, child slots the library lists, alternatives, and warnings. visibility is unknown unless a captured child names a real property that shows or hides it. A gap is a warning with next. Do not invent a component or a property value. For the designer choosing and configuring. Do not Read graph.json.",
  inputSchema: {
    type: "object",
    properties: {
      graphId: { type: "string", description: "Graph to query. Optional when exactly one graph is stored." },
      intent: { type: "string", description: "What the screen needs, in the designer's words." },
      journey: { type: "string", description: "Journey or screen job, only when the request names one." },
      screenType: { type: "string", description: "Screen kind, only when the request names one." },
    },
    required: ["intent"],
  },
};

export function configureFromArgs(args: Record<string, unknown>): ConfigureReport {
  const intent = args["intent"] ?? args["request"];
  const journey = typeof args["journey"] === "string" ? args["journey"] : undefined;
  const screenType = typeof args["screenType"] === "string" ? args["screenType"] : undefined;
  return configureReport(typeof intent === "string" ? intent : "", typeof args["graphId"] === "string" ? args["graphId"] : undefined, {
    ...(journey ? { journey } : {}),
    ...(screenType ? { screenType } : {}),
  });
}
