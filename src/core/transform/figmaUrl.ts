/**
 * Figma deep links.
 *
 * Node ids are `1:23` in the API and `1-23` in URLs. Styles, variables and
 * collections have no addressable URL, so they return the file URL instead.
 */

export function slugifyFileName(fileName: string): string {
  const slug = fileName
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
  return slug.length ? slug : "Untitled";
}

/** A made-up example file (its JSON says `"example": true`) must not grow a figma.com address. */
export const EXAMPLE_FILE_NOTE = "example, not a real Figma file";

export function figmaFileUrl(fileKey: string, fileName: string, options: { example?: boolean } = {}): string {
  if (options.example) return `${EXAMPLE_FILE_NOTE} (${fileKey} ${fileName})`;
  return `https://www.figma.com/design/${encodeURIComponent(fileKey)}/${encodeURIComponent(
    slugifyFileName(fileName),
  )}`;
}

export function figmaNodeUrl(
  fileKey: string,
  fileName: string,
  figmaNodeId: string,
  options: { devMode?: boolean; example?: boolean } = {},
): string {
  if (options.example) return `${EXAMPLE_FILE_NOTE} (${fileKey} ${figmaNodeId})`;
  const url = new URL(figmaFileUrl(fileKey, fileName));
  url.searchParams.set("node-id", figmaNodeId.replace(/:/g, "-"));
  if (options.devMode) url.searchParams.set("m", "dev");
  return url.toString();
}
