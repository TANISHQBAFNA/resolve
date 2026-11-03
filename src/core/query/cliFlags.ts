/**
 * CLI flag hygiene, so a CI typo cannot pass silently. Flag names match case-insensitively,
 * `--name=value` works, `--strict=true|false` works, and an unknown flag is a warning with a
 * `next:` step (never an exit). Pure: the CLI prints the warnings.
 */

/** Every flag any Resolve command reads. A guard test keeps it in step with src. */
export const KNOWN_FLAGS: ReadonlySet<string> = new Set([
  "a11y", "all", "answer", "audience", "budget", "check", "components", "compose", "confirm", "confirm-evidence",
  "css", "deny", "depth", "design-context", "domain", "draft", "dry-run", "figma", "file", "file-key", "force",
  "force-role", "from-metadata", "golden", "handoff", "help", "id", "import", "init", "intent", "job", "journey",
  "json", "label", "last-modified", "libraries", "library-built-at", "limit", "list", "mcp", "name", "no-record",
  "out", "pack", "package", "packs", "pairs", "phrases", "pretty", "product", "propose", "recipe", "record", "ref",
  "repeat", "replace", "repo", "rescan", "resume", "retired", "role", "rules", "scope", "screen-type", "shuffle",
  "slot", "strict", "suggest", "texts", "theme", "unmatched", "url", "variant", "version", "who", "whole-file",
  "workspace", "write", "write-id", "yes",
]);

/** Switches that take no value, so `--json=true` means `--json` and `--json=false` means off. */
const SWITCHES = new Set(["strict", "json", "pretty", "all", "yes", "dry-run", "force", "force-role", "no-record", "draft", "write-id"]);
const TRUE = new Set(["true", "1", "yes", "on"]);
const FALSE = new Set(["false", "0", "no", "off"]);

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const kept = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = kept;
    }
  }
  return row[b.length]!;
}

/** Closest known flag within two edits, for the `did you mean` hint. */
export function closestFlag(name: string): string | undefined {
  let best: string | undefined;
  let bestScore = 3;
  for (const known of KNOWN_FLAGS) {
    const score = distance(name, known);
    if (score < bestScore) [best, bestScore] = [known, score];
  }
  return best;
}

export interface NormalizedArgs {
  argv: string[];
  warnings: string[];
}

/** Lower-case flag names, split `--name=value`, and warn (never stop) on a flag Resolve does not know. */
export function normalizeCliArgs(argv: readonly string[], warn?: (line: string) => void): NormalizedArgs {
  const out: string[] = [];
  const warnings: string[] = [];
  for (const arg of argv) {
    if (!arg.startsWith("--") || arg === "--") {
      out.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = (eq < 0 ? arg.slice(2) : arg.slice(2, eq)).toLowerCase();
    const value = eq < 0 ? undefined : arg.slice(eq + 1);
    if (!KNOWN_FLAGS.has(name)) {
      const near = closestFlag(name);
      warnings.push(`warning: unknown flag --${name} was ignored. next: ${near ? `did you mean --${near}? ` : ""}run resolve help for the flags each command takes.`);
      out.push(arg);
      continue;
    }
    if (value === undefined) out.push(`--${name}`);
    else if (SWITCHES.has(name) && TRUE.has(value.toLowerCase())) out.push(`--${name}`);
    else if (SWITCHES.has(name) && FALSE.has(value.toLowerCase())) continue;
    else if (SWITCHES.has(name)) warnings.push(`warning: --${name}=${value} was ignored. next: write --${name} on its own (or --${name}=true).`);
    else out.push(`--${name}`, value);
  }
  if (warn) for (const line of warnings) warn(line);
  return { argv: out, warnings };
}

/** True when `--strict` is on, in any spelling `normalizeCliArgs` accepts. */
export function hasStrict(args: readonly string[]): boolean {
  return args.some((arg) => {
    const lower = arg.toLowerCase();
    return lower === "--strict" || (lower.startsWith("--strict=") && TRUE.has(lower.slice("--strict=".length)));
  });
}
