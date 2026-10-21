import { tokensOf } from "../queryTokens";

const PURPOSE_WORD = new Set(["to", "for", "on", "when"]);

/** Words after to, for, on, or when are why the part is used, not a second component. */
export function purposeTailTokens(ask: string): Set<string> {
  const parts = ask.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const at = parts.findIndex((part) => PURPOSE_WORD.has(part));
  if (at < 0) return new Set();
  return new Set(tokensOf(parts.slice(at + 1).join(" ")));
}

export function purposePhrase(ask: string): string | null {
  const parts = ask.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const at = parts.findIndex((part) => PURPOSE_WORD.has(part));
  if (at < 0) return null;
  const tail = parts.slice(at + 1).join(" ").trim();
  return tail || null;
}
