/**
 * Compare a linked component's Figma variant values with its CSS modifiers (`block--value`).
 * Advice only: a gap never blocks. An axis with no value in code at all is skipped (it is likely built another way,
 * for example an attribute), and code-only modifiers are reported only when at least one axis matched.
 */
const fold = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

export function codeValueWarnings(
  properties: Record<string, string[]> | undefined,
  modifiers: Record<string, string[]> | undefined,
): { warnings?: string[] } {
  const suffixes = [...new Set(Object.values(modifiers ?? {}).flat().map((cls) => cls.slice(cls.lastIndexOf("--") + 2)))];
  if (!properties || !suffixes.length) return {};
  const known = new Set(suffixes.map(fold));
  const used = new Set<string>();
  const warnings: string[] = [];
  for (const [axis, values] of Object.entries(properties)) {
    const hits = values.filter((value) => known.has(fold(value)));
    if (!hits.length) continue;
    for (const value of hits) used.add(fold(value));
    const missing = values.filter((value) => !known.has(fold(value)));
    if (missing.length) warnings.push(`Figma ${axis} values with no code modifier: ${missing.join(", ")}. next: build these from the base class or say the modifier is missing; do not invent a class.`);
  }
  const extra = used.size ? suffixes.filter((suffix) => !used.has(fold(suffix)) && !Object.values(properties).flat().some((v) => fold(v) === fold(suffix))) : [];
  if (extra.length) warnings.push(`Code modifiers with no Figma value: ${extra.join(", ")}. next: check whether Figma names it differently before using it.`);
  return warnings.length ? { warnings } : {};
}
