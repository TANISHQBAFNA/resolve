/**
 * Claude Code truncates each MCP server's `instructions` at 2,048 characters
 * (per server, since 2.1.84). Stay under 1,500 so the trigger survives.
 * Longer detail lives on the `resolve://workflow` resource and in tool descriptions.
 */

import type { Mode } from "./mode.ts";
import { activeMode, includesPack } from "./mode.ts";

export const INSTRUCTION_LIMIT = 1500;

export const WORKFLOW_URI = "resolve://workflow";
export const FIGMA_URI = "resolve://figma";
export const CODE_URI = "resolve://code";

/** Figma pack: the original instructions, unchanged. */
export const MCP_INSTRUCTIONS = [
  "For ANY Figma design, screen, or component task, call Resolve first. Do not draw until this path runs.",
  "",
  "Check first. Resolve works best when the Figma MCP connection is active AND a design system, library, or existing screens are learned. Look for Figma tools (get_metadata, use_figma). If those tools are missing, or Resolve has no ingested library or screens, stop. Tell the user in plain words what is missing and how to add it (connect Figma in this app, then map the file). Do not guess. Do not invent components.",
  "",
  "Map the Figma file first: get_metadata, then learn_library (fileKey; role=library for the design system, product or client for screens). Set context before any component pick from the requirements or FSD: product, journey, audience, and a11y. The agent reads that document; Resolve does not. Do not ask for those four. Leave a field off when the document does not say it. Do not invent a product. A context pack is optional and matches only an exact product, and an exact journey when the document gives one. Then recipe; brief before recommend; recommend each unbound slot with that same context; get_example and clone that instance (do not start from the default variant); an empty recommend means stop; verify_frame (pass designContext and the same context); check_cousins when a library and a product file are both linked.",
  "",
  "Resolve is read-only. Never invent a component, name, or node id. Place only returned figmaNodeIds. Longer workflow: read resource resolve://workflow.",
].join("\n");

/** Figma pack workflow, unchanged. */
export const WORKFLOW_MARKDOWN = `# Resolve workflow

Resolve is read-only. For any Figma design, screen, or component task, call it before drawing.

## Check first

Resolve works best when both are true:

1. The Figma MCP connection is active in this app (tools such as get_metadata and use_figma).
2. A design system, library, or existing screens have been learned.

If either is missing, stop. Tell the user in plain words what is missing and how to add it. Connect Figma in the same app as Resolve, then map the file. Do not guess. Do not invent a component, name, or node id.

## Path

1. Map the Figma file first. Figma get_metadata, then learn_library with that XML, the file key, and a role (\`library\` for the design system, \`product\` or \`client\` for screens). Pass search_design_system or get_libraries as \`libraries\` so published component keys are stored. Pass designContext too: metadata usually has no characters, and the component default is stored only from real text. Re-run when that file changed. Big libraries: a few frames per pass; progress is saved and resumes. A view or free seat has a low read quota and uses the same resume path. A paid Dev or Full seat can read more. Secondary learn is REST ingest. Never hand-build capture JSON.
2. Set context before any component pick. Read the requirements or FSD (the agent reads that document; Resolve does not) and pass product, journey, domain, audience, and a11y only when it states them. Do not ask for those four. Leave a field off when the document does not say it. Do not invent a product, an audience, or an a11y bar. A context pack is optional. Resolve uses one only on an exact product match, and an exact journey match when the document gives a journey. Do not pass pack unless the document names that pack id. A saved pack is the copy of src/data/context-packs.example.json at .resolve/context-packs.json. Never put Figma ids in that file. Audience, a11y, and density are shown on the card and do not change which component is picked.
3. recipe for the screen job. Pass the same context. After learn, slots bind to live ids. The card echoes audience and a11y. On a screen request, call brief before recommend. It asks at most 3 multiple-choice questions, and only when the answer would change the component. Options are live masters from the learned library. Pass the answers to recommend and get_handoff. "Just build" logs assumptions and asks nothing.
4. recommend for each unbound, missing, or deprecated slot. Pass the same context and any brief answers. The top pick has a one-line why and \`ex\` (a real instance). Place only returned figmaNodeIds. Cards stamp fileKey. Ids collide across files. An empty card means stop. Do not draw a stand-in.
5. get_example for the full config (and for hits that are not the top pick). Pass the same context. Clone that instance and replace the content. Do not start from the default variant. \`resolve\` with a name is the I-know-the-name path: an exact master returns id + fileKey + figmaNodeId even with zero instances. A miss says so and points at recommend.
6. verify_frame after the frame exists. Pass the same context. Fetch that frame's design context first and pass it as designContext. \`texts\` only fills empty layers inside the frame. textChecked is true only when the instance text and the learned default were both read. Lorem-ipsum filler fails. Leftover default copy warns, and fails only when that default is also on placeholders.json. The same card has a Proper use section (detached copies, unbound values, property misuse, contrast, tap size, icon-only buttons). Exit 0 starts \`PASS · Components: PASS · Proper use: PASS\`. Proper-use errors fail that line. No frame stays \`NOTHING CHECKED\` and does not add a proper-use block. Warnings stay a pass, with the count. A crowded card keeps every error; \`all: true\` lists the rest. Unknown when the capture has no boundVariables. A pass records usage. Rules never change themselves.
7. check_cousins when a library file and a product or client file are both linked. Pass the same context. Unsure means stop. Do not invent a master.

Placing a component into a different Figma file needs the library published and search_design_system output passed as libraries. Otherwise build inside the library file.

If freshness.stale, freshness.delta lists the pages or frames to re-fetch, then learn_library again. A master removed from the file is deprecated and must not be recommended. Bind rules (require / forbid / prefer) live in bind-rules.json. Team template strings live in placeholders.json.

## Design work

Simplest thing that works. Reuse an existing component before anything new. One check: verify_frame.

Default tools: learn_library, recipe, brief, recommend, resolve, get_example, verify_frame, check_cousins. Set RESOLVE_MCP_ADVANCED=1 for the rest. Do not Read or dump graph.json.
`;

/** Code pack: coded components in a repo instead of Figma masters. */
export const CODE_INSTRUCTIONS = [
  "For ANY HTML/CSS/JS screen or component built on the repo's design system, call Resolve first. Do not write markup until this path runs.",
  "",
  "Resolve is read-only. Use only real components from the repo. Never invent a class, variant, token, or markup. If nothing fits, say so.",
  "",
  "1. code_scan once (and after the design system changes). It reads the repo from config repoPath or RESOLVE_REPO_PATH. No repoPath: tell the user to set it.",
  '2. code_pick "<what the screen needs>" for each part of the screen. Build with the returned classes, variants, and markup. Avoid the deprecated classes it lists. Style with tokens, never literal colours.',
  "3. code_check on the finished HTML file before you finish. Fix every error and each warning you can. Report what is left.",
  "",
  "Longer workflow: read resource resolve://code.",
].join("\n");

/** Both packs: a short core. The pack text loads only for the part of the task that needs it. */
export const BOTH_INSTRUCTIONS = [
  "Resolve gives real components, never invented ones, and checks the result before you finish. Two workflows: Figma designs and coded HTML prototypes.",
  "",
  "Pick one: what the user says wins (Figma file, frame, or design = Figma; HTML, CSS, prototype, repo, or code = code). Otherwise follow config mode. If still unclear, ask one short question. Load both only when the task needs both.",
  "",
  "Figma workflow: read resource resolve://figma, then learn_library, recipe, brief, recommend, get_example, verify_frame, check_cousins.",
  "Code workflow: read resource resolve://code, then code_scan, code_pick, code_check, code_map.",
  "",
  "Resolve is read-only. Never invent a component, class, name, or node id.",
].join("\n");

export const CODE_WORKFLOW_MARKDOWN = `# Resolve code workflow

Resolve is read-only. For any HTML, CSS, or JS screen built on the repo's design system, call it before writing markup. Use only what it returns.

Needs: \`repoPath\` (folder with the design system CSS) in .resolve/config.json or RESOLVE_REPO_PATH. Optional: \`cssEntry\` (entry stylesheet) and \`theme\` (token file). Without a repoPath, stop and ask the user for it.

1. code_scan reads the CSS and HTML under repoPath. It builds one catalog entry per component: name, variants, rules, real markup, CSS file, deprecated classes, and tokens. It saves .resolve/code-catalog.json and is reused until a CSS file changes. Re-run it after the design system changes.
2. code_pick with what the screen needs, one call per part (a transaction table, a confirm dialog, a status badge). It returns classes, modifiers, markup, rules, and deprecated classes to avoid. Build with exactly those. A modifier needs its base class. Use tokens for colour, space, and type. Include the design-system and theme stylesheets the picked components come from.
3. code_check on the finished file. Errors: deprecated or unknown classes, unknown tokens. Warnings: modifier without base, literal colours. Fix them, run it again, and report what is left. Page-local classes with a local prefix (config localPrefixes) are reported as info.

If nothing fits, say so. Do not invent a class. With both packs on, code_scan joins a Figma component to its coded one by exact name, alias, or .resolve/mapping.json; code_map shows the pairs, the unmatched, and (suggest:true) likely pairs. A suggested pair is not a link: ask the user to confirm it in the mapping file.

Default tools: code_scan, code_pick, code_check, code_map.
`;

const CORE_MARKDOWN = `# Resolve

One engine, two workflows. Resolve is read-only. Use real components only, never invent a name, class, or id, and run the check before you finish.

Workflow: the user's words decide (Figma file, frame, or design = Figma; HTML, CSS, prototype, repo, or code = code). Otherwise the config mode (figma, code, both). If still unclear, ask one short question. Load a pack only when the task needs it.
`;

export function mcpInstructions(mode: Mode = activeMode()): string {
  return mode === "code" ? CODE_INSTRUCTIONS : mode === "both" ? BOTH_INSTRUCTIONS : MCP_INSTRUCTIONS;
}

export function listResources(mode: Mode = activeMode()): Array<{ uri: string; name: string; description: string; mimeType: string }> {
  const rows = [
    {
      uri: WORKFLOW_URI,
      name: "Resolve workflow",
      description: mode === "both" ? "Which workflow to use and which resource to read next. Resolve is read-only." : "Full Resolve path. Read this after the short server instructions. Resolve is read-only.",
      mimeType: "text/markdown",
    },
  ];
  if (mode === "both" || mode === "figma") rows.push({ uri: FIGMA_URI, name: "Resolve Figma workflow", description: "Full path for a Figma screen. Read when the task is a Figma design.", mimeType: "text/markdown" });
  if (includesPack(mode, "code")) rows.push({ uri: CODE_URI, name: "Resolve code workflow", description: "Full path for an HTML screen built on the repo's design system. Read when the task is code.", mimeType: "text/markdown" });
  return rows;
}

export function readResource(uri: string, mode: Mode = activeMode()): { contents: Array<{ uri: string; mimeType: string; text: string }> } | undefined {
  const text =
    uri === WORKFLOW_URI ? (mode === "figma" ? WORKFLOW_MARKDOWN : mode === "code" ? CODE_WORKFLOW_MARKDOWN : `${CORE_MARKDOWN}\nRead resolve://figma or resolve://code for the workflow you need.\n`)
    : uri === FIGMA_URI && includesPack(mode, "figma") ? WORKFLOW_MARKDOWN
    : uri === CODE_URI && includesPack(mode, "code") ? CODE_WORKFLOW_MARKDOWN
    : undefined;
  return text === undefined ? undefined : { contents: [{ uri, mimeType: "text/markdown", text }] };
}
