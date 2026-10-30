/**
 * Resolve never stops on a finding: each one is a labelled warning with a short `next:` step for the AI to try.
 * `--strict` (CLI, for CI) restores the old non-zero exits and the handoff refusal.
 */

export const HANDOFF_NEXT = {
  retired: "swap the retired part for the replacement named above (verify_frame lists the copies), then run handoff again.",
  review: "re-review the code link (resolve code-map review) for the new library or package version, then run handoff again.",
  identity: "learn the file with design context (learn_library with designContext) or Figma REST, then run handoff again.",
  "not-found": "learn the library file that holds the component (resolve ingest), or replace the copy.",
} as const;

export const BRIEF_NEXT = {
  frontmatter: "fill the missing frontmatter keys (see templates/design-brief/brief.md), then run brief check again.",
  screens: "add the screen rows the brief needs, then run brief check again.",
  fields: "fill the empty fields named above, then run brief check again.",
  questions: "answer the open questions, or ask the designer, then run brief check again.",
  status: "set status: complete when the brief is ready.",
  handoff: "fix the handoff warnings (or run handoff without --draft), check the screen, then run brief check again.",
} as const;

export const CODE_MAP_NEXT: Partial<Record<string, string>> = {
  retired: "use the replacement named above.",
  "not-in-handoff": "run handoff for the screen that uses it, or check the name.",
  unmapped: "add a code-map row (resolve code-map --init, then --import), or build it from its Figma parts and say it is unmapped.",
  "not-found": "check the name (resolve status lists components), or learn the library that holds it.",
  "other-library": "learn that library file to see its code.",
};

/** Next step for a verify verdict that is not a pass (exit 1 components, 7 proper use). */
export function verifyNext(exit: number): string | undefined {
  if (exit === 7) return "set each flagged property to one of the allowed values listed, then check the screen again.";
  if (exit !== 0) return "fix what is listed above: swap retired or invented parts (recommend gives the current part) and set flagged properties to an allowed value, then check the screen again.";
  return undefined;
}
