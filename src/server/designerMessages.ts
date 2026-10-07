/**
 * Plain sentences a designer can act on. Slash commands and the CLI use these.
 * Never a stack trace.
 */

export const DESIGNER = {
  badLink:
    "That does not look like a Figma link. Copy the link from the browser address bar. It contains figma.com/design/. A screen link also contains node-id.",
  token:
    "Figma needs you to sign in again. The token is missing or has expired. Connect Figma in this app, then run this command again.",
  viewSeat:
    "Figma refused this file. The seat may only be able to view it, or this token may not have access. Learning a library needs a Dev or Full seat and access to the file. Ask someone with that seat to run /design-system, or check access, then try again.",
  nothingLearned:
    "Resolve has not learned a design system yet. Run /design-system and paste the Figma link to the library.",
  notInstalled:
    "Resolve is not installed in this project. In the chat, paste: Install Resolve from https://github.com/TANISHQBAFNA/resolve — follow INSTALL-FOR-AI.md. Do not create the files yourself.",
  generic: "Resolve could not finish that. Run /resolve-status, then try the same command again.",
} as const;

const STACK_LINE = /^\s*at .+$/gm;

/** One plain sentence. Stack frames are dropped. Known failures map to DESIGNER. */
export function designerFailure(raw: string): string {
  const stripped = raw.replace(STACK_LINE, "").replace(/^Error:\s*/gm, "").trim();
  const one = stripped
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("at "))
    .join(" ");
  if (!one) return DESIGNER.generic;
  if (Object.values(DESIGNER).some((sentence) => one === sentence)) return one;
  if (/^No file at /i.test(one)) return one;
  if (/^Not a Figma file URL or file key:/i.test(one) || /^Give a Figma file URL or file key/i.test(one)) return DESIGNER.badLink;
  if (/\b403\b|Figma authorization failed|view[- ]only|view seat|free seat|Dev or Full seat/i.test(one)) return DESIGNER.viewSeat;
  if (/\b401\b|FIGMA_ACCESS_TOKEN|authentication failed|invalid token|token expired|expired token/i.test(one)) return DESIGNER.token;
  if (/No design system or screens are ingested yet|Nothing is learned yet/i.test(one)) return DESIGNER.nothingLearned;
  if (/Resolve MCP is not built|cannot find module|ENOENT/i.test(one)) return DESIGNER.notInstalled;
  if (/node_modules|node:internal/.test(one)) return DESIGNER.generic;
  return one;
}
