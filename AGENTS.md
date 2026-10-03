## Resolve

For ANY Figma design, screen, or component task, call Resolve before drawing.

**Check first.** Resolve works best when the Figma MCP connection is active and a design system, library, or existing screens are learned. Look for Figma tools (`get_metadata`, `use_figma`). If those tools are missing, or nothing is ingested, stop. Tell the user in plain words what is missing and how to add it (connect Figma in this app, then map the file). Do not guess. Do not invent components.

**Path (Resolve MCP tools):**

1. Map the Figma file first. `get_metadata`, then `learn_library` (fileKey; `role` `library` for the design system, `product` or `client` for screens). Re-run when that file changed.
2. `recipe` when the screen job matches a pack.
3. `recommend` for each unbound, missing, or deprecated slot. Place returned `figmaNodeId`s only (cards stamp `fileKey`).
4. `get_example`, then clone that instance and replace the content. Do not start from the default variant.
5. `verify_frame` after the frame exists. Fetch that frame's design context first and pass it as `designContext`.
6. `check_cousins` when a library file and a product or client file are both linked. Unsure means stop.

Resolve is read-only. Never invent a component, name, or node id. Never Read `.resolve/graph.json`.

**Design work.** Simplest thing that works. Reuse an existing component before anything new. One check: `verify_frame`.

Full workflow, when this client can read MCP resources: `resolve://workflow`.
