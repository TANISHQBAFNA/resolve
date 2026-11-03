export type KnowledgeAction = "guide" | "check" | "confirm" | "unknown";

export interface KnowledgeArgs {
  action: KnowledgeAction;
  json: boolean;
  repo?: string;
  ref?: string;
  file?: string;
  usage?: string;
  who?: string;
  out?: string;
  unknown: string[];
  unknownFlags: string[];
}

const VALUE_FLAGS = new Set(["--repo", "--ref", "--usage", "--who", "--out"]);

/** `resolve code knowledge` flags. Unknown flags are returned, not thrown. */
export function parseKnowledgeArgs(args: readonly string[]): KnowledgeArgs {
  const unknownFlags: string[] = [];
  const values = new Map<string, string>();
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--json") continue;
    if (arg.startsWith("--")) {
      if (!VALUE_FLAGS.has(arg)) unknownFlags.push(arg);
      else {
        const next = args[index + 1];
        if (!next || next.startsWith("--")) unknownFlags.push(arg);
        else {
          values.set(arg, next);
          index += 1;
        }
      }
      continue;
    }
    positionals.push(arg);
  }
  const word = positionals[0];
  const action: KnowledgeAction = !word ? "guide" : word === "check" ? "check" : word === "confirm" ? "confirm" : "unknown";
  const file = action === "check" ? positionals[1] : undefined;
  const unknown = action === "check" ? positionals.slice(2) : positionals.slice(1);
  return {
    action,
    json: args.includes("--json"),
    ...(values.has("--repo") ? { repo: values.get("--repo") } : {}),
    ...(values.has("--ref") ? { ref: values.get("--ref") } : {}),
    ...(file ? { file } : {}),
    ...(values.has("--usage") ? { usage: values.get("--usage") } : {}),
    ...(values.has("--who") ? { who: values.get("--who") } : {}),
    ...(values.has("--out") ? { out: values.get("--out") } : {}),
    unknown,
    unknownFlags,
  };
}
