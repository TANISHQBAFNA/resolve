Installing Resolve for a user? Follow [INSTALL-FOR-AI.md](INSTALL-FOR-AI.md). The rest of this file is how to use Resolve once it is installed.

## Resolve

Resolve gives your AI real components, never invented ones: Figma masters or coded classes. Run its check before you finish.

**Pick the workflow.** The user's words decide: a Figma design or screen means the Figma workflow; an HTML/CSS/JS prototype on the repo's design system means the code workflow. If the words do not say, use `mode` from `.resolve/config.json` (`figma`, `code` or `both`; `RESOLVE_MODE` overrides it). Still unclear: ask one short question. Read only the workflow you need. Resolve's tools follow the mode too.

### Figma workflow

For ANY Figma design, screen, or component task, call Resolve before drawing.

**Check first.** Resolve works best when the Figma MCP connection is active and a design system, library, or existing screens are learned. Look for Figma tools (`get_metadata`, `use_figma`). If those tools are missing, or nothing is ingested, stop. Tell the user in plain words what is missing and how to add it (connect Figma in this app, then map the file). Do not guess. Do not invent components.

**Path (Resolve MCP tools):**

1. Map the Figma file first. `get_metadata`, then `learn_library` (fileKey; `role` `library` for the design system, `product` or `client` for screens). Re-run when that file changed.
2. Set context before any component pick. Read the requirements or FSD (you read that document; Resolve does not) and pass `product`, `journey`, `domain`, `audience`, and `a11y` only when it states them. Do not ask for those four. Leave a field off when the document does not say it. Do not invent a product, an audience, or an a11y bar. A context pack is optional. Resolve uses one only on an exact product match, and an exact journey match when the document gives a journey. Do not pass `pack` unless the document names that pack id.
3. `recipe` for the screen job. Pass the same context. On a screen request, call `brief` before `recommend`. At most 3 multiple-choice questions, and only when the answer changes the component. Pass those answers to `recommend` and handoff.
4. `recommend` for each unbound, missing, or deprecated slot. Pass the same context and any brief answers. Place returned `figmaNodeId`s only (cards stamp `fileKey`). An empty card means stop.
5. `get_example`, then clone that instance and replace the content. Pass the same context. Do not start from the default variant.
6. `verify_frame` after the frame exists. Pass the same context. Fetch that frame's design context first and pass it as `designContext`.
7. `check_cousins` when a library file and a product or client file are both linked. Pass the same context. Unsure means stop.

Resolve is read-only. Never invent a component, name, or node id. Never Read `.resolve/graph.json`.

**Design work.** Simplest thing that works. Reuse an existing component before anything new. One check: `verify_frame`.

Full workflow, when this client can read MCP resources: `resolve://figma`.

### Code workflow

For ANY HTML, CSS, or JS screen or component built on the repo's design system, call Resolve before writing markup. Needs `repoPath` in `.resolve/config.json` (or `RESOLVE_REPO_PATH`); `cssEntry` and `theme` are optional. No `repoPath`: ask the user for it and stop.

1. `code_scan` once, and again when the design system changes. It builds the catalog: components, variants, rules, real markup, deprecated classes, tokens. Never Read `.resolve/code-catalog.json`.
2. `code_pick` with what the screen needs, for each part. Build with the returned classes, variants and markup only. A modifier needs its base class. Never use a class listed under `avoid`. Use tokens, not literal colours or sizes.
3. `code_check` on the HTML file before you finish. Fix every error, check again, report what is left. Nothing fits: say so. Never invent a class.

Full workflow, when this client can read MCP resources: `resolve://code`. In a shell: `resolve code scan|pick|check`.
