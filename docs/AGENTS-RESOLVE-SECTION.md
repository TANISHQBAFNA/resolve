## Resolve

Building Resolve? See this file. Using Resolve as a designer? Start at [GUIDE.md](GUIDE.md).

For ANY Figma design, screen, or component task, call Resolve before drawing. **Never Read `graph.json`.** Never invent components.

**Check first.** Resolve works best when the Figma MCP connection is active and a design system, library, or existing screens are learned. If either is missing, tell the user in plain words what is missing and how to add it. Do not guess.

**Path (Resolve MCP tools):**

1. Map the Figma file first. `get_metadata`, then `learn_library` (`role` `library` for the design system, `product` or `client` for screens). Pass `designContext` so the component default text is stored. Re-run when that file changed.
2. Set context before any component pick. Name the product, the journey step, the audience, and the a11y bar (for example `wcag-aa`). Pass `pack` when `.resolve/context-packs.json` matches. Otherwise pass `product`, `journey`, `domain`, `audience`, and `a11y` from the designer. If any of those four are unknown, ask once in plain words. Do not call `recommend` and do not draw until they are set. Do not invent a product, an audience, or an a11y bar. Overlay `.resolve/recipes.json` still wins.
3. `recipe` for the screen job. Pass the same context.
4. `recommend` for each unbound, missing, or deprecated slot. Pass the same context. Place returned `figmaNodeId`s only (cards stamp `fileKey`). An empty card means stop.
5. `get_example`, then clone that instance and replace the content. Pass the same context. Do not start from the default variant.
6. `verify_frame` after the frame exists. Pass the same context. Fetch that frame's design context first and pass it as `designContext`.
7. `check_cousins` when a library file and a product or client file are both linked. Pass the same context. Unsure means stop.

Resolve is read-only. Never invent a component, name, or node id.

**Design work.** Simplest thing that works. Reuse an existing component before anything new. One check: `verify_frame`.

Full workflow, when this client can read MCP resources: `resolve://workflow`.

Designers add recipes in JSON (`src/data/recipes.json` or `.resolve/recipes.json`), product+journey+domain packs in `.resolve/context-packs.json`, and linked files in `.resolve/workspace.json`. See [GUIDE.md](GUIDE.md).
