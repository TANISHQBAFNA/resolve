/**
 * Claude Code truncates each MCP server's `instructions` at 2,048 characters
 * (per server, since 2.1.84). Stay under 1,500 so the trigger survives.
 * Longer detail lives on the `resolve://workflow` resource and in tool descriptions.
 */

export const INSTRUCTION_LIMIT = 1500;

export const WORKFLOW_URI = "resolve://workflow";

export const MCP_INSTRUCTIONS = [
  "For ANY Figma design, screen, or component task, call Resolve first. Do not draw until this path runs.",
  "",
  "Check first. Resolve works best when the Figma MCP connection is active AND a design system, library, or existing screens are learned. Look for Figma tools (get_metadata, use_figma). If those tools are missing, or Resolve has no ingested library or screens, stop. Tell the user in plain words what is missing and how to add it (connect Figma in this app, then map the file). Do not guess. Do not invent components.",
  "",
  "Map the Figma file first: get_metadata, then learn_library (fileKey; role=library for the design system, product or client for screens). Set context before any component pick: product, journey step, audience, and a11y. Pass pack when a context pack matches; else pass product, journey, domain, audience, and a11y from the designer. If those are unknown, ask once. Do not recommend until they are set. Do not invent a product. Then recipe; recommend each unbound slot with that same context; get_example and clone that instance (do not start from the default variant); an empty recommend means stop; verify_frame (pass designContext and the same context); check_cousins when a library and a product file are both linked.",
  "",
  "Resolve is read-only. Never invent a component, name, or node id. Place only returned figmaNodeIds. Longer workflow: read resource resolve://workflow.",
].join("\n");

export const WORKFLOW_MARKDOWN = `# Resolve workflow

Resolve is read-only. For any Figma design, screen, or component task, call it before drawing.

## Check first

Resolve works best when both are true:

1. The Figma MCP connection is active in this app (tools such as get_metadata and use_figma).
2. A design system, library, or existing screens have been learned.

If either is missing, stop. Tell the user in plain words what is missing and how to add it. Connect Figma in the same app as Resolve, then map the file. Do not guess. Do not invent a component, name, or node id.

## Path

1. Map the Figma file first. Figma get_metadata, then learn_library with that XML, the file key, and a role (\`library\` for the design system, \`product\` or \`client\` for screens). Pass search_design_system or get_libraries as \`libraries\` so published component keys are stored. Pass designContext too: metadata usually has no characters, and the component default is stored only from real text. Re-run when that file changed. Big libraries: a few frames per pass; progress is saved and resumes. A view or free seat has a low read quota and uses the same resume path. A paid Dev or Full seat can read more. Secondary learn is REST ingest. Never hand-build capture JSON.
2. Set context before any component pick. Name the product, the journey step, the audience, and the a11y bar (for example wcag-aa). Pass pack when .resolve/context-packs.json matches this screen. Otherwise pass product, journey, domain, audience, and a11y from the designer. If any of those four are unknown, ask once in plain words. Do not call recommend and do not draw until they are set. Do not invent a product, an audience, or an a11y bar. A saved pack is the copy of src/data/context-packs.example.json at .resolve/context-packs.json. Never put Figma ids in that file.
3. recipe for the screen job. Pass the same context. After learn, slots bind to live ids. The card echoes audience and a11y.
4. recommend for each unbound, missing, or deprecated slot. Pass the same context. The top pick has a one-line why and \`ex\` (a real instance). Place only returned figmaNodeIds. Cards stamp fileKey. Ids collide across files. An empty card means stop. Do not draw a stand-in.
5. get_example for the full config (and for hits that are not the top pick). Pass the same context. Clone that instance and replace the content. Do not start from the default variant. \`resolve\` with a name is the I-know-the-name path: an exact master returns id + fileKey + figmaNodeId even with zero instances. A miss says so and points at recommend.
6. verify_frame after the frame exists. Pass the same context. Fetch that frame's design context first and pass it as designContext. \`texts\` only fills empty layers inside the frame. textChecked is true only when the instance text and the learned default were both read. Lorem-ipsum filler fails. Leftover default copy warns, and fails only when that default is also on placeholders.json. A pass records usage. Rules never change themselves.
7. check_cousins when a library file and a product or client file are both linked. Pass the same context. Unsure means stop. Do not invent a master.

Placing a component into a different Figma file needs the library published and search_design_system output passed as libraries. Otherwise build inside the library file.

If freshness.stale, freshness.delta lists the pages or frames to re-fetch, then learn_library again. A master removed from the file is deprecated and must not be recommended. Bind rules (require / forbid / prefer) live in bind-rules.json. Team template strings live in placeholders.json.

## Design work

Simplest thing that works. Reuse an existing component before anything new. One check: verify_frame.

Default tools: learn_library, recipe, recommend, resolve, get_example, verify_frame, check_cousins. Set RESOLVE_MCP_ADVANCED=1 for the rest. Do not Read or dump graph.json.
`;

export function listResources(): Array<{ uri: string; name: string; description: string; mimeType: string }> {
  return [
    {
      uri: WORKFLOW_URI,
      name: "Resolve workflow",
      description:
        "Full Resolve path for a Figma screen. Read this after the short server instructions. Resolve is read-only.",
      mimeType: "text/markdown",
    },
  ];
}

export function readResource(uri: string): { contents: Array<{ uri: string; mimeType: string; text: string }> } | undefined {
  if (uri !== WORKFLOW_URI) return undefined;
  return { contents: [{ uri, mimeType: "text/markdown", text: WORKFLOW_MARKDOWN }] };
}
