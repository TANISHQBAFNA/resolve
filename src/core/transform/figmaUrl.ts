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

/** Made-up fixture keys must not grow a figma.com address. */
const EXAMPLE_FILE_KEYS = new Set(["M3SPEC"]);

export function figmaFileUrl(fileKey: string, fileName: string): string {
  if (EXAMPLE_FILE_KEYS.has(fileKey)) return `example, not a real Figma file (${fileKey} ${fileName})`;
  return `https://www.figma.com/design/${encodeURIComponent(fileKey)}/${encodeURIComponent(
    slugifyFileName(fileName),
  )}`;
}

export function figmaNodeUrl(
  fileKey: string,
  fileName: string,
  figmaNodeId: string,
  options: { devMode?: boolean } = {},
): string {
  if (EXAMPLE_FILE_KEYS.has(fileKey)) return `example, not a real Figma file (${fileKey} ${figmaNodeId})`;
  const url = new URL(figmaFileUrl(fileKey, fileName));
  url.searchParams.set("node-id", figmaNodeId.replace(/:/g, "-"));
  if (options.devMode) url.searchParams.set("m", "dev");
  return url.toString();
}
