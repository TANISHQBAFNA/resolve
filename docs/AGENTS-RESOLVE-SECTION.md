## Resolve

Building Resolve? See this file. Using Resolve as a designer? Start at [GUIDE.md](GUIDE.md).

For ANY Figma design, screen, or component task, call Resolve before drawing. **Never Read `graph.json`.** Never invent components.

**Check first.** Resolve works best when the Figma MCP connection is active and a design system, library, or existing screens are learned. If either is missing, tell the user in plain words what is missing and how to add it. Do not guess.

**Path (Resolve MCP tools):**

1. Map the Figma file first. `get_metadata`, then `learn_library` (`role` `library` for the design system, `product` or `client` for screens). Pass `designContext` so the component default text is stored. Re-run when that file changed.
2. `recipe` when the screen job matches a pack. Overlay `.resolve/recipes.json` still wins. Optional `.resolve/context-packs.json` scopes product + journey + domain.
3. `recommend` for each unbound, missing, or deprecated slot. Place returned `figmaNodeId`s only (cards stamp `fileKey`).
4. `get_example`, then clone that instance and replace the content. Do not start from the default variant.
5. `verify_frame` after the frame exists. Fetch that frame's design context first and pass it as `designContext`.
6. `check_cousins` when a library file and a product or client file are both linked. Unsure means stop.

Resolve is read-only. Never invent a component, name, or node id.

**Design work.** Simplest thing that works. Reuse an existing component before anything new. One check: `verify_frame`.

Full workflow, when this client can read MCP resources: `resolve://workflow`.

Designers add recipes in JSON (`src/data/recipes.json` or `.resolve/recipes.json`), product+journey+domain packs in `.resolve/context-packs.json`, and linked files in `.resolve/workspace.json`. See [GUIDE.md](GUIDE.md).
