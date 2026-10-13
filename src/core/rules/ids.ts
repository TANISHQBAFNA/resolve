/** Figma ids are written with ":" or "-". Callers match every form. */
export function idVariants(value: string): string[] {
  return [...new Set([value, value.replace(/-/g, ":"), value.replace(/:/g, "-")])];
}
