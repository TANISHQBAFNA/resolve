Installing Resolve for a user? Follow [INSTALL-FOR-AI.md](INSTALL-FOR-AI.md). The rest of this file is how to use Resolve once it is installed.

## Resolve

For ANY Figma design, screen, or component task, call Resolve before drawing.

**Check first.** Resolve works best when the Figma MCP connection is active and a design system, library, or existing screens are learned. Look for Figma tools (`get_metadata`, `use_figma`). If those tools are missing, or nothing is ingested, stop. Tell the user in plain words what is missing and how to add it (connect Figma in this app, then map the file). Do not guess. Do not invent components.

**Path (Resolve MCP tools):**

1. Map the Figma file first. `get_metadata`, then `learn_library` (fileKey; `role` `library` for the design system, `product` or `client` for screens). Re-run when that file changed.
2. Set context before any component pick. Read the requirements or FSD and take the product, journey step, audience, and a11y bar from that text. Do not ask for those four. Pass `pack` when `.resolve/context-packs.json` matches the same document. Otherwise pass `product`, `journey`, `domain`, `audience`, and `a11y` only when the requirements or FSD state them. Leave a field off when the document does not say it. Do not invent a product, an audience, or an a11y bar.
3. `recipe` for the screen job. Pass the same context.
4. `recommend` for each unbound, missing, or deprecated slot. Pass the same context. Place returned `figmaNodeId`s only (cards stamp `fileKey`). An empty card means stop.
5. `get_example`, then clone that instance and replace the content. Pass the same context. Do not start from the default variant.
6. `verify_frame` after the frame exists. Pass the same context. Fetch that frame's design context first and pass it as `designContext`.
7. `check_cousins` when a library file and a product or client file are both linked. Pass the same context. Unsure means stop.

Resolve is read-only. Never invent a component, name, or node id. Never Read `.resolve/graph.json`.

**Design work.** Simplest thing that works. Reuse an existing component before anything new. One check: `verify_frame`.

Full workflow, when this client can read MCP resources: `resolve://workflow`.
